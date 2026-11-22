const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRoomRecord, updateRoomRecord } = require('./rooms');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function createId(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeDropBaselines(value) {
  if (!isPlainObject(value)) return {};
  const allowedKeys = [
    'resetAt',
    'processSessionId',
    'networkDroppedFrames',
    'networkExpectedFrames',
  ];
  return Object.fromEntries(Object.entries(value).flatMap(([outputId, baseline]) => {
    if (!isPlainObject(baseline)) return [];
    const sanitized = Object.fromEntries(allowedKeys
      .filter(key => Object.prototype.hasOwnProperty.call(baseline, key))
      .map(key => [key, baseline[key]]));
    return [[outputId, sanitized]];
  }));
}

function defaultState() {
  return {
    version: 6,
    updatedAt: new Date().toISOString(),
    settings: {
      appName: 'StreamHub',
      webPort: Number(process.env.STREAMHUB_PORT || 18080),
      rtmpPort: Number(process.env.STREAMHUB_RTMP_PORT || 1935),
      srtPort: 10081,
      metricsPort: 18081,
      restoreOnBoot: false,
      lowBitrateWarningPercent: 30,
    },
    monitorDisplay: {
      dropBaselines: {},
    },
    rooms: [],
    sources: [],
    destinations: [],
    pipelines: [],
    mediaAssets: [],
    scenes: [],
    recordingJobs: [],
  };
}

function migratePipelineSettingsForVersionFour(pipeline) {
  if (!pipeline) return pipeline;
  const hasSettings = Object.prototype.hasOwnProperty.call(pipeline, 'settings');
  if (hasSettings && !isPlainObject(pipeline.settings)) return { ...pipeline };

  const rawSettings = hasSettings ? pipeline.settings : {};
  const hasLive = Object.prototype.hasOwnProperty.call(rawSettings, 'live');
  if (hasLive && !isPlainObject(rawSettings.live)) {
    return { ...pipeline, settings: { ...rawSettings } };
  }

  const rawLive = hasLive ? rawSettings.live : {};
  const settings = { ...rawSettings, live: { ...rawLive } };
  if (!Object.prototype.hasOwnProperty.call(rawLive, 'videoEncoder')) {
    settings.live.videoEncoder = 'libx264';
  }
  return { ...pipeline, settings };
}

function buildLoadedState(parsed, base) {
  const parsedMonitorDisplay = isPlainObject(parsed.monitorDisplay) ? parsed.monitorDisplay : {};
  const state = {
    ...base,
    ...parsed,
    settings: { ...base.settings, ...(parsed.settings || {}) },
    rooms: Array.isArray(parsed.rooms) ? parsed.rooms.map(room => updateRoomRecord(room, room)) : base.rooms,
    sources: Array.isArray(parsed.sources) ? parsed.sources : base.sources,
    destinations: Array.isArray(parsed.destinations) ? parsed.destinations : base.destinations,
    pipelines: Array.isArray(parsed.pipelines) ? parsed.pipelines : base.pipelines,
    mediaAssets: Array.isArray(parsed.mediaAssets) ? parsed.mediaAssets : base.mediaAssets,
    scenes: Array.isArray(parsed.scenes) ? parsed.scenes : base.scenes,
    recordingJobs: Array.isArray(parsed.recordingJobs) ? parsed.recordingJobs : base.recordingJobs,
    monitorDisplay: {
      ...base.monitorDisplay,
      ...parsedMonitorDisplay,
      dropBaselines: sanitizeDropBaselines(parsedMonitorDisplay.dropBaselines),
    },
  };

  const numericVersion = Number(parsed.version);
  const parsedVersion = Number.isFinite(numericVersion) && numericVersion > 0 ? numericVersion : 1;
  if (parsedVersion < 4) {
    state.pipelines = Array.isArray(state.pipelines)
      ? state.pipelines.map(migratePipelineSettingsForVersionFour)
      : base.pipelines.map(migratePipelineSettingsForVersionFour);
  }

  if (parsedVersion < 6) {
    state.version = 6;
    return { state, migrated: true };
  }

  return { state, migrated: false };
}

class StreamHubStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.dataDir = path.join(rootDir, 'data');
    this.statePath = path.join(this.dataDir, 'state.json');
    ensureDir(this.dataDir);
    ensureDir(path.join(this.dataDir, 'logs'));
    ensureDir(path.join(this.dataDir, 'recordings'));
    this.state = this.load();
  }

  load() {
    const base = defaultState();
    if (!fs.existsSync(this.statePath)) {
      const state = base;
      this.save(state);
      return state;
    }
    const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    const { state, migrated } = buildLoadedState(parsed, base);
    return migrated ? this.save(state) : state;
  }

  save(state = this.state) {
    state.updatedAt = new Date().toISOString();
    ensureDir(this.dataDir);
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, this.statePath);
    this.state = state;
    return this.state;
  }

  getState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  update(mutator) {
    const draft = this.getState();
    const result = mutator(draft) || draft;
    return this.save(result);
  }

  list(collection) {
    return this.getState()[collection] || [];
  }

  resetTransientPipelineStatuses() {
    const transientStatuses = new Set(['running', 'starting', 'fallback', 'draining']);
    const resetIds = (this.state.pipelines || [])
      .filter(pipeline => transientStatuses.has(pipeline.status))
      .map(pipeline => pipeline.id);
    if (!resetIds.length) return resetIds;
    this.update(state => {
      state.pipelines = (state.pipelines || []).map(pipeline => (
        transientStatuses.has(pipeline.status) ? { ...pipeline, status: 'stopped' } : pipeline
      ));
      return state;
    });
    return resetIds;
  }

  create(collection, payload, prefix) {
    return this.update(state => {
      const item = collection === 'rooms'
        ? createRoomRecord(payload)
        : { id: payload.id || createId(prefix), enabled: true, ...payload };
      state[collection] = [...(state[collection] || []), item];
      return state;
    })[collection].at(-1);
  }

  patch(collection, id, payload) {
    let updated;
    this.update(state => {
      state[collection] = (state[collection] || []).map(item => {
        if (item.id !== id) return item;
        updated = collection === 'rooms'
          ? updateRoomRecord(item, payload)
          : { ...item, ...payload, id };
        return updated;
      });
      if (!updated) throw new Error(`${collection} ${id} not found`);
      return state;
    });
    return updated;
  }

  remove(collection, id) {
    this.update(state => {
      state[collection] = (state[collection] || []).filter(item => item.id !== id);
      if (collection === 'sources') {
        state.pipelines = state.pipelines.map(p => p.sourceId === id ? { ...p, sourceId: '' } : p);
      }
      if (collection === 'destinations') {
        state.pipelines = state.pipelines.map(p => ({ ...p, destinationIds: (p.destinationIds || []).filter(d => d !== id) }));
      }
      if (collection === 'rooms') {
        state.pipelines = state.pipelines.map(p => {
          if (p.input && p.input.type === 'room' && p.input.roomId === id) return { ...p, input: null };
          return p;
        });
      }
      if (collection === 'mediaAssets') {
        state.scenes = (state.scenes || []).map(scene => ({
          ...scene,
          playlist: (scene.playlist || []).filter(mediaId => mediaId !== id),
        }));
      }
      return state;
    });
    return { ok: true };
  }
}

module.exports = { StreamHubStore, defaultState, createId, ensureDir };
