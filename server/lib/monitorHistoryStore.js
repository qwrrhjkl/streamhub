const fs = require('node:fs');
const path = require('node:path');

const HISTORY_RETENTION_MS = 72 * 60 * 60 * 1000;
const DEFAULT_MAX_POINTS = 1200;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const REMOVED_MONITOR_KEYS = new Set([
  'encoderDuplicatedFrames',
  'encoderDroppedFrames',
  'encoderFrame',
  'videoStallDelta',
  'videoStallFrames',
  'videoStallRatePercent',
  'recentVideoStallFrames',
  'recentVideoStallRatePercent',
]);
const PUBLIC_HISTORY_KEYS = [
  'time',
  'bitrateKbps',
  'actualBitrateAvailable',
  'actualBitrateStatus',
  'fps',
  'measuredFps',
];
const RETAINED_MONITOR_KEYS = [
  'encodingMode',
  'speed',
  'targetFps',
  'totalDroppedFrames',
  'droppedFrames',
  'totalDropRatePercent',
  'dropRatePercent',
  'dropMetricVersion',
  'processSessionId',
  'networkDroppedFrames',
  'networkExpectedFrames',
  'deliveredFrames',
  'networkDropAvailable',
  'networkLossActive',
];

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function dateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dateKeysBetween(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const keys = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);
  while (cursor <= end) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

function encodedOutputId(outputId) {
  return Buffer.from(String(outputId || ''), 'utf8').toString('base64url');
}

