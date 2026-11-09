const { mergeSettings } = require('./ffmpegBuilder');

const REPORT_PAGE_LIMIT = 5;
const PAGE_WIDTH = 596;
const PAGE_HEIGHT = 842;
const PAGE_MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const ACTIVE_OUTPUT_STATUSES = new Set(['running', 'starting', 'fallback', 'draining']);

const COLORS = Object.freeze({
  navy: [0.05, 0.2, 0.32],
  cyan: [0.13, 0.57, 0.68],
  ink: [0.08, 0.13, 0.18],
  muted: [0.36, 0.43, 0.49],
  pale: [0.94, 0.97, 0.98],
  line: [0.78, 0.84, 0.88],
  white: [1, 1, 1],
  green: [0.08, 0.45, 0.27],
  amber: [0.72, 0.42, 0.04],
  red: [0.72, 0.12, 0.12],
});

function sanitizeReportText(value) {
  return String(value ?? '')
    .replace(/(?:rtmp|rtmps|srt|https?|udp|tcp):\/\/[^\s'"<>]+/gi, '[redacted-url]')
    .replace(/\b(streamKey|password|passphrase|token|secret|key)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]');
}

function formatValue(value, fallback = '-') {
  const text = sanitizeReportText(value).replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validTimeMs(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatBeijingTime(value) {
  const time = typeof value === 'number' ? value : validTimeMs(value);
  if (!Number.isFinite(time)) return '无可用记录';
  return new Date(time + BEIJING_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

function formatDurationSec(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '无可用记录';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole % 3600 / 60);
  const remaining = whole % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
}

function streamRuntimeTimeline({ output = {}, pipeline = {}, logs = [], now = new Date() } = {}) {
  const status = String(output.status || '').toLowerCase();
  const nowMs = validTimeMs(now);
  const uptimeSec = finiteNumber(output.uptimeSec);
  if (ACTIVE_OUTPUT_STATUSES.has(status) && nowMs !== null && uptimeSec !== null && uptimeSec >= 0) {
    const startedAtMs = nowMs - uptimeSec * 1000;
    return {
      startedAt: formatBeijingTime(startedAtMs),
      endedAt: '仍在推流',
      duration: formatDurationSec(uptimeSec),
      ongoing: true,
      startedAtMs,
      endedAtMs: null,
    };
  }

  const latestLog = (Array.isArray(logs) ? logs : [])
    .slice()
    .sort((a, b) => (
      (validTimeMs(b.startedAt || b.timestamp) || 0)
      - (validTimeMs(a.startedAt || a.timestamp) || 0)
    ))[0] || {};
  const startedAtMs = validTimeMs(pipeline.lastStartedAt)
    ?? validTimeMs(latestLog.startedAt || latestLog.timestamp);
  const endedAtMs = validTimeMs(pipeline.lastStoppedAt)
    ?? validTimeMs(latestLog.endedAt);
  const validRange = startedAtMs !== null && endedAtMs !== null && endedAtMs >= startedAtMs;
  return {
    startedAt: formatBeijingTime(startedAtMs),
    endedAt: formatBeijingTime(endedAtMs),
    duration: validRange ? formatDurationSec((endedAtMs - startedAtMs) / 1000) : '无可用记录',
    ongoing: false,
    startedAtMs,
    endedAtMs,
  };
}

function taskRuntimeTimeline(model = {}, now = new Date()) {
  const nowMs = validTimeMs(now);
  const activeStatus = String(model.active && model.active.status || '').toLowerCase();
  if (ACTIVE_OUTPUT_STATUSES.has(activeStatus) && nowMs !== null) {
    const timelines = (Array.isArray(model.streams) ? model.streams : [])
      .map(stream => streamRuntimeTimeline({
        output: stream.output || {},
        pipeline: model.pipeline || {},
        logs: stream.logs || [],
        now,
      }))
      .filter(timeline => timeline.ongoing && timeline.startedAtMs !== null);
    const startedAtMs = timelines.length
      ? Math.min(...timelines.map(timeline => timeline.startedAtMs))
      : null;
    if (startedAtMs !== null && startedAtMs <= nowMs) {
      return {
        startedAt: formatBeijingTime(startedAtMs),
        endedAt: '仍在推流',
        duration: formatDurationSec((nowMs - startedAtMs) / 1000),
        ongoing: true,
        startedAtMs,
        endedAtMs: null,
      };
    }
  }
  return streamRuntimeTimeline({
    output: { status: 'stopped' },
    pipeline: model.pipeline || {},
    logs: model.relayLogs || [],
    now,
  });
}

function metricNumber(value, suffix = '') {
  const number = finiteNumber(value);
  if (number === null) return '-';
  const rounded = Math.round(number * 100) / 100;
  return `${rounded}${suffix}`;
}

function signedPercent(value) {
  const number = finiteNumber(value);
  if (number === null) return '-';
  const rounded = Math.round(number * 100) / 100;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

function lookupById(values = []) {
  return new Map((Array.isArray(values) ? values : []).map(item => [String(item.id), item]));
}

function pipelineInputSummary(pipeline, source) {
  const input = pipeline && pipeline.input || {};
  if (input.type === 'room') return `直播间 ${input.roomId || '-'}`;
  if (input.type === 'url') return `URL 输入 ${formatValue(input.url)}`;
  if (input.type === 'file') return `本地文件 ${formatValue(input.path || input.url)}`;
  if (input.type === 'capture') {
    const capture = input.capture || {};
    return capture.backend === 'decklink'
      ? `DeckLink ${formatValue(capture.device || '-')}`
      : `V4L2 ${formatValue(capture.videoDevice || '-')}`;
  }
  if (source) return `${formatValue(source.name)} / ${formatValue(source.type || 'source')}`;
  return '-';
}

function boundaryTime(lines, label) {
  const pattern = new RegExp(`^=====\\s+(\\d{4}-\\d{2}-\\d{2}T[^\\s]+)\\s+${label}\\b`);
  const values = label === 'EXIT' ? [...lines].reverse() : lines;
  for (const line of values) {
    const match = line.match(pattern);
    if (match && validTimeMs(match[1]) !== null) return new Date(match[1]).toISOString();
  }
  return '';
}

function summarizeLogEntry(logManager, entry) {
  let content = '';
  try {
    if (typeof logManager.read === 'function') content = logManager.read(entry.file);
  } catch {}
  const lines = sanitizeReportText(content).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const notable = lines.filter(line => (
    /\b(?:error|failed|warning|drop|frame=|fps=|bitrate=|START|END|EXIT)\b/i.test(line)
  )).slice(-8);
  return {
    file: entry.file,
    displayName: entry.displayName || entry.file,
    timestamp: entry.timestamp || '',
    kind: entry.kind || '',
    pipelineId: entry.pipelineId || '',
    destinationId: entry.destinationId || '',
    sizeBytes: Number(entry.sizeBytes) || 0,
    active: Boolean(entry.active),
    startedAt: boundaryTime(lines, 'START') || entry.timestamp || '',
    endedAt: boundaryTime(lines, 'EXIT'),
    lines: lines.length,
    errors: lines.filter(line => /\b(?:error|failed|fatal)\b/i.test(line)).length,
    warnings: lines.filter(line => /\b(?:warning|drop|overrun)\b/i.test(line)).length,
    notable,
  };
}

function collectReportLogs(logManager, { pipelineId, destinationId = '', includeRelay = false }) {
  if (!logManager || typeof logManager.list !== 'function') return [];
  let entries = [];
  try {
    entries = logManager.list().filter(entry => {
      if (entry.pipelineId !== pipelineId) return false;
      if (destinationId) return entry.kind === 'destination' && entry.destinationId === destinationId;
      return includeRelay && entry.kind === 'relay';
    });
  } catch {
    return [];
  }
  return entries.slice(0, 8).map(entry => summarizeLogEntry(logManager, entry));
}

function reportModel({ store, manager, logManager, pipelineId, destinationId = '' }) {
  const state = store.getState();
  const pipelines = Array.isArray(state.pipelines) ? state.pipelines : [];
  const pipeline = pipelines.find(item => item.id === pipelineId);
  if (!pipeline) {
    const error = new Error('Pipeline not found');
    error.statusCode = 404;
    throw error;
  }
  const sources = lookupById(state.sources);
  const destinations = lookupById(state.destinations);
  let monitor = {};
  let programs = {};
  try {
    monitor = typeof manager.publicMonitor === 'function'
      ? manager.publicMonitor({ historyMode: 'none' })
      : manager.monitor({ historyMode: 'none' });
  } catch {}
  try {
    programs = typeof manager.programStates === 'function' ? manager.programStates() : {};
  } catch {}
  const outputs = (Array.isArray(monitor.outputs) ? monitor.outputs : [])
    .filter(output => output.pipelineId === pipelineId);
  const active = (Array.isArray(monitor.activePipelines) ? monitor.activePipelines : [])
    .find(item => item.pipelineId === pipelineId);
  const configuredDestinations = (pipeline.destinationIds || [])
    .map(id => destinations.get(id))
    .filter(Boolean);
  const scopedDestinations = destinationId
    ? configuredDestinations.filter(item => item.id === destinationId)
    : configuredDestinations;
  if (destinationId && scopedDestinations.length === 0) {
    const error = new Error('Destination not found');
    error.statusCode = 404;
    throw error;
  }
  const streams = scopedDestinations.map(destination => ({
    destination,
    output: outputs.find(output => output.destination && output.destination.id === destination.id) || null,
    logs: collectReportLogs(logManager, { pipelineId, destinationId: destination.id }),
  }));
  const relayLogs = destinationId
    ? []
    : collectReportLogs(logManager, { pipelineId, includeRelay: true });
  const scopedOutputs = streams.map(stream => stream.output).filter(Boolean);
  return {
    scope: destinationId ? 'destination' : 'pipeline',
    pipeline,
    source: pipeline.sourceId ? sources.get(pipeline.sourceId) : null,
    destinations: scopedDestinations,
    program: programs[pipelineId] || null,
    active: active || null,
    outputs: scopedOutputs,
    logs: [...relayLogs, ...streams.flatMap(stream => stream.logs)],
    streams,
    relayLogs,
  };
}

function statusLabel(value) {
  const status = String(value || '').toLowerCase();
  const labels = {
    running: '运行中',
    starting: '启动中',
    fallback: '无信号回退中',
    draining: '延时排空中',
    stopped: '未运行',
    error: '异常',
    disabled: '已禁用',
  };
  return labels[status] || formatValue(value, '未知');
}

function encodingLabel(output, settings) {
  const mode = String(output && output.encodingMode || '').toLowerCase();
  if (mode === 'copy') return 'copy';
  if (mode === 'nvenc') return 'h264_nvenc';
  if (mode === 'cpu') return settings.live.videoEncoder === 'auto' ? 'libx264' : settings.live.videoEncoder;
  return settings.live.videoEncoder || 'auto';
}

function assessStreamQuality(output = {}) {
  const status = String(output.status || 'stopped').toLowerCase();
  if (status === 'error') return { level: '异常', reasons: ['输出进程处于异常状态。'] };
  if (!['running', 'starting', 'fallback', 'draining'].includes(status)) {
    return { level: '数据不足', reasons: ['输出尚未运行，没有可用于质量判断的实时采样。'] };
  }

  const severe = [];
  const attention = [];
  const shortfall = finiteNumber(output.transportShortfallPercent);
  const recentDropRate = finiteNumber(output.recentDropRatePercent ?? output.dropRatePercent) || 0;
  const totalDropRate = finiteNumber(output.totalDropRatePercent) || 0;
  const corruptPackets = finiteNumber(output.corruptPackets) || 0;
  const udpOverruns = finiteNumber(output.udpOverruns) || 0;
  const actualFps = finiteNumber(output.fps ?? output.measuredFps);
  const targetFps = finiteNumber(output.targetFps);
  const fpsDeviation = actualFps !== null && targetFps && targetFps > 0
    ? Math.abs(actualFps - targetFps) / targetFps * 100
    : null;

  if (corruptPackets > 0) severe.push(`检测到 ${corruptPackets} 个损坏包。`);
  if (recentDropRate >= 3) severe.push(`近期丢帧率 ${metricNumber(recentDropRate, '%')}。`);
  if (output.networkLossActive && shortfall !== null && shortfall >= 50) {
    severe.push(`网络码率不足 ${metricNumber(shortfall, '%')}。`);
  }
  if (severe.length) return { level: '异常', reasons: severe };

  if (output.actualBitrateAvailable !== true) {
    return { level: '数据不足', reasons: ['实时传输码率尚未形成有效采样。'] };
  }
  if (shortfall !== null && shortfall >= 30) attention.push(`网络码率不足 ${metricNumber(shortfall, '%')}。`);
  if (fpsDeviation !== null && fpsDeviation >= 5) attention.push(`FPS 偏差 ${metricNumber(fpsDeviation, '%')}。`);
  if (recentDropRate > 0) attention.push(`近期丢帧率 ${metricNumber(recentDropRate, '%')}。`);
  if (totalDropRate >= 0.1) attention.push(`累计丢帧率 ${metricNumber(totalDropRate, '%')}。`);
  if (udpOverruns > 0) attention.push(`UDP overrun ${udpOverruns} 次。`);
  if (output.networkLossActive) attention.push('网络损失检测已触发。');
  if (attention.length) return { level: '需关注', reasons: attention };
  return {
    level: '良好',
    reasons: ['输出进程运行正常，当前采样未发现明显码率、帧率、丢帧或网络异常。'],
  };
}

function logStatistics(logs = []) {
  return {
    files: logs.length,
    lines: logs.reduce((sum, item) => sum + (Number(item.lines) || 0), 0),
    errors: logs.reduce((sum, item) => sum + (Number(item.errors) || 0), 0),
    warnings: logs.reduce((sum, item) => sum + (Number(item.warnings) || 0), 0),
    notable: logs.flatMap(item => item.notable || []).slice(0, 4),
  };
}

function streamReportDetails(stream, pipeline, now = new Date()) {
  const settings = mergeSettings(pipeline.settings || {});
  const output = stream.output || {};
  const destination = stream.destination || {};
  const audioTrack = settings.audio.tracks[0] || {};
  const actualBitrate = finiteNumber(output.bitrateKbps);
  const targetBitrate = finiteNumber(settings.live.bitrateKbps);
  const actualFps = finiteNumber(output.fps ?? output.measuredFps);
  const targetFps = finiteNumber(output.targetFps ?? settings.video.fps);
  const bitrateDeviation = actualBitrate !== null && targetBitrate && targetBitrate > 0
    ? (actualBitrate - targetBitrate) / targetBitrate * 100
    : null;
  const fpsDeviation = actualFps !== null && targetFps && targetFps > 0
    ? (actualFps - targetFps) / targetFps * 100
    : null;
  const quality = assessStreamQuality(output);
  const timeline = streamRuntimeTimeline({
    output,
    pipeline,
    logs: stream.logs,
    now,
  });
  return {
    destination: {
      id: destination.id || '-',
      name: formatValue(destination.name || destination.id),
      protocol: formatValue(destination.protocol || destination.type || 'rtmp').toUpperCase(),
      enabled: destination.enabled === false ? '已禁用' : '已启用',
      target: formatValue(destination.server || destination.url || ''),
    },
    runtime: {
      status: statusLabel(output.status || (destination.enabled === false ? 'disabled' : 'stopped')),
      rawStatus: output.status || 'stopped',
      uptime: timeline.duration,
      uptimeSec: finiteNumber(output.uptimeSec) || 0,
      startedAt: timeline.startedAt,
      endedAt: timeline.endedAt,
      ongoing: timeline.ongoing,
      startedAtMs: timeline.startedAtMs,
      endedAtMs: timeline.endedAtMs,
      encodingMode: formatValue(output.encodingMode || pipeline.mode || '-'),
    },
    video: {
      resolution: settings.video.outputResolution,
      encoder: encodingLabel(output, settings),
      bitrate: metricNumber(actualBitrate, ' Kbps'),
      targetBitrate: metricNumber(targetBitrate, ' Kbps'),
      bitrateDeviation: signedPercent(bitrateDeviation),
      bitrateAvailable: output.actualBitrateAvailable === true ? '可用' : '采样中/不可用',
      fps: metricNumber(actualFps),
      targetFps: metricNumber(targetFps),
      fpsDeviation: signedPercent(fpsDeviation),
      encoderSpeed: metricNumber(output.encoderSpeed, 'x'),
    },
    audio: {
      encoder: output.encodingMode === 'copy' ? 'copy' : settings.live.audioEncoder,
      sampleRate: `${settings.audio.sampleRate} Hz`,
      channels: settings.audio.channels === 'mono' ? '单声道' : '立体声',
      bitrate: metricNumber(audioTrack.bitrateKbps, ' Kbps'),
      status: output.status === 'running' ? '随输出进程运行' : '输出未运行',
    },
    quality,
    qualityMetrics: {
      recentDrops: metricNumber(output.recentDroppedFrames ?? output.droppedFrames ?? 0),
      recentDropRate: metricNumber(output.recentDropRatePercent ?? output.dropRatePercent ?? 0, '%'),
      totalDrops: metricNumber(output.totalDroppedFrames ?? output.droppedFrames ?? 0),
      totalDropRate: metricNumber(output.totalDropRatePercent ?? output.dropRatePercent ?? 0, '%'),
      shortfall: metricNumber(output.transportShortfallPercent, '%'),
      network: output.networkDropAvailable
        ? (output.networkLossActive ? '检测到网络损失' : '未检测到网络损失')
        : '无可用网络损失采样',
      udpOverruns: metricNumber(output.udpOverruns ?? 0),
      corruptPackets: metricNumber(output.corruptPackets ?? 0),
    },
    logs: logStatistics(stream.logs),
  };
}

function utf16Hex(value) {
  let hex = '';
  for (const char of String(value || '')) {
    const code = char.charCodeAt(0);
    hex += code.toString(16).padStart(4, '0');
  }
  return hex;
}

function asciiHex(value) {
  return Buffer.from(String(value || ''), 'ascii').toString('hex');
}

const HELVETICA_UPPERCASE = Object.freeze({
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278,
  J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
});

const HELVETICA_LOWERCASE = Object.freeze({
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222,
  j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333,
  s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
});

const HELVETICA_PUNCTUATION = Object.freeze({
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 333,
  '{': 334, '|': 260, '}': 334, '~': 584,
});

function helveticaWidth(char) {
  if (/\d/.test(char)) return 556;
  return HELVETICA_UPPERCASE[char]
    || HELVETICA_LOWERCASE[char]
    || HELVETICA_PUNCTUATION[char]
    || 556;
}

function fontForChar(char) {
  return char.charCodeAt(0) <= 0x7f ? 'F2' : 'F1';
}

function textRuns(value) {
  const runs = [];
  for (const char of Array.from(String(value || ''))) {
    const font = fontForChar(char);
    const previous = runs[runs.length - 1];
    if (previous && previous.font === font) previous.value += char;
    else runs.push({ font, value: char });
  }
  return runs;
}

function measureRun(value, font, size) {
  const units = font === 'F1'
    ? Array.from(String(value || '')).length * 1000
    : Array.from(String(value || '')).reduce((sum, char) => sum + helveticaWidth(char), 0);
  return units * size / 1000;
}

function measureText(value, size) {
  return textRuns(value).reduce((sum, run) => sum + measureRun(run.value, run.font, size), 0);
}

function wrapText(value, maxWidth, size, maxLines = 4) {
  const source = formatValue(value);
  const lines = [];
  let current = '';
  for (const char of Array.from(source)) {
    const next = current + char;
    if (current && measureText(next, size) > maxWidth) {
      lines.push(current.trimEnd());
      current = char === ' ' ? '' : char;
      if (lines.length === maxLines) break;
    } else {
      current = next;
    }
  }
  if (lines.length < maxLines && current.trim()) lines.push(current.trim());
  if (!lines.length) lines.push('-');
  if (lines.length === maxLines && measureText(lines[maxLines - 1], size) > maxWidth - measureText('...', size)) {
    let last = lines[maxLines - 1];
    while (last && measureText(`${last}...`, size) > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}...`;
  }
  return lines;
}

function buildPage() {
  return { ops: [], y: 730 };
}

function setFill(page, color) {
  page.ops.push(`${color.join(' ')} rg`);
}

function rect(page, x, y, width, height, color) {
  setFill(page, color);
  page.ops.push(`${x} ${y} ${width} ${height} re f`);
}

function line(page, x1, y1, x2, y2, color = COLORS.line, width = 0.6) {
  page.ops.push(`${color.join(' ')} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S`);
}

function drawText(page, value, x, y, size = 10, color = COLORS.ink) {
  const safe = sanitizeReportText(value);
  setFill(page, color);
  let cursor = x;
  for (const run of textRuns(safe)) {
    const hex = run.font === 'F1' ? utf16Hex(run.value) : asciiHex(run.value);
    page.ops.push(`BT /${run.font} ${size} Tf 1 0 0 1 ${cursor.toFixed(2)} ${y.toFixed(2)} Tm <${hex}> Tj ET`);
    cursor += measureRun(run.value, run.font, size);
  }
  return cursor - x;
}

function drawWrapped(page, value, x, y, maxWidth, size = 9, color = COLORS.ink, maxLines = 3, gap = 3) {
  const rows = wrapText(value, maxWidth, size, maxLines);
  rows.forEach((row, index) => drawText(page, row, x, y - index * (size + gap), size, color));
  return rows.length * (size + gap);
}

function qualityColor(level) {
  if (level === '良好') return COLORS.green;
  if (level === '需关注') return COLORS.amber;
  if (level === '异常') return COLORS.red;
  return COLORS.muted;
}

function drawHeader(page, title, subtitle, now) {
  rect(page, 0, 750, PAGE_WIDTH, 92, COLORS.navy);
  drawText(page, 'StreamHub', PAGE_MARGIN, 807, 18, COLORS.white);
  drawText(page, title, 154, 807, 18, COLORS.white);
  drawText(page, subtitle, PAGE_MARGIN, 779, 10, [0.84, 0.95, 0.98]);
  drawText(page, `生成时间 ${now.toISOString().replace('T', ' ').slice(0, 19)} UTC`, 390, 779, 7.8, [0.84, 0.95, 0.98]);
  page.y = 720;
}

function drawMetricCards(page, cards) {
  const gap = 8;
  const width = (CONTENT_WIDTH - gap * (cards.length - 1)) / cards.length;
  cards.forEach((card, index) => {
    const x = PAGE_MARGIN + index * (width + gap);
    rect(page, x, page.y - 56, width, 50, COLORS.pale);
    drawText(page, card.label, x + 9, page.y - 24, 7.3, COLORS.muted);
    drawWrapped(page, card.value, x + 9, page.y - 43, width - 18, 11.5, card.color || COLORS.navy, 1);
  });
  page.y -= 68;
}

function drawSection(page, title) {
  page.y -= 4;
  drawText(page, title, PAGE_MARGIN, page.y, 12.5, COLORS.navy);
  page.y -= 10;
  line(page, PAGE_MARGIN, page.y, PAGE_WIDTH - PAGE_MARGIN, page.y, COLORS.cyan, 0.8);
  page.y -= 18;
}

function drawFieldGrid(page, rows, { columns = 2, rowHeight = 29, valueSize = 8.8 } = {}) {
  const columnWidth = CONTENT_WIDTH / columns;
  for (let index = 0; index < rows.length; index += columns) {
    const row = rows.slice(index, index + columns);
    row.forEach(([label, value], columnIndex) => {
      const x = PAGE_MARGIN + columnIndex * columnWidth;
      drawText(page, label, x, page.y, 7.2, COLORS.muted);
      drawWrapped(page, value, x, page.y - 13, columnWidth - 16, valueSize, COLORS.ink, 1);
    });
    page.y -= rowHeight;
  }
}

function drawLogSummary(page, details) {
  drawFieldGrid(page, [
    ['日志文件', String(details.logs.files)],
    ['日志行数', String(details.logs.lines)],
    ['错误关键字', String(details.logs.errors)],
    ['警告关键字', String(details.logs.warnings)],
  ], { rowHeight: 27 });
  const notable = details.logs.notable.slice(0, 2);
  if (notable.length) {
    drawText(page, '关键事件', PAGE_MARGIN, page.y, 7.2, COLORS.muted);
    page.y -= 13;
    notable.forEach(item => {
      const used = drawWrapped(page, `- ${item}`, PAGE_MARGIN, page.y, CONTENT_WIDTH, 7.8, COLORS.ink, 1);
      page.y -= used + 2;
    });
  }
}

function buildDestinationReport(model, now) {
  const page = buildPage();
  const pages = [page];
  const stream = model.streams[0] || { destination: {}, output: null, logs: [] };
  const details = streamReportDetails(stream, model.pipeline, now);
  drawHeader(
    page,
    '单路推流运行报告',
    `${formatValue(model.pipeline.name || model.pipeline.id)} / ${details.destination.name}`,
    now,
  );
  drawMetricCards(page, [
    { label: '输出状态', value: details.runtime.status },
    { label: '推流时长', value: details.runtime.uptime },
    { label: '当前码率', value: details.video.bitrate },
    { label: '当前 FPS', value: details.video.fps },
    { label: '质量结论', value: details.quality.level, color: qualityColor(details.quality.level) },
  ]);

  drawSection(page, '1. 链路信息');
  drawFieldGrid(page, [
    ['任务 ID', model.pipeline.id],
    ['输出 ID', details.destination.id],
    ['开始时间', details.runtime.startedAt],
    ['结束时间/状态', details.runtime.endedAt],
    ['平台名称', details.destination.name],
    ['协议', details.destination.protocol],
    ['输入源', pipelineInputSummary(model.pipeline, model.source)],
    ['当前 Program', model.program ? `${model.program.kind || '-'} / ${model.program.sourceLabel || model.program.mediaName || '-'}` : '-'],
    ['分发模式', model.pipeline.mode || '-'],
    ['实际编码模式', details.runtime.encodingMode],
  ], { rowHeight: 27 });

  drawSection(page, '2. 视频状态');
  drawFieldGrid(page, [
    ['分辨率', details.video.resolution],
    ['视频编码器', details.video.encoder],
    ['当前 / 目标码率', `${details.video.bitrate} / ${details.video.targetBitrate}`],
    ['码率偏差', details.video.bitrateDeviation],
    ['当前 / 目标 FPS', `${details.video.fps} / ${details.video.targetFps}`],
    ['FPS 偏差', details.video.fpsDeviation],
    ['码率采样', details.video.bitrateAvailable],
    ['编码速度', details.video.encoderSpeed],
  ], { rowHeight: 27 });

  drawSection(page, '3. 音频状态');
  drawFieldGrid(page, [
    ['音频编码器', details.audio.encoder],
    ['采样率', details.audio.sampleRate],
    ['声道', details.audio.channels],
    ['音频码率', details.audio.bitrate],
    ['链路状态', details.audio.status],
  ], { rowHeight: 27 });

  drawSection(page, '4. 质量与日志');
  drawFieldGrid(page, [
    ['近期丢帧', `${details.qualityMetrics.recentDrops} / ${details.qualityMetrics.recentDropRate}`],
    ['累计丢帧', `${details.qualityMetrics.totalDrops} / ${details.qualityMetrics.totalDropRate}`],
    ['码率不足', details.qualityMetrics.shortfall],
    ['网络状态', details.qualityMetrics.network],
    ['UDP overrun', details.qualityMetrics.udpOverruns],
    ['损坏包', details.qualityMetrics.corruptPackets],
  ], { rowHeight: 26 });
  drawText(page, '质量依据', PAGE_MARGIN, page.y, 7.2, COLORS.muted);
  page.y -= 13;
  const reasonText = details.quality.reasons.join(' ');
  page.y -= drawWrapped(page, reasonText, PAGE_MARGIN, page.y, CONTENT_WIDTH, 8.2, qualityColor(details.quality.level), 2) + 4;
  drawLogSummary(page, details);
  return pages;
}

function taskStatus(model) {
  return statusLabel(model.active && model.active.status || model.pipeline.status || 'stopped');
}

function drawComparisonTable(page, model, now) {
  const columns = [
    ['平台', 112], ['状态', 54], ['时长', 62], ['码率', 72], ['FPS', 48], ['累计丢帧', 75], ['质量', 57],
  ];
  let x = PAGE_MARGIN;
  rect(page, PAGE_MARGIN, page.y - 21, CONTENT_WIDTH, 21, COLORS.pale);
  columns.forEach(([label, width]) => {
    drawText(page, label, x + 4, page.y - 14, 7.2, COLORS.muted);
    x += width;
  });
  page.y -= 24;
  model.streams.forEach(stream => {
    const details = streamReportDetails(stream, model.pipeline, now);
    const values = [
      details.destination.name,
      details.runtime.status,
      details.runtime.uptime,
      details.video.bitrate,
      details.video.fps,
      details.qualityMetrics.totalDropRate,
      details.quality.level,
    ];
    x = PAGE_MARGIN;
    values.forEach((value, index) => {
      const width = columns[index][1];
      drawWrapped(page, value, x + 4, page.y - 12, width - 8, 7.2, index === 6 ? qualityColor(details.quality.level) : COLORS.ink, 1);
      x += width;
    });
    line(page, PAGE_MARGIN, page.y - 20, PAGE_WIDTH - PAGE_MARGIN, page.y - 20, COLORS.line, 0.4);
    page.y -= 23;
  });
}

function drawStreamBlock(page, model, stream, height, now) {
  const details = streamReportDetails(stream, model.pipeline, now);
  const top = page.y;
  const compact = height < 190;
  const valueSize = compact ? 7.2 : 7.8;
  rect(page, PAGE_MARGIN, top - height + 4, CONTENT_WIDTH, height - 4, [0.975, 0.985, 0.99]);
  rect(page, PAGE_MARGIN, top - 27, CONTENT_WIDTH, 27, COLORS.pale);
  drawText(page, details.destination.name, PAGE_MARGIN + 10, top - 18, compact ? 10 : 11, COLORS.navy);
  drawText(page, details.destination.protocol, PAGE_MARGIN + 210, top - 18, 7.5, COLORS.muted);
  drawText(page, details.runtime.status, PAGE_MARGIN + 286, top - 18, 8, COLORS.ink);
  drawText(page, details.runtime.uptime, PAGE_MARGIN + 360, top - 18, 8, COLORS.ink);
  drawText(page, details.quality.level, PAGE_MARGIN + 444, top - 18, 8.5, qualityColor(details.quality.level));

  let y = top - 44;
  const rows = [
    `时间：开始 ${details.runtime.startedAt} / 时长 ${details.runtime.uptime} / 结束 ${details.runtime.endedAt}`,
    `视频：${details.video.resolution} / ${details.video.encoder} / ${details.video.bitrate}（目标 ${details.video.targetBitrate}，偏差 ${details.video.bitrateDeviation}） / ${details.video.fps} FPS（目标 ${details.video.targetFps}）`,
    `音频：${details.audio.encoder} / ${details.audio.sampleRate} / ${details.audio.channels} / ${details.audio.bitrate} / ${details.audio.status}`,
    `质量：近期丢帧 ${details.qualityMetrics.recentDrops}（${details.qualityMetrics.recentDropRate}），累计 ${details.qualityMetrics.totalDrops}（${details.qualityMetrics.totalDropRate}），码率不足 ${details.qualityMetrics.shortfall}`,
    `网络：${details.qualityMetrics.network}，UDP overrun ${details.qualityMetrics.udpOverruns}，损坏包 ${details.qualityMetrics.corruptPackets}`,
    `日志：${details.logs.files} 个文件，${details.logs.lines} 行，错误 ${details.logs.errors}，警告 ${details.logs.warnings}`,
  ];
  rows.forEach(row => {
    const used = drawWrapped(page, row, PAGE_MARGIN + 10, y, CONTENT_WIDTH - 20, valueSize, COLORS.ink, 1);
    y -= used + (compact ? 2 : 4);
  });
  drawWrapped(
    page,
    `结论依据：${details.quality.reasons.join(' ')}`,
    PAGE_MARGIN + 10,
    y,
    CONTENT_WIDTH - 20,
    valueSize,
    qualityColor(details.quality.level),
    compact ? 1 : 2,
  );
  page.y = top - height;
}

function buildPipelineReport(model, now) {
  const pages = [buildPage()];
  const overview = pages[0];
  drawHeader(overview, '分发任务运行报告', formatValue(model.pipeline.name || model.pipeline.id), now);
  const details = model.streams.map(stream => streamReportDetails(stream, model.pipeline, now));
  const taskTimeline = taskRuntimeTimeline(model, now);
  const running = details.filter(item => item.runtime.rawStatus === 'running').length;
  const totalBitrate = model.streams.reduce((sum, stream) => sum + (finiteNumber(stream.output && stream.output.bitrateKbps) || 0), 0);
  const measuredFps = model.streams
    .map(stream => finiteNumber(stream.output && (stream.output.fps ?? stream.output.measuredFps)))
    .filter(value => value !== null);
  const averageFps = measuredFps.length ? measuredFps.reduce((sum, value) => sum + value, 0) / measuredFps.length : null;
  drawMetricCards(overview, [
    { label: '任务状态', value: taskStatus(model) },
    { label: '输出数量', value: String(model.streams.length) },
    { label: '运行输出', value: String(running) },
    { label: '总码率', value: metricNumber(totalBitrate, ' Kbps') },
    { label: '平均 FPS', value: metricNumber(averageFps) },
  ]);

  drawSection(overview, '1. 任务总览');
  drawFieldGrid(overview, [
    ['任务 ID', model.pipeline.id],
    ['输入源', pipelineInputSummary(model.pipeline, model.source)],
    ['开始时间', taskTimeline.startedAt],
    ['推送时长', taskTimeline.duration],
    ['结束时间/状态', taskTimeline.endedAt],
    ['当前 Program', model.program ? `${model.program.kind || '-'} / ${model.program.sourceLabel || model.program.mediaName || '-'}` : '-'],
    ['分发模式', model.pipeline.mode || '-'],
  ], { rowHeight: 26 });

  drawSection(overview, '2. 输出对比');
  drawComparisonTable(overview, model, now);
  if (model.relayLogs.length) {
    const relayStats = logStatistics(model.relayLogs);
    overview.y -= 6;
    drawText(
      overview,
      `共享转推日志：${relayStats.files} 个文件，${relayStats.lines} 行，错误 ${relayStats.errors}，警告 ${relayStats.warnings}`,
      PAGE_MARGIN,
      overview.y,
      7.8,
      COLORS.muted,
    );
  }

  if (model.streams.length) {
    const detailPageCount = Math.min(REPORT_PAGE_LIMIT - 1, Math.max(1, Math.ceil(model.streams.length / 2)));
    const perPage = Math.ceil(model.streams.length / detailPageCount);
    for (let offset = 0; offset < model.streams.length; offset += perPage) {
      const page = buildPage();
      pages.push(page);
      drawHeader(page, '逐路输出详细状态', `${formatValue(model.pipeline.name || model.pipeline.id)} / ${offset + 1}-${Math.min(offset + perPage, model.streams.length)}`, now);
      page.y = 724;
      const batch = model.streams.slice(offset, offset + perPage);
      const blockHeight = Math.min(300, Math.floor(650 / Math.max(1, batch.length)));
      batch.forEach(stream => drawStreamBlock(page, model, stream, blockHeight, now));
    }
  }
  return pages.slice(0, REPORT_PAGE_LIMIT);
}

function addFooters(pages, pipelineId) {
  pages.forEach((page, index) => {
    line(page, PAGE_MARGIN, 44, PAGE_WIDTH - PAGE_MARGIN, 44, COLORS.line, 0.4);
    drawText(page, `StreamHub | ${pipelineId}`, PAGE_MARGIN, 28, 7.2, COLORS.muted);
    drawText(page, `${index + 1} / ${pages.length}`, 515, 28, 7.2, COLORS.muted);
  });
}

function buildPipelineReportPdf(model, now = new Date()) {
  const pages = model.scope === 'destination'
    ? buildDestinationReport(model, now)
    : buildPipelineReport(model, now);
  addFooters(pages, model.pipeline.id);
  return renderPdf(pages);
}

function renderPdf(pages) {
  const objects = [];
  const add = content => {
    objects.push(content);
    return objects.length;
  };
  const descriptorId = add('<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>');
  const cidFontId = add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor ${descriptorId} 0 R >>`);
  const chineseFontId = add(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${cidFontId} 0 R] >>`);
  const latinFontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageObjectIds = [];
  const contentObjectIds = [];
  for (const page of pages) {
    const content = page.ops.join('\n');
    contentObjectIds.push(add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`));
    pageObjectIds.push(0);
  }
  const pagesId = objects.length + pageObjectIds.length + 1;
  for (let index = 0; index < pages.length; index += 1) {
    pageObjectIds[index] = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${chineseFontId} 0 R /F2 ${latinFontId} 0 R >> >> /Contents ${contentObjectIds[index]} 0 R >>`);
  }
  add(`<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectIds.map(id => `${id} 0 R`).join(' ')}] >>`);
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const chunks = ['%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'];
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(chunks.join(''), 'binary'));
    chunks.push(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`);
  }
  const xrefOffset = Buffer.byteLength(chunks.join(''), 'binary');
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (let index = 1; index < offsets.length; index += 1) {
    chunks.push(`${String(offsets[index]).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return Buffer.from(chunks.join(''), 'binary');
}

function createPipelineReport({ store, manager, logManager, pipelineId, destinationId, now }) {
  return buildPipelineReportPdf(reportModel({ store, manager, logManager, pipelineId, destinationId }), now);
}

module.exports = {
  assessStreamQuality,
  buildPipelineReportPdf,
  createPipelineReport,
  reportModel,
  sanitizeReportText,
  streamRuntimeTimeline,
  streamReportDetails,
  taskRuntimeTimeline,
};
