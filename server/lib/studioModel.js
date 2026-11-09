const crypto = require('node:crypto');

const MAX_SCENE_WATERMARKS = 20;
const STREAM_URL_PATTERN = /^(?:rtmps?|srt|https?):\/\//i;

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value, fallback) {
  if (value === undefined) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function normalizeWatermarks(value) {
  const watermarks = Array.isArray(value) ? value : [];
  if (watermarks.length > MAX_SCENE_WATERMARKS) {
    throw validationError(`Scene watermarks cannot exceed ${MAX_SCENE_WATERMARKS} layers`);
  }
  return watermarks.map(item => {
    if (!isPlainObject(item) || !String(item.path || '').trim()) {
      throw validationError('Scene watermark requires a managed image path');
    }
    return clone(item, {});
  });
}

function normalizeScene(payload = {}, state = {}, existing = null) {
  if (!isPlainObject(payload)) throw validationError('Scene payload must be an object');
  const name = String(payload.name ?? (existing && existing.name) ?? '').trim();
  if (!name) throw validationError('Scene name is required');
  const sourceType = String(payload.sourceType ?? (existing && existing.sourceType) ?? 'playlist').toLowerCase();
  if (!['playlist', 'stream'].includes(sourceType)) {
    throw validationError('Scene sourceType must be playlist or stream');
  }

  const normalized = {
    ...(existing ? clone(existing, {}) : {}),
    name,
    sourceType,
    loop: true,
    watermarks: normalizeWatermarks(payload.watermarks ?? (existing && existing.watermarks)),
  };

  if (sourceType === 'playlist') {
    const playlist = clone(payload.playlist ?? (existing && existing.playlist), []);
    if (!Array.isArray(playlist) || !playlist.length) {
      throw validationError('Scene video playlist requires at least one item');
    }
    const known = new Set((state.mediaAssets || []).map(item => item.id));
    for (const mediaId of playlist) {
      if (!known.has(mediaId)) throw validationError(`Scene video asset not found: ${mediaId}`);
    }
    normalized.playlist = playlist.map(String);
    normalized.stream = null;
  } else {
    const input = payload.stream ?? (existing && existing.stream);
    const stream = isPlainObject(input) ? input : {};
    const url = String(stream.url || '').trim();
    if (!STREAM_URL_PATTERN.test(url)) throw validationError('Scene stream URL is invalid');
    let protocol;
    try {
      protocol = new URL(url).protocol.replace(':', '').toLowerCase();
    } catch {
      throw validationError('Scene stream URL is invalid');
    }
    normalized.stream = { protocol, url };
    normalized.playlist = [];
  }

  return normalized;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function taskWatermarkFingerprint(settings = {}) {
  const slideshow = isPlainObject(settings.slideshow) ? settings.slideshow : {};
  const overlays = {
    watermarks: clone(Array.isArray(settings.watermarks) ? settings.watermarks : [], []),
    slideshow: {
      images: clone(Array.isArray(slideshow.images) ? slideshow.images : [], []),
      intervalMs: slideshow.intervalMs,
      transitionMs: slideshow.transitionMs,
    },
  };
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(overlays))).digest('hex');
}

function effectiveSceneSettings(taskSettings = {}, scene = {}, asset = null, pipelineId = '') {
  const settings = clone(taskSettings, {});
  const taskWatermarks = Array.isArray(settings.watermarks) ? settings.watermarks : [];
  const sceneWatermarks = Array.isArray(scene.watermarks) ? clone(scene.watermarks, []) : [];
  const matchingRecording = Boolean(
    asset &&
    asset.sourcePipelineId === pipelineId &&
    asset.watermarkFingerprint &&
    asset.watermarkFingerprint === taskWatermarkFingerprint(taskSettings)
  );

  settings.watermarks = matchingRecording ? [] : [...sceneWatermarks, ...clone(taskWatermarks, [])];
  if (matchingRecording) {
    settings.watermark = null;
    settings.slideshow = { ...(isPlainObject(settings.slideshow) ? settings.slideshow : {}), images: [] };
  }
  return settings;
}

module.exports = {
  MAX_SCENE_WATERMARKS,
  effectiveSceneSettings,
  normalizeScene,
  taskWatermarkFingerprint,
};
