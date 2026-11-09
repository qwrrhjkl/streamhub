const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MonitorHistoryStore,
  HISTORY_RETENTION_MS,
  downsample,
} = require('../server/lib/monitorHistoryStore');

const REMOVED_STALL_KEYS = [
  'encoderDuplicatedFrames',
  'encoderDroppedFrames',
  'encoderFrame',
  'videoStallDelta',
  'videoStallFrames',
  'videoStallRatePercent',
  'recentVideoStallFrames',
  'recentVideoStallRatePercent',
];

function createRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-history-'));
}

function historyFiles(rootDir) {
  const historyDir = path.join(rootDir, 'data', 'monitor-history');
  if (!fs.existsSync(historyDir)) return [];
  return fs.readdirSync(historyDir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => path.join(entry.parentPath || entry.path, entry.name));
}

test('monitor history survives a store restart and enforces the 72 hour boundary', () => {
  const rootDir = createRoot();
  const now = Date.UTC(2026, 6, 24, 12, 0, 0);
  const store = new MonitorHistoryStore({ rootDir });

  store.append('pipe-a-dest-a', { time: now - HISTORY_RETENTION_MS - 1000, bitrateKbps: 1000, fps: 30 });
  store.append('pipe-a-dest-a', { time: now - 60_000, bitrateKbps: 4200, fps: 30 });
  store.append('pipe-a-dest-a', { time: now, bitrateKbps: 4300, fps: 30 });

  const reloaded = new MonitorHistoryStore({ rootDir });
  const history = reloaded.query('pipe-a-dest-a', {
    now,
    from: now - HISTORY_RETENTION_MS - 60_000,
    to: now + 60_000,
  });

  assert.deepEqual(history.map(point => point.bitrateKbps), [4200, 4300]);
  assert.equal(history.every(point => point.time >= now - HISTORY_RETENTION_MS && point.time <= now), true);
});

test('monitor history ignores a malformed trailing JSONL row', () => {
  const rootDir = createRoot();
  const now = Date.UTC(2026, 6, 24, 12, 0, 0);
  const store = new MonitorHistoryStore({ rootDir });
  store.append('pipe-a-dest-a', { time: now - 1000, bitrateKbps: 4200, fps: 30 });

  const [file] = historyFiles(rootDir);
  assert.ok(file, 'history file should exist after append');
  fs.appendFileSync(file, '{"time":', 'utf8');

  const history = new MonitorHistoryStore({ rootDir }).query('pipe-a-dest-a', { now, rangeSec: 60 });
  assert.deepEqual(history.map(point => point.bitrateKbps), [4200]);
});

test('monitor history invalidates cached output queries after append', () => {
  const rootDir = createRoot();
  const now = Date.UTC(2026, 6, 24, 12, 0, 0);
  const store = new MonitorHistoryStore({ rootDir });
  store.append('pipe-a-dest-a', { time: now - 1000, bitrateKbps: 4200 });

  assert.deepEqual(store.query('pipe-a-dest-a', { now, rangeSec: 60 }).map(point => point.bitrateKbps), [4200]);
  store.append('pipe-a-dest-a', { time: now, bitrateKbps: 4300 });

  assert.deepEqual(store.query('pipe-a-dest-a', { now, rangeSec: 60 }).map(point => point.bitrateKbps), [4200, 4300]);
});

test('monitor history omits legacy derived video-stall metrics', () => {
  const rootDir = createRoot();
  const now = Date.UTC(2026, 6, 24, 12, 0, 0);
  const store = new MonitorHistoryStore({ rootDir });
  store.append('pipe-a-dest-a', {
    time: now,
    bitrateKbps: 4200,
    fps: 30,
    networkDroppedFrames: 12,
    encoderDuplicatedFrames: 8,
    encoderDroppedFrames: 4,
    encoderFrame: 120,
    videoStallDelta: 1,
    videoStallFrames: 4,
    videoStallRatePercent: 2.5,
    recentVideoStallFrames: 2,
    recentVideoStallRatePercent: 1.25,
  });

  const [point] = store.query('pipe-a-dest-a', { now, rangeSec: 60 });
  assert.equal(point.bitrateKbps, 4200);
  assert.equal(point.networkDroppedFrames, 12);
  for (const key of REMOVED_STALL_KEYS) assert.equal(Object.hasOwn(point, key), false);
});

test('monitor history downsamples responses without removing raw records', () => {
  const rootDir = createRoot();
  const now = Date.UTC(2026, 6, 24, 12, 0, 0);
  const store = new MonitorHistoryStore({ rootDir });

  for (let index = 0; index < 1505; index += 1) {
    store.append('pipe-a-dest-a', {
      time: now - 1504_000 + index * 1000,
      bitrateKbps: 4000 + index,
      fps: 30,
      droppedFrames: index,
    });
  }

  const history = store.query('pipe-a-dest-a', { now, rangeSec: 2000, maxPoints: 1200 });
  const rawLineCount = historyFiles(rootDir)
    .flatMap(file => fs.readFileSync(file, 'utf8').trim().split('\n'))
    .filter(Boolean).length;

  assert.ok(history.length <= 1200);
  assert.equal(history[0].time, now - 1504_000);
  assert.equal(history.at(-1).time, now);
  assert.equal(rawLineCount, 1505);
});

test('monitor history downsampling preserves unavailable bitrate instead of averaging it as zero', () => {
  const points = [
    { time: 0, bitrateKbps: 100, actualBitrateAvailable: true },
    { time: 1000, bitrateKbps: null, actualBitrateAvailable: false },
    { time: 2000, bitrateKbps: 200, actualBitrateAvailable: true },
    { time: 3000, bitrateKbps: null, actualBitrateAvailable: false },
    { time: 4000, bitrateKbps: null, actualBitrateAvailable: false },
    { time: 5000, bitrateKbps: 300, actualBitrateAvailable: true },
  ];

  const sampled = downsample(points, 4);

  assert.equal(sampled[1].bitrateKbps, 200);
  assert.equal(sampled[2].bitrateKbps, null);
  assert.deepEqual(sampled.map(point => point.time), [0, 2000, 4000, 5000]);
});

test('monitor history rejects reversed exact ranges', () => {
  const store = new MonitorHistoryStore({ rootDir: createRoot() });
  assert.throws(
    () => store.query('pipe-a-dest-a', { now: 20_000, from: 15_000, to: 10_000 }),
    /结束时间不能早于开始时间/,
  );
});

test('monitor history removes fully expired date directories on startup', () => {
  const rootDir = createRoot();
  const expiredDir = path.join(rootDir, 'data', 'monitor-history', '2020-01-01');
  fs.mkdirSync(expiredDir, { recursive: true });
  fs.writeFileSync(path.join(expiredDir, 'expired.jsonl'), '{"time":1}\n', 'utf8');

  new MonitorHistoryStore({ rootDir });

  assert.equal(fs.existsSync(expiredDir), false);
});
