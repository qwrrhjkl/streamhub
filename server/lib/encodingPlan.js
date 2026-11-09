function normalizeObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function normalizeEncoder(value, fallback, label) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assetHasPath(asset) {
  if (typeof asset === 'string') return asset.length > 0;
  return Boolean(asset && asset.path);
}

function visualProcessingActive(settings = {}) {
  settings = normalizeObject(settings, 'Encoding settings');
  const watermarks = Array.isArray(settings.watermarks) ? settings.watermarks : [];
  const slideshowImages = settings.slideshow && Array.isArray(settings.slideshow.images)
    ? settings.slideshow.images
    : [];

  return watermarks.some(assetHasPath)
    || assetHasPath(settings.watermark)
    || assetHasPath(settings.slideshow && settings.slideshow.preparedPath)
    || slideshowImages.some(assetHasPath);
}

function isRtmpSource(source = {}) {
  source = normalizeObject(source, 'Encoding source');
  if (source.type !== 'pull') return false;
  const input = source.inputUrl || source.url;
  return /^rtmps?:\/\//i.test(String(input || ''));
}

function createPlan(requestedVideoEncoder, videoEncoder, audioEncoder, encodingMode) {
  const requiresNvenc = encodingMode === 'nvenc';
  return {
    requestedVideoEncoder,
    videoEncoder,
    audioEncoder,
    encodingMode,
    requiresNvenc,
    filtersAllowed: encodingMode !== 'copy',
  };
}

function resolveEncodingPlan(source = {}, settings = {}, options = {}) {
  source = normalizeObject(source, 'Encoding source');
  settings = normalizeObject(settings, 'Encoding settings');
  options = normalizeObject(options, 'Encoding options');
  const nvencAvailable = options.nvencAvailable === undefined
    ? process.env.STREAMHUB_NVENC_ENABLED !== '0'
    : Boolean(options.nvencAvailable);
  const live = normalizeObject(settings.live, 'Encoding settings.live');
  const requestedVideoEncoder = normalizeEncoder(live.videoEncoder, 'auto', 'videoEncoder');
  const configuredAudioEncoder = normalizeEncoder(live.audioEncoder, 'aac', 'audioEncoder');
  if (source.type === 'fallback') {
    if (requestedVideoEncoder === 'h264_nvenc' && !nvencAvailable) {
      throw new Error('视频编码器 h264_nvenc 不可用：当前主机未检测到可用的 NVIDIA GPU，请选择 libx264（CPU）');
    }
    const videoEncoder = requestedVideoEncoder === 'libx264' ? 'libx264' : 'h264_nvenc';
    const audioEncoder = configuredAudioEncoder === 'copy' ? 'aac' : configuredAudioEncoder;
    return createPlan(
      requestedVideoEncoder,
      videoEncoder,
      audioEncoder,
      videoEncoder === 'h264_nvenc' ? 'nvenc' : 'cpu',
    );
  }
  const isCapture = source.type === 'capture';
  const isLocalMedia = source.type === 'file' || source.type === 'playlist';
  const hasVisualProcessing = visualProcessingActive(settings);

  if (requestedVideoEncoder === 'auto') {
    if (isCapture || isLocalMedia) {
      return nvencAvailable
        ? createPlan('auto', 'h264_nvenc', 'aac', 'nvenc')
        : createPlan('auto', 'libx264', 'aac', 'cpu');
    }
    if (!isRtmpSource(source)) {
      throw new Error('Video encoder "auto" only supports RTMP pull and capture inputs');
    }
    if (hasVisualProcessing) {
      return nvencAvailable
        ? createPlan('auto', 'h264_nvenc', 'copy', 'nvenc')
        : createPlan('auto', 'libx264', 'copy', 'cpu');
    }
    return createPlan('auto', 'copy', 'copy', 'copy');
  }

  if (requestedVideoEncoder === 'copy') {
    if (isCapture) throw new Error('Video encoder "copy" cannot be used with capture inputs');
    if (hasVisualProcessing) {
      throw new Error('Video encoder "copy" cannot be used with watermark or slideshow processing');
    }
    return createPlan('copy', 'copy', configuredAudioEncoder, 'copy');
  }

  if (requestedVideoEncoder === 'h264_nvenc') {
    if (!nvencAvailable) {
      throw new Error('视频编码器 h264_nvenc 不可用：当前主机未检测到可用的 NVIDIA GPU，请选择 libx264（CPU）');
    }
    return createPlan('h264_nvenc', 'h264_nvenc', configuredAudioEncoder, 'nvenc');
  }

  if (requestedVideoEncoder === 'libx264') {
    return createPlan('libx264', 'libx264', configuredAudioEncoder, 'cpu');
  }

  throw new Error(`Unsupported video encoder: ${requestedVideoEncoder}`);
}

module.exports = {
  visualProcessingActive,
  isRtmpSource,
  resolveEncodingPlan,
};
