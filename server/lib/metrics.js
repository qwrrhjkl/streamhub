function parseFirstNumber(pattern, line) {
  const match = String(line || '').match(pattern);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function parseMediaTimeSeconds(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return undefined;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseFloat(match[3]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return undefined;
  return hours * 3600 + minutes * 60 + seconds;
}

function createFFmpegProgressAccumulator() {
  let pending = '';
  return {
    push(chunk) {
      pending += String(chunk || '');
      const records = [];
      let start = 0;
      const separator = /[\r\n]+/g;
      let match;
      while ((match = separator.exec(pending)) !== null) {
        const record = pending.slice(start, match.index);
        if (record) records.push(record);
        start = separator.lastIndex;
      }
      pending = pending.slice(start);
      return records;
    },
    flush() {
      const record = pending;
      pending = '';
      return record ? [record] : [];
    },
  };
}

function parseFFmpegStatsLine(line) {
  const raw = String(line || '');
  const progress = raw.split(/\r/).filter(part => /(?:frame|size)=/.test(part)).at(-1) || raw;
  const text = progress.replace(/\r/g, ' ');
  const result = {};
  const frame = parseFirstNumber(/frame=\s*([0-9]+)/, text);
  const fps = parseFirstNumber(/fps=\s*([0-9.]+)/, text);
  const dup = parseFirstNumber(/dup=\s*([0-9]+)/, text);
  const drop = parseFirstNumber(/drop=\s*([0-9]+)/, text);
  const speed = parseFirstNumber(/speed=\s*([0-9.]+)x/, text);
  const time = text.match(/time=\s*([^\s]+)/);
  const bitrate = text.match(/bitrate=\s*([0-9.]+)\s*([kKmM])?bits\/s/);
  const size = text.match(/size=\s*([0-9.]+)\s*([kKmMgG]?B)\b/);

  if (frame !== undefined) result.frame = frame;
  if (fps !== undefined) result.fps = fps;
  if (dup !== undefined) result.dup = dup;
  if (drop !== undefined) result.drop = drop;
  if (speed !== undefined) result.speed = speed;
  if (time) {
    result.time = time[1];
    const timeSec = parseMediaTimeSeconds(time[1]);
    if (timeSec !== undefined) result.timeSec = timeSec;
  }
  if (bitrate) {
    const raw = Number.parseFloat(bitrate[1]);
    result.bitrateKbps = bitrate[2] && bitrate[2].toLowerCase() === 'm' ? raw * 1000 : raw;
  }
  if (size) {
    const raw = Number.parseFloat(size[1]);
    const unit = size[2].toLowerCase();
    const multiplier = unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
    result.sizeBytes = raw * multiplier;
  }

  if (!Object.keys(result).length) return null;
  return result;
}

function isRelayTransportWarning(role, args, line) {
  const readsLocalRelay = role === 'output' && (args || []).some(arg => /^udp:\/\/127\.0\.0\.1:\d+/.test(String(arg)));
  return readsLocalRelay && /circular buffer overrun|packet corrupt|corrupt input packet/i.test(String(line || ''));
}

function parseFFmpegStreamInfoLine(line) {
  const text = String(line || '');
  if (!/\bStream #\d+:\d+/.test(text)) return null;
  const typeMatch = text.match(/\b(Video|Audio):/i);
  if (!typeMatch) return null;

  const result = { type: typeMatch[1].toLowerCase() };
  const bitrate = text.match(/,\s*([0-9.]+)\s*kb\/s\b/i);
  const fps = text.match(/,\s*([0-9.]+)\s*fps\b/i);

  if (bitrate) {
    const value = Number.parseFloat(bitrate[1]);
    if (Number.isFinite(value)) result.bitrateKbps = value;
  }
  if (fps) {
    const value = Number.parseFloat(fps[1]);
    if (Number.isFinite(value)) result.fps = value;
  }

  return Object.keys(result).length > 1 ? result : null;
}

function updateDropRate(previous, current) {
  const prev = previous || {};
  const next = { ...(current || {}) };
  const frameDelta = Math.max(0, (next.frame || 0) - (prev.frame || 0));
  const dropDelta = Math.max(0, (next.drop || 0) - (prev.drop || 0));
  const total = frameDelta + dropDelta;
  next.frameDelta = frameDelta;
  next.dropDelta = dropDelta;
  next.dropRatePercent = total > 0 ? (dropDelta / total) * 100 : 0;
  return next;
}

function mergeFFmpegProgressSnapshot(previous, parsed, metadata = {}) {
  return updateDropRate(previous, {
    ...(parsed || {}),
    ...(metadata || {}),
  });
}

function secondsToHuman(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function isReportableFFmpegError(role, args, line) {
  const text = String(line || '');
  if (!/error|failed|invalid|refused|timeout|Packet corrupt|concealing \d+ DC|non-existing PPS|no frame!/i.test(text)) return false;
  const readsLocalRelay = role === 'output' && (args || []).some(arg => /^udp:\/\/127\.0\.0\.1:\d+/.test(String(arg)));
  if (readsLocalRelay && /decode_slice_header error|non-existing PPS|no frame!/i.test(text)) return false;
  return true;
}

module.exports = {
  createFFmpegProgressAccumulator,
  parseFFmpegStatsLine,
  parseFFmpegStreamInfoLine,
  parseMediaTimeSeconds,
  updateDropRate,
  mergeFFmpegProgressSnapshot,
  secondsToHuman,
  isReportableFFmpegError,
  isRelayTransportWarning,
};
