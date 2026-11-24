const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { StreamHubStore, defaultState } = require('../server/lib/store');
const { createRoomRecord } = require('../server/lib/rooms');

test('defaultState is a clean version 7 deployment on RTMP port 1935', () => {
  const state = defaultState();

  assert.equal(state.version, 7);
  assert.equal(state.settings.rtmpPort, 1935);
  assert.equal(state.settings.logRetentionDays, 7);
  assert.equal(state.settings.recordingRetentionDays, 30);
  assert.deepEqual(state.rooms, []);
  assert.deepEqual(state.sources, []);
  assert.deepEqual(state.destinations, []);
  assert.deepEqual(state.pipelines, []);
  assert.deepEqual(state.pipelineRuns, []);
  assert.deepEqual(state.monitorDisplay, { dropBaselines: {} });
});

test('StreamHubStore persists room names secrets and settings across reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-store-'));
  try {
    const store = new StreamHubStore(dir);
    const room = store.create('rooms', createRoomRecord({
      name: '自定义直播间',
      streamName: 'custom-room',
      publishSecret: 'secret123',
      settings: {
        live: { bitrateKbps: 9000 },
        video: { outputResolution: '1920x1080', fps: '60' },
      },
    }), 'room');

    const reloaded = new StreamHubStore(dir);
    const saved = reloaded.getState().rooms.find(item => item.id === room.id);

    assert.equal(saved.name, '自定义直播间');
    assert.equal(saved.streamName, 'custom-room');
    assert.equal(saved.publishSecret, 'secret123');
    assert.equal(saved.settings.live.bitrateKbps, 9000);
    assert.equal(saved.settings.video.fps, '60');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamHubStore migrates old state to version 7 without injecting demo data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-migrate-'));
  try {
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 1,
      settings: { webPort: 18080 },
      rooms: [],
      sources: [],
      destinations: [{ id: 'dest-user', name: '用户平台', protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'abc', enabled: true }],
      pipelines: [],
    }, null, 2));

    const store = new StreamHubStore(dir);
    const migrated = store.getState();

    assert.equal(migrated.version, 7);
    assert.deepEqual(migrated.pipelineRuns, []);
    assert.equal(migrated.settings.logRetentionDays, 7);
    assert.equal(migrated.settings.recordingRetentionDays, 30);
    assert.deepEqual(migrated.rooms, []);
    assert.equal(migrated.destinations.length, 1);
    assert.equal(migrated.destinations.some(item => item.id === 'dest-user'), true);

    const reloaded = new StreamHubStore(dir).getState();
    assert.equal(reloaded.destinations.filter(item => item.id === 'dest-user').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamHubStore preserves an explicit copy encoder while migrating version 2 state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-migrate-transcode-'));
  try {
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 2,
      settings: { webPort: 18080 },
      rooms: [],
      sources: [],
      destinations: [],
      pipelines: [{
        id: 'pipe-legacy',
        name: '旧版任务',
        enabled: true,
        status: 'stopped',
        settings: {
          live: {
            videoEncoder: 'copy',
            audioEncoder: 'aac',
            bitrateKbps: 6000,
            keyframeSec: 2,
            preset: 'veryfast',
            profile: 'high',
          },
          video: {
            outputResolution: '1920x1080',
            fps: '30',
          },
          audio: {
            sampleRate: '48000',
            channels: 'stereo',
            tracks: [{ bitrateKbps: 320 }],
          },
        },
      }],
    }, null, 2));

    const store = new StreamHubStore(dir);
    const migrated = store.getState();

    assert.equal(migrated.version, 7);
    assert.equal(migrated.pipelines[0].settings.live.videoEncoder, 'copy');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamHubStore preserves explicit copy and libx264 encoders while migrating version 3 state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-migrate-v3-explicit-'));
  try {
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 3,
      settings: { webPort: 18080 },
      rooms: [],
      sources: [],
      destinations: [],
      pipelines: [
        { id: 'pipe-copy', settings: { live: { videoEncoder: 'copy' } } },
        { id: 'pipe-libx264', settings: { live: { videoEncoder: 'libx264' } } },
      ],
    }, null, 2));

    const migrated = new StreamHubStore(dir).getState();

    assert.equal(migrated.version, 7);
    assert.deepEqual(
      migrated.pipelines.map(pipeline => pipeline.settings.live.videoEncoder),
      ['copy', 'libx264'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamHubStore gives legacy version 3 pipelines without an encoder the libx264 runtime fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-migrate-v3-missing-'));
  try {
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 3,
      settings: { webPort: 18080 },
      rooms: [],
      sources: [],
      destinations: [],
      pipelines: [{ id: 'pipe-missing', settings: { live: { bitrateKbps: 6000 } } }],
    }, null, 2));

    const migrated = new StreamHubStore(dir).getState();

    assert.equal(migrated.version, 7);
    assert.equal(migrated.pipelines[0].settings.live.videoEncoder, 'libx264');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamHubStore preserves unknown settings fields through version 3 migration and disk reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-migrate-v3-unknown-settings-'));
  try {
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const settings = {
      vendorBlock: { mode: 'future', nested: { enabled: true } },
      live: { videoEncoder: 'copy', vendorTune: 'quality' },
      slideshow: { images: [], futureTransition: 'radial', extension: { amount: 3 } },
    };
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 3,
      settings: { webPort: 18080 },
      rooms: [],
      sources: [],
      destinations: [],
      pipelines: [{ id: 'pipe-unknown', settings }],
    }, null, 2));

    const migrated = new StreamHubStore(dir).getState();
    const reloaded = new StreamHubStore(dir).getState();

    assert.deepEqual(migrated.pipelines[0].settings, settings);
    assert.deepEqual(reloaded.pipelines[0].settings, settings);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamHubStore preserves non-object settings containers through migration and disk reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-migrate-v3-invalid-containers-'));
  try {
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const pipelines = [
      { id: 'pipe-string-settings', settings: 'keep-me' },
      { id: 'pipe-array-live', settings: { live: ['keep'], vendorBlock: { preserve: true } } },
    ];
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 3,
      settings: { webPort: 18080 },
      rooms: [],
      sources: [],
      destinations: [],
      pipelines,
    }, null, 2));

    const migrated = new StreamHubStore(dir).getState();
    const reloaded = new StreamHubStore(dir).getState();

    assert.equal(migrated.version, 7);
    assert.deepEqual(migrated.pipelines, pipelines);
    assert.deepEqual(reloaded.pipelines, pipelines);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamHubStore preserves every explicit encoder value during migration and disk reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-migrate-v3-explicit-values-'));
  try {
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const explicitValues = ['', '   ', 42, { codec: 'future' }, 'future_encoder'];
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 3,
      settings: { webPort: 18080 },
      rooms: [],
      sources: [],
      destinations: [],
      pipelines: explicitValues.map((videoEncoder, index) => ({
        id: `pipe-explicit-${index}`,
        settings: { live: { videoEncoder } },
      })),
    }, null, 2));

    const migrated = new StreamHubStore(dir).getState();
    const reloaded = new StreamHubStore(dir).getState();

    assert.deepEqual(
      migrated.pipelines.map(pipeline => pipeline.settings.live.videoEncoder),
      explicitValues,
    );
    assert.deepEqual(
      reloaded.pipelines.map(pipeline => pipeline.settings.live.videoEncoder),
      explicitValues,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamHubStore recovers invalid and nonpositive versions as legacy version 1 state', () => {
  for (const invalidVersion of ['broken', 0, -1]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-migrate-invalid-version-'));
    try {
      const dataDir = path.join(dir, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      const pipeline = {
        id: `pipe-${String(invalidVersion)}`,
        settings: {
          vendorBlock: { preserve: true },
          live: { videoEncoder: 'copy', vendorTune: 'future' },
        },
      };
      fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
        version: invalidVersion,
        settings: { webPort: 18080 },
        rooms: [],
        sources: [],
        destinations: [],
        pipelines: [pipeline],
      }, null, 2));

      const migrated = new StreamHubStore(dir).getState();

      assert.equal(migrated.version, 7);
      assert.deepEqual(migrated.rooms, []);
      assert.deepEqual(migrated.destinations, []);
      assert.deepEqual(migrated.pipelines[0], pipeline);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('StreamHubStore preserves an explicit h264_nvenc encoder during version 4 migration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-migrate-v4-nvenc-'));
  try {
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 3,
      settings: { webPort: 18080 },
      rooms: [],
      sources: [],
      destinations: [],
      pipelines: [{ id: 'pipe-nvenc', settings: { live: { videoEncoder: 'h264_nvenc' } } }],
    }, null, 2));

    const migrated = new StreamHubStore(dir).getState();

    assert.equal(migrated.version, 7);
    assert.equal(migrated.pipelines[0].settings.live.videoEncoder, 'h264_nvenc');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamHubStore migrates version 6 state once without rewriting encoder values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-reload-v4-'));
  try {
    const dataDir = path.join(dir, 'data');
    const statePath = path.join(dataDir, 'state.json');
    fs.mkdirSync(dataDir, { recursive: true });
    const serialized = `${JSON.stringify({
      version: 6,
      updatedAt: '2026-07-25T00:00:00.000Z',
      settings: { webPort: 18080 },
      rooms: [],
      sources: [],
      destinations: [],
      pipelines: [{ id: 'pipe-v4', settings: { live: { videoEncoder: 'copy' } } }],
    }, null, 2)}\n`;
    fs.writeFileSync(statePath, serialized);

    const firstReload = new StreamHubStore(dir).getState();
    const migratedSerialized = fs.readFileSync(statePath, 'utf8');
    const secondReload = new StreamHubStore(dir).getState();

    assert.equal(firstReload.version, 7);
    assert.equal(firstReload.settings.logRetentionDays, 7);
    assert.equal(firstReload.settings.recordingRetentionDays, 30);
    assert.equal(firstReload.pipelines[0].settings.live.videoEncoder, 'copy');
    assert.equal(secondReload.pipelines[0].settings.live.videoEncoder, 'copy');
    assert.notEqual(migratedSerialized, serialized);
    assert.equal(fs.readFileSync(statePath, 'utf8'), migratedSerialized);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamHubStore leaves future finite state versions untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-reload-future-version-'));
  try {
    const dataDir = path.join(dir, 'data');
    const statePath = path.join(dataDir, 'state.json');
    fs.mkdirSync(dataDir, { recursive: true });
    const pipeline = {
      id: 'pipe-future',
      settings: { vendorBlock: { version: 5 }, live: { vendorTune: 'future' } },
    };
    const serialized = `${JSON.stringify({
      version: 8,
      updatedAt: '2026-07-25T00:00:00.000Z',
      settings: { webPort: 18080 },
      monitorDisplay: { dropBaselines: {}, futurePanel: { enabled: true } },
      rooms: [],
      sources: [],
      destinations: [],
      pipelines: [pipeline],
    }, null, 2)}\n`;
    fs.writeFileSync(statePath, serialized);

    const loaded = new StreamHubStore(dir).getState();

    assert.equal(loaded.version, 8);
    assert.deepEqual(loaded.pipelines[0], pipeline);
    assert.deepEqual(loaded.monitorDisplay.futurePanel, { enabled: true });
    assert.equal(fs.readFileSync(statePath, 'utf8'), serialized);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamHubStore adds empty monitor display baselines without replacing existing pipelines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-monitor-display-'));
  try {
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 3,
      settings: { webPort: 18080 },
      rooms: [],
      sources: [],
      destinations: [],
      pipelines: [{ id: 'pipe-existing', name: 'Existing', settings: {} }],
    }, null, 2));

    const reloaded = new StreamHubStore(dir).getState();

    assert.deepEqual(reloaded.monitorDisplay, { dropBaselines: {} });
    assert.equal(reloaded.pipelines[0].id, 'pipe-existing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamHubStore resets only transient pipeline states after a service restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-restart-status-'));
  try {
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 5,
      settings: { webPort: 18080 },
      rooms: [],
      sources: [],
      destinations: [],
      pipelines: [
        { id: 'pipe-running', status: 'running' },
        { id: 'pipe-starting', status: 'starting' },
        { id: 'pipe-fallback', status: 'fallback' },
        { id: 'pipe-draining', status: 'draining' },
        { id: 'pipe-error', status: 'error' },
        { id: 'pipe-stopped', status: 'stopped' },
      ],
    }, null, 2));
    const store = new StreamHubStore(dir);

    const resetIds = store.resetTransientPipelineStatuses();

    assert.deepEqual(resetIds, ['pipe-running', 'pipe-starting', 'pipe-fallback', 'pipe-draining']);
    assert.deepEqual(store.getState().pipelines.map(pipeline => pipeline.status), [
      'stopped', 'stopped', 'stopped', 'stopped', 'error', 'stopped',
    ]);
    assert.deepEqual(new StreamHubStore(dir).getState().pipelines.map(pipeline => pipeline.status), [
      'stopped', 'stopped', 'stopped', 'stopped', 'error', 'stopped',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamHubStore strips removed fields from version 4 monitor display baselines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-monitor-baseline-v3-'));
  try {
    const baseline = {
      resetAt: 1000,
      processSessionId: 'session-a',
      networkDroppedFrames: 40,
      networkExpectedFrames: 60,
      videoStallFrames: 6,
      encoderFrame: 60,
      encoderDroppedFrames: 1,
    };
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 4,
      settings: { webPort: 18080 },
      monitorDisplay: {
        dropBaselines: { 'pipe-a-dest-a': baseline },
        futurePanel: { density: 'compact' },
      },
      rooms: [],
      sources: [],
      destinations: [],
      pipelines: [],
    }, null, 2));

    const reloaded = new StreamHubStore(dir).getState();
    const secondReload = new StreamHubStore(dir).getState();
    assert.equal(reloaded.version, 7);
    assert.deepEqual(reloaded.monitorDisplay.dropBaselines['pipe-a-dest-a'], {
      resetAt: 1000,
      processSessionId: 'session-a',
      networkDroppedFrames: 40,
      networkExpectedFrames: 60,
    });
    assert.deepEqual(reloaded.monitorDisplay.futurePanel, { density: 'compact' });
    assert.deepEqual(secondReload.monitorDisplay, reloaded.monitorDisplay);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('StreamHubStore rejects array monitor baselines while preserving monitor extensions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-monitor-baseline-array-'));
  try {
    const dataDir = path.join(dir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
      version: 3,
      settings: { webPort: 18080 },
      monitorDisplay: {
        dropBaselines: [{ resetAt: 1000 }],
        futurePanel: { density: 'expanded' },
      },
      rooms: [],
      sources: [],
      destinations: [],
      pipelines: [],
    }, null, 2));

    const migrated = new StreamHubStore(dir).getState();
    const reloaded = new StreamHubStore(dir).getState();

    assert.deepEqual(migrated.monitorDisplay.dropBaselines, {});
    assert.deepEqual(migrated.monitorDisplay.futurePanel, { density: 'expanded' });
    assert.deepEqual(reloaded.monitorDisplay, migrated.monitorDisplay);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
