const fs = require('node:fs');
const path = require('node:path');
const { createId, ensureDir } = require('./store');
const {
  effectiveSceneSettings,
  normalizeScene,
  taskWatermarkFingerprint,
} = require('./studioModel');
const {
  configuredProgramBitrateKbps,
  estimateRecordingCapacity,
  availableBytesFromStatfs,
} = require('./recordingCapacity');

function studioError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function publicRecordingJob(job, active = null, now = Date.now()) {
  if (!job) return null;
  const elapsedMs = job.startedAt
    ? Math.max(0, (job.endedAt ? Date.parse(job.endedAt) : Number(now)) - Date.parse(job.startedAt))
    : 0;
  return {
    id: job.id,
    pipelineId: job.pipelineId,
    pipelineName: job.pipelineName || '',
    name: job.name,
    status: job.status,
    startedAt: job.startedAt || '',
    endedAt: job.endedAt || '',
    elapsedSec: Math.floor(elapsedMs / 1000),
    sizeBytes: active && fs.existsSync(active.temporaryPath) ? fs.statSync(active.temporaryPath).size : Number(job.sizeBytes) || 0,
    assetId: job.assetId || '',
    error: job.error || '',
  };
}

class StudioManager {
  constructor({
    rootDir,
    store,
    processManager,
    mediaAssets,
    now = Date.now,
    spawnRecording = null,
    statfs = fs.statfsSync,
  }) {
    this.rootDir = rootDir;
    this.store = store;
    this.processManager = processManager;
    this.mediaAssets = mediaAssets;
    this.now = now;
    this.statfs = statfs;
    this.playlistDir = path.resolve(rootDir, 'data', 'playlists');
    this.videoDir = path.resolve(rootDir, 'data', 'videos');
    ensureDir(this.playlistDir);
    ensureDir(this.videoDir);
    this.activeRecordings = new Map();
    this.spawnRecording = spawnRecording || ((id, args) => (
      this.processManager.spawnFFmpeg('recording', id, args, `${id}.log`, null, null, { gracefulStop: true })
    ));
    this.failInterruptedRecordings();
  }

  timestamp() {
    return new Date(Number(this.now())).toISOString();
  }

  failInterruptedRecordings() {
    const interrupted = (this.store.list('recordingJobs') || []).filter(job => ['recording', 'finalizing'].includes(job.status));
    for (const job of interrupted) {
      this.store.patch('recordingJobs', job.id, {
        status: 'failed',
        endedAt: this.timestamp(),
        error: '服务重启导致录制中断',
      });
    }
  }

  listScenes() {
    return clone(this.store.list('scenes') || []);
  }

  requireScene(id) {
    const scene = (this.store.list('scenes') || []).find(item => item.id === id);
    if (!scene) throw studioError('未找到画面场景', 404);
    return scene;
  }

  createScene(payload) {
    const normalized = normalizeScene(payload, this.store.getState());
    const timestamp = this.timestamp();
    return this.store.create('scenes', {
      ...normalized,
      id: createId('scene'),
      createdAt: timestamp,
      updatedAt: timestamp,
    }, 'scene');
  }

  updateScene(id, payload) {
    const existing = this.requireScene(id);
    const normalized = normalizeScene(payload, this.store.getState(), existing);
    return this.store.patch('scenes', id, {
      ...normalized,
      id,
      createdAt: existing.createdAt,
      updatedAt: this.timestamp(),
    });
  }

  removeScene(id) {
    this.requireScene(id);
    this.store.remove('scenes', id);
    return { ok: true, id };
  }

  requirePipeline(id) {
    const pipeline = (this.store.list('pipelines') || []).find(item => item.id === id);
    if (!pipeline) throw studioError('未找到分发任务', 404);
    return pipeline;
  }

  requireMedia(id) {
    const asset = (this.store.list('mediaAssets') || []).find(item => item.id === id);
    if (!asset) throw studioError('未找到视频素材', 404);
    return asset;
  }

