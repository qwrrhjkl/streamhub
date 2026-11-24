const { mergeSettings } = require('./ffmpegBuilder');

const PAGE_WIDTH = 596;
const PAGE_HEIGHT = 842;
const PAGE_MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const CONTENT_BOTTOM = 66;
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
  const runStartedAtMs = validTimeMs(model.run && model.run.startedAt);
  const runEndedAtMs = validTimeMs(model.run && model.run.endedAt);
  if (runStartedAtMs !== null && runEndedAtMs !== null && runEndedAtMs >= runStartedAtMs) {
    return {
      startedAt: formatBeijingTime(runStartedAtMs),
      endedAt: formatBeijingTime(runEndedAtMs),
      duration: formatDurationSec((runEndedAtMs - runStartedAtMs) / 1000),
      ongoing: false,
      startedAtMs: runStartedAtMs,
      endedAtMs: runEndedAtMs,
    };
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

function collectReportLogs(logManager, {
  pipelineId, destinationId = '', includeRelay = false, startedAt = '', endedAt = '',
}) {
  if (!logManager || typeof logManager.list !== 'function') return [];
  let entries = [];
  try {
    entries = logManager.list().filter(entry => {
      if (entry.pipelineId !== pipelineId) return false;
      const timestamp = validTimeMs(entry.timestamp);
      const from = validTimeMs(startedAt);
      const to = validTimeMs(endedAt);
      if (from !== null && (timestamp === null || timestamp < from - 1000)) return false;
      if (to !== null && (timestamp === null || timestamp > to + 1000)) return false;
      if (destinationId) return entry.kind === 'destination' && entry.destinationId === destinationId;
      return includeRelay && entry.kind === 'relay';
    });
  } catch {
    return [];
  }
  return entries.slice(0, 8).map(entry => summarizeLogEntry(logManager, entry));
}

function reportModel({ store, manager, logManager, pipelineId, destinationId = '', runId = '' }) {
  const state = store.getState();
  const run = runId
    ? (state.pipelineRuns || []).find(item => item.id === runId)
    : null;
  if (runId && !run) {
    const error = new Error('Run report not found');
    error.statusCode = 404;
    throw error;
  }
  if (run) {
    const runPipeline = run.pipeline || { id: run.pipelineId, name: run.pipelineId, settings: {} };
    if (pipelineId && pipelineId !== run.pipelineId) {
      const error = new Error('Run report does not belong to pipeline');
      error.statusCode = 404;
      throw error;
    }
    const scopedDestinations = destinationId
      ? (run.destinations || []).filter(item => item.id === destinationId)
      : (run.destinations || []);
    if (destinationId && scopedDestinations.length === 0) {
      const error = new Error('Destination not found');
      error.statusCode = 404;
      throw error;
    }
    const logRange = { startedAt: run.startedAt, endedAt: run.endedAt };
    const streams = scopedDestinations.map(destination => ({
      destination,
      output: (run.outputs || []).find(output => output.destination && output.destination.id === destination.id) || null,
      logs: collectReportLogs(logManager, {
        pipelineId: run.pipelineId, destinationId: destination.id, ...logRange,
      }),
    }));
    const relayLogs = destinationId ? [] : collectReportLogs(logManager, {
      pipelineId: run.pipelineId, includeRelay: true, ...logRange,
    });
    return {
      scope: destinationId ? 'destination' : 'pipeline',
      run,
      pipeline: {
        ...runPipeline,
        lastStartedAt: run.startedAt,
        lastStoppedAt: run.endedAt,
      },
      source: run.source || null,
      destinations: scopedDestinations,
      program: run.program || null,
      active: run.active || null,
      outputs: streams.map(stream => stream.output).filter(Boolean),
      logs: [...relayLogs, ...streams.flatMap(stream => stream.logs)],
      streams,
      relayLogs,
    };
  }
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

function stopModeLabel(run) {
  if (!run) return '-';
  if (run.outcome === 'service-restart' || run.status === 'interrupted') return '服务中断';
  if (run.stopMode === 'drain') return '播完延时后停止';
  if (run.stopMode === 'discard') return '立即停止';
  return formatValue(run.outcome || run.status);
}

function encodingLabel(output, settings) {
  const mode = String(output && output.encodingMode || '').toLowerCase();
  if (mode === 'copy') return 'copy';
  if (mode === 'nvenc') return 'h264_nvenc';
  if (mode === 'cpu') return settings.live.videoEncoder === 'auto' ? 'libx264' : settings.live.videoEncoder;
  return settings.live.videoEncoder || 'auto';
}

function normalizeReportOutput(output = {}) {
  const metrics = output.metrics && typeof output.metrics === 'object' ? output.metrics : {};
  const normalized = { ...metrics, ...output };
  if (normalized.encoderSpeed == null && metrics.speed != null) {
    normalized.encoderSpeed = metrics.speed;
  }
  return normalized;
}

function assessStreamQuality(output = {}, evidence = {}) {
  output = normalizeReportOutput(output);
  const status = String(output.status || 'stopped').toLowerCase();
  const operationalStatus = String(output.lastOperationalStatus || status).toLowerCase();
  const logs = evidence.logs || {};
  if (status === 'error' || operationalStatus === 'error') {
    return { level: '异常', basis: '进程状态', reasons: ['输出进程记录为异常状态。'] };
  }

  const severe = [];
  const attention = [];
  const shortfall = finiteNumber(output.transportShortfallPercent);
  const recentDropRate = finiteNumber(output.recentDropRatePercent ?? output.dropRatePercent);
  const totalDropRate = finiteNumber(output.totalDropRatePercent);
  const corruptPackets = finiteNumber(output.corruptPackets) || 0;
  const udpOverruns = finiteNumber(output.udpOverruns) || 0;
  const actualFps = finiteNumber(output.fps ?? output.measuredFps);
  const targetFps = finiteNumber(output.targetFps);
  const actualBitrate = finiteNumber(output.bitrateKbps);
  const sampleAvailable = output.actualBitrateAvailable === true
    || (actualBitrate !== null && actualBitrate > 0)
    || (actualFps !== null && actualFps > 0)
    || output.networkDropAvailable === true;
  const fpsDeviation = actualFps !== null && targetFps && targetFps > 0
    ? Math.abs(actualFps - targetFps) / targetFps * 100
    : null;

  if (corruptPackets > 0) severe.push(`检测到 ${corruptPackets} 个损坏包。`);
  if (recentDropRate !== null && recentDropRate >= 3) severe.push(`近期丢帧率 ${metricNumber(recentDropRate, '%')}。`);
  if (output.networkLossActive && shortfall !== null && shortfall >= 50) {
    severe.push(`网络码率不足 ${metricNumber(shortfall, '%')}。`);
  }
  if (Number(logs.errors) > 0) severe.push(`日志摘要检出 ${logs.errors} 条错误关键字。`);
  if (severe.length) return { level: '异常', reasons: severe };

  if (shortfall !== null && shortfall >= 30) attention.push(`网络码率不足 ${metricNumber(shortfall, '%')}。`);
  if (fpsDeviation !== null && fpsDeviation >= 5) attention.push(`FPS 偏差 ${metricNumber(fpsDeviation, '%')}。`);
  if (recentDropRate !== null && recentDropRate > 0) attention.push(`近期丢帧率 ${metricNumber(recentDropRate, '%')}。`);
  if (totalDropRate !== null && totalDropRate >= 0.1) attention.push(`累计丢帧率 ${metricNumber(totalDropRate, '%')}。`);
  if (udpOverruns > 0) attention.push(`UDP overrun ${udpOverruns} 次。`);
  if (output.networkLossActive) attention.push('网络损失检测已触发。');
  if (Number(logs.warnings) > 0) attention.push(`日志摘要检出 ${logs.warnings} 条警告关键字。`);
  if (attention.length) return { level: '需关注', basis: sampleAvailable ? '运行指标与日志' : '日志摘要', reasons: attention };

  const runObserved = evidence.runObserved === true
    || Number(evidence.durationSec) > 0
    || Number(logs.files) > 0;
  if (!sampleAvailable) {
    if (ACTIVE_OUTPUT_STATUSES.has(status)
      || (!runObserved && ACTIVE_OUTPUT_STATUSES.has(operationalStatus))) {
      return {
        level: '采样中',
        basis: Number(logs.files) ? '进程状态与日志摘要' : '进程状态',
        reasons: ['输出进程已运行，当前尚未形成有效码率或 FPS 样本；待样本生成后可补充性能判断。'],
      };
    }
    if (runObserved) {
      return {
        level: '未见明显故障',
        basis: '运行记录与日志摘要',
        reasons: [
          '本次运行记录已保存，日志摘要未检出错误或警告关键字。',
          '未取得有效码率、FPS 或网络丢失采样，因此结论仅覆盖进程与日志证据，不代表全程传输质量。',
        ],
      };
    }
    return { level: '未运行', basis: '运行状态', reasons: ['本次没有可识别的运行记录或日志，任务未形成可评估的输出链路。'] };
  }

  return {
    level: '良好',
    basis: '运行指标与日志摘要',
    reasons: ['已取得有效运行样本，未发现达到告警阈值的码率、帧率、丢帧或网络异常。'],
  };
}

function logStatistics(logs = []) {
  return {
    files: logs.length,
    lines: logs.reduce((sum, item) => sum + (Number(item.lines) || 0), 0),
    sizeBytes: logs.reduce((sum, item) => sum + (Number(item.sizeBytes) || 0), 0),
    errors: logs.reduce((sum, item) => sum + (Number(item.errors) || 0), 0),
    warnings: logs.reduce((sum, item) => sum + (Number(item.warnings) || 0), 0),
    notable: logs.flatMap(item => item.notable || []).slice(0, 4),
  };
}

function streamReportDetails(stream, pipeline, now = new Date(), run = null) {
  const settings = mergeSettings(pipeline.settings || {});
  const output = normalizeReportOutput(stream.output || {});
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
  const timeline = streamRuntimeTimeline({
    output,
    pipeline: run ? {
      ...pipeline,
      lastStartedAt: run.startedAt || pipeline.lastStartedAt,
      lastStoppedAt: run.endedAt || pipeline.lastStoppedAt,
    } : pipeline,
    logs: stream.logs,
    now,
  });
  const logs = logStatistics(stream.logs);
  const quality = assessStreamQuality(output, {
    logs,
    runObserved: Boolean(run),
    durationSec: finiteNumber(output.uptimeSec) || 0,
  });
  const lastStatus = String(output.lastOperationalStatus || '').toLowerCase();
  const endedNormally = output.status === 'stopped'
    && ['running', 'draining', 'fallback'].includes(lastStatus);
  const actualBitrateAvailable = output.actualBitrateAvailable === true && actualBitrate !== null;
  const fpsAvailable = actualFps !== null && actualFps > 0;
  return {
    destination: {
      id: destination.id || '-',
      name: formatValue(destination.name || destination.id),
      protocol: formatValue(destination.protocol || destination.type || 'rtmp').toUpperCase(),
      enabled: destination.enabled === false ? '已禁用' : '已启用',
      target: destination.server || destination.url ? '已配置，地址与密钥已隐藏' : '未提供目标地址',
    },
    runtime: {
      status: endedNormally ? '已结束'
        : run && output.status === 'stopped' ? '已停止'
          : statusLabel(output.status || (destination.enabled === false ? 'disabled' : 'stopped')),
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
      bitrate: actualBitrateAvailable ? metricNumber(actualBitrate, ' Kbps') : '无有效采样',
      targetBitrate: metricNumber(targetBitrate, ' Kbps'),
      bitrateDeviation: signedPercent(bitrateDeviation),
      bitrateAvailable: actualBitrateAvailable ? '已采样' : '无有效采样',
      fps: fpsAvailable ? metricNumber(actualFps) : '无有效采样',
      targetFps: metricNumber(targetFps),
      fpsDeviation: signedPercent(fpsDeviation),
      encoderSpeed: finiteNumber(output.encoderSpeed) > 0 ? metricNumber(output.encoderSpeed, 'x') : '无有效采样',
    },
    audio: {
      encoder: output.encodingMode === 'copy' ? 'copy' : settings.live.audioEncoder,
      sampleRate: `${settings.audio.sampleRate} Hz`,
      channels: settings.audio.channels === 'mono' ? '单声道' : '立体声',
      bitrate: metricNumber(audioTrack.bitrateKbps, ' Kbps'),
      status: endedNormally ? '本次输出已结束'
        : ACTIVE_OUTPUT_STATUSES.has(output.status) ? '随输出进程运行'
          : '依据任务音频配置',
    },
    quality,
    qualityMetrics: {
      recentDrops: metricNumber(output.recentDroppedFrames ?? output.droppedFrames),
      recentDropRate: metricNumber(output.recentDropRatePercent ?? output.dropRatePercent, '%'),
      totalDrops: metricNumber(output.totalDroppedFrames),
      totalDropRate: metricNumber(output.totalDropRatePercent, '%'),
      shortfall: actualBitrateAvailable ? metricNumber(output.transportShortfallPercent, '%') : '无有效采样',
      network: output.networkDropAvailable
        ? (output.networkLossActive ? '检测到网络损失' : '未检测到网络损失')
        : '未采集网络丢失样本',
      udpOverruns: output.networkDropAvailable ? metricNumber(output.udpOverruns) : '未采样',
      corruptPackets: output.networkDropAvailable ? metricNumber(output.corruptPackets) : '未采样',
    },
    logs,
    profile: {
      targetBitrate: metricNumber(targetBitrate, ' Kbps'),
      targetFps: metricNumber(targetFps),
      resolution: formatValue(settings.video.outputResolution),
      videoEncoder: encodingLabel(output, settings),
      audioEncoder: output.encodingMode === 'copy' ? 'copy' : formatValue(settings.live.audioEncoder),
      audioSampleRate: `${settings.audio.sampleRate} Hz`,
      audioChannels: settings.audio.channels === 'mono' ? '单声道' : '立体声',
      audioBitrate: metricNumber(audioTrack.bitrateKbps, ' Kbps'),
      liveDelay: settings.live.delayEnabled ? `${settings.live.delaySeconds} 秒` : '关闭',
      watermarkCount: settings.watermarks.length,
      slideshowCount: settings.slideshow.images.length,
      audioTrackCount: settings.audio.tracks.length,
    },
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
  if (level === '良好' || level === '未见明显故障') return COLORS.green;
  if (level === '需关注' || level === '采样中') return COLORS.amber;
  if (level === '异常') return COLORS.red;
  return COLORS.muted;
}

function drawHeader(page, title, subtitle, now) {
  rect(page, 0, 750, PAGE_WIDTH, 92, COLORS.navy);
  drawText(page, 'StreamHub', PAGE_MARGIN, 807, 18, COLORS.white);
  drawText(page, title, 154, 807, 18, COLORS.white);
  drawText(page, subtitle, PAGE_MARGIN, 779, 10, [0.84, 0.95, 0.98]);
  drawText(page, `生成时间 ${formatBeijingTime(now)} 北京时间`, 390, 779, 7.8, [0.84, 0.95, 0.98]);
  page.y = 720;
}

function drawMetricCards(page, cards) {
  const gap = 8;
  const width = (CONTENT_WIDTH - gap * (cards.length - 1)) / cards.length;
  const valueSize = cards.length >= 6 ? 9.5 : 11.5;
  cards.forEach((card, index) => {
    const x = PAGE_MARGIN + index * (width + gap);
    rect(page, x, page.y - 56, width, 50, COLORS.pale);
    drawText(page, card.label, x + 9, page.y - 24, 7.3, COLORS.muted);
    drawWrapped(page, card.value, x + 9, page.y - 43, width - 18, valueSize, card.color || COLORS.navy, 1);
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
    ['匹配日志文件', details.logs.files ? String(details.logs.files) : '无'],
    ['摘要行数', String(details.logs.lines)],
    ['日志文件体积', details.logs.sizeBytes ? formatBytes(details.logs.sizeBytes) : '-'],
    ['错误 / 警告关键字', `${details.logs.errors} / ${details.logs.warnings}`],
  ], { rowHeight: 25 });
  if (details.logs.files) {
    drawWrapped(page, '范围：最多纳入 8 个关联日志文件，每个文件读取末尾 20 KB 摘要。', PAGE_MARGIN, page.y, CONTENT_WIDTH, 7, COLORS.muted, 1);
    page.y -= 12;
  }
  const notable = details.logs.notable.slice(0, 3);
  if (notable.length) {
    drawText(page, '关键事件', PAGE_MARGIN, page.y, 7.2, COLORS.muted);
    page.y -= 13;
    notable.forEach(item => {
      const used = drawWrapped(page, `- ${item}`, PAGE_MARGIN, page.y, CONTENT_WIDTH, 7.2, COLORS.ink, 2);
      page.y -= used + 2;
    });
  } else if (!details.logs.files) {
    drawText(page, '本次运行未找到可关联的任务或目标日志。', PAGE_MARGIN, page.y, 7.4, COLORS.muted);
    page.y -= 12;
  }
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function pipelineProfile(pipeline = {}) {
  const settings = mergeSettings(pipeline.settings || {});
  const audio = settings.audio.tracks[0] || {};
  return {
    resolution: settings.video.outputResolution,
    fps: settings.video.fps,
    encoder: settings.live.videoEncoder,
    preset: settings.live.preset,
    bitrate: settings.live.bitrateKbps,
    audioEncoder: settings.live.audioEncoder,
    audioSampleRate: settings.audio.sampleRate,
    channels: settings.audio.channels === 'mono' ? '单声道' : '立体声',
    audioBitrate: audio.bitrateKbps,
    audioTracks: settings.audio.tracks.length,
    liveDelay: settings.live.delayEnabled ? `${settings.live.delaySeconds} 秒` : '关闭',
    watermarks: settings.watermarks.length,
    slideshowImages: settings.slideshow.images.length,
    noSignalImage: Boolean(settings.noSignalImage),
  };
}

function drawQualityBand(page, quality) {
  const body = quality.reasons.join(' ');
  const rows = wrapText(body, CONTENT_WIDTH - 24, 7.6, 3);
  const height = Math.max(47, 28 + rows.length * 11);
  const top = page.y;
  const fill = quality.level === '异常' ? [1, 0.94, 0.94]
    : quality.level === '需关注' || quality.level === '采样中' ? [1, 0.97, 0.89]
      : [0.93, 0.97, 0.95];
  rect(page, PAGE_MARGIN, top - height, CONTENT_WIDTH, height, fill);
  drawText(page, `结论：${quality.level}  |  依据：${quality.basis || '-'}`, PAGE_MARGIN + 12, top - 16, 8.2, qualityColor(quality.level));
  drawWrapped(page, body, PAGE_MARGIN + 12, top - 31, CONTENT_WIDTH - 24, 7.6, COLORS.ink, 3, 3);
  page.y -= height + 8;
}

function buildDestinationReport(model, now) {
  const page = buildPage();
  const evidencePage = buildPage();
  const pages = [page, evidencePage];
  const stream = model.streams[0] || { destination: {}, output: null, logs: [] };
  const details = streamReportDetails(stream, model.pipeline, now, model.run);
  const profile = pipelineProfile(model.pipeline);
  drawHeader(
    page,
    '单路推流运行报告',
    `${formatValue(model.pipeline.name || model.pipeline.id)} / ${details.destination.name}`,
    now,
  );
  drawMetricCards(page, [
    { label: '本次状态', value: details.runtime.status },
    { label: '推流时长', value: details.runtime.uptime },
    { label: '采样码率', value: details.video.bitrate },
    { label: '采样 FPS', value: details.video.fps },
    { label: '质量判断', value: details.quality.level, color: qualityColor(details.quality.level) },
  ]);

  drawSection(page, '1. 运行批次');
  drawFieldGrid(page, [
    ['任务名称', model.pipeline.name || model.pipeline.id],
    ['任务 ID', model.pipeline.id],
    ['运行批次', model.run && model.run.id || '-'],
    ['停止方式', stopModeLabel(model.run)],
    ['开始时间', details.runtime.startedAt],
    ['结束时间/状态', details.runtime.endedAt],
    ['输入源', pipelineInputSummary(model.pipeline, model.source)],
    ['分发模式 / 实际编码', `${model.pipeline.mode || '-'} / ${details.runtime.encodingMode}`],
  ], { rowHeight: 25 });

  drawSection(page, '2. 输出链路与媒体配置');
  drawFieldGrid(page, [
    ['目标平台', details.destination.name],
    ['平台 ID / 协议', `${details.destination.id} / ${details.destination.protocol}`],
    ['推流地址', details.destination.target],
    ['启用状态', details.destination.enabled],
    ['当前 Program', model.program ? `${model.program.kind || '-'} / ${model.program.sourceLabel || model.program.mediaName || '-'}` : '-'],
    ['视频规格', `${profile.resolution} / ${profile.fps} FPS / ${profile.bitrate} Kbps`],
    ['视频编码', `${details.video.encoder} / ${profile.preset}`],
    ['音频规格', `${details.audio.encoder} / ${profile.audioSampleRate} Hz / ${profile.channels} / ${profile.audioBitrate} Kbps`],
    ['延时 / 画面层', `${profile.liveDelay} / 水印 ${profile.watermarks} / 幻灯片 ${profile.slideshowImages}`],
  ], { rowHeight: 25 });

  drawHeader(evidencePage, '质量结论与运行证据', `${details.destination.name} / ${details.destination.protocol}`, now);
  drawMetricCards(evidencePage, [
    { label: '结论', value: details.quality.level, color: qualityColor(details.quality.level) },
    { label: '运行日志', value: String(details.logs.files) },
    { label: '错误关键字', value: String(details.logs.errors), color: details.logs.errors ? COLORS.red : COLORS.navy },
    { label: '警告关键字', value: String(details.logs.warnings), color: details.logs.warnings ? COLORS.amber : COLORS.navy },
  ]);

  drawQualityBand(evidencePage, details.quality);
  drawSection(evidencePage, '3. 质量指标与采样覆盖');
  drawFieldGrid(evidencePage, [
    ['采样码率 / 目标', `${details.video.bitrate} / ${details.video.targetBitrate}`],
    ['采样 FPS / 目标', `${details.video.fps} / ${details.video.targetFps}`],
    ['近期丢帧', `${details.qualityMetrics.recentDrops} / ${details.qualityMetrics.recentDropRate}`],
    ['累计丢帧', `${details.qualityMetrics.totalDrops} / ${details.qualityMetrics.totalDropRate}`],
    ['码率不足', details.qualityMetrics.shortfall],
    ['网络状态', details.qualityMetrics.network],
    ['UDP overrun', details.qualityMetrics.udpOverruns],
    ['损坏包', details.qualityMetrics.corruptPackets],
  ], { rowHeight: 24 });

  drawSection(evidencePage, '4. 日志摘要');
  drawLogSummary(evidencePage, details);
  drawWrapped(
    evidencePage,
    '结论口径：优先依据本次运行批次的进程状态、输出采样与关联日志。未采集到的指标显示为“无有效采样”，不会按 0 参与结论。日志摘要仅覆盖末尾片段，完整原始日志可在控制台下载查看。',
    PAGE_MARGIN,
    evidencePage.y,
    CONTENT_WIDTH,
    7,
    COLORS.muted,
    3,
  );
  evidencePage.y -= 38;
  return pages;
}

function taskStatus(model) {
  const runStatus = String(model.run && (model.run.outcome || model.run.status) || '').toLowerCase();
  if (runStatus === 'interrupted' || runStatus === 'service-restart') return '服务中断';
  if (runStatus === 'error' || runStatus === 'failed') return '异常';
  if (runStatus === 'stopped') return '已停止';
  return statusLabel(model.active && model.active.status || model.pipeline.status || runStatus || 'stopped');
}

function overallQuality(details = []) {
  const levels = details.map(item => item.quality.level);
  if (!levels.length || levels.every(level => level === '未运行')) return '未运行';
  if (levels.includes('异常')) return '异常';
  if (levels.includes('需关注')) return '需关注';
  if (levels.includes('良好')) return levels.includes('未见明显故障') ? '未见明显故障' : '良好';
  if (levels.includes('采样中')) return '采样中';
  return '未见明显故障';
}

function drawComparisonTable(page, model, now, details) {
  const columns = [
    ['平台', 105], ['状态', 52], ['时长', 62], ['采样码率', 77], ['FPS', 46], ['丢帧率', 66], ['判断', 62],
  ];
  let x = PAGE_MARGIN;
  rect(page, PAGE_MARGIN, page.y - 21, CONTENT_WIDTH, 21, COLORS.pale);
  columns.forEach(([label, width]) => {
    drawText(page, label, x + 4, page.y - 14, 7.2, COLORS.muted);
    x += width;
  });
  page.y -= 24;
  const visibleStreams = model.streams.slice(0, 6);
  visibleStreams.forEach((stream, streamIndex) => {
    const detail = details[streamIndex] || streamReportDetails(stream, model.pipeline, now, model.run);
    const values = [detail.destination.name, detail.runtime.status, detail.runtime.uptime,
      detail.video.bitrate, detail.video.fps, detail.qualityMetrics.totalDropRate, detail.quality.level];
    x = PAGE_MARGIN;
    values.forEach((value, index) => {
      const width = columns[index][1];
      drawWrapped(page, value, x + 4, page.y - 12, width - 8, 7.2, index === 6 ? qualityColor(detail.quality.level) : COLORS.ink, 1);
      x += width;
    });
    line(page, PAGE_MARGIN, page.y - 20, PAGE_WIDTH - PAGE_MARGIN, page.y - 20, COLORS.line, 0.4);
    page.y -= 23;
  });
  if (model.streams.length > visibleStreams.length) {
    page.y -= 7;
    drawText(page, `其余 ${model.streams.length - visibleStreams.length} 路输出详见后续逐路详情。`, PAGE_MARGIN, page.y, 7.2, COLORS.muted);
    page.y -= 12;
  }
}

function drawStreamPage(page, model, stream, details, now, index) {
  drawHeader(page, '逐路输出质量报告', `${index + 1} / ${model.streams.length}  ${details.destination.name}`, now);
  drawMetricCards(page, [
    { label: '输出状态', value: details.runtime.status },
    { label: '推流时长', value: details.runtime.uptime },
    { label: '采样码率', value: details.video.bitrate },
    { label: '采样 FPS', value: details.video.fps },
    { label: '质量判断', value: details.quality.level, color: qualityColor(details.quality.level) },
  ]);

  drawSection(page, '1. 输出链路');
  drawFieldGrid(page, [
    ['目标平台', details.destination.name],
    ['目标 ID / 协议', `${details.destination.id} / ${details.destination.protocol}`],
    ['推流地址', details.destination.target],
    ['开始 / 结束', `${details.runtime.startedAt} / ${details.runtime.endedAt}`],
    ['输入源', pipelineInputSummary(model.pipeline, model.source)],
    ['Program / 分发模式', `${model.program ? model.program.kind || '-' : '-'} / ${model.pipeline.mode || '-'}`],
  ], { rowHeight: 25 });

  drawSection(page, '2. 编码与媒体规格');
  drawFieldGrid(page, [
    ['视频规格', `${details.video.resolution} / 目标 ${details.video.targetFps} FPS`],
    ['编码器 / 模式', `${details.video.encoder} / ${details.runtime.encodingMode}`],
    ['采样 / 目标码率', `${details.video.bitrate} / ${details.video.targetBitrate}`],
    ['码率偏差 / 编码速度', `${details.video.bitrateDeviation} / ${details.video.encoderSpeed}`],
    ['采样 / 目标 FPS', `${details.video.fps} / ${details.video.targetFps}`],
    ['音频规格', `${details.audio.encoder} / ${details.audio.sampleRate} / ${details.audio.channels}`],
    ['音频码率 / 状态', `${details.audio.bitrate} / ${details.audio.status}`],
    ['延时 / 画面层', `${details.profile.liveDelay} / 水印 ${details.profile.watermarkCount} / 幻灯片 ${details.profile.slideshowCount}`],
  ], { rowHeight: 24 });

  drawSection(page, '3. 质量指标与判定');
  drawFieldGrid(page, [
    ['近期丢帧 / 比率', `${details.qualityMetrics.recentDrops} / ${details.qualityMetrics.recentDropRate}`],
    ['累计丢帧 / 比率', `${details.qualityMetrics.totalDrops} / ${details.qualityMetrics.totalDropRate}`],
    ['网络码率不足', details.qualityMetrics.shortfall],
    ['网络丢失样本', details.qualityMetrics.network],
    ['UDP overrun', details.qualityMetrics.udpOverruns],
    ['损坏包', details.qualityMetrics.corruptPackets],
  ], { rowHeight: 24 });
  drawQualityBand(page, details.quality);

  drawSection(page, '4. 运行日志证据');
  drawLogSummary(page, details);
}

function buildPipelineReport(model, now) {
  const pages = [buildPage()];
  const overview = pages[0];
  drawHeader(overview, '分发任务运行报告', formatValue(model.pipeline.name || model.pipeline.id), now);
  const details = model.streams.map(stream => streamReportDetails(stream, model.pipeline, now, model.run));
  const taskTimeline = taskRuntimeTimeline(model, now);
  const running = details.filter(item => ['运行中', '启动中', '无信号回退中', '延时排空中'].includes(item.runtime.status)).length;
  const normalizedOutputs = model.streams.map(stream => normalizeReportOutput(stream.output || {}));
  const sampledBitrates = normalizedOutputs
    .filter(output => output.actualBitrateAvailable === true)
    .map(output => finiteNumber(output.bitrateKbps))
    .filter(value => value !== null);
  const totalBitrate = sampledBitrates.length ? sampledBitrates.reduce((sum, value) => sum + value, 0) : null;
  const measuredFps = normalizedOutputs
    .map(output => finiteNumber(output.fps ?? output.measuredFps))
    .filter(value => value !== null && value > 0);
  const averageFps = measuredFps.length ? measuredFps.reduce((sum, value) => sum + value, 0) / measuredFps.length : null;
  const summaryQuality = overallQuality(details);
  const profile = pipelineProfile(model.pipeline);
  drawMetricCards(overview, [
    { label: '任务状态', value: taskStatus(model) },
    { label: '输出数量', value: String(model.streams.length) },
    { label: '活动链路', value: String(running) },
    { label: '采样总码率', value: totalBitrate === null ? '无有效采样'
      : totalBitrate >= 1000 ? metricNumber(totalBitrate / 1000, ' Mbps') : metricNumber(totalBitrate, ' Kbps') },
    { label: '平均 FPS', value: averageFps === null ? '无有效采样' : metricNumber(averageFps) },
    { label: '综合质量判断', value: summaryQuality, color: qualityColor(summaryQuality) },
  ]);

  drawSection(overview, '1. 任务运行摘要');
  drawFieldGrid(overview, [
    ['任务 ID', model.pipeline.id],
    ['运行批次', model.run && model.run.id || '-'],
    ['输入源', pipelineInputSummary(model.pipeline, model.source)],
    ['停止方式', stopModeLabel(model.run)],
    ['开始时间', taskTimeline.startedAt],
    ['结束时间 / 推流时长', `${taskTimeline.endedAt} / ${taskTimeline.duration}`],
    ['当前 Program', model.program ? `${model.program.kind || '-'} / ${model.program.sourceLabel || model.program.mediaName || '-'}` : '-'],
    ['任务状态 / 分发模式', `${taskStatus(model)} / ${model.pipeline.mode || '-'}`],
  ], { rowHeight: 25 });

  drawSection(overview, '2. 任务编码配置');
  drawFieldGrid(overview, [
    ['视频输出', `${profile.resolution} / ${profile.fps} FPS / ${profile.bitrate} Kbps`],
    ['视频编码', `${profile.encoder} / ${profile.preset}`],
    ['音频配置', `${profile.audioEncoder} / ${profile.audioSampleRate} Hz / ${profile.channels} / ${profile.audioBitrate} Kbps`],
    ['延时与画面处理', `${profile.liveDelay} / 水印 ${profile.watermarks} / 幻灯片 ${profile.slideshowImages} / 无信号图 ${profile.noSignalImage ? '已配置' : '未配置'}`],
  ], { rowHeight: 25 });

  drawSection(overview, '3. 各目标输出对比');
  drawComparisonTable(overview, model, now, details);
  if (model.relayLogs.length) {
    const relayStats = logStatistics(model.relayLogs);
    overview.y -= 6;
    drawWrapped(
      overview,
      `共享中继证据：${relayStats.files} 个日志文件，摘要 ${relayStats.lines} 行，错误 ${relayStats.errors}，警告 ${relayStats.warnings}。`
        + '每个日志只统计末尾 20 KB 摘要，完整原始日志未纳入本 PDF。',
      PAGE_MARGIN,
      overview.y,
      CONTENT_WIDTH,
      7.8,
      COLORS.muted,
      2,
    );
    overview.y -= 21;
  }

  if (!model.streams.length) {
    drawQualityBand(overview, {
      level: '未运行',
      basis: '任务运行记录',
      reasons: ['本次任务记录未包含输出目标，无法形成逐路质量判断。'],
    });
  }

  for (let index = 0; index < model.streams.length; index += 1) {
    const page = buildPage();
    pages.push(page);
    drawStreamPage(page, model, model.streams[index], details[index], now, index);
  }
  return pages;
}

function addFooters(pages, pipelineId) {
  pages.forEach((page, index) => {
    if (page.y < CONTENT_BOTTOM) throw new Error(`Report page ${index + 1} content exceeded the footer boundary`);
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

function listPipelineRunReports(store) {
  const state = store.getState();
  return (state.pipelineRuns || [])
    .filter(run => run && run.id && run.pipelineId && run.endedAt)
    .map(run => ({
      id: run.id,
      pipelineId: run.pipelineId,
      pipelineName: run.pipeline && (run.pipeline.name || run.pipeline.id) || run.pipelineId,
      startedAt: run.startedAt || '',
      endedAt: run.endedAt || '',
      status: run.status || run.outcome || 'stopped',
      stopMode: run.stopMode || '',
      destinations: (run.destinations || []).map(destination => ({
        id: destination.id,
        name: destination.name || destination.id,
        protocol: destination.protocol || destination.type || 'rtmp',
      })),
    }))
    .sort((left, right) => (validTimeMs(right.startedAt) || 0) - (validTimeMs(left.startedAt) || 0));
}

function createPipelineReport({ store, manager, logManager, pipelineId, destinationId, runId, now }) {
  return buildPipelineReportPdf(reportModel({
    store, manager, logManager, pipelineId, destinationId, runId,
  }), now);
}

module.exports = {
  assessStreamQuality,
  buildPipelineReportPdf,
  createPipelineReport,
  listPipelineRunReports,
  reportModel,
  sanitizeReportText,
  streamRuntimeTimeline,
  streamReportDetails,
  taskRuntimeTimeline,
};
