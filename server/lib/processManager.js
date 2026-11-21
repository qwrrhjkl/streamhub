const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  buildInputArgs,
  buildOutputArgs,
  buildSharedRelayArgs,
  buildRelayOutputArgs,
  createRelayChannels,
  createPreviewMirrorChannel,
  createRecordingMirrorChannel,
  createLiveDelayChannel,
  createFallbackSource,
  mergeSettings,
  resolveEncodingPlan,
  resolvePipelineSource,
  sourceFingerprint,
} = require('./ffmpegBuilder');
const { resolveSceneSource } = require('./sceneSource');
const { checkEncoderAvailability, checkNvencAvailability } = require('./encoderCapabilities');
const {
  parseFFmpegStatsLine,
  parseFFmpegStreamInfoLine,
  createFFmpegProgressAccumulator,
  mergeFFmpegProgressSnapshot,
  secondsToHuman,
  isReportableFFmpegError,
  isRelayTransportWarning,
} = require('./metrics');
const {
  MonitorHistoryStore,
  HISTORY_RETENTION_MS,
  downsample,
  sanitizeMonitorPoint,
  projectMonitorHistoryPoint,
} = require('./monitorHistoryStore');
const { MonitorHistoryQueryCoordinator } = require('./monitorHistoryQueryCoordinator');
const { ensureDir } = require('./store');
const { prepareSlideshowCache } = require('./slideshowCache');
const { prepareFallbackImage: prepareFallbackImageAsset } = require('./fallbackImageCache');
const { resolveMediaBinaries } = require('./mediaBinaries');
const { checkDecklinkAvailability } = require('./decklink');
const { createRotatingLogWriter } = require('./rotatingLogWriter');
const {
  TcpSocketStatsCollector,
  destinationSupportsTcpStats,
} = require('./tcpSocketStats');
const {
  LiveDelayBuffer,
  LiveDelayMemoryBudget,
  DEFAULT_MAX_BUFFERED_BYTES,
} = require('./liveDelayBuffer');

const BYTE_RATE_WINDOW_MS = 5 * 1000;
const BYTE_RATE_ANCHOR_TOLERANCE_MS = 2500;
const BITRATE_SHORTFALL_WARNING_PERCENT = 30;
const TRANSPORT_STARTUP_GRACE_MS = 7500;
const RELAY_METRIC_MAX_AGE_MS = 5 * 1000;
const RECOVERY_INTERVAL_MS = 3 * 1000;
const SOURCE_FAILURE_DEBOUNCE_MS = 4 * 1000;
const STARTUP_FALLBACK_GRACE_MS = 10 * 1000;
const STARTUP_SOURCE_RETRY_LIMIT = 4;
const STARTUP_SOURCE_RETRY_DELAY_MS = 1500;
const FALLBACK_SWITCH_TIMEOUT_MS = 30 * 1000;
const FALLBACK_RETRY_DELAY_MS = 3 * 1000;
const OUTPUT_RESTART_DELAY_MS = 3 * 1000;

const COPY_ENCODER_METRIC_KEYS = [
  'speed',
  'dup',
  'drop',
  'rawDroppedFrames',
  'rawDropCounterPresent',
  'encoderSpeed',
];

function sourceFailureFallbackDelay(session = {}, now = Date.now()) {
  const startedAt = Number(session.startedAt) || now;
  const remainingStartupGrace = Math.max(0, STARTUP_FALLBACK_GRACE_MS - (now - startedAt));
  return session.status === 'running'
    ? Math.max(SOURCE_FAILURE_DEBOUNCE_MS, remainingStartupGrace)
    : SOURCE_FAILURE_DEBOUNCE_MS;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function isSourceFailureMessage(value) {
  return /no (?:input )?signal|input\/output error|end of file|error opening input|failed to open input|connection reset|connection timed out|timed out/i.test(String(value || ''));
}

function sanitizeCopyMetrics(metrics) {
  const sanitized = { ...(metrics || {}) };
  for (const key of COPY_ENCODER_METRIC_KEYS) delete sanitized[key];
  return sanitized;
}

function publicDestinationDescriptor(destination = {}) {
  return {
    id: String(destination.id || ''),
    name: String(destination.name || ''),
    protocol: String(destination.protocol || destination.type || ''),
    enabled: destination.enabled !== false,
  };
}

function validateStaticWatermarkFiles(settings) {
  for (const watermark of settings.watermarks || []) {
    const filePath = String(watermark.path || '');
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      const error = new Error(`静态水印文件不存在：${path.basename(filePath) || filePath}`);
      error.statusCode = 400;
      throw error;
    }
    if (!stat.isFile()) {
      const error = new Error(`静态水印路径不是文件：${path.basename(filePath) || filePath}`);
      error.statusCode = 400;
      throw error;
    }
  }
}

function outputTargetFps(settings) {
  const fps = Number.parseFloat(settings && settings.video && settings.video.fps);
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

function outputExpectedBitrateKbps(settings) {
  const live = settings && settings.live || {};
  const forcedEncode = Boolean(
    settings && (
      (Array.isArray(settings.watermarks) && settings.watermarks.some(item => item && item.path)) ||
      (settings.watermark && settings.watermark.path) ||
      (settings.slideshow && Array.isArray(settings.slideshow.images) && settings.slideshow.images.some(item => item && item.path))
    )
  );
  if (live.videoEncoder === 'copy' && !forcedEncode) return 0;
  const bitrate = Number(live.bitrateKbps);
  return Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 0;
}

function explicitEncodingMode(videoEncoder) {
  if (videoEncoder === 'copy') return 'copy';
  if (videoEncoder === 'h264_nvenc') return 'nvenc';
  if (videoEncoder === 'libx264') return 'cpu';
  return undefined;
}

function hasFiniteMetric(metrics, key) {
  return metrics && metrics[key] !== undefined && metrics[key] !== null && Number.isFinite(Number(metrics[key]));
}

function isBitrateShortfallWarning(value) {
  const percent = Number(value);
  return Number.isFinite(percent) && Math.round(percent * 1000) / 1000 >= BITRATE_SHORTFALL_WARNING_PERCENT;
}

function outputCountersReset(previousPoint, metrics) {
  if (metrics && metrics.sessionBoundary) return true;
  if (!previousPoint) return false;
  if (
    previousPoint.rawDropCounterPresent &&
    hasFiniteMetric(previousPoint, 'rawDroppedFrames') &&
    hasFiniteMetric(metrics, 'drop') &&
    Number(metrics.drop) < Number(previousPoint.rawDroppedFrames)
  ) return true;
  return ['sizeBytes', 'frame', 'timeSec', 'tcpSentBytes', 'tcpAckedBytes'].some(key => (
    hasFiniteMetric(previousPoint, key) &&
    hasFiniteMetric(metrics, key) &&
    Number(metrics[key]) < Number(previousPoint[key])
  ));
}

function transportDeliveryMetrics(history, metrics, timestamp) {
  const source = String(metrics && metrics.transportMetricSource || '');
  const sampleAvailable = Boolean(metrics && metrics.transportSampleAvailable);
  const currentAckedBytes = Number(metrics && metrics.tcpAckedBytes);
  if (source !== 'tcp-acked' || !sampleAvailable || !Number.isFinite(currentAckedBytes)) {
    return {
      status: metrics && metrics.transportSampleStatus === 'sampling' ? 'sampling' : 'unavailable',
      bitrateKbps: null,
      sampleElapsedSec: 0,
      transportShortfallPercent: null,
    };
  }
  if (!history.length) {
    return { status: 'sampling', bitrateKbps: null, sampleElapsedSec: 0, transportShortfallPercent: null };
  }
  const previousPoint = history[history.length - 1];
  if (outputCountersReset(previousPoint, metrics)) {
    return { status: 'sampling', bitrateKbps: null, sampleElapsedSec: 0, transportShortfallPercent: null };
  }

  const targetTime = Number(timestamp) - BYTE_RATE_WINDOW_MS;
  const processSessionId = String(metrics && metrics.processSessionId || '');
  let anchor = null;
  let anchorDistance = Number.POSITIVE_INFINITY;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const point = history[index];
    if (String(point.processSessionId || '') !== processSessionId) break;
    if (
      point.transportMetricSource === 'tcp-acked' &&
      Number.isFinite(Number(point.tcpAckedBytes)) &&
      Number(point.tcpAckedBytes) <= currentAckedBytes &&
      Number(point.time) < Number(timestamp)
    ) {
      const distance = Math.abs(Number(point.time) - targetTime);
      if (distance < anchorDistance) {
        anchor = point;
        anchorDistance = distance;
      }
    }
    if (point.counterReset || point.sessionBoundary) break;
  }
  if (!anchor || anchorDistance > BYTE_RATE_ANCHOR_TOLERANCE_MS) {
    return { status: 'sampling', bitrateKbps: null, sampleElapsedSec: 0, transportShortfallPercent: null };
  }

  const elapsedMs = Number(timestamp) - Number(anchor.time);
  if (elapsedMs <= 0) {
    return { status: 'sampling', bitrateKbps: null, sampleElapsedSec: 0, transportShortfallPercent: null };
  }
  const bitrateKbps = ((currentAckedBytes - Number(anchor.tcpAckedBytes)) * 8) / elapsedMs;
  const expectedBitrateKbps = finiteNumber(metrics && metrics.expectedBitrateKbps);
  if (expectedBitrateKbps <= 0) {
    return {
      status: 'available',
      bitrateKbps,
      sampleElapsedSec: elapsedMs / 1000,
      transportShortfallPercent: null,
    };
  }

  const deliveryRatio = Math.max(0, Math.min(1, bitrateKbps / expectedBitrateKbps));
  return {
    status: 'available',
    bitrateKbps,
    deliveryRatio,
    transportShortfallPercent: (1 - deliveryRatio) * 100,
    sampleElapsedSec: elapsedMs / 1000,
  };
}

function filterMemoryHistory(points, { now = Date.now(), rangeSec = 900, from, to, maxPoints = 1200 } = {}) {
  const exact = Number.isFinite(Number(from)) && Number.isFinite(Number(to));
  const end = exact ? Number(to) : Number(now);
  const start = exact ? Number(from) : end - Math.max(0, Number(rangeSec) || 0) * 1000;
  return downsample(
    (points || []).filter(point => Number(point.time) >= start && Number(point.time) <= end),
    maxPoints,
  ).map(sanitizeMonitorPoint);
}

function recentDropToleranceFrames(expectedFrameDelta) {
  const expected = finiteNumber(expectedFrameDelta);
  if (expected <= 0) return 0;
  return Math.max(3, Math.round(expected * 0.02));
}

function latestRawDropPoint(history, metrics) {
  if (!history.length || metrics.sessionBoundary) return null;
  const processSessionId = metrics.processSessionId ? String(metrics.processSessionId) : undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const point = history[index];
    if (processSessionId) {
      if (point.processSessionId !== processSessionId) break;
    } else if (point.processSessionId) {
      break;
    }
    if (point.rawDropCounterPresent && hasFiniteMetric(point, 'rawDroppedFrames')) return point;
    if (point.sessionBoundary || point.counterReset) break;
  }
  return null;
}

function networkDropMetrics(previousPoint, metrics, timestamp, counterReset = false, transport = null) {
  const currentSessionId = String(metrics && metrics.processSessionId || '');
  const previousSessionId = String(previousPoint && previousPoint.processSessionId || '');
  const compatiblePrevious = Boolean(
    previousPoint &&
    Number(previousPoint.dropMetricVersion) === 2 &&
    !counterReset &&
    currentSessionId === previousSessionId
  );
  const previousDroppedExact = compatiblePrevious
    ? finiteNumber(previousPoint.networkDroppedFramesExact, finiteNumber(previousPoint.networkDroppedFrames))
    : 0;
  const previousExpected = compatiblePrevious ? finiteNumber(previousPoint.networkExpectedFrames) : 0;
  const previousDelivered = compatiblePrevious ? finiteNumber(previousPoint.networkDeliveredFrames) : 0;
  let networkDropDeltaExact = 0;
  let expectedFrameDelta = 0;
  let deliveredFrameDelta = 0;
  const relayTransport = Boolean(metrics && metrics.relayTransport);
  const targetFps = finiteNumber(metrics && metrics.targetFps);
  const expectedBitrateKbps = finiteNumber(metrics && metrics.expectedBitrateKbps);
  const currentRelayDroppedBytes = finiteNumber(metrics && metrics.relayDroppedBytes, Number.NaN);
  const previousRelayDroppedBytes = finiteNumber(previousPoint && previousPoint.relayDroppedBytes, Number.NaN);
  const networkDropAvailable = Boolean(
    relayTransport
    && Number.isFinite(currentRelayDroppedBytes)
    && targetFps > 0
    && expectedBitrateKbps > 0
  );

  if (compatiblePrevious && targetFps > 0) {
    const elapsedMs = Number(timestamp) - Number(previousPoint.time);
    if (elapsedMs >= 250 && elapsedMs <= 2500) {
      expectedFrameDelta = targetFps * elapsedMs / 1000;
    }
  }

  if (
    compatiblePrevious
    && networkDropAvailable
    && Number.isFinite(previousRelayDroppedBytes)
    && currentRelayDroppedBytes >= previousRelayDroppedBytes
  ) {
    const skippedBytes = currentRelayDroppedBytes - previousRelayDroppedBytes;
    const bytesPerFrame = expectedBitrateKbps * 1000 / 8 / targetFps;
    if (bytesPerFrame > 0) networkDropDeltaExact = skippedBytes / bytesPerFrame;
  }
  expectedFrameDelta = Math.max(expectedFrameDelta, networkDropDeltaExact);
  deliveredFrameDelta = Math.max(0, expectedFrameDelta - networkDropDeltaExact);
  const networkLossActive = networkDropDeltaExact > 0;

  const networkDroppedFramesExact = previousDroppedExact + networkDropDeltaExact;
  const networkDroppedFrames = Math.round(networkDroppedFramesExact);
  const previousDropped = Math.round(previousDroppedExact);
  const networkDropDelta = Math.max(0, networkDroppedFrames - previousDropped);
  const networkExpectedFrames = previousExpected + expectedFrameDelta;
  const networkDeliveredFrames = previousDelivered + deliveredFrameDelta;
  return {
    networkDropDelta,
    networkDropDeltaExact,
    networkExpectedDelta: expectedFrameDelta,
    networkDeliveredDelta: deliveredFrameDelta,
    networkDroppedFrames,
    networkDroppedFramesExact,
    networkExpectedFrames,
    networkDeliveredFrames,
    networkEstimateReady: networkDropAvailable,
    networkDropAvailable,
    networkLossActive,
    networkDropRatePercent: networkExpectedFrames > 0
      ? (networkDroppedFramesExact / networkExpectedFrames) * 100
      : 0,
  };
}