function averageBucket(points) {
  if (points.length === 1) return { ...points[0] };
  const result = { ...points.at(-1) };
  const isPresentNumber = value => (
    value !== null &&
    value !== undefined &&
    value !== '' &&
    typeof value !== 'boolean' &&
    Number.isFinite(Number(value))
  );
  const numericKeys = new Set(points.flatMap(point => (
    Object.keys(point).filter(key => key !== 'time' && isPresentNumber(point[key]))
  )));
  for (const key of numericKeys) {
    const values = points.map(point => point[key]).filter(isPresentNumber).map(Number);
    if (values.length) result[key] = values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  result.time = points[Math.floor(points.length / 2)].time;
  return result;
}

function downsample(points, maxPoints) {
  const limit = Math.max(2, Math.floor(Number(maxPoints) || DEFAULT_MAX_POINTS));
  if (points.length <= limit) return points.map(point => ({ ...point }));
  const bucketCount = limit - 2;
  const middle = points.slice(1, -1);
  const sampled = [{ ...points[0] }];
  for (let index = 0; index < bucketCount; index += 1) {
    const start = Math.floor(index * middle.length / bucketCount);
    const end = Math.floor((index + 1) * middle.length / bucketCount);
    sampled.push(averageBucket(middle.slice(start, Math.max(start + 1, end))));
  }
  sampled.push({ ...points.at(-1) });
  return sampled;
}

function sanitizeMonitorPoint(point) {
  const result = { ...(point || {}) };
  for (const key of REMOVED_MONITOR_KEYS) delete result[key];
  return result;
}

function pickMonitorFields(point, keys) {
  if (!point || typeof point !== 'object') return null;
  const result = {};
  for (const key of keys) {
    if (point[key] !== undefined) result[key] = point[key];
  }
  return result;
}

function projectMonitorHistoryPoint(point) {
  const result = pickMonitorFields(point, PUBLIC_HISTORY_KEYS);
  const time = Number(result && result.time);
  if (!result || !Number.isFinite(time)) return null;
  result.time = time;
  return result;
}

function projectRetainedMonitorPoint(point) {
  const result = pickMonitorFields(point, RETAINED_MONITOR_KEYS);
  return result && Object.keys(result).length ? result : null;
}

class MonitorHistoryStore {
  constructor({ rootDir, retentionMs = HISTORY_RETENTION_MS, maxPoints = DEFAULT_MAX_POINTS, logger = console }) {
    this.rootDir = path.resolve(rootDir);
    this.historyDir = path.join(this.rootDir, 'data', 'monitor-history');
    this.retentionMs = retentionMs;
    this.maxPoints = maxPoints;
    this.logger = logger;
    this.responseCache = new Map();
    ensureDir(this.historyDir);
    this.cleanup(Date.now());
    this.lastCleanupAt = Date.now();
  }

  fileFor(outputId, timestamp) {
    const directory = path.join(this.historyDir, dateKey(timestamp));
    const file = path.join(directory, `${encodedOutputId(outputId)}.jsonl`);
    const relative = path.relative(this.historyDir, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid monitor history path');
    return { directory, file };
  }

  append(outputId, point) {
    const timestamp = Number(point && point.time);
    if (!outputId || !Number.isFinite(timestamp)) return false;
    const normalized = { ...point, time: timestamp };
    const { directory, file } = this.fileFor(outputId, timestamp);
    try {
      ensureDir(directory);
      fs.appendFileSync(file, `${JSON.stringify(normalized)}\n`, 'utf8');
      for (const key of this.responseCache.keys()) {
        if (key.startsWith(`${outputId}:`)) this.responseCache.delete(key);
      }
      const now = Date.now();
      if (now - this.lastCleanupAt >= CLEANUP_INTERVAL_MS) {
        this.cleanup(now);
        this.lastCleanupAt = now;
      }
      return true;
    } catch (error) {
      this.logger.error(`Monitor history append failed for ${outputId}: ${error.message}`);
      return false;
    }
  }

  normalizeRange({ now = Date.now(), rangeSec = 900, from, to } = {}) {
    const current = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const hasFrom = Number.isFinite(Number(from));
    const hasTo = Number.isFinite(Number(to));
    if (hasFrom && hasTo && Number(to) < Number(from)) throw new Error('结束时间不能早于开始时间');
    const retentionStart = current - this.retentionMs;
    const requestedFrom = hasFrom
      ? Number(from)
      : current - Math.max(0, Number(rangeSec) || 900) * 1000;
    const requestedTo = hasTo ? Number(to) : current;
    return {
      now: current,
      from: Math.max(retentionStart, requestedFrom),
      to: Math.min(current, requestedTo),
    };
  }

  readFile(file, outputId) {
    try {
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap(line => {
          try {
            const point = JSON.parse(line);
            return Number.isFinite(Number(point.time)) ? [{ ...point, time: Number(point.time) }] : [];
          } catch {
            return [];
          }
        });
    } catch (error) {
      this.logger.error(`Monitor history read failed for ${outputId}: ${error.message}`);
      return [];
    }
  }

  query(outputId, options = {}) {
    if (!outputId) return [];
    const range = this.normalizeRange(options);
    if (range.to < range.from) return [];
    const maxPoints = options.maxPoints || this.maxPoints;
    const exact = Number.isFinite(Number(options.from)) && Number.isFinite(Number(options.to));
    const cacheKey = exact
      ? `${outputId}:exact:${range.from}:${range.to}:${maxPoints}`
      : `${outputId}:rolling:${Number(options.rangeSec) || 900}:${maxPoints}`;
    const cached = this.responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.points.map(sanitizeMonitorPoint);
    const pointsByTime = new Map();
    for (const key of dateKeysBetween(range.from, range.to)) {
      const { file } = this.fileFor(outputId, Date.parse(`${key}T00:00:00.000Z`));
      for (const point of this.readFile(file, outputId)) {
        if (point.time >= range.from && point.time <= range.to) pointsByTime.set(point.time, point);
      }
    }
    const points = Array.from(pointsByTime.values()).sort((left, right) => left.time - right.time);
    const sampled = downsample(points, maxPoints);
    const ttlMs = range.to - range.from >= 60 * 60 * 1000 ? 15_000 : 3_000;
    this.responseCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, points: sampled });
    while (this.responseCache.size > 50) this.responseCache.delete(this.responseCache.keys().next().value);
    return sampled.map(sanitizeMonitorPoint);
  }

  hasHistory(outputId, options = {}) {
    return this.query(outputId, { ...options, maxPoints: 2 }).length > 0;
  }

  cleanup(now = Date.now()) {
    const cutoff = Number(now) - this.retentionMs;
    try {
      for (const entry of fs.readdirSync(this.historyDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
        const endOfDay = Date.parse(`${entry.name}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
        if (endOfDay <= cutoff) fs.rmSync(path.join(this.historyDir, entry.name), { recursive: true, force: true });
      }
      return true;
    } catch (error) {
      this.logger.error(`Monitor history cleanup failed: ${error.message}`);
      return false;
    }
  }
}

module.exports = {
  MonitorHistoryStore,
  HISTORY_RETENTION_MS,
  DEFAULT_MAX_POINTS,
  downsample,
  sanitizeMonitorPoint,
  projectMonitorHistoryPoint,
  projectRetainedMonitorPoint,
};
