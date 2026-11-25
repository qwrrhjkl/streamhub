const fs = require('node:fs');
const path = require('node:path');

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const LOG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*\.log(?:-(?:\d{8}T\d{6}Z?)|\.\d+|\.old)?$/;
const PIPELINE_ID = 'pipe-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*';
const DESTINATION_ID = 'dest-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*';

function logError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function formatLocalTimestamp(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function timeRangeLabel(parsed) {
  const start = formatLocalTimestamp(parsed.timestamp);
  const end = parsed.endTimestamp ? formatLocalTimestamp(parsed.endTimestamp) : '';
  return end ? `${start} ~ ${end}` : `${start} ~ 持续推流中`;
}

function timestampFromFilename(value) {
  const match = String(value).match(/(\d{8})T(\d{6})Z$/);
  if (!match) return null;
  const [, date, time] = match;
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T`
    + `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}.000Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseLogFilename(filename) {
  const name = String(filename || '');
  if (!LOG_NAME_PATTERN.test(name)) return null;

  const rotatedMatch = name.match(/^(.*)\.log-(\d{8}T\d{6}Z?)$/);
  const numericRotation = name.match(/^(.*)\.log\.(\d+)$/);
  const oldRotation = name.match(/^(.*)\.log\.old$/);
  const timestampedMatch = name.match(/^(.*?)-(\d{8}T\d{6}Z)(?:~(\d{8}T\d{6}Z))?(?:-part-(\d+))?\.log$/);
  const base = rotatedMatch ? `${rotatedMatch[1]}.log`
    : numericRotation ? `${numericRotation[1]}.log`
      : oldRotation ? `${oldRotation[1]}.log`
        : timestampedMatch ? `${timestampedMatch[1]}.log`
          : name;
  const timestamp = rotatedMatch ? timestampFromFilename(rotatedMatch[2])
    : timestampedMatch ? timestampFromFilename(timestampedMatch[2])
      : null;
  const endTimestamp = timestampedMatch && timestampedMatch[3] ? timestampFromFilename(timestampedMatch[3]) : null;
  const rotation = rotatedMatch ? 'dated'
    : numericRotation ? Number(numericRotation[2])
      : oldRotation ? 'old'
        : null;

  let match = base.match(new RegExp(`^(${PIPELINE_ID})-(${DESTINATION_ID})\\.log$`));
  if (match) return { kind: 'destination', pipelineId: match[1], destinationId: match[2], timestamp, endTimestamp, rotation };
  match = base.match(new RegExp(`^(${PIPELINE_ID})-relay\\.log$`));
  if (match) return { kind: 'relay', pipelineId: match[1], timestamp, endTimestamp, rotation };
  match = base.match(/^preview-([A-Za-z0-9][A-Za-z0-9_-]*)\.log$/);
  if (match) return { kind: 'preview', previewId: `preview-${match[1]}`, timestamp, endTimestamp, rotation };
  match = base.match(/^recording-([A-Za-z0-9][A-Za-z0-9_-]*)\.log$/);
  if (match) return { kind: 'recording', recordingId: `recording-${match[1]}`, timestamp, endTimestamp, rotation };
  if (base === 'nginx-rtmp-access.log') return { kind: 'rtmp-access', timestamp, endTimestamp, rotation, protected: !rotation };
  if (base === 'nginx-rtmp-ingest-access.log') return { kind: 'rtmp-ingest', timestamp, endTimestamp, rotation, protected: !rotation };
  if (base === 'nginx-rtmp-error.log') return { kind: 'rtmp-error', timestamp, endTimestamp, rotation, protected: !rotation };
  return { kind: 'other', baseName: base, timestamp, endTimestamp, rotation };
}

function safeLabel(value, fallback) {
  const label = String(value || '').replace(/\s+/g, ' ').trim();
  if (!label) return fallback;
  return label
    .replace(/(?:rtmp|rtmps|srt|https?|udp|tcp):\/\/[^\s]+/gi, '[已脱敏]')
    .slice(0, 180);
}

function stateIndexes(store) {
  let state = {};
  try { state = store && typeof store.getState === 'function' ? store.getState() : {}; } catch {}
  const index = values => new Map((Array.isArray(values) ? values : []).map(item => [String(item.id), item]));
  return {
    pipelines: index(state.pipelines),
    destinations: index(state.destinations),
    recordings: index(state.recordingJobs),
  };
}

function fallbackEntity(prefix, id) {
  return `已删除${prefix} ${id}`;
}

function describeFile(filename, metadata = {}, store, previewLabel = '') {
  const parsed = parseLogFilename(filename);
  if (!parsed) throw logError('日志文件名无效', 400);
  const timestamp = parsed.timestamp || new Date(Number(metadata.mtimeMs) || 0).toISOString();
  const indexes = stateIndexes(store);
  const pipeline = parsed.pipelineId && indexes.pipelines.get(parsed.pipelineId);
  const pipelineName = safeLabel(pipeline && pipeline.name, fallbackEntity('任务', parsed.pipelineId || ''));
  let displayName;
  if (parsed.kind === 'destination') {
    const destination = indexes.destinations.get(parsed.destinationId);
    displayName = `${pipelineName} / ${safeLabel(destination && destination.name, fallbackEntity('平台', parsed.destinationId))} / ${timeRangeLabel(parsed)}`;
  } else if (parsed.kind === 'relay') {
    displayName = `${pipelineName} / 共享转推 / ${timeRangeLabel(parsed)}`;
  } else if (parsed.kind === 'preview') {
    displayName = `输入预览 / ${safeLabel(previewLabel, `已结束预览 ${parsed.previewId}`)} / ${formatLocalTimestamp(timestamp)}`;
  } else if (parsed.kind === 'recording') {
    const recording = indexes.recordings.get(parsed.recordingId);
    displayName = `录制 / ${safeLabel(recording && recording.name, parsed.recordingId)} / ${formatLocalTimestamp(timestamp)}`;
  } else if (parsed.kind === 'rtmp-ingest') {
    displayName = `RTMP 接入访问 / ${formatLocalTimestamp(timestamp)}`;
  } else if (parsed.kind === 'rtmp-access') {
    displayName = `RTMP 播放访问 / ${formatLocalTimestamp(timestamp)}`;
  } else if (parsed.kind === 'rtmp-error') {
    displayName = `RTMP 服务错误 / ${formatLocalTimestamp(timestamp)}`;
  } else {
    displayName = `系统日志 / ${safeLabel(parsed.baseName, filename)} / ${formatLocalTimestamp(timestamp)}`;
  }
  return {
    file: filename,
    displayName,
    kind: parsed.kind,
    pipelineId: parsed.pipelineId || '',
    destinationId: parsed.destinationId || '',
    timestamp,
    sizeBytes: Number(metadata.sizeBytes) || 0,
    active: Boolean(metadata.active),
    deletable: !metadata.protected && !metadata.active,
  };
}

function sanitizeLogContent(content) {
  return String(content || '').split(/\r?\n/).map(line => {
    if (/^\s*(?:\/[^\s]+\/)?ffmpeg(?:\s|$)/i.test(line)
      || /\bSTART\b.*\b(?:output|pipeline|recording)\b/i.test(line) && /\s-[-\w]/.test(line)) {
      return '[FFmpeg command redacted]';
    }
    return line.replace(/(?:rtmp|rtmps|srt|https?|udp|tcp):\/\/[^\s'"<>]+/gi, '[已脱敏]');
  }).join('\n');
}

function createLogManager({
  rootDir,
  store,
  activeFiles = () => [],
  now = Date.now,
  scheduleInterval = setInterval,
  clearScheduledInterval = clearInterval,
} = {}) {
  const logDir = path.resolve(rootDir || process.cwd(), 'data', 'logs');
  let retentionMs = RETENTION_MS;
  let cleanupTimer = null;
  ensureDirectory(logDir);

  function filePath(filename) {
    if (typeof filename !== 'string' || path.basename(filename) !== filename || !LOG_NAME_PATTERN.test(filename)) {
      throw logError('日志文件名无效', 400);
    }
    const resolved = path.resolve(logDir, filename);
    if (resolved !== path.join(logDir, filename)) throw logError('日志路径无效', 400);
    return resolved;
  }

  function activeSet() {
    let values = [];
    try { values = activeFiles() || []; } catch {}
    return new Set(values.map(value => path.resolve(logDir, path.basename(String(value)))));
  }

  function previewLabel(file) {
    try {
      const prefix = fs.readFileSync(file, 'utf8').slice(0, 4096);
      const match = prefix.match(/(?:^|\n)sourceLabel=([^\r\n]+)/);
      return match ? match[1] : '';
    } catch { return ''; }
  }

  function list() {
    const active = activeSet();
    const entries = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(name => parseLogFilename(name)) : [];
    const result = entries.map(name => {
      const file = path.join(logDir, name);
      const stats = fs.statSync(file);
      const parsed = parseLogFilename(name);
      return describeFile(name, {
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
        active: active.has(path.resolve(file)),
        protected: Boolean(parsed.protected),
      }, store, parsed.kind === 'preview' ? previewLabel(file) : '');
    });
    return result.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || b.file.localeCompare(a.file));
  }

  function read(filename) {
    const file = filePath(filename);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw logError('日志文件不存在', 404);
    return sanitizeLogContent(fs.readFileSync(file, 'utf8').slice(-20000));
  }

  function remove(filename) {
    const file = filePath(filename);
    const parsed = parseLogFilename(filename);
    if (parsed.protected) throw logError('当前 RTMP 基础日志不允许删除', 409);
    if (activeSet().has(path.resolve(file))) throw logError('日志正在使用，无法删除', 409);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw logError('日志文件不存在', 404);
    fs.unlinkSync(file);
    return { ok: true, file: filename };
  }

  function cleanup() {
    const cutoff = Number(now()) - retentionMs;
    const active = activeSet();
    const result = { deleted: [], skippedActive: [], protected: [] };
    const entries = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(name => parseLogFilename(name)) : [];
    for (const name of entries) {
      const file = path.join(logDir, name);
      const parsed = parseLogFilename(name);
      const stats = fs.statSync(file);
      if (parsed.protected) { result.protected.push(name); continue; }
      if (active.has(path.resolve(file))) { result.skippedActive.push(name); continue; }
      if (stats.mtimeMs < cutoff) {
        try { fs.unlinkSync(file); result.deleted.push(name); } catch {}
      }
    }
    result.deleted.sort();
    result.skippedActive.sort();
    result.protected.sort();
    return result;
  }

  return {
    logDir,
    list,
    read,
    delete: remove,
    cleanup,
    start() {
      if (cleanupTimer) return cleanupTimer;
      cleanup();
      cleanupTimer = scheduleInterval(cleanup, CLEANUP_INTERVAL_MS);
      if (cleanupTimer && typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
      return cleanupTimer;
    },
    stop() {
      if (!cleanupTimer) return;
      clearScheduledInterval(cleanupTimer);
      cleanupTimer = null;
    },
    getActiveFiles: activeSet,
    describeFile: (name, metadata) => describeFile(name, metadata, store),
    setRetentionDays(days) {
      const value = Number(days);
      if (!Number.isInteger(value) || value < 1 || value > 90) throw logError('日志保留时间须为 1 至 90 天', 400);
      retentionMs = value * 24 * 60 * 60 * 1000;
      return value;
    },
    getRetentionDays() { return Math.round(retentionMs / (24 * 60 * 60 * 1000)); },
  };
}

module.exports = {
  CLEANUP_INTERVAL_MS,
  RETENTION_MS,
  createLogManager,
  describeFile,
  parseLogFilename,
  sanitizeLogContent,
};