function outputDropMetrics(previousPoint, metrics, previousRawPoint = null) {
  const targetFps = finiteNumber(metrics && metrics.targetFps);
  let counterReset = outputCountersReset(previousPoint, metrics);
  if (
    !counterReset &&
    hasFiniteMetric(metrics, 'drop') &&
    previousRawPoint &&
    Number(metrics.drop) < Number(previousRawPoint.rawDroppedFrames)
  ) counterReset = true;
  const previousDropped = counterReset ? 0 : finiteNumber(previousPoint && previousPoint.totalDroppedFrames);
  const hasRawDropCounter = hasFiniteMetric(metrics, 'drop');
  const frame = hasFiniteMetric(metrics, 'frame') ? Number(metrics.frame) : Number.NaN;

  if (hasRawDropCounter) {
    const droppedFrames = Math.max(0, Number(metrics.drop));
    const previousRaw = !counterReset && previousRawPoint
      ? finiteNumber(previousRawPoint.rawDroppedFrames)
      : 0;
    const dropDelta = Math.max(0, droppedFrames - previousRaw);
    const deliveredFrames = Number.isFinite(frame)
      ? Math.max(0, frame)
      : (counterReset ? 0 : finiteNumber(previousPoint && previousPoint.deliveredFrames));
    const totalFrames = deliveredFrames + droppedFrames;
    return {
      droppedFrames,
      dropRatePercent: totalFrames > 0 ? (droppedFrames / totalFrames) * 100 : 0,
      dropDelta,
      frameDelta: Number.isFinite(frame) && !counterReset && hasFiniteMetric(previousPoint, 'frame')
        ? Math.max(0, frame - Number(previousPoint.frame))
        : 0,
      deliveredFrames,
      rawDropCounterPresent: true,
      counterReset,
    };
  }

  const timeSec = hasFiniteMetric(metrics, 'timeSec') ? Number(metrics.timeSec) : Number.NaN;
  if (targetFps > 0 && Number.isFinite(frame) && Number.isFinite(timeSec)) {
    const previousFrame = Number.isFinite(finiteNumber(previousPoint && previousPoint.frame, Number.NaN))
      ? finiteNumber(previousPoint && previousPoint.frame)
      : 0;
    const previousTimeSec = Number.isFinite(finiteNumber(previousPoint && previousPoint.timeSec, Number.NaN))
      ? finiteNumber(previousPoint && previousPoint.timeSec)
      : 0;
    const frameDelta = Math.max(0, frame - previousFrame);
    const timeDelta = Math.max(0, timeSec - previousTimeSec);
    const expectedDelta = Math.max(0, Math.round(timeDelta * targetFps));
    const dropDelta = Math.max(0, expectedDelta - frameDelta);
    const droppedFrames = previousDropped + dropDelta;
    const deliveredFrames = counterReset ? Math.max(0, frame) : finiteNumber(previousPoint && previousPoint.deliveredFrames) + frameDelta;
    const totalFrames = deliveredFrames + droppedFrames;
    return {
      droppedFrames,
      dropRatePercent: totalFrames > 0 ? (droppedFrames / totalFrames) * 100 : 0,
      dropDelta,
      frameDelta,
      expectedFrameDelta: expectedDelta,
      deliveredFrames,
      rawDropCounterPresent: false,
      counterReset,
    };
  }

  return {
    droppedFrames: previousDropped,
    dropRatePercent: finiteNumber(previousPoint && previousPoint.totalDropRatePercent),
    dropDelta: 0,
    frameDelta: 0,
    deliveredFrames: counterReset ? 0 : finiteNumber(previousPoint && previousPoint.deliveredFrames),
    rawDropCounterPresent: false,
    counterReset,
  };
}

function dropMetricsForSpan(firstPoint, lastPoint, targetFps, windowSec) {
  const first = firstPoint || {};
  const last = lastPoint || {};
  if (Number(last.dropMetricVersion) === 2) {
    const sameSession = String(first.processSessionId || '') === String(last.processSessionId || '');
    const firstDropped = sameSession && Number(first.dropMetricVersion) === 2
      ? finiteNumber(first.networkDroppedFrames)
      : 0;
    const firstExpected = sameSession && Number(first.dropMetricVersion) === 2
      ? finiteNumber(first.networkExpectedFrames)
      : 0;
    const droppedFrames = Math.max(0, finiteNumber(last.networkDroppedFrames) - firstDropped);
    const expectedFrameDelta = Math.max(0, finiteNumber(last.networkExpectedFrames) - firstExpected);
    const firstFrame = finiteNumber(first.frame, Number.NaN);
    const lastFrame = finiteNumber(last.frame, Number.NaN);
    const firstTimeSec = finiteNumber(first.timeSec, Number.NaN);
    const lastTimeSec = finiteNumber(last.timeSec, Number.NaN);
    const frameDelta = Number.isFinite(firstFrame) && Number.isFinite(lastFrame) && lastFrame >= firstFrame
      ? lastFrame - firstFrame
      : Math.max(0, expectedFrameDelta - droppedFrames);
    const spanSec = Number.isFinite(firstTimeSec) && Number.isFinite(lastTimeSec) && lastTimeSec > firstTimeSec
      ? lastTimeSec - firstTimeSec
      : Math.max(0, (Number(last.time) - Number(first.time)) / 1000);
    return {
      droppedFrames,
      dropRatePercent: expectedFrameDelta > 0 ? (droppedFrames / expectedFrameDelta) * 100 : 0,
      frameDelta,
      expectedFrameDelta,
      measuredFps: spanSec > 0 ? frameDelta / spanSec : finiteNumber(last.measuredFps || last.fps),
      spanSec,
      windowSec,
    };
  }
  if (last.rawDropCounterPresent) {
    const firstDrop = first.rawDropCounterPresent ? finiteNumber(first.rawDroppedFrames) : 0;
    const droppedFrames = Math.max(0, finiteNumber(last.rawDroppedFrames) - firstDrop);
    const firstFrame = finiteNumber(first.frame, Number.NaN);
    const lastFrame = finiteNumber(last.frame, Number.NaN);
    const firstTimeSec = finiteNumber(first.timeSec, Number.NaN);
    const lastTimeSec = finiteNumber(last.timeSec, Number.NaN);
    const frameDelta = Number.isFinite(firstFrame) && Number.isFinite(lastFrame) && lastFrame >= firstFrame
      ? lastFrame - firstFrame
      : 0;
    const timeDelta = Number.isFinite(firstTimeSec) && Number.isFinite(lastTimeSec) && lastTimeSec > firstTimeSec
      ? lastTimeSec - firstTimeSec
      : 0;
    const totalFrames = frameDelta + droppedFrames;
    return {
      droppedFrames,
      dropRatePercent: totalFrames > 0 ? (droppedFrames / totalFrames) * 100 : 0,
      frameDelta,
      expectedFrameDelta: frameDelta + droppedFrames,
      measuredFps: timeDelta > 0 ? frameDelta / timeDelta : finiteNumber(last.measuredFps || last.fps),
      spanSec: timeDelta,
      windowSec,
    };
  }
  const fps = finiteNumber(targetFps || last.targetFps);
  if (fps <= 0) {
    return {
      droppedFrames: finiteNumber(last.dropDelta),
      dropRatePercent: finiteNumber(last.dropRatePercent),
      frameDelta: finiteNumber(last.frameDelta),
      expectedFrameDelta: finiteNumber(last.expectedFrameDelta),
      measuredFps: finiteNumber(last.fps),
      windowSec,
    };
  }

  const firstFrame = finiteNumber(first.frame, Number.NaN);
  const lastFrame = finiteNumber(last.frame, Number.NaN);
  const firstTimeSec = finiteNumber(first.timeSec, Number.NaN);
  const lastTimeSec = finiteNumber(last.timeSec, Number.NaN);
  if (
    Number.isFinite(firstFrame) &&
    Number.isFinite(lastFrame) &&
    Number.isFinite(firstTimeSec) &&
    Number.isFinite(lastTimeSec) &&
    lastFrame >= firstFrame &&
    lastTimeSec > firstTimeSec
  ) {
    const timeDelta = lastTimeSec - firstTimeSec;
    const frameDelta = Math.max(0, lastFrame - firstFrame);
    const expectedFrameDelta = Math.max(0, Math.round(timeDelta * fps));
    const rawDroppedFrames = Math.max(0, expectedFrameDelta - frameDelta);
    const toleranceFrames = recentDropToleranceFrames(expectedFrameDelta);
    const droppedFrames = rawDroppedFrames <= toleranceFrames ? 0 : rawDroppedFrames;
    return {
      droppedFrames,
      dropRatePercent: expectedFrameDelta > 0 ? (droppedFrames / expectedFrameDelta) * 100 : 0,
      frameDelta,
      expectedFrameDelta,
      measuredFps: timeDelta > 0 ? frameDelta / timeDelta : 0,
      spanSec: timeDelta,
      windowSec,
    };
  }

  return {
    droppedFrames: finiteNumber(last.dropDelta),
    dropRatePercent: finiteNumber(last.dropRatePercent),
    frameDelta: finiteNumber(last.frameDelta),
    expectedFrameDelta: finiteNumber(last.expectedFrameDelta),
    measuredFps: finiteNumber(last.fps),
    windowSec,
  };
}

class ProcessManager {
  constructor({
    rootDir,
    store,
    historyStore = null,
    prepareSlideshow = prepareSlideshowCache,
    prepareFallbackImage = prepareFallbackImageAsset,
    checkNvenc = null,
    checkEncoder = null,
    checkDecklink = null,
    mediaBinaries = resolveMediaBinaries(),
    spawnProcess = spawn,
    scheduleInterval = setInterval,
    clearScheduledInterval = clearInterval,
    scheduleTimeout = setTimeout,
    clearScheduledTimeout = clearTimeout,
    probeSource = null,
    scheduleRecoveryInterval = scheduleInterval,
    clearScheduledRecoveryInterval = clearScheduledInterval,
    now = Date.now,
    tcpStatsCollector = null,
    liveDelayFactory = null,
    liveDelayMemoryBudget = null,
    createLogWriter = createRotatingLogWriter,
    historyQueryCoordinator = null,
  }) {
    this.rootDir = rootDir;
    this.store = store;
    this.logDir = path.join(rootDir, 'data', 'logs');
    ensureDir(this.logDir);
    this.sessions = new Map();
    this.pendingPipelineRestarts = new Map();
    this.pendingPipelineShutdowns = new Map();
    this.outputHistory = new Map();
    this.outputProcessSequence = 0;
    this.activeLogFiles = new Set();
    this.historyStore = historyStore || new MonitorHistoryStore({ rootDir });
    this.historyQueryCoordinator = historyQueryCoordinator || new MonitorHistoryQueryCoordinator({
      historyDir: path.join(rootDir, 'data', 'monitor-history'),
    });
    this.prepareSlideshow = prepareSlideshow;
    this.prepareFallbackImage = prepareFallbackImage;
    this.mediaBinaries = mediaBinaries;
    this.spawnProcess = spawnProcess;
    this.checkNvenc = checkNvenc || (() => checkNvencAvailability(undefined, this.mediaBinaries));
    this.checkEncoder = checkEncoder || (encoder => checkEncoderAvailability(encoder, undefined, this.mediaBinaries));
    this.checkDecklink = checkDecklink || (source => checkDecklinkAvailability(source, undefined, this.mediaBinaries));
    this.nvencReady = false;
    this.readyHardwareEncoders = new Set();
    this.scheduleInterval = scheduleInterval;
    this.clearScheduledInterval = clearScheduledInterval;
    this.scheduleTimeout = scheduleTimeout;
    this.clearScheduledTimeout = clearScheduledTimeout;
    this.probeSource = probeSource || (source => this.probeSourceWithFFprobe(source));
    this.scheduleRecoveryInterval = scheduleRecoveryInterval;
    this.clearScheduledRecoveryInterval = clearScheduledRecoveryInterval;
    this.now = now;
    this.tcpStatsCollector = tcpStatsCollector || new TcpSocketStatsCollector();
    this.liveDelayFactory = liveDelayFactory || (options => new LiveDelayBuffer(options));
    this.liveDelayMemoryBudget = liveDelayMemoryBudget || new LiveDelayMemoryBudget(DEFAULT_MAX_BUFFERED_BYTES);
    this.createLogWriter = createLogWriter;
    this.historyMaxAgeMs = 60 * 60 * 1000;
    if (typeof this.store.resetTransientPipelineStatuses === 'function') {
      this.store.resetTransientPipelineStatuses();
    }
  }

  appendLog(state, line) {
    if (!state || !state.logWriter) return;
    state.logFile = state.logWriter.append(line);
  }

  getActiveLogFiles() {
    return Array.from(this.activeLogFiles);
  }

  ensureNvencAvailable() {
    this.ensureEncoderAvailable('h264_nvenc');
  }

  ensureEncoderAvailable(encoder) {
    const id = String(encoder || '').trim();
    if (!id || this.readyHardwareEncoders.has(id)) return;
    const result = id === 'h264_nvenc' ? this.checkNvenc() : this.checkEncoder(id);
    if (!result || !result.ok) {
      const diagnostic = String(result && result.diagnostic || '').trim() || '编码测试失败';
      if (id === 'h264_nvenc') {
        throw new Error(`NVIDIA NVENC 不可用：${diagnostic}。请检查驱动、GPU 可见性和 FFmpeg h264_nvenc 支持，或显式选择 libx264 进行 CPU 编码。`);
      }
      const label = {
        h264_qsv: 'Intel Quick Sync',
        h264_amf: 'AMD AMF',
      }[id] || id;
      throw new Error(`${label} 不可用：${diagnostic}。请检查硬件、驱动和 FFmpeg 编码器支持，或选择 libx264 软件编码。`);
    }
    this.readyHardwareEncoders.add(id);
    if (id === 'h264_nvenc') this.nvencReady = true;
  }

  ensureEncodingPlanAvailable(encodingPlan) {
    const encoder = encodingPlan && encodingPlan.videoEncoder;
    if (['h264_nvenc', 'h264_qsv', 'h264_amf'].includes(encoder)) this.ensureEncoderAvailable(encoder);
  }