  managedMediaPath(asset) {
    const filePath = path.resolve(String(asset && asset.path || ''));
    if (!filePath.startsWith(`${this.videoDir}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw studioError(`视频素材文件不存在：${asset && asset.name || asset && asset.id || ''}`, 400);
    }
    return filePath;
  }

  createPlaylistManifest(scene, assets) {
    const id = createId('playlist');
    const manifestPath = path.join(this.playlistDir, `${id}.ffconcat`);
    const lines = ['ffconcat version 1.0'];
    for (const asset of assets) {
      const filePath = this.managedMediaPath(asset);
      const escaped = filePath.replace(/'/g, "'\\''");
      lines.push(`file '${escaped}'`);
    }
    fs.writeFileSync(manifestPath, `${lines.join('\n')}\n`, { flag: 'wx' });
    return manifestPath;
  }

  sceneSnapshot(pipelineId, sceneId) {
    const state = this.store.getState();
    const pipeline = this.requirePipeline(pipelineId);
    const scene = this.requireScene(sceneId);
    const validated = normalizeScene(scene, state, scene);
    let source;
    let mediaIds = [];
    if (validated.sourceType === 'playlist') {
      mediaIds = validated.playlist.slice();
      const assets = mediaIds.map(id => this.requireMedia(id));
      source = {
        id: `scene-source-${scene.id}`,
        name: `画面场景：${scene.name}`,
        type: 'playlist',
        manifestPath: this.createPlaylistManifest(scene, assets),
        mediaIds,
        sharedRelay: true,
      };
    } else {
      source = {
        id: `scene-source-${scene.id}`,
        name: `画面场景：${scene.name}`,
        type: 'pull',
        url: validated.stream.url,
        sharedRelay: true,
      };
    }
    return {
      kind: 'scene',
      sceneId: scene.id,
      label: scene.name,
      sourceLabel: source.name,
      mediaIds,
      source,
      settings: effectiveSceneSettings(pipeline.settings || {}, validated),
    };
  }

  switchScene(pipelineId, sceneId) {
    return this.processManager.switchProgram(pipelineId, this.sceneSnapshot(pipelineId, sceneId));
  }

  mediaSnapshot(pipelineId, mediaId, label = '') {
    const pipeline = this.requirePipeline(pipelineId);
    const asset = this.requireMedia(mediaId);
    const filePath = this.managedMediaPath(asset);
    return {
      kind: asset.source === 'recording' ? 'recording' : 'media',
      mediaId: asset.id,
      mediaIds: [asset.id],
      label: label || asset.name,
      sourceLabel: asset.name,
      source: {
        id: `media-source-${asset.id}`,
        name: `视频素材：${asset.name}`,
        type: 'file',
        path: filePath,
        loop: true,
        mediaIds: [asset.id],
        sharedRelay: true,
      },
      settings: effectiveSceneSettings(pipeline.settings || {}, { watermarks: [] }, asset, pipelineId),
    };
  }

  switchMedia(pipelineId, mediaId, label = '') {
    return this.processManager.switchProgram(pipelineId, this.mediaSnapshot(pipelineId, mediaId, label));
  }

  restoreProgram(pipelineId) {
    this.requirePipeline(pipelineId);
    return this.processManager.restoreProgram(pipelineId);
  }

  listRecordingJobs() {
    return (this.store.list('recordingJobs') || [])
      .map(job => publicRecordingJob(job, this.activeRecordings.get(job.id), this.now()))
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  recordingCapacity(pipelineId) {
    const pipeline = this.requirePipeline(pipelineId);
    let measuredBitrateKbps = 0;
    try {
      measuredBitrateKbps = this.processManager.recordingInput(pipelineId).bitrateKbps;
    } catch {}
    let availableBytes = null;
    try {
      availableBytes = availableBytesFromStatfs(this.statfs(this.videoDir));
    } catch {}
    return {
      pipelineId: pipeline.id,
      ...estimateRecordingCapacity({
        measuredBitrateKbps,
        configuredBitrateKbps: configuredProgramBitrateKbps(pipeline),
        availableBytes,
      }),
    };
  }

  requireRecordingJob(id) {
    const job = (this.store.list('recordingJobs') || []).find(item => item.id === id);
    if (!job) throw studioError('未找到录制任务', 404);
    return job;
  }

  removeRecordingJob(id) {
    const job = this.requireRecordingJob(id);
    if (this.activeRecordings.has(id) || ['recording', 'finalizing'].includes(job.status)) {
      throw studioError('录制任务正在录制或保存，无法删除', 409);
    }
    this.store.remove('recordingJobs', id);
    return { ok: true, id };
  }

  startRecording({ pipelineId, name } = {}) {
    const recordingName = String(name || '').trim();
    if (!recordingName) throw studioError('录制名称不能为空', 400);
    const pipeline = this.requirePipeline(pipelineId);
    if (Array.from(this.activeRecordings.values()).some(item => item.pipelineId === pipelineId)) {
      throw studioError('该分发任务正在录制，请先结束当前录制', 409);
    }
    const mirror = this.processManager.recordingInput(pipelineId);
    const id = createId('recording');
    const temporaryPath = path.join(this.videoDir, `.recording-${id}.mp4`);
    const args = [
      '-hide_banner', '-fflags', '+genpts',
      '-dts_delta_threshold', '0.1',
      '-i', mirror.inputUrl,
      '-map', '0:v:0?', '-map', '0:a:0?',
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y', temporaryPath,
    ];
    const startedAt = this.timestamp();
    const job = this.store.create('recordingJobs', {
      id,
      pipelineId,
      pipelineName: pipeline.name,
      name: recordingName,
      status: 'recording',
      startedAt,
      endedAt: '',
      assetId: '',
      error: '',
      watermarkFingerprint: taskWatermarkFingerprint(pipeline.settings || {}),
    }, 'recording');
    let process;
    try {
      process = this.spawnRecording(id, args);
    } catch (error) {
      this.store.patch('recordingJobs', id, { status: 'failed', endedAt: this.timestamp(), error: error.message });
      throw error;
    }
    this.activeRecordings.set(id, { id, pipelineId, temporaryPath, process, finalizing: false });
    return publicRecordingJob(job, this.activeRecordings.get(id), this.now());
  }

  async stopRecording(id, { replay = false } = {}) {
    const job = this.requireRecordingJob(id);
    const active = this.activeRecordings.get(id);
    if (!active || job.status !== 'recording') throw studioError('录制任务当前不在录制中', 409);
    active.finalizing = true;
    this.store.patch('recordingJobs', id, { status: 'finalizing' });

    let asset;
    try {
      active.process.stop();
      if (active.process.exitPromise) await active.process.exitPromise;
      if (!fs.existsSync(active.temporaryPath) || !fs.statSync(active.temporaryPath).size) {
        throw studioError('录制文件未生成或为空', 500);
      }
      asset = await this.mediaAssets.registerRecording(active.temporaryPath, {
        name: job.name,
        sourcePipelineId: job.pipelineId,
        watermarkFingerprint: job.watermarkFingerprint,
        createdAt: job.startedAt,
      });
      const endedAt = this.timestamp();
      const completed = this.store.patch('recordingJobs', id, {
        status: 'completed',
        endedAt,
        assetId: asset.id,
        sizeBytes: Number(asset.sizeBytes) || 0,
        error: '',
      });
      this.activeRecordings.delete(id);
      const result = { job: publicRecordingJob(completed, null, this.now()), asset };
      if (replay) result.program = await this.switchMedia(job.pipelineId, asset.id, job.name);
      return result;
    } catch (error) {
      if (!asset) {
        this.activeRecordings.delete(id);
        try { fs.unlinkSync(active.temporaryPath); } catch {}
        this.store.patch('recordingJobs', id, {
          status: 'failed',
          endedAt: this.timestamp(),
          error: String(error && error.message || error),
        });
      }
      throw error;
    }
  }
}

module.exports = { StudioManager, publicRecordingJob };