  ensureDecklinkAvailable(source) {
    if (!source || source.type !== 'capture' || source.capture && source.capture.backend !== 'decklink') return;
    const result = this.checkDecklink(source);
    if (!result || !result.ok) {
      const diagnostic = String(result && result.diagnostic || '').trim() || '设备或输入格式检测失败';
      throw new Error(`Blackmagic DeckLink 不可用：${diagnostic}。请检查 Desktop Video 驱动、设备连接、输入制式和 FFmpeg DeckLink 支持。`);
    }
  }

  probeSourceWithFFprobe(source) {
    return new Promise(resolve => {
      const isDecklink = source && source.type === 'capture'
        && source.capture && source.capture.backend === 'decklink';
      let completed = false;
      let timeout = null;
      const finish = result => {
        if (completed) return;
        completed = true;
        if (timeout) clearTimeout(timeout);
        resolve(Boolean(result));
      };
      let proc;
      try {
        const inputArgs = buildInputArgs(source, { forProbe: true });
        const command = isDecklink ? this.mediaBinaries.ffmpeg : this.mediaBinaries.ffprobe;
        const args = isDecklink
          ? [
            '-nostdin', '-v', 'error',
            ...inputArgs,
            '-map', '0:v:0',
            '-frames:v', '1',
            '-f', 'null', '-',
          ]
          : [
            '-v', 'error',
            '-show_entries', 'stream=codec_type',
            '-of', 'default=nw=1',
            ...inputArgs,
          ];
        proc = this.spawnProcess(command, args, { stdio: ['ignore', 'ignore', 'ignore'] });
      } catch {
        finish(false);
        return;
      }
      timeout = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        finish(false);
      }, isDecklink ? 5000 : 2000);
      if (timeout && typeof timeout.unref === 'function') timeout.unref();
      proc.once('exit', code => finish(code === 0));
      proc.once('error', () => finish(false));
    });
  }

  spawnFFmpeg(role, id, args, logName, onMetric, onExit, options = {}) {
    const startedAt = Date.now();
    const gracefulStop = options.gracefulStop === true;
    const proc = this.spawnProcess(this.mediaBinaries.ffmpeg, args, {
      stdio: [gracefulStop ? 'pipe' : 'ignore', 'ignore', 'pipe'],
    });
    const state = {
      role,
      id,
      pid: proc.pid,
      status: 'starting',
      args,
      logFile: '',
      startedAt,
      metrics: {},
      lastError: '',
      collectingOutputStreams: false,
      estimatedBitrateKbps: 0,
      estimatedFps: 0,
      udpOverruns: 0,
      corruptPackets: 0,
      progressAccumulator: createFFmpegProgressAccumulator(),
    };
    const logPrefix = path.basename(String(logName || ''), '.log');
    state.logWriter = this.createLogWriter({
      dir: this.logDir,
      prefix: logPrefix,
      now: this.now,
      onRotate: (oldFile, newFile) => {
        if (oldFile) this.activeLogFiles.delete(oldFile);
        this.activeLogFiles.add(newFile);
        state.logFile = newFile;
      },
    });
    let resolveExit;
    state.exitPromise = new Promise(resolve => { resolveExit = resolve; });

    this.appendLog(state, `\n===== ${new Date().toISOString()} START ${role} ${id} args=${args.length} redacted =====\n`);

    const processStderrRecords = records => {
      for (const raw of records) {
        const trimmed = raw.trim();
        if (!/^(?:frame|size)=/.test(trimmed)) this.appendLog(state, `${raw}\n`);
        if (isRelayTransportWarning(role, args, raw)) {
          if (/circular buffer overrun/i.test(raw)) state.udpOverruns += 1;
          if (/packet corrupt|corrupt input packet/i.test(raw)) state.corruptPackets += 1;
        }
        if (/^Output #\d+/.test(trimmed)) {
          state.collectingOutputStreams = true;
          state.estimatedBitrateKbps = 0;
          state.estimatedFps = 0;
        } else if (/^Input #\d+/.test(trimmed) || /^Stream mapping:/.test(trimmed) || /^frame=|^size=/.test(trimmed)) {
          if (!/^size=|^frame=/.test(trimmed)) state.collectingOutputStreams = false;
        }

        if (state.collectingOutputStreams) {
          const streamInfo = parseFFmpegStreamInfoLine(raw);
          if (streamInfo && streamInfo.bitrateKbps) {
            state.estimatedBitrateKbps += streamInfo.bitrateKbps;
          }
          if (streamInfo && streamInfo.type === 'video' && streamInfo.fps) {
            state.estimatedFps = streamInfo.fps;
          }
        }

        const parsed = parseFFmpegStatsLine(raw);
        if (parsed) {
          if (!parsed.bitrateKbps && state.estimatedBitrateKbps) parsed.bitrateKbps = state.estimatedBitrateKbps;
          if (!parsed.fps && state.estimatedFps) parsed.fps = state.estimatedFps;
          state.status = 'running';
          state.lastError = '';
          const previous = state.metrics;
          state.metrics = mergeFFmpegProgressSnapshot(previous, parsed, {
            udpOverruns: state.udpOverruns,
            corruptPackets: state.corruptPackets,
            updatedAt: new Date().toISOString(),
          });
          if (onMetric) onMetric(state.metrics);
        }
        if (isReportableFFmpegError(role, args, raw)) state.lastError = raw.trim().slice(0, 500);
        if (isSourceFailureMessage(raw)) {
          state.lastSourceError = raw.trim().slice(0, 500);
          if (!state.sourceFailureReported && typeof options.onSourceFailure === 'function') {
            state.sourceFailureReported = true;
            queueMicrotask(() => options.onSourceFailure(state, raw));
          }
        }
        if (/input returned/i.test(raw)) {
          state.lastSourceError = '';
          state.sourceFailureReported = false;
          if (typeof options.onSourceRecovered === 'function') {
            queueMicrotask(() => options.onSourceRecovered(state, raw));
          }
        }
      }
    };

    proc.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      processStderrRecords(state.progressAccumulator.push(text));
    });
    proc.stderr.once('end', () => processStderrRecords(state.progressAccumulator.flush()));

    proc.on('exit', (code, signal) => {
      state.status = state.stopping ? 'stopped' : 'exited';
      state.exitCode = code;
      state.signal = signal;
      state.endedAt = Date.now();
      this.appendLog(state, `\n===== ${new Date().toISOString()} EXIT code=${code} signal=${signal || ''} =====\n`);
      this.activeLogFiles.delete(state.logFile);
      state.logWriter.close();
      resolveExit(state);
      if (onExit) onExit(state);
    });

    const terminate = () => {
      if (['stopped', 'exited'].includes(state.status) || state.terminating) return;
      state.terminating = true;
      try { proc.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        if (!['stopped', 'exited'].includes(state.status)) {
          try { proc.kill('SIGKILL'); } catch {}
        }
      }, 5000).unref();
    };

    state.stop = () => {
      if (state.status === 'stopped' || state.status === 'exited') return;
      state.stopping = true;
      state.status = 'stopping';
      if (gracefulStop && proc.stdin && proc.stdin.writable && !proc.stdin.destroyed) {
        try {
          proc.stdin.write('q\n', error => {
            if (error) terminate();
          });
          setTimeout(terminate, 10000).unref();
          return;
        } catch {}
      }
      terminate();
    };

    return state;
  }

  recordOutputMetric(outputId, metrics, timestamp = Date.now()) {
    if (!outputId || !metrics) return;
    const history = this.outputHistory.get(outputId) || [];
    const previousPoint = history[history.length - 1] || null;
    const processSessionId = metrics.processSessionId ? String(metrics.processSessionId) : undefined;
    const previousSessionId = previousPoint && previousPoint.processSessionId;
    const hasSessionInMemory = history.some(point => point.processSessionId === processSessionId);
    const sessionBoundary = Boolean(processSessionId && processSessionId !== previousSessionId && !hasSessionInMemory);
    const currentMetrics = sessionBoundary ? { ...metrics, sessionBoundary: true } : metrics;
    const encodingMode = currentMetrics.encodingMode;
    const copyMode = encodingMode === 'copy';
    const transport = transportDeliveryMetrics(history, currentMetrics, timestamp);
    const versionTwo = Boolean(processSessionId || Number(currentMetrics.dropMetricVersion) === 2);
    const previousRawPoint = versionTwo ? null : latestRawDropPoint(history, currentMetrics);
    const legacyDrop = versionTwo ? null : outputDropMetrics(previousPoint, currentMetrics, previousRawPoint);
    const counterReset = versionTwo ? outputCountersReset(previousPoint, currentMetrics) : Boolean(legacyDrop.counterReset);
    const network = versionTwo ? networkDropMetrics(previousPoint, currentMetrics, timestamp, counterReset, transport) : null;
    const frame = hasFiniteMetric(currentMetrics, 'frame') ? Number(currentMetrics.frame) : undefined;
    const timeSec = hasFiniteMetric(currentMetrics, 'timeSec') ? Number(currentMetrics.timeSec) : undefined;
    const previousFrame = previousPoint ? Number(previousPoint.frame) : Number.NaN;
    const previousTimeSec = previousPoint ? Number(previousPoint.timeSec) : Number.NaN;
    const fallbackMeasuredFps = (
      Number.isFinite(previousFrame) &&
      Number.isFinite(previousTimeSec) &&
      Number.isFinite(timeSec) &&
      Number.isFinite(frame) &&
      timeSec > previousTimeSec &&
      frame >= previousFrame
    ) ? (frame - previousFrame) / (timeSec - previousTimeSec) : (Number(currentMetrics.fps) || 0);
    const measuredFps = fallbackMeasuredFps;
    const versionTwoFrameDelta = versionTwo && Number.isFinite(frame) && Number.isFinite(previousFrame) && !counterReset
      ? Math.max(0, frame - previousFrame)
      : 0;
    const droppedFrames = versionTwo ? network.networkDroppedFrames : legacyDrop.droppedFrames;
    const dropRatePercent = versionTwo ? network.networkDropRatePercent : legacyDrop.dropRatePercent;
    const actualBitrateAvailable = transport.status === 'available';
    const point = {
      time: timestamp,
      bitrateKbps: actualBitrateAvailable ? transport.bitrateKbps : null,
      reportedBitrateKbps: Number(currentMetrics.bitrateKbps) || 0,
      actualBitrateAvailable,
      actualBitrateStatus: transport.status,
      ...(currentMetrics.transportMetricSource ? { transportMetricSource: currentMetrics.transportMetricSource } : {}),
      ...(hasFiniteMetric(currentMetrics, 'tcpSentBytes') ? { tcpSentBytes: Number(currentMetrics.tcpSentBytes) } : {}),
      ...(hasFiniteMetric(currentMetrics, 'tcpAckedBytes') ? { tcpAckedBytes: Number(currentMetrics.tcpAckedBytes) } : {}),
      ...(hasFiniteMetric(currentMetrics, 'tcpRetransBytes') ? { tcpRetransBytes: Number(currentMetrics.tcpRetransBytes) } : {}),
      fps: Number(currentMetrics.fps) || 0,
      measuredFps,
      targetFps: Number(currentMetrics.targetFps) || 0,
      expectedBitrateKbps: Number(currentMetrics.expectedBitrateKbps) || 0,
      encodingMode,
      ...(hasFiniteMetric(currentMetrics, 'sizeBytes') ? { sizeBytes: Number(currentMetrics.sizeBytes) } : {}),
      transportShortfallPercent: actualBitrateAvailable && Number.isFinite(Number(transport.transportShortfallPercent))
        ? Number(transport.transportShortfallPercent)
        : null,
      sampleElapsedSec: Number(transport.sampleElapsedSec) || 0,
      udpOverruns: Number(currentMetrics.udpOverruns) || 0,
      corruptPackets: Number(currentMetrics.corruptPackets) || 0,
      relayTransport: Boolean(currentMetrics.relayTransport),
      ...(hasFiniteMetric(currentMetrics, 'relayDroppedBytes') ? {
        relayDroppedBytes: Number(currentMetrics.relayDroppedBytes),
      } : {}),
      ...(Number.isFinite(frame) ? { frame } : {}),
      ...(Number.isFinite(timeSec) ? { timeSec } : {}),
      ...(hasFiniteMetric(currentMetrics, 'drop') ? { rawDroppedFrames: Number(currentMetrics.drop) } : {}),
      rawDropCounterPresent: versionTwo
        ? hasFiniteMetric(currentMetrics, 'drop')
        : Boolean(legacyDrop.rawDropCounterPresent),
      deliveredFrames: versionTwo ? network.networkDeliveredFrames : (legacyDrop.deliveredFrames || 0),
      droppedFrames,
      dropRatePercent,
      totalDroppedFrames: droppedFrames,
      totalDropRatePercent: dropRatePercent,
      dropDelta: versionTwo ? network.networkDropDelta : legacyDrop.dropDelta,
      frameDelta: versionTwo ? versionTwoFrameDelta : legacyDrop.frameDelta,
      expectedFrameDelta: versionTwo ? network.networkExpectedDelta : (legacyDrop.expectedFrameDelta || 0),
      ...(versionTwo ? {
        dropMetricVersion: 2,
        ...network,
      } : {}),
      ...(!copyMode && hasFiniteMetric(currentMetrics, 'speed') ? { speed: Number(currentMetrics.speed) } : {}),
      counterReset,
      processSessionId,
      sessionBoundary,
      updatedAt: currentMetrics.updatedAt || new Date(timestamp).toISOString(),
    };
    history.push(point);
    const minTime = timestamp - this.historyMaxAgeMs;
    while (history.length && history[0].time < minTime) history.shift();
    this.outputHistory.set(outputId, history);
    this.historyStore.append(outputId, point);
  }

  historyForOutput(outputId, options = {}) {
    if (options.historyMode === 'none') return [];
    if (options.historyMode === 'memory') {
      return filterMemoryHistory(this.outputHistory.get(outputId) || [], options);
    }
    const { rangeSec = 0, from, to } = options;
    const now = options.now === undefined && Number.isFinite(Number(to)) ? Number(to) : (options.now || Date.now());
    const exactNow = Number(now);
    return this.historyStore.query(outputId, { now: exactNow, rangeSec, from, to });
  }

  dropDisplayBaseline(outputId) {
    const state = this.store.getState();
    const baselines = state.monitorDisplay && state.monitorDisplay.dropBaselines || {};
    return baselines[outputId] || null;
  }

  applyDropDisplayBaseline(output) {
    if (!output || !output.id) return output;
    const baseline = this.dropDisplayBaseline(output.id);
    const metrics = output.metrics || {};
    const processSessionId = String(metrics.processSessionId || '');
    if (!baseline || String(baseline.processSessionId || '') !== processSessionId) return output;

    if (Number(metrics.dropMetricVersion) === 2) {
      const rawNetworkDropped = finiteNumber(metrics.networkDroppedFrames, finiteNumber(output.totalDroppedFrames));
      const rawNetworkExpected = finiteNumber(metrics.networkExpectedFrames);
      const displayedNetworkDropped = Math.max(0, rawNetworkDropped - finiteNumber(baseline.networkDroppedFrames));
      const displayedNetworkExpected = Math.max(0, rawNetworkExpected - finiteNumber(baseline.networkExpectedFrames));
      return {
        ...output,
        totalDroppedFrames: displayedNetworkDropped,
        totalDropRatePercent: displayedNetworkExpected > 0
          ? (displayedNetworkDropped / displayedNetworkExpected) * 100
          : 0,
        dropDisplayResetAt: Number(baseline.resetAt) || 0,
      };
    }

    const rawDroppedFrames = finiteNumber(metrics.totalDroppedFrames, finiteNumber(output.totalDroppedFrames));
    const rawDeliveredFrames = finiteNumber(metrics.deliveredFrames);
    const displayedDroppedFrames = Math.max(0, rawDroppedFrames - finiteNumber(baseline.totalDroppedFrames));
    const displayedDeliveredFrames = Math.max(0, rawDeliveredFrames - finiteNumber(baseline.deliveredFrames));
    const displayedTotalFrames = displayedDeliveredFrames + displayedDroppedFrames;
    return {
      ...output,
      totalDroppedFrames: displayedDroppedFrames,
      totalDropRatePercent: displayedTotalFrames > 0 ? (displayedDroppedFrames / displayedTotalFrames) * 100 : 0,
      dropDisplayResetAt: Number(baseline.resetAt) || 0,
    };
  }

  outputDescriptorForId(outputId, options = {}) {
    const monitored = this.monitor({ ...options, outputId }).outputs[0];
    if (monitored) return monitored;
    const history = this.historyForOutput(outputId, options);
    const latest = history[history.length - 1] || null;
    if (!latest && !this.historyStore.hasHistory(outputId, {
      now: options.now || Date.now(),
      rangeSec: 259200,
    })) return null;
    const encodingMode = latest && latest.encodingMode;
    const copyMode = encodingMode === 'copy';
    const raw = {
      id: outputId,
      role: 'output',
      status: 'stopped',
      destination: null,
      pipelineId: '',
      pipelineName: '',
      sourceName: '',
      bitrateKbps: null,
      actualBitrateAvailable: false,
      actualBitrateStatus: 'unavailable',
      networkDropAvailable: false,
      fps: 0,
      encodingMode,
      encoderSpeed: copyMode ? 0 : finiteNumber(latest && latest.speed),
      targetFps: finiteNumber(latest && latest.targetFps),
      totalDroppedFrames: finiteNumber(latest && (latest.totalDroppedFrames ?? latest.droppedFrames)),
      totalDropRatePercent: finiteNumber(latest && (latest.totalDropRatePercent ?? latest.dropRatePercent)),
      uptimeSec: 0,
      uptime: '00:00:00',
      metrics: latest || {},
      history,
      lastError: '',
    };
    return this.applyDropDisplayBaseline(raw);
  }

  resetOutputDropDisplay(outputId, now = Date.now()) {
    const running = Array.from(this.sessions.values()).some(session => (
      Array.from(session.outputs.values()).some(output => output.id === outputId)
    ));
    const output = this.outputDescriptorForId(outputId, running
      ? { now, rangeSec: 0, historyMode: 'none' }
      : { now, rangeSec: 259200 });
    if (!output) {
      const error = new Error('未找到推流输出');
      error.statusCode = 404;
      throw error;
    }
    const metrics = output.metrics || {};
    const baseline = Number(metrics.dropMetricVersion) === 2
      ? {
        resetAt: now,
        processSessionId: String(metrics.processSessionId || ''),
        networkDroppedFrames: finiteNumber(metrics.networkDroppedFrames, finiteNumber(output.totalDroppedFrames)),
        networkExpectedFrames: finiteNumber(metrics.networkExpectedFrames),
      }
      : {
        resetAt: now,
        processSessionId: String(metrics.processSessionId || ''),
        totalDroppedFrames: finiteNumber(metrics.totalDroppedFrames, finiteNumber(output.totalDroppedFrames)),
        deliveredFrames: finiteNumber(metrics.deliveredFrames),
      };
    this.store.update(state => {
      if (!state.monitorDisplay) state.monitorDisplay = { dropBaselines: {} };
      if (!state.monitorDisplay.dropBaselines || typeof state.monitorDisplay.dropBaselines !== 'object') {
        state.monitorDisplay.dropBaselines = {};
      }
      state.monitorDisplay.dropBaselines[outputId] = baseline;
      return state;
    });
    return this.applyDropDisplayBaseline(output);
  }

  recentDropForOutput(outputId, { now = Date.now(), windowSec = 30 } = {}) {
    const history = this.outputHistory.get(outputId) || [];
    if (!history.length) {
      return {
        droppedFrames: 0,
        dropRatePercent: 0,
        frameDelta: 0,
        expectedFrameDelta: 0,
        measuredFps: 0,
        windowSec,
      };
    }

    const seconds = Math.max(1, Number(windowSec) || 30);
    const minTime = now - seconds * 1000;
    let points = history.filter(point => point.time >= minTime);
    if (points.length < 2 && history.length >= 2) points = history.slice(-2);
    const resetIndex = points.map(point => Boolean(point.counterReset || point.sessionBoundary)).lastIndexOf(true);
    if (resetIndex >= 0) points = points.slice(resetIndex);
    const latestPoint = points[points.length - 1];
    if (Number(latestPoint && latestPoint.dropMetricVersion) === 2) {
      const processSessionId = String(latestPoint.processSessionId || '');
      points = points.filter(point => (
        Number(point.dropMetricVersion) === 2 &&
        String(point.processSessionId || '') === processSessionId
      ));
    } else {
      const rawPoints = points.filter(point => point.rawDropCounterPresent && hasFiniteMetric(point, 'rawDroppedFrames'));
      if (rawPoints.length) points = rawPoints;
    }
    const first = points[0] || history[0];
    const last = points[points.length - 1] || history[history.length - 1];
    return dropMetricsForSpan(first, last, last && last.targetFps, seconds);
  }

  async transportMetricForOutput(output, destination) {
    if (!destinationSupportsTcpStats(destination)) {
      return {
        transportSampleAvailable: false,
        transportSampleStatus: 'unavailable',
      };
    }
    let sample;
    try {
      sample = await this.tcpStatsCollector.sample(output && output.pid);
    } catch {
      sample = { status: 'unavailable' };
    }
    if (sample && sample.status === 'available') {
      return {
        transportMetricSource: 'tcp-acked',
        transportSampleAvailable: true,
        transportSampleStatus: 'available',
        tcpSentBytes: Number(sample.tcpSentBytes),
        tcpAckedBytes: Number(sample.tcpAckedBytes),
        tcpRetransBytes: Number(sample.tcpRetransBytes) || 0,
      };
    }
    const startedAt = Number(output && output.startedAt);
    const ageMs = Number(this.now()) - startedAt;
    const starting = Number.isFinite(startedAt) && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= TRANSPORT_STARTUP_GRACE_MS;
    return {
      transportMetricSource: 'tcp-acked',
      transportSampleAvailable: false,
      transportSampleStatus: starting ? 'sampling' : 'unavailable',
    };
  }

  startOutputMetricSampler(output, outputId, snapshotProvider, destination) {
    let samplerCleared = false;
    let sampleInFlight = false;
    let sampler;
    const clearSampler = () => {
      if (samplerCleared) return;
      samplerCleared = true;
      this.clearScheduledInterval(sampler);
    };
    sampler = this.scheduleInterval(async () => {
      if (output.status === 'exited' || output.status === 'stopped') {
        clearSampler();
        return;
      }
      if (sampleInFlight) return;
      sampleInFlight = true;
      try {
        const snapshot = snapshotProvider();
        if (!snapshot) return;
        const transport = await this.transportMetricForOutput(output, destination);
        this.recordOutputMetric(outputId, { ...snapshot, ...transport }, this.now());
      } finally {
        sampleInFlight = false;
      }
    }, 1000);
    if (sampler && typeof sampler.unref === 'function') sampler.unref();

    const originalStop = typeof output.stop === 'function' ? output.stop.bind(output) : () => {};
    output.stop = () => {
      clearSampler();
      return originalStop();
    };
    output.metricSampler = sampler;
  }

  startDirectOutput(session, destination, settings, targetFps) {
    const outputId = `${session.pipelineId}-${destination.id}`;
    const processSessionId = `${outputId}:${this.now()}:${++this.outputProcessSequence}`;
    const args = buildOutputArgs(session.source, destination, settings);
    let latestWorkerMetrics = null;
    const output = this.spawnFFmpeg('output', outputId, args, `${session.pipelineId}-${destination.id}.log`, metrics => {
      const copyMetrics = session.encodingMode === 'copy'
        ? Object.fromEntries(Object.entries(metrics).filter(([key]) => !['speed', 'dup', 'drop'].includes(key)))
        : metrics;
      latestWorkerMetrics = {
        ...copyMetrics,
        targetFps,
        expectedBitrateKbps: session.expectedBitrateKbps,
        encodingMode: session.encodingMode,
        processSessionId,
      };
    }, process => this.handleSourceProcessExit(session, process));
    this.startOutputMetricSampler(output, outputId, () => latestWorkerMetrics, destination);
    output.destination = destination;
    output.encodingMode = session.encodingMode;
    session.outputs.set(destination.id, output);
    return output;
  }

  startRelayOutput(session, destination) {
    this.clearOutputRestart(session, destination.id);
    const outputId = `${session.pipelineId}-${destination.id}`;
    const processSessionId = `${outputId}:${this.now()}:${++this.outputProcessSequence}`;
    const channel = session.relayChannels && session.relayChannels.get(destination.id);
    if (!channel) throw new Error(`缺少平台 ${destination.id} 的本机中继通道`);
    const args = buildRelayOutputArgs(channel, destination);
    let latestWorkerMetrics = null;
    const output = this.spawnFFmpeg(
      'output',
      outputId,
      args,
      `${session.pipelineId}-${destination.id}.log`,
      metrics => { latestWorkerMetrics = metrics; },
      process => this.handleRelayOutputExit(session, process),
    );
    this.startOutputMetricSampler(output, outputId, () => {
      if (!latestWorkerMetrics) return null;
      const copyMode = session.encodingMode === 'copy';
      const relayProcess = session.pipelineProcess;
      const relayBuffer = this.relayBufferFor(session);
      const currentRelayMetrics = relayProcess && relayProcess.metrics || {};
      const relayUpdatedAt = Date.parse(String(currentRelayMetrics.updatedAt || ''));
      const relayMetricAgeMs = this.now() - relayUpdatedAt;
      const copyRelayFresh = Boolean(
        relayProcess &&
        relayProcess.status === 'running' &&
        Number.isFinite(relayMetricAgeMs) &&
        relayMetricAgeMs >= 0 &&
        relayMetricAgeMs <= RELAY_METRIC_MAX_AGE_MS
      );
      const relayMetrics = copyMode && !copyRelayFresh ? {} : currentRelayMetrics;
      const relayFps = copyMode
        ? positiveFinite(relayMetrics.fps)
        : (Number(relayMetrics.fps) > 0 ? relayMetrics.fps : 0);
      const relayHasProgressPair = hasFiniteMetric(relayMetrics, 'frame') && hasFiniteMetric(relayMetrics, 'timeSec');
      const relayFallback = {
        ...(relayFps > 0 ? { fps: relayFps } : {}),
        ...(!copyMode && hasFiniteMetric(relayMetrics, 'speed') ? { speed: relayMetrics.speed } : {}),
        ...(!copyMode && hasFiniteMetric(relayMetrics, 'dup') ? { dup: relayMetrics.dup } : {}),
        ...(!copyMode && hasFiniteMetric(relayMetrics, 'drop') ? { drop: relayMetrics.drop } : {}),
        ...(relayHasProgressPair ? {
          frame: relayMetrics.frame,
          timeSec: relayMetrics.timeSec,
        } : {}),
      };
      const workerMetrics = copyMode
        ? Object.fromEntries(Object.entries(latestWorkerMetrics).filter(([key]) => !['speed', 'dup', 'drop'].includes(key)))
        : latestWorkerMetrics;
      return {
        ...workerMetrics,
        ...relayFallback,
        targetFps: copyMode ? relayFps : session.targetFps,
        expectedBitrateKbps: copyMode && positiveFinite(relayMetrics.bitrateKbps) > 0
          ? positiveFinite(relayMetrics.bitrateKbps)
          : session.expectedBitrateKbps,
        encodingMode: session.encodingMode,
        relayTransport: true,
        ...(relayBuffer && typeof relayBuffer.droppedBytesForOutput === 'function' ? {
          relayDroppedBytes: relayBuffer.droppedBytesForOutput(channel.port),
        } : {}),
        processSessionId,
      };
    }, destination);
    output.destination = destination;
    output.relayChannel = channel;
    output.encodingMode = session.encodingMode;
    session.outputs.set(destination.id, output);
    return output;
  }

  sessionDestinations(session) {
    const state = this.store.getState();
    const configuredDestinations = (session.configuredDestinationIds || [])
      .map(id => (state.destinations || []).find(item => item.id === id))
      .filter(Boolean);
    return {
      configuredDestinations,
      destinations: configuredDestinations.filter(item => item.enabled !== false),
    };
  }

  setSessionSource(session, source) {
    const encodingPlan = resolveEncodingPlan(source, session.settings);
    session.source = source;
    session.encodingPlan = encodingPlan;
    session.encodingMode = encodingPlan.encodingMode;
    session.targetFps = encodingPlan.encodingMode === 'copy' ? 0 : outputTargetFps(session.settings);
    session.expectedBitrateKbps = encodingPlan.encodingMode === 'copy' ? 0 : outputExpectedBitrateKbps(session.settings);
    return encodingPlan;
  }

  fallbackSourceForSession(session) {
    const settings = session && session.settings || {};
    const image = settings.noSignalImage;
    if (!image || !image.path) return createFallbackSource(settings);
    try {
      const prepared = this.prepareFallbackImage({
        rootDir: this.rootDir,
        sourcePath: image.path,
        resolution: settings.video && settings.video.outputResolution,
        binaries: this.mediaBinaries,
      });
      return createFallbackSource({
        ...settings,
        noSignalImage: { ...image, path: prepared.preparedPath },
      }, { imagePrepared: true });
    } catch {
      return createFallbackSource(settings);
    }
  }

  startSharedRelaySource(session, relayTargets, {
    source = session.source,
    settings = session.settings,
    assign = true,
    onExit = null,
    onSourceFailure = null,
    onSourceRecovered = null,
  } = {}) {
    const args = buildSharedRelayArgs(
      source,
      relayTargets,
      settings,
    );
    const process = this.spawnFFmpeg(
      'pipeline',
      `${session.pipelineId}-relay`,
      args,
      `${session.pipelineId}-relay.log`,
      undefined,
      onExit || (process => this.handleSourceProcessExit(session, process)),
      {
        onSourceFailure: onSourceFailure
          || ((process, message) => this.handleSourceFailureSignal(session, process, message)),
        onSourceRecovered: onSourceRecovered
          || ((process, message) => this.handleSourceRecoverySignal(session, process, message)),
      },
    );
    if (assign) session.pipelineProcess = process;
    return process;
  }

  relayBufferFor(session) {
    return session ? (session.liveDelayBuffer || session.relayBridge || null) : null;
  }

  async transitionSharedRelaySource(session, {
    source,
    settings = session.settings,
    status,
    lastSourceError = '',
    patch = {},
    switchTimeoutMs = 12_000,
  }) {
    const relayBuffer = this.relayBufferFor(session);
    if (!relayBuffer || typeof relayBuffer.beginInputSwitch !== 'function') {
      throw new Error('当前共享转推中继不支持原子输入切换');
    }

    const previousProcess = session.pipelineProcess;
    const transition = relayBuffer.beginInputSwitch({ timeoutMs: switchTimeoutMs });
    let candidate = null;
    let committed = false;
    try {
      candidate = this.startSharedRelaySource(session, [session.liveDelayChannel], {
        source,
        settings,
        assign: false,
        onExit: process => {
          if (!committed) {
            transition.abort(new Error(`候选输入进程在切换前已退出（code=${process.exitCode ?? 'unknown'}）`));
            return;
          }
          queueMicrotask(() => this.handleSourceProcessExit(session, process));
        },
        onSourceFailure: (process, message) => {
          if (!committed) transition.abort(new Error(String(message || '候选输入不可用')));
          else this.handleSourceFailureSignal(session, process, message);
        },
      });
      await transition.ready;
      if (this.sessions.get(session.pipelineId) !== session || session.intentionalStop) {
        throw new Error('分发任务已停止，输入切换已取消');
      }
      await transition.commit();
      committed = true;
      this.setSessionSource(session, source);
      session.pipelineProcess = candidate;
      session.status = status;
      if (status === 'running') {
        session.startedAt = Date.now();
        session.startupSourceRetries = 0;
      }
      session.lastSourceError = lastSourceError;
      this.store.patch('pipelines', session.pipelineId, { status, ...patch });
      if (previousProcess && previousProcess !== candidate && typeof previousProcess.stop === 'function') {
        previousProcess.stop();
      }
      return candidate;
    } catch (error) {
      if (!committed) {
        try { transition.abort(error); } catch {}
        try { await transition.ready; } catch {}
        if (candidate && candidate !== previousProcess && typeof candidate.stop === 'function') {
          try { candidate.stop(); } catch {}
        }
      }
      throw error;
    }
  }

  startSessionProcesses(session, { reuseRelayOutputs = false } = {}) {
    const { configuredDestinations, destinations } = this.sessionDestinations(session);
    if (!destinations.length) throw new Error('管线没有启用的输出目标');

    if (session.mode === 'shared-relay') {
      if (!session.relayChannels) {
        const channels = createRelayChannels(session.pipelineId, configuredDestinations, {
          transport: 'tcp',
        });
        session.relayChannels = new Map(channels.map(channel => [channel.destinationId, channel]));
      }
      if (!session.previewMirror) session.previewMirror = createPreviewMirrorChannel(session.pipelineId);
      if (!session.recordingMirror) session.recordingMirror = createRecordingMirrorChannel(session.pipelineId);
      const channels = Array.from(session.relayChannels.values());
      if (!session.liveDelayChannel) session.liveDelayChannel = createLiveDelayChannel(session.pipelineId);
      const delayEnabled = session.settings.live.delayEnabled === true;
      const relayBuffer = this.relayBufferFor(session);
      if (!relayBuffer) {
        const buffer = this.liveDelayFactory({
          delaySeconds: delayEnabled ? session.settings.live.delaySeconds : 0,
          inputPort: session.liveDelayChannel.port,
          outputPorts: channels.map(channel => channel.port),
          udpOutputPorts: [session.previewMirror.port, session.recordingMirror.port],
          memoryBudget: this.liveDelayMemoryBudget,
          inputTransport: 'tcp-server',
          outputTransport: 'tcp-server',
          packetizeMpegTs: true,
          onOverflow: error => this.handleLiveDelayFailure(session, error),
          onError: error => this.handleLiveDelayFailure(session, error),
          onReady: () => {
            session.liveDelayReady = true;
            if (
              this.sessions.get(session.pipelineId) !== session
              || session.intentionalStop
            ) return;
            this.startSharedRelaySource(session, [session.liveDelayChannel]);
            if (!reuseRelayOutputs) {
              for (const destination of destinations) {
                if (!session.outputs.has(destination.id)) this.startRelayOutput(session, destination);
              }
            }
          },
        });
        if (delayEnabled) session.liveDelayBuffer = buffer;
        else session.relayBridge = buffer;
        buffer.start();
        return;
      }
      this.startSharedRelaySource(session, [session.liveDelayChannel]);
      if (!reuseRelayOutputs) {
        if (session.liveDelayReady) {
          for (const destination of destinations) {
            if (!session.outputs.has(destination.id)) this.startRelayOutput(session, destination);
          }
        }
      }
      return;
    }

    for (const destination of destinations) {
      this.startDirectOutput(session, destination, session.settings, session.targetFps);
    }
  }

  stopSourceProcess(session) {
    this.clearSourceFailureDebounce(session);
    const exits = [];
    if (session.pipelineProcess && session.pipelineProcess.status !== 'exited' && typeof session.pipelineProcess.stop === 'function') {
      if (session.pipelineProcess.exitPromise) exits.push(session.pipelineProcess.exitPromise);
      session.pipelineProcess.stop();
    }
    if (session.relay && session.relay.status !== 'exited' && typeof session.relay.stop === 'function') {
      if (session.relay.exitPromise) exits.push(session.relay.exitPromise);
      session.relay.stop();
    }
    session.pipelineProcess = null;
    session.relay = null;
    return exits;
  }

  stopOutputProcesses(session) {
    const exits = [];
    for (const timer of session.outputRestartTimers && session.outputRestartTimers.values() || []) {
      this.clearScheduledTimeout(timer);
    }
    if (session.outputRestartTimers) session.outputRestartTimers.clear();
    for (const output of session.outputs.values()) {
      if (output.exitPromise) exits.push(output.exitPromise);
      if (!['exited', 'stopped'].includes(output.status) && typeof output.stop === 'function') output.stop();
    }
    session.outputs.clear();
    return exits;
  }

  stopSessionProcesses(session, { discardDelay = true } = {}) {
    const exits = this.stopSourceProcess(session);
    const relayBuffer = this.relayBufferFor(session);
    if (discardDelay && relayBuffer) exits.push(relayBuffer.discard());
    exits.push(...this.stopOutputProcesses(session));
    return exits;
  }

  clearOutputRestart(session, destinationId) {
    const timers = session && session.outputRestartTimers;
    if (!timers || !timers.has(destinationId)) return;
    this.clearScheduledTimeout(timers.get(destinationId));
    timers.delete(destinationId);
  }

  scheduleRelayOutputRestart(session, destination) {
    if (!session.outputRestartTimers) session.outputRestartTimers = new Map();
    if (session.outputRestartTimers.has(destination.id)) return;
    const restart = () => {
      session.outputRestartTimers.delete(destination.id);
      if (
        this.sessions.get(session.pipelineId) !== session
        || session.intentionalStop
        || ['draining', 'stopped', 'error'].includes(session.status)
      ) return;
      if (session.transitioning) {
        this.scheduleRelayOutputRestart(session, destination);
        return;
      }
      const configured = (this.store.getState().destinations || []).find(item => item.id === destination.id);
      if (!configured || configured.enabled === false || session.outputs.has(destination.id)) return;
      try {
        this.startRelayOutput(session, configured);
      } catch {
        this.scheduleRelayOutputRestart(session, configured);
      }
    };
    const timer = this.scheduleTimeout(restart, OUTPUT_RESTART_DELAY_MS);
    session.outputRestartTimers.set(destination.id, timer);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  handleRelayOutputExit(session, process) {
    const destination = process && process.destination;
    if (!destination || session.outputs.get(destination.id) !== process) return;
    session.outputs.delete(destination.id);
    if (
      this.sessions.get(session.pipelineId) !== session
      || session.intentionalStop
      || ['draining', 'stopped', 'error'].includes(session.status)
    ) return;
    this.scheduleRelayOutputRestart(session, destination);
  }

  restartDelayedPipeline(session) {
    const pipelineId = session.pipelineId;
    session.intentionalStop = true;
    this.clearFallbackRecovery(session);
    const shutdowns = this.stopSessionProcesses(session);
    session.status = 'stopped';
    this.sessions.delete(pipelineId);
    this.store.patch('pipelines', pipelineId, {
      status: 'starting',
      lastStoppedAt: new Date().toISOString(),
    });

    const token = {};
    this.pendingPipelineRestarts.set(pipelineId, token);
    token.promise = Promise.allSettled(shutdowns).then(() => {
      if (this.pendingPipelineRestarts.get(pipelineId) !== token) return;
      this.pendingPipelineRestarts.delete(pipelineId);
      try {
        this.startPipeline(pipelineId);
      } catch (error) {
        this.store.patch('pipelines', pipelineId, {
          status: 'error',
          lastError: `延时直播重启失败：${String(error && error.message || error)}`,
        });
      }
    });
    return token.promise;
  }

  handleLiveDelayFailure(session, error) {
    if (this.sessions.get(session.pipelineId) !== session || session.status === 'error') return;
    session.intentionalStop = true;
    this.clearFallbackRecovery(session);
    const relayBuffer = this.relayBufferFor(session);
    if (relayBuffer && typeof relayBuffer.discard === 'function') {
      relayBuffer.discard();
    }
    this.stopSourceProcess(session);
    this.stopOutputProcesses(session);
    session.status = 'error';
    session.lastSourceError = `直播延时缓冲失败：${String(error && error.message || error || '未知错误')}`;
    this.store.patch('pipelines', session.pipelineId, {
      status: 'error',
      lastError: session.lastSourceError,
    });
  }

  clearFallbackRecovery(session) {
    if (!session) return;
    session.fallbackRecoverySuccesses = 0;
    if (session.recoveryTimer) {
      this.clearScheduledRecoveryInterval(session.recoveryTimer);
      session.recoveryTimer = null;
    }
    if (session.fallbackRetryTimer) {
      this.clearScheduledTimeout(session.fallbackRetryTimer);
      session.fallbackRetryTimer = null;
    }
  }

  clearSourceFailureDebounce(session) {
    if (!session) return;
    if (session.sourceFailureTimer) {
      this.clearScheduledTimeout(session.sourceFailureTimer);
      session.sourceFailureTimer = null;
    }
    session.sourceFailureProcess = null;
    if (session.startupSourceRetryTimer) {
      this.clearScheduledTimeout(session.startupSourceRetryTimer);
      session.startupSourceRetryTimer = null;
    }
  }

  canRetryStartupSource(session, process, now = Date.now()) {
    return Boolean(
      session
      && process
      && session.mode === 'shared-relay'
      && session.status === 'running'
      && session.source
      && session.source.type === 'capture'
      && session.liveDelayChannel
      && !session.intentionalStop
      && !session.transitioning
      && Number(session.startupSourceRetries || 0) < STARTUP_SOURCE_RETRY_LIMIT
      && now - (Number(session.startedAt) || now) < STARTUP_FALLBACK_GRACE_MS
    );
  }

  scheduleStartupSourceRetry(session, process) {
    if (!this.canRetryStartupSource(session, process)) return false;
    this.clearSourceFailureDebounce(session);
    session.startupSourceRetries = Number(session.startupSourceRetries || 0) + 1;
    const retry = () => {
      session.startupSourceRetryTimer = null;
      if (
        this.sessions.get(session.pipelineId) !== session
        || session.pipelineProcess !== process
        || session.intentionalStop
        || session.transitioning
        || session.status !== 'running'
      ) return;
      try {
        this.startSharedRelaySource(session, [session.liveDelayChannel]);
        session.lastSourceError = '采集源正在重新连接';
        this.store.patch('pipelines', session.pipelineId, { status: 'running' });
      } catch {
        if (!this.scheduleStartupSourceRetry(session, process)) {
          this.scheduleSourceFailureFallback(session, process);
        }
      }
    };
    session.startupSourceRetryTimer = this.scheduleTimeout(retry, STARTUP_SOURCE_RETRY_DELAY_MS);
    if (session.startupSourceRetryTimer && typeof session.startupSourceRetryTimer.unref === 'function') {
      session.startupSourceRetryTimer.unref();
    }
    return true;
  }

  scheduleFallbackRetry(session) {
    if (!session || session.fallbackRetryTimer) return;
    const retry = async () => {
      session.fallbackRetryTimer = null;
      if (
        this.sessions.get(session.pipelineId) !== session
        || session.intentionalStop
        || session.status === 'fallback'
      ) return;
      await this.enterFallback(session);
    };
    session.fallbackRetryTimer = this.scheduleTimeout(retry, FALLBACK_RETRY_DELAY_MS);
    if (session.fallbackRetryTimer && typeof session.fallbackRetryTimer.unref === 'function') {
      session.fallbackRetryTimer.unref();
    }
  }

  scheduleFallbackRecovery(session) {
    if (session.recoveryTimer || session.status !== 'fallback') return;
    session.recoveryTimer = this.scheduleRecoveryInterval(() => this.probeFallbackSource(session), RECOVERY_INTERVAL_MS);
    if (session.recoveryTimer && typeof session.recoveryTimer.unref === 'function') session.recoveryTimer.unref();
  }

  probeFallbackSource(session) {
    if (this.sessions.get(session.pipelineId) !== session || session.status !== 'fallback' || session.probing) return;
    session.probing = true;
    const complete = async available => {
      if (!available || this.sessions.get(session.pipelineId) !== session || session.status !== 'fallback') {
        session.fallbackRecoverySuccesses = 0;
        session.probing = false;
        return;
      }
      session.fallbackRecoverySuccesses = (session.fallbackRecoverySuccesses || 0) + 1;
      if (session.fallbackRecoverySuccesses < 2) {
        session.probing = false;
        return;
      }
      session.fallbackRecoverySuccesses = 0;
      try {
        await this.restoreOriginalSource(session);
      } finally {
        session.probing = false;
      }
    };
    try {
      const result = this.probeSource(session.originalSource);
      if (result && typeof result.then === 'function') return result.then(complete, () => complete(false));
      return complete(result);
    } catch {
      return complete(false);
    }
  }

  async enterFallback(session) {
    if (
      this.sessions.get(session.pipelineId) !== session ||
      session.intentionalStop ||
      session.transitioning ||
      session.status === 'fallback'
    ) return;
    session.transitioning = true;
    session.fallbackRecoverySuccesses = 0;
    session.startupSourceRetries = 0;
    try {
      const fallbackSource = this.fallbackSourceForSession(session);
      const encodingPlan = resolveEncodingPlan(fallbackSource, session.settings);
      this.ensureEncodingPlanAvailable(encodingPlan);
      const lastSourceError = '输入信号不可用，正在推送无信号画面和静音并等待恢复';
      if (session.mode === 'shared-relay') {
        await this.transitionSharedRelaySource(session, {
          source: fallbackSource,
          status: 'fallback',
          lastSourceError,
          switchTimeoutMs: FALLBACK_SWITCH_TIMEOUT_MS,
        });
      } else {
        const exits = this.stopSessionProcesses(session);
        if (exits.length) await Promise.allSettled(exits);
        if (this.sessions.get(session.pipelineId) !== session || session.intentionalStop) return;
        this.setSessionSource(session, fallbackSource);
        session.status = 'fallback';
        session.lastSourceError = lastSourceError;
        this.startSessionProcesses(session);
        this.store.patch('pipelines', session.pipelineId, { status: 'fallback' });
      }
      this.scheduleFallbackRecovery(session);
    } catch {
      this.clearFallbackRecovery(session);
      const relayBuffer = this.relayBufferFor(session);
      const relayStatus = relayBuffer && typeof relayBuffer.describe === 'function'
        ? relayBuffer.describe().status
        : null;
      if (
        session.mode === 'shared-relay'
        && this.sessions.get(session.pipelineId) === session
        && !session.intentionalStop
        && relayBuffer
        && !['error', 'stopped'].includes(relayStatus)
      ) {
        session.status = 'running';
        session.lastSourceError = '输入信号不可用，无信号画面切换正在重试';
        this.store.patch('pipelines', session.pipelineId, { status: 'running' });
        this.scheduleFallbackRetry(session);
        return;
      }
      this.stopSessionProcesses(session);
      session.status = 'error';
      session.lastSourceError = '黑屏静音回退启动失败，请检查编码器和输出配置';
      this.store.patch('pipelines', session.pipelineId, { status: 'error' });
    } finally {
      session.transitioning = false;
    }
  }

  async restoreOriginalSource(session) {
    if (this.sessions.get(session.pipelineId) !== session || session.status !== 'fallback' || session.transitioning) return;
    session.transitioning = true;
    if (session.mode === 'shared-relay') {
      try {
        this.ensureDecklinkAvailable(session.originalSource);
        const originalPlan = resolveEncodingPlan(session.originalSource, session.settings);
        this.ensureEncodingPlanAvailable(originalPlan);
        await this.transitionSharedRelaySource(session, {
          source: session.originalSource,
          status: 'running',
          patch: { lastStartedAt: new Date().toISOString() },
        });
        this.clearFallbackRecovery(session);
      } catch {
        session.fallbackRecoverySuccesses = 0;
        session.status = 'fallback';
        session.lastSourceError = '输入信号仍不可用，继续推送无信号画面和静音';
        this.store.patch('pipelines', session.pipelineId, { status: 'fallback' });
        this.scheduleFallbackRecovery(session);
      } finally {
        session.transitioning = false;
      }
      return;
    }

    try {
      this.ensureDecklinkAvailable(session.originalSource);
      const originalPlan = resolveEncodingPlan(session.originalSource, session.settings);
      this.ensureEncodingPlanAvailable(originalPlan);
      this.clearFallbackRecovery(session);
      const exits = this.stopSessionProcesses(session);
      if (exits.length) await Promise.allSettled(exits);
      if (this.sessions.get(session.pipelineId) !== session || session.intentionalStop) return;
      this.setSessionSource(session, session.originalSource);
      session.status = 'running';
      session.startedAt = Date.now();
      session.startupSourceRetries = 0;
      session.lastSourceError = '';
      this.startSessionProcesses(session);
      this.store.patch('pipelines', session.pipelineId, { status: 'running', lastStartedAt: new Date().toISOString() });
    } catch {
      try {
        const exits = this.stopSessionProcesses(session);
        if (exits.length) await Promise.allSettled(exits);
        if (this.sessions.get(session.pipelineId) !== session || session.intentionalStop) return;
        const fallbackPlan = this.setSessionSource(session, this.fallbackSourceForSession(session));
        this.ensureEncodingPlanAvailable(fallbackPlan);
        session.status = 'fallback';
        session.lastSourceError = '输入信号仍不可用，继续推送黑屏和静音';
        this.startSessionProcesses(session);
        this.store.patch('pipelines', session.pipelineId, { status: 'fallback' });
        this.scheduleFallbackRecovery(session);
      } catch {
        session.status = 'error';
        session.lastSourceError = '黑屏静音回退启动失败，请检查编码器和输出配置';
        this.store.patch('pipelines', session.pipelineId, { status: 'error' });
      }
    } finally {
      session.transitioning = false;
    }
  }

  scheduleSourceFailureFallback(session, process) {
    this.clearSourceFailureDebounce(session);
    let timer = null;
    const confirmFailure = async () => {
      if (session.sourceFailureTimer !== timer || session.sourceFailureProcess !== process) return;
      session.sourceFailureTimer = null;
      session.sourceFailureProcess = null;
      if (
        this.sessions.get(session.pipelineId) !== session
        || session.pipelineProcess !== process
        || session.intentionalStop
        || session.transitioning
      ) return;
      await this.enterFallback(session);
    };
    session.sourceFailureProcess = process;
    timer = this.scheduleTimeout(confirmFailure, sourceFailureFallbackDelay(session));
    session.sourceFailureTimer = timer;
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  handleSourceFailureSignal(session, process, message) {
    if (
      this.sessions.get(session.pipelineId) !== session
      || session.pipelineProcess !== process
      || session.intentionalStop
      || session.transitioning
      || session.source.type !== 'capture'
      || !/no (?:input )?signal|cannot autodetect input stream/i.test(String(message || ''))
    ) return;
    this.scheduleSourceFailureFallback(session, process);
  }

  handleSourceRecoverySignal(session, process) {
    if (
      this.sessions.get(session.pipelineId) !== session
      || session.pipelineProcess !== process
      || session.intentionalStop
      || session.source.type !== 'capture'
    ) return;
    this.clearSourceFailureDebounce(session);
  }

  handleSourceProcessExit(session, process) {
    if (this.sessions.get(session.pipelineId) !== session || session.intentionalStop || session.transitioning) return;
    if (session.mode === 'shared-relay' && session.pipelineProcess !== process) return;
    this.clearSourceFailureDebounce(session);
    if (session.source.type === 'fallback') {
      this.clearFallbackRecovery(session);
      this.stopSessionProcesses(session);
      session.status = 'error';
      session.lastSourceError = '黑屏静音回退进程已结束，请检查编码器和输出配置';
      this.store.patch('pipelines', session.pipelineId, { status: 'error' });
      return;
    }
    if (!isSourceFailureMessage(process && (process.lastSourceError || process.lastError))) return;
    if (this.scheduleStartupSourceRetry(session, process)) return;
    this.scheduleSourceFailureFallback(session, process);
  }

  startPipeline(pipelineId) {
    if (this.pendingPipelineRestarts.has(pipelineId)) {
      const error = new Error('延时直播正在等待旧进程退出，请稍后重试');
      error.statusCode = 409;
      throw error;
    }
    if (this.pendingPipelineShutdowns.has(pipelineId)) {
      const error = new Error('延时直播正在等待旧进程退出，请稍后重试');
      error.statusCode = 409;
      throw error;
    }
    const state = this.store.getState();
    const pipeline = state.pipelines.find(item => item.id === pipelineId);
    if (!pipeline) throw new Error(`未找到管线 ${pipelineId}`);

    const source = resolvePipelineSource(pipeline, state, {
      resolveSceneSource: (sceneId, sceneState) => resolveSceneSource(sceneId, sceneState, this.rootDir),
    });
    this.ensureDecklinkAvailable(source);
    const configuredDestinations = (pipeline.destinationIds || [])
      .map(id => state.destinations.find(item => item.id === id))
      .filter(Boolean);
    const destinations = configuredDestinations.filter(item => item.enabled !== false);
    if (!destinations.length) throw new Error('管线没有启用的输出目标');

    const settings = mergeSettings(pipeline.settings);
    validateStaticWatermarkFiles(settings);
    const encodingPlan = resolveEncodingPlan(source, settings);
    const mode = settings.live.delayEnabled
      ? 'shared-relay'
      : (pipeline.mode || (destinations.length > 1 || source.type === 'capture' ? 'shared-relay' : 'direct'));
    if (encodingPlan.encodingMode === 'copy' && mode === 'direct') {
      const error = new Error('原样复制必须使用共享转推，直连推送只支持 CPU 或 NVENC 编码');
      error.statusCode = 400;
      throw error;
    }
    this.ensureEncodingPlanAvailable(encodingPlan);
    const existingSession = this.sessions.get(pipelineId);
    if (this.relayBufferFor(existingSession)) {
      const error = new Error('共享转推任务正在运行，请先停止后再重新开始');
      error.statusCode = 409;
      throw error;
    }
    if (existingSession) this.stopPipeline(pipelineId);
    if (settings.slideshow.images.length) {
      const prepared = this.prepareSlideshow({
        rootDir: this.rootDir,
        slideshow: settings.slideshow,
        resolution: settings.video.outputResolution,
        fps: settings.video.fps,
        binaries: this.mediaBinaries,
      });
      if (prepared.preparedPath) settings.slideshow.preparedPath = prepared.preparedPath;
    }
    const copyMode = encodingPlan.encodingMode === 'copy';
    const targetFps = copyMode ? 0 : outputTargetFps(settings);
    const expectedBitrateKbps = copyMode ? 0 : outputExpectedBitrateKbps(settings);
    const session = {
      pipelineId,
      name: pipeline.name,
      mode,
      source,
      originalSource: source,
      pipelineOriginalSource: source,
      pipelineOriginalSettings: mergeSettings(settings),
      settings,
      encodingPlan,
      encodingMode: encodingPlan.encodingMode,
      targetFps,
      expectedBitrateKbps,
      sourceFingerprint: sourceFingerprint(source),
      configuredDestinationIds: (pipeline.destinationIds || []).slice(),
      outputs: new Map(),
      outputRestartTimers: new Map(),
      startedAt: Date.now(),
      status: 'running',
      lastSourceError: '',
      recoveryTimer: null,
      fallbackRetryTimer: null,
      sourceFailureTimer: null,
      sourceFailureProcess: null,
      fallbackRecoverySuccesses: 0,
      startupSourceRetries: 0,
      startupSourceRetryTimer: null,
      probing: false,
      transitioning: false,
      intentionalStop: false,
      stopPromise: null,
      liveDelayBuffer: null,
      relayBridge: null,
      liveDelayChannel: null,
      liveDelayReady: false,
      program: {
        pipelineId,
        kind: 'original',
        label: '原直播源',
        sourceLabel: source.name || pipeline.name || '原直播源',
        switchedAt: new Date().toISOString(),
        mediaIds: [],
      },
    };

    this.sessions.set(pipelineId, session);
    try {
      this.startSessionProcesses(session);
    } catch (error) {
      session.intentionalStop = true;
      this.stopSessionProcesses(session);
      this.sessions.delete(pipelineId);
      throw error;
    }

    this.store.patch('pipelines', pipelineId, { status: 'running', lastStartedAt: new Date().toISOString() });
    return this.describeSession(session);
  }

  reconcileDestination(destinationId) {
    const state = this.store.getState();
    const destination = (state.destinations || []).find(item => item.id === destinationId) || null;
    const sessions = Array.from(this.sessions.values());
    const reconciled = [];

    for (const session of sessions) {
      const pipeline = (state.pipelines || []).find(item => item.id === session.pipelineId);
      const configured = Boolean(pipeline && (pipeline.destinationIds || []).includes(destinationId));
      const hasOutput = session.outputs.has(destinationId);
      if (!configured && !hasOutput) continue;

      const enabled = Boolean(configured && destination && destination.enabled !== false);
      if (session.liveDelayBuffer) {
        if (session.intentionalStop || !['running', 'fallback'].includes(session.status)) {
          reconciled.push({ pipelineId: session.pipelineId, destinationId, action: 'ignored-stopping' });
          continue;
        }
        const hasEnabledDestination = (pipeline && pipeline.destinationIds || [])
          .map(id => (state.destinations || []).find(item => item.id === id))
          .some(item => item && item.enabled !== false);
        if (hasEnabledDestination) {
          this.restartDelayedPipeline(session);
          reconciled.push({ pipelineId: session.pipelineId, destinationId, action: 'restarting-pipeline' });
        } else {
          this.stopPipeline(session.pipelineId);
          reconciled.push({ pipelineId: session.pipelineId, destinationId, action: 'stopped' });
        }
        continue;
      }
      if (session.mode === 'shared-relay') {
        const existing = session.outputs.get(destinationId);
        if (existing && typeof existing.stop === 'function') existing.stop();
        if (existing) session.outputs.delete(destinationId);
        if (enabled) this.startRelayOutput(session, destination);
        reconciled.push({ pipelineId: session.pipelineId, destinationId, action: enabled ? 'started' : 'removed' });
        continue;
      }

      const existing = session.outputs.get(destinationId);
      if (existing && typeof existing.stop === 'function') existing.stop();
      if (existing) session.outputs.delete(destinationId);
      if (enabled) {
        const settings = session.settings || mergeSettings(pipeline && pipeline.settings);
        this.startDirectOutput(session, destination, settings, session.targetFps ?? outputTargetFps(settings));
      }
      if (!session.outputs.size) this.stopPipeline(session.pipelineId);
      reconciled.push({ pipelineId: session.pipelineId, destinationId, action: enabled ? 'restarted' : 'removed' });
    }

    return { ok: true, reconciled };
  }

  reconcileRoom(roomId) {
    const state = this.store.getState();
    const room = (state.rooms || []).find(item => item.id === roomId) || null;
    const sessions = Array.from(this.sessions.values());
    const reconciled = [];

    for (const session of sessions) {
      const pipeline = (state.pipelines || []).find(item => item.id === session.pipelineId);
      const usesRoom = session.source && session.source.roomId === roomId
        || pipeline && pipeline.input && pipeline.input.type === 'room' && pipeline.input.roomId === roomId;
      if (!usesRoom) continue;
      if (!room || room.enabled === false) {
        this.stopPipeline(session.pipelineId);
        reconciled.push({ pipelineId: session.pipelineId, roomId, action: 'stopped' });
      } else {
        this.startPipeline(session.pipelineId);
        reconciled.push({ pipelineId: session.pipelineId, roomId, action: 'restarted' });
      }
    }

    return { ok: true, reconciled };
  }

  findPreviewSource(source) {
    const fingerprint = sourceFingerprint(source);
    for (const session of this.sessions.values()) {
      if (!['running', 'fallback'].includes(session.status) || session.sourceFingerprint !== fingerprint) continue;
      if (session.mode === 'shared-relay' && session.previewMirror) {
        return { kind: 'relay', previewMirror: { ...session.previewMirror } };
      }
      if (session.status === 'fallback' && session.source.type === 'fallback') {
        return { kind: 'fallback', source: { ...session.source } };
      }
      if (session.mode === 'shared-relay') return { kind: 'relay-restart-required' };
      if (session.mode === 'direct' && session.source.type === 'capture') return { kind: 'direct-capture' };
    }
    return null;
  }

  programState(pipelineId) {
    const session = this.sessions.get(pipelineId);
    return session && session.program ? JSON.parse(JSON.stringify(session.program)) : null;
  }

  programStates() {
    return Object.fromEntries(Array.from(this.sessions.keys()).map(pipelineId => [pipelineId, this.programState(pipelineId)]));
  }

  findProgramPreviewSource(pipelineId) {
    const session = this.sessions.get(pipelineId);
    if (!session || !['running', 'fallback'].includes(session.status)) return null;
    if (session.mode !== 'shared-relay' || !session.previewMirror) return null;
    return {
      kind: 'relay',
      previewMirror: { ...session.previewMirror },
      sourceLabel: session.program && session.program.label || session.name || '当前节目',
      epoch: session.program && session.program.switchedAt || '',
    };
  }

  recordingInput(pipelineId) {
    const session = this.sessions.get(pipelineId);
    if (!session || !['running', 'fallback'].includes(session.status)) {
      const error = new Error('分发任务当前没有运行，无法录制');
      error.statusCode = 409;
      throw error;
    }
    if (session.mode !== 'shared-relay' || !session.recordingMirror) {
      const error = new Error('录制只支持正在运行的共享转推任务');
      error.statusCode = 409;
      throw error;
    }
    return {
      ...session.recordingMirror,
      bitrateKbps: positiveFinite(session.pipelineProcess && session.pipelineProcess.metrics && session.pipelineProcess.metrics.bitrateKbps),
    };
  }

  isMediaInProgram(mediaId) {
    return Array.from(this.sessions.values()).some(session => (
      session.program && Array.isArray(session.program.mediaIds) && session.program.mediaIds.includes(mediaId)
    ));
  }

  async transitionProgram(session, { source, settings, program }) {
    const nextSettings = mergeSettings(settings);
    validateStaticWatermarkFiles(nextSettings);
    this.ensureDecklinkAvailable(source);
    const nextPlan = resolveEncodingPlan(source, nextSettings);
    this.ensureEncodingPlanAvailable(nextPlan);

    const relayBuffer = this.relayBufferFor(session);
    if (!relayBuffer || typeof relayBuffer.beginInputSwitch !== 'function') {
      throw new Error('当前共享转推中继不支持原子节目切换');
    }
    const previousProcess = session.pipelineProcess;
    const transition = relayBuffer.beginInputSwitch({ timeoutMs: 12_000 });
    let candidate = null;
    let committed = false;
    session.transitioning = true;
    this.clearFallbackRecovery(session);
    try {
      candidate = this.startSharedRelaySource(session, [session.liveDelayChannel], {
        source,
        settings: nextSettings,
        assign: false,
        onExit: process => {
          if (!committed) {
            transition.abort(new Error(`候选节目进程在切换前已退出（code=${process.exitCode ?? 'unknown'}）`));
            return;
          }
          queueMicrotask(() => this.handleSourceProcessExit(session, process));
        },
        onSourceFailure: (process, message) => {
          if (!committed) transition.abort(new Error(String(message || '候选节目输入不可用')));
          else this.handleSourceFailureSignal(session, process, message);
        },
      });
      await transition.ready;
      if (this.sessions.get(session.pipelineId) !== session || session.intentionalStop) {
        throw new Error('分发任务已停止，节目切换已取消');
      }
      transition.commit();
      committed = true;
      session.settings = nextSettings;
      this.setSessionSource(session, source);
      session.sourceFingerprint = sourceFingerprint(source);
      session.originalSource = source;
      session.status = 'running';
      session.lastSourceError = '';
      session.pipelineProcess = candidate;
      session.program = {
        pipelineId: session.pipelineId,
        kind: String(program.kind || 'scene'),
        label: String(program.label || '画面场景'),
        sourceLabel: String(program.sourceLabel || source.name || program.label || '画面场景'),
        sceneId: String(program.sceneId || ''),
        mediaId: String(program.mediaId || ''),
        mediaIds: Array.isArray(program.mediaIds) ? program.mediaIds.map(String) : [],
        switchedAt: new Date().toISOString(),
      };
      this.store.patch('pipelines', session.pipelineId, { status: 'running' });
      if (previousProcess && previousProcess !== candidate && typeof previousProcess.stop === 'function') {
        previousProcess.stop();
      }
      return this.programState(session.pipelineId);
    } catch (error) {
      if (!committed) {
        try { transition.abort(error); } catch {}
        try { await transition.ready; } catch {}
        if (candidate && candidate !== previousProcess && typeof candidate.stop === 'function') {
          try { candidate.stop(); } catch {}
        }
      }
      throw error;
    } finally {
      session.transitioning = false;
    }
  }

  switchProgram(pipelineId, snapshot = {}) {
    const session = this.sessions.get(pipelineId);
    if (!session || !['running', 'fallback'].includes(session.status)) {
      const error = new Error('分发任务当前没有运行，无法切换画面');
      error.statusCode = 409;
      throw error;
    }
    if (session.mode !== 'shared-relay') {
      const error = new Error('画面切换只支持共享转推任务');
      error.statusCode = 409;
      throw error;
    }
    if (session.transitioning) {
      const error = new Error('分发任务正在切换画面，请稍后重试');
      error.statusCode = 409;
      throw error;
    }
    if (!snapshot.source) {
      const error = new Error('待切换画面缺少输入源');
      error.statusCode = 400;
      throw error;
    }
    return this.transitionProgram(session, {
      source: { ...snapshot.source },
      settings: snapshot.settings || session.pipelineOriginalSettings,
      program: snapshot,
    });
  }

  restoreProgram(pipelineId) {
    const session = this.sessions.get(pipelineId);
    if (!session || !['running', 'fallback'].includes(session.status)) {
      const error = new Error('分发任务当前没有运行，无法恢复直播源');
      error.statusCode = 409;
      throw error;
    }
    if (session.mode !== 'shared-relay') {
      const error = new Error('画面切换只支持共享转推任务');
      error.statusCode = 409;
      throw error;
    }
    return this.transitionProgram(session, {
      source: { ...session.pipelineOriginalSource },
      settings: session.pipelineOriginalSettings,
      program: {
        kind: 'original',
        label: '原直播源',
        sourceLabel: session.pipelineOriginalSource.name || session.name || '原直播源',
        mediaIds: [],
      },
    });
  }

  finishPipelineStop(session) {
    if (this.sessions.get(session.pipelineId) !== session) return;
    this.stopOutputProcesses(session);
    session.liveDelayBuffer = null;
    session.relayBridge = null;
    session.status = 'stopped';
    this.sessions.delete(session.pipelineId);
    this.store.patch('pipelines', session.pipelineId, {
      status: 'stopped',
      lastStoppedAt: new Date().toISOString(),
    });
  }

  stopPipeline(pipelineId, { mode = 'discard', waitForExit = false } = {}) {
    this.pendingPipelineRestarts.delete(pipelineId);
    const session = this.sessions.get(pipelineId);
    if (!session) {
      try { this.store.patch('pipelines', pipelineId, { status: 'stopped', lastStoppedAt: new Date().toISOString() }); } catch {}
      return { ok: true, status: 'not-running' };
    }

    const drainDelay = mode === 'drain' && session.liveDelayBuffer;
    if (drainDelay) {
      if (session.status === 'draining') {
        return { ok: true, status: 'draining', liveDelay: session.liveDelayBuffer.describe() };
      }
      session.intentionalStop = true;
      this.clearFallbackRecovery(session);
      session.status = 'draining';
      this.store.patch('pipelines', pipelineId, { status: 'draining' });
      const sourceExits = this.stopSourceProcess(session);
      const outputExits = Array.from(session.outputs.values())
        .map(output => output.exitPromise)
        .filter(Boolean);
      session.stopPromise = (async () => {
        await Promise.allSettled(sourceExits);
        if (this.sessions.get(pipelineId) !== session || session.status !== 'draining') return;
        await session.liveDelayBuffer.beginDrain();
        if (this.sessions.get(pipelineId) !== session || session.status !== 'draining') return;
        await Promise.allSettled(outputExits);
        if (this.sessions.get(pipelineId) !== session || session.status !== 'draining') return;
        this.finishPipelineStop(session);
      })().catch(error => this.handleLiveDelayFailure(session, error));
      return { ok: true, status: 'draining', liveDelay: session.liveDelayBuffer.describe() };
    }

    session.intentionalStop = true;
    this.clearFallbackRecovery(session);
    const delayedShutdown = Boolean(this.relayBufferFor(session));
    const shutdowns = this.stopSessionProcesses(session);
    const shutdownPromise = Promise.allSettled(shutdowns);
    if (delayedShutdown) {
      const token = {};
      this.pendingPipelineShutdowns.set(pipelineId, token);
      token.promise = shutdownPromise.finally(() => {
        if (this.pendingPipelineShutdowns.get(pipelineId) === token) {
          this.pendingPipelineShutdowns.delete(pipelineId);
        }
      });
    }
    session.status = 'stopped';
    this.sessions.delete(pipelineId);
    this.store.patch('pipelines', pipelineId, { status: 'stopped', lastStoppedAt: new Date().toISOString() });
    if (waitForExit) return shutdownPromise.then(() => ({ ok: true, status: 'stopped' }));
    return { ok: true, status: 'stopped' };
  }

  describeProcess(proc) {
    const uptimeSec = proc.startedAt ? Math.floor((Date.now() - proc.startedAt) / 1000) : 0;
    return {
      id: proc.id,
      role: proc.role,
      pid: proc.pid,
      status: proc.status,
      uptimeSec,
      uptime: secondsToHuman(uptimeSec),
      logFile: proc.logFile,
      lastError: proc.lastError || '',
      metrics: proc.metrics || {},
      bitrateKbps: proc.metrics && proc.metrics.bitrateKbps ? proc.metrics.bitrateKbps : 0,
      fps: proc.metrics && proc.metrics.fps ? proc.metrics.fps : 0,
      droppedFrames: proc.metrics && proc.metrics.drop ? proc.metrics.drop : 0,
      dropRatePercent: proc.metrics && proc.metrics.dropRatePercent ? proc.metrics.dropRatePercent : 0,
      udpOverruns: proc.metrics && proc.metrics.udpOverruns ? proc.metrics.udpOverruns : 0,
      corruptPackets: proc.metrics && proc.metrics.corruptPackets ? proc.metrics.corruptPackets : 0,
      exitCode: proc.exitCode,
      signal: proc.signal,
    };
  }

  describeOutput(output, options = {}) {
    const history = this.historyForOutput(output.id, options);
    const fullHistory = this.outputHistory.get(output.id) || [];
    const latestFullPoint = fullHistory[fullHistory.length - 1] || null;
    const recentDrop = this.recentDropForOutput(output.id, {
      now: options.now || Date.now(),
      windowSec: options.recentDropWindowSec || 30,
    });
    if (output.sharedProcess) {
      const described = this.describeProcess(output.sharedProcess);
      const latest = latestFullPoint || history[history.length - 1] || null;
      const encodingMode = output.encodingMode || latest && latest.encodingMode;
      const copyMode = encodingMode === 'copy';
      const combinedMetrics = latest
        ? { ...(described.metrics || {}), ...latest }
        : (described.metrics || {});
      return {
        ...described,
        ...(latest ? {
          metrics: { ...(described.metrics || {}), ...latest },
          bitrateKbps: latest.bitrateKbps,
          actualBitrateAvailable: Boolean(latest.actualBitrateAvailable),
          actualBitrateStatus: latest.actualBitrateStatus || 'unavailable',
          transportMetricSource: latest.transportMetricSource,
          fps: latest.fps,
          targetFps: latest.targetFps,
          totalDroppedFrames: finiteNumber(latest.totalDroppedFrames, finiteNumber(latest.droppedFrames)),
          totalDropRatePercent: finiteNumber(latest.totalDropRatePercent, finiteNumber(latest.dropRatePercent)),
          encoderSpeed: finiteNumber(latest.speed),
        } : {}),
        droppedFrames: recentDrop.droppedFrames,
        dropRatePercent: recentDrop.dropRatePercent,
        recentDroppedFrames: recentDrop.droppedFrames,
        recentDropRatePercent: recentDrop.dropRatePercent,
        recentDropWindowSec: recentDrop.windowSec,
        recentFrameDelta: recentDrop.frameDelta,
        recentExpectedFrameDelta: recentDrop.expectedFrameDelta,
        recentMeasuredFps: recentDrop.measuredFps,
        bitrateKbps: latest && latest.actualBitrateAvailable ? latest.bitrateKbps : null,
        actualBitrateAvailable: Boolean(latest && latest.actualBitrateAvailable),
        actualBitrateStatus: latest && latest.actualBitrateStatus || 'unavailable',
        transportMetricSource: latest && latest.transportMetricSource,
        networkDropAvailable: Boolean(latest && latest.networkDropAvailable),
        networkLossActive: Boolean(latest && latest.networkLossActive),
        transportShortfallPercent: latest && Number.isFinite(Number(latest.transportShortfallPercent))
          ? Number(latest.transportShortfallPercent)
          : null,
        udpOverruns: Number(latest && latest.udpOverruns) || described.udpOverruns || 0,
        corruptPackets: Number(latest && latest.corruptPackets) || described.corruptPackets || 0,
        id: output.id,
        role: output.role || 'output',
        destination: publicDestinationDescriptor(output.destination),
        encodingMode,
        metrics: sanitizeMonitorPoint(copyMode ? sanitizeCopyMetrics(combinedMetrics) : combinedMetrics),
        ...(copyMode ? {
          encoderSpeed: 0,
        } : {}),
        history,
      };
    }
    const described = this.describeProcess(output);
    const latest = latestFullPoint || history[history.length - 1] || null;
    const encodingMode = output.encodingMode || latest && latest.encodingMode;
    const copyMode = encodingMode === 'copy';
    const combinedMetrics = latest
      ? { ...(described.metrics || {}), ...latest }
      : (described.metrics || {});
    return {
      ...described,
      ...(latest ? {
        metrics: { ...(described.metrics || {}), ...latest },
        bitrateKbps: latest.bitrateKbps,
        actualBitrateAvailable: Boolean(latest.actualBitrateAvailable),
        actualBitrateStatus: latest.actualBitrateStatus || 'unavailable',
        transportMetricSource: latest.transportMetricSource,
        fps: latest.fps,
        targetFps: latest.targetFps,
        totalDroppedFrames: finiteNumber(latest.totalDroppedFrames, finiteNumber(latest.droppedFrames)),
        totalDropRatePercent: finiteNumber(latest.totalDropRatePercent, finiteNumber(latest.dropRatePercent)),
        encoderSpeed: finiteNumber(latest.speed),
      } : {}),
      droppedFrames: recentDrop.droppedFrames,
      dropRatePercent: recentDrop.dropRatePercent,
      recentDroppedFrames: recentDrop.droppedFrames,
      recentDropRatePercent: recentDrop.dropRatePercent,
      recentDropWindowSec: recentDrop.windowSec,
      recentFrameDelta: recentDrop.frameDelta,
      recentExpectedFrameDelta: recentDrop.expectedFrameDelta,
      recentMeasuredFps: recentDrop.measuredFps,
      bitrateKbps: latest && latest.actualBitrateAvailable ? latest.bitrateKbps : null,
      actualBitrateAvailable: Boolean(latest && latest.actualBitrateAvailable),
      actualBitrateStatus: latest && latest.actualBitrateStatus || 'unavailable',
      transportMetricSource: latest && latest.transportMetricSource,
      networkDropAvailable: Boolean(latest && latest.networkDropAvailable),
      networkLossActive: Boolean(latest && latest.networkLossActive),
      transportShortfallPercent: latest && Number.isFinite(Number(latest.transportShortfallPercent))
        ? Number(latest.transportShortfallPercent)
        : null,
      udpOverruns: Number(latest && latest.udpOverruns) || described.udpOverruns || 0,
      corruptPackets: Number(latest && latest.corruptPackets) || described.corruptPackets || 0,
      destination: publicDestinationDescriptor(output.destination),
      encodingMode,
      metrics: sanitizeMonitorPoint(copyMode ? sanitizeCopyMetrics(combinedMetrics) : combinedMetrics),
      ...(copyMode ? {
        encoderSpeed: 0,
      } : {}),
      history,
    };
  }

  describeSession(session, options = {}) {
    const liveDelay = session.liveDelayBuffer
      ? session.liveDelayBuffer.describe()
      : {
        enabled: false,
        delaySeconds: 0,
        status: 'disabled',
        bufferedBytes: 0,
        bufferedPackets: 0,
        remainingSeconds: 0,
      };
    return {
      pipelineId: session.pipelineId,
      name: session.name,
      mode: session.mode,
      encodingMode: session.encodingMode,
      status: session.status,
      fallback: session.status === 'fallback',
      message: session.status === 'fallback' ? session.lastSourceError : '',
      liveDelay,
      source: {
        id: session.source.id,
        name: session.source.name,
        type: session.source.type,
        roomId: session.source.roomId || '',
      },
      program: this.programState(session.pipelineId),
      relay: session.pipelineProcess ? this.describeProcess(session.pipelineProcess) : (session.relay ? this.describeProcess(session.relay) : null),
      outputs: Array.from(session.outputs.values()).map(output => this.describeOutput(output, options)),
    };
  }

  monitor(options = {}) {
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const requestedRangeSec = options.rangeSec === undefined ? 900 : Math.max(0, Number(options.rangeSec) || 0);
    const rangeSec = Math.min(259200, requestedRangeSec);
    const hasExactRange = Number.isFinite(Number(options.from)) && Number.isFinite(Number(options.to));
    if (hasExactRange && Number(options.to) < Number(options.from)) throw new Error('结束时间不能早于开始时间');
    const retentionStart = now - HISTORY_RETENTION_MS;
    const from = hasExactRange
      ? Math.max(retentionStart, Number(options.from))
      : now - (rangeSec || 259200) * 1000;
    const to = hasExactRange ? Math.min(now, Number(options.to)) : now;
    const monitorOptions = {
      ...options,
      now,
      rangeSec: hasExactRange ? 0 : rangeSec,
      ...(hasExactRange ? { from, to } : {}),
      recentDropWindowSec: options.recentDropWindowSec || 30,
    };
    const active = Array.from(this.sessions.values()).map(session => this.describeSession(session, monitorOptions));
    const activeOutputs = active.flatMap(session => session.outputs.map(output => ({
      ...output,
      pipelineId: session.pipelineId,
      pipelineName: session.name,
      sourceName: session.source.name,
      pipelineStatus: session.status,
      pipelineMessage: session.message || '',
    })));
    const state = this.store.getState();
    const activeOutputIds = new Set(activeOutputs.map(output => output.id));
    const inactiveOutputs = (state.pipelines || []).flatMap(pipeline => (pipeline.destinationIds || []).map(destinationId => {
      const destination = (state.destinations || []).find(item => item.id === destinationId);
      const id = `${pipeline.id}-${destinationId}`;
      if (!destination || activeOutputIds.has(id)) return null;
      const history = this.historyForOutput(id, monitorOptions);
      const persistentHistory = monitorOptions.historyMode !== 'none' && monitorOptions.historyMode !== 'memory';
      const hasRetainedHistory = history.length > 0 || (
        persistentHistory && this.historyStore.hasHistory(id, { now, rangeSec: 259200 })
      );
      if (persistentHistory && destination.enabled !== false && !hasRetainedHistory) return null;
      const latest = history[history.length - 1] || null;
      const retainedLatest = latest || (
        persistentHistory
          ? this.historyStore.query(id, { now, rangeSec: 259200, maxPoints: 2 }).at(-1)
          : (this.outputHistory.get(id) || []).at(-1)
      ) || null;
      const savedVideoEncoder = pipeline.settings && pipeline.settings.live && pipeline.settings.live.videoEncoder;
      const encodingMode = retainedLatest && retainedLatest.encodingMode || explicitEncodingMode(savedVideoEncoder);
      const copyMode = encodingMode === 'copy';
      return {
        id,
        role: 'output',
        status: destination.enabled === false ? 'disabled' : 'stopped',
        destination: publicDestinationDescriptor(destination),
        pipelineId: pipeline.id,
        pipelineName: pipeline.name,
        sourceName: '',
        bitrateKbps: null,
        actualBitrateAvailable: false,
        actualBitrateStatus: 'unavailable',
        networkDropAvailable: false,
        fps: 0,
        encodingMode,
        encoderSpeed: copyMode ? 0 : Number(latest && latest.speed) || 0,
        targetFps: Number(latest && latest.targetFps) || 0,
        droppedFrames: 0,
        dropRatePercent: 0,
        totalDroppedFrames: Number(latest && (latest.totalDroppedFrames ?? latest.droppedFrames)) || 0,
        totalDropRatePercent: Number(latest && (latest.totalDropRatePercent ?? latest.dropRatePercent)) || 0,
        uptimeSec: 0,
        uptime: '00:00:00',
        metrics: latest || {},
        history,
        lastError: '',
      };
    })).filter(Boolean);
    const allOutputs = [...activeOutputs, ...inactiveOutputs];
    const outputId = String(options.outputId || '');
    const selectedOutputs = outputId ? allOutputs.filter(output => output.id === outputId) : allOutputs;
    const outputs = selectedOutputs.map(output => this.applyDropDisplayBaseline(output));
    const runningOutputs = outputs.filter(output => output.status !== 'disabled' && output.status !== 'stopped');
    return {
      activePipelines: active,
      outputs,
      totals: {
        pipelines: active.length,
        outputs: runningOutputs.length,
        disabledOutputs: outputs.length - runningOutputs.length,
        bitrateKbps: runningOutputs
          .filter(item => item.actualBitrateAvailable)
          .reduce((sum, item) => sum + (Number(item.bitrateKbps) || 0), 0),
        actualBitrateAvailable: runningOutputs.some(item => item.actualBitrateAvailable),
        actualBitrateSampling: runningOutputs.some(item => item.actualBitrateStatus === 'sampling'),
        errors: runningOutputs.filter(item => (
          item.lastError ||
          item.status === 'exited' ||
          (item.actualBitrateAvailable && isBitrateShortfallWarning(item.transportShortfallPercent))
        )).length,
      },
      range: {
        now,
        from,
        to,
        rangeSec: hasExactRange ? Math.max(0, (to - from) / 1000) : rangeSec,
        ...(hasExactRange ? { exact: true } : {}),
      },
    };
  }

  publicMonitor(options = {}) {
    return this.projectPublicMonitor(this.monitor(options));
  }

  projectPublicMonitor(monitor) {
    return {
      ...monitor,
      activePipelines: (monitor.activePipelines || []).map(pipeline => ({
        ...pipeline,
        outputs: (pipeline.outputs || []).map(({ history, ...output }) => output),
      })),
      outputs: (monitor.outputs || []).map(output => ({
        ...output,
        history: (output.history || []).map(projectMonitorHistoryPoint).filter(Boolean),
      })),
    };
  }

  async monitorPersistent(options = {}, { signal } = {}) {
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    const requestedRangeSec = options.rangeSec === undefined ? 900 : Math.max(0, Number(options.rangeSec) || 0);
    const rangeSec = Math.min(259200, requestedRangeSec);
    const hasExactRange = Number.isFinite(Number(options.from)) && Number.isFinite(Number(options.to));
    if (hasExactRange && Number(options.to) < Number(options.from)) throw new Error('结束时间不能早于开始时间');
    const retentionFrom = now - HISTORY_RETENTION_MS;
    const from = hasExactRange ? Math.max(retentionFrom, Number(options.from)) : now - (rangeSec || 259200) * 1000;
    const to = hasExactRange ? Math.min(now, Number(options.to)) : now;
    const outputId = String(options.outputId || '');
    const activeOutputIds = new Set(Array.from(this.sessions.values()).flatMap(session => (
      Array.from(session.outputs.values()).map(output => output.id)
    )));
    const state = this.store.getState();
    const configuredOutputIds = (state.pipelines || []).flatMap(pipeline => (
      (pipeline.destinationIds || []).map(destinationId => `${pipeline.id}-${destinationId}`)
    ));
    const outputIds = Array.from(new Set([...configuredOutputIds, ...activeOutputIds]))
      .filter(id => !outputId || id === outputId);
    const historyResults = await this.historyQueryCoordinator.query({
      outputs: outputIds.map(id => ({ id, active: activeOutputIds.has(id) })),
      range: {
        now,
        from,
        to,
        rangeSec: hasExactRange ? Math.max(0, (to - from) / 1000) : rangeSec,
        ...(hasExactRange ? { exact: true } : {}),
      },
      retentionFrom,
      maxPoints: this.historyStore.maxPoints,
    }, { signal });
    const historyById = new Map(historyResults.map(result => [result.id, result]));
    const live = this.monitor({ ...options, now, historyMode: 'none' });
    const destinationsById = new Map((state.destinations || []).map(destination => [destination.id, destination]));
    const outputs = live.outputs.flatMap(output => {
      const historyResult = historyById.get(output.id) || {
        history: [],
        retainedLatest: null,
        hasRetainedHistory: false,
      };
      if (!activeOutputIds.has(output.id)) {
        const destinationId = output.destination && output.destination.id;
        const destination = destinationsById.get(destinationId) || output.destination || {};
        if (destination.enabled !== false && !historyResult.hasRetainedHistory) return [];
      }
      const retained = historyResult.retainedLatest || {};
      if (activeOutputIds.has(output.id)) {
        return [{ ...output, history: historyResult.history || [] }];
      }
      const encodingMode = retained.encodingMode || output.encodingMode;
      const copyMode = encodingMode === 'copy';
      const raw = {
        ...output,
        encodingMode,
        encoderSpeed: copyMode ? 0 : finiteNumber(retained.speed, output.encoderSpeed),
        targetFps: finiteNumber(retained.targetFps, output.targetFps),
        totalDroppedFrames: finiteNumber(retained.totalDroppedFrames, finiteNumber(retained.droppedFrames, output.totalDroppedFrames)),
        totalDropRatePercent: finiteNumber(retained.totalDropRatePercent, finiteNumber(retained.dropRatePercent, output.totalDropRatePercent)),
        networkDropAvailable: Boolean(retained.networkDropAvailable),
        networkLossActive: Boolean(retained.networkLossActive),
        metrics: retained,
        history: historyResult.history || [],
      };
      return [this.applyDropDisplayBaseline(raw)];
    });
    const runningOutputs = outputs.filter(output => output.status !== 'disabled' && output.status !== 'stopped');
    return this.projectPublicMonitor({
      ...live,
      outputs,
      totals: {
        ...live.totals,
        outputs: runningOutputs.length,
        disabledOutputs: outputs.length - runningOutputs.length,
      },
    });
  }

  closeMonitorHistoryQueries() {
    if (this.historyQueryCoordinator && typeof this.historyQueryCoordinator.close === 'function') {
      this.historyQueryCoordinator.close();
    }
  }
}

module.exports = { ProcessManager, sourceFailureFallbackDelay };
