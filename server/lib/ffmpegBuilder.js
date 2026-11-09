const crypto = require('node:crypto');
const { resolveEncodingPlan } = require('./encodingPlan');

const DEFAULT_SETTINGS = {
  live: {
    videoEncoder: 'auto',
    audioEncoder: 'aac',
    bitrateKbps: 8000,
    keyframeSec: 2,
    preset: 'veryfast',
    profile: 'high',
    delayEnabled: false,
    delaySeconds: 20,
  },
  video: {
    outputResolution: '1920x1080',
    fps: '59.94',
  },
  audio: {
    sampleRate: '48000',
    channels: 'stereo',
    tracks: [{ bitrateKbps: 320 }],
  },
  watermark: null,
  watermarks: [],
  noSignalImage: null,
  slideshow: {
    images: [],
    intervalMs: 2000,
    transitionMs: 700,
    loop: true,
  },
};

const MAX_OVERLAY_IMAGES = 20;
const SHARED_RELAY_MPEGTS_OPTIONS = 'f=mpegts:mpegts_flags=+initial_discontinuity+resend_headers';

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function settingsValidationError(message) {
  const error = new Error(`Invalid FFmpeg configuration: ${message}`);
  error.statusCode = 400;
  return error;
}

function overlayValidationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeOverlayLayout(value) {
  if (!isPlainObject(value)) return undefined;
  const x = value.x;
  const y = value.y;
  const width = value.width;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || width <= 0) return undefined;
  return { x, y, width };
}

function normalizeAssetList(value, label) {
  const assets = (Array.isArray(value) ? value : []).filter(item => item && item.path);
  if (assets.length > MAX_OVERLAY_IMAGES) {
    throw overlayValidationError(`${label}最多添加 ${MAX_OVERLAY_IMAGES} 张图片`);
  }
  return assets.map(item => {
    const { layout: rawLayout, ...asset } = item;
    const layout = normalizeOverlayLayout(rawLayout);
    return {
      ...asset,
      path: String(item.path),
      ...(layout ? { layout } : {}),
    };
  });
}

function normalizeSlideshow(input) {
  const value = isPlainObject(input) ? input : {};
  const layout = normalizeOverlayLayout(value.layout);
  return {
    images: normalizeAssetList(value.images, '幻灯片'),
    intervalMs: Number.isFinite(Number(value.intervalMs)) ? Number(value.intervalMs) : 2000,
    transitionMs: Number.isFinite(Number(value.transitionMs)) ? Number(value.transitionMs) : 700,
    loop: true,
    ...(layout ? { layout } : {}),
    ...(value.preparedPath ? { preparedPath: String(value.preparedPath) } : {}),
  };
}

function filterFrameRate(value) {
  const text = String(value || '').trim();
  if (!/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/.test(text)) return '59.94';
  const [numerator, denominator = '1'] = text.split('/');
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? text : '59.94';
}

function formatFilterNumber(value) {
  return String(Number(Number(value).toFixed(10)));
}

function mergeSettings(input) {
  if (input != null && !isPlainObject(input)) {
    throw settingsValidationError('settings must be a plain object');
  }
  const settings = input || {};
  if (Object.prototype.hasOwnProperty.call(settings, 'live') && !isPlainObject(settings.live)) {
    throw settingsValidationError('settings.live must be a plain object');
  }
  const legacyWatermark = settings.watermark && settings.watermark.path
    ? { ...settings.watermark, path: String(settings.watermark.path) }
    : null;
  const watermarks = Array.isArray(settings.watermarks)
    ? normalizeAssetList(settings.watermarks, '静态水印')
    : normalizeAssetList(legacyWatermark ? [legacyWatermark] : [], '静态水印');
  const noSignalImage = isPlainObject(settings.noSignalImage) && String(settings.noSignalImage.path || '').trim()
    ? { ...settings.noSignalImage, path: String(settings.noSignalImage.path).trim() }
    : null;
  const liveInput = settings.live || {};
  const delayEnabled = liveInput.delayEnabled === true;
  const parsedDelaySeconds = Number(liveInput.delaySeconds ?? DEFAULT_SETTINGS.live.delaySeconds);
  const delaySeconds = Number.isInteger(parsedDelaySeconds) ? parsedDelaySeconds : DEFAULT_SETTINGS.live.delaySeconds;
  if (delayEnabled && (delaySeconds < 1 || delaySeconds > 300)) {
    throw settingsValidationError('直播延时必须在 1 至 300 秒之间');
  }
  return {
    live: {
      ...DEFAULT_SETTINGS.live,
      ...liveInput,
      delayEnabled,
      delaySeconds,
    },
    video: { ...DEFAULT_SETTINGS.video, ...(settings.video || {}) },
    audio: {
      ...DEFAULT_SETTINGS.audio,
      ...(settings.audio || {}),
      tracks: (
        Array.isArray(settings.audio && settings.audio.tracks) && settings.audio.tracks.length
          ? settings.audio.tracks
          : DEFAULT_SETTINGS.audio.tracks
      ).map(track => isPlainObject(track) ? { ...track } : track),
    },
    watermark: legacyWatermark,
    watermarks,
    noSignalImage,
    slideshow: normalizeSlideshow(settings.slideshow),
  };
}

function hashId(value) {
  const text = String(value || 'streamhub');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function buildDestinationUrl(destination) {
  if (!destination) throw new Error('Destination is required');
  const protocol = String(destination.protocol || destination.type || '').toLowerCase();
  if (destination.url && String(destination.url).trim()) return normalizeDestinationTarget(protocol, String(destination.url).trim());
  const server = normalizeDestinationTarget(protocol, String(destination.server || '').trim());
  const streamKey = String(destination.streamKey || destination.secret || '').trim();
  if (!server || !streamKey) throw new Error('Destination requires url or server + streamKey');
  return `${server.replace(/\/+$/, '')}/${streamKey.replace(/^\/+/, '')}`;
}

function hasUrlScheme(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value || ''));
}

function normalizeDestinationTarget(protocol, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const type = String(protocol || '').toLowerCase();
  if ((type === 'rtmp' || type === 'rtmps') && !hasUrlScheme(text)) {
    return `${type}://${text.replace(/^\/+/, '')}`;
  }
  if (type === 'srt' && !hasUrlScheme(text)) {
    return `srt://${text.replace(/^\/+/, '')}`;
  }
  return text;
}

function buildInputArgs(source, { forProbe = false } = {}) {
  if (!source) throw new Error('Source is required');
  if (source.type === 'fallback') {
    const settings = mergeSettings(source.settings);
    const channels = settings.audio.channels === 'mono' ? 'mono' : 'stereo';
    const imagePath = settings.noSignalImage && settings.noSignalImage.path;
    if (imagePath) {
      return [
        '-re', '-loop', '1', '-framerate', filterFrameRate(settings.video.fps), '-i', imagePath,
        '-re', '-f', 'lavfi', '-i', `anullsrc=channel_layout=${channels}:sample_rate=${settings.audio.sampleRate || '48000'}`,
      ];
    }
    return [
      '-re', '-f', 'lavfi', '-i', `color=c=black:s=${settings.video.outputResolution}:r=${filterFrameRate(settings.video.fps)}`,
      '-re', '-f', 'lavfi', '-i', `anullsrc=channel_layout=${channels}:sample_rate=${settings.audio.sampleRate || '48000'}`,
    ];
  }
  if (source.inputUrl) return ['-i', source.inputUrl];

  if (source.type === 'playlist') {
    const manifestPath = String(source.manifestPath || '').trim();
    if (!manifestPath) throw new Error('Playlist source requires a concat manifest');
    return ['-stream_loop', '-1', '-re', '-f', 'concat', '-safe', '0', '-i', manifestPath];
  }

  if (source.type === 'capture') {
    const capture = source.capture || {};
    const backend = capture.backend || 'v4l2';
    if (backend === 'decklink') {
      const device = String(capture.device || '').trim();
      if (!device) throw new Error('DeckLink 设备名称不能为空');
      const formatCode = String(capture.formatCode || 'auto').trim();
      const rawFormat = String(capture.rawFormat || 'uyvy422').trim().toLowerCase();
      const allowedRawFormats = new Set(['auto', 'uyvy422', 'yuv422p10', 'argb', 'bgra', 'rgb10']);
      if (!allowedRawFormats.has(rawFormat)) throw new Error(`DeckLink 像素格式不受支持：${rawFormat}`);
      const audioChannels = Number(capture.audioChannels === undefined ? 2 : capture.audioChannels);
      if (![2, 8, 16].includes(audioChannels)) throw new Error(`DeckLink 音频声道数不受支持：${capture.audioChannels}`);
      const args = forProbe ? ['-f', 'decklink'] : ['-thread_queue_size', '1024', '-f', 'decklink'];
      if (formatCode && formatCode.toLowerCase() !== 'auto') args.push('-format_code', formatCode);
      if (rawFormat !== 'auto') args.push('-raw_format', rawFormat);
      if (!forProbe) args.push('-signal_loss_action', 'repeat');
      args.push('-channels', String(audioChannels), '-i', device);
      return args;
    }
    if (backend !== 'v4l2') throw new Error(`采集接口不受支持：${backend}`);
    const args = [
      '-thread_queue_size', '1024',
      '-f', 'v4l2',
      '-framerate', String(capture.fps || '59.94'),
      '-video_size', String(capture.resolution || '1920x1080'),
      '-i', String(capture.videoDevice || source.device || '/dev/video0'),
    ];
    if (capture.audioDevice && capture.audioDevice !== 'disabled') {
      args.push('-thread_queue_size', '1024', '-f', 'alsa', '-i', String(capture.audioDevice));
    }
    return args;
  }

  if (source.type === 'file') {
    const args = [];
    if (source.loop) args.push('-stream_loop', '-1', '-re');
    args.push('-i', String(source.path || source.url));
    return args;
  }

  const url = source.url || source.target || source.input;
  if (!url) throw new Error('Source url is required');
  return ['-i', String(url)];
}

function createFallbackSource(settings, { imagePrepared = false } = {}) {
  const merged = mergeSettings(settings);
  return {
    id: 'fallback-source',
    name: '输入信号不可用，黑屏静音回退',
    type: 'fallback',
    isFallback: true,
    fallbackKind: merged.noSignalImage ? 'custom' : 'black',
    fallbackImagePrepared: Boolean(merged.noSignalImage && imagePrepared),
    settings: merged,
  };
}

function roomPlaybackUrl(room, state = {}) {
  const port = Number(state.settings && state.settings.rtmpPort || 1935);
  return `rtmp://127.0.0.1:${port}/live/${room.streamName}`;
}

function resolvePipelineSource(pipeline, state = {}) {
  if (!pipeline) throw new Error('Pipeline is required');
  const input = pipeline.input || null;

  if (input && input.type === 'room') {
    const room = (state.rooms || []).find(item => item.id === input.roomId);
    if (!room) throw new Error('本地直播间不存在');
    if (room.enabled === false) throw new Error('本地直播间已禁用');
    return {
      id: `room-source-${room.id}`,
      name: `本地直播间：${room.name}`,
      type: 'pull',
      url: roomPlaybackUrl(room, state),
      roomId: room.id,
      sharedRelay: true,
    };
  }

  if (input && input.type === 'url') {
    if (!input.url) throw new Error('URL 输入源需要填写地址');
    return {
      id: 'inline-url',
      name: input.name || 'URL 输入源',
      type: 'pull',
      url: input.url,
      sharedRelay: true,
    };
  }

  if (input && input.type === 'file') {
    if (!input.path && !input.url) throw new Error('本地视频文件需要填写路径');
    const fileSource = {
      id: 'inline-file',
      name: input.name || '本地视频文件',
      type: 'file',
      path: input.path || input.url,
      loop: input.loop !== false,
      sharedRelay: true,
    };
    if (input.url) fileSource.url = input.url;
    return fileSource;
  }

  if (input && input.type === 'capture') {
    const capture = input.capture || {};
    const backend = capture.backend || 'v4l2';
    if (backend === 'decklink') {
      return {
        id: 'inline-capture',
        name: input.name || 'DeckLink 采集信号',
        type: 'capture',
        capture: {
          ...capture,
          backend,
          device: capture.device || '',
          formatCode: capture.formatCode || 'auto',
          rawFormat: capture.rawFormat || 'uyvy422',
          audioChannels: Number(capture.audioChannels || 2),
        },
        sharedRelay: true,
      };
    }
    return {
      id: 'inline-capture',
      name: input.name || '采集卡信号',
      type: 'capture',
      capture: {
        ...capture,
        backend,
        videoDevice: capture.videoDevice || '/dev/video0',
        audioDevice: capture.audioDevice || 'disabled',
        resolution: capture.resolution || '1920x1080',
        fps: capture.fps || '59.94',
      },
      sharedRelay: true,
    };
  }

  if (pipeline.sourceId) {
    const source = (state.sources || []).find(item => item.id === pipeline.sourceId);
    if (!source) throw new Error('管线没有有效输入源');
    if (source.type === 'capture') {
      const capture = source.capture || {};
      return {
        ...source,
        capture: { ...capture, backend: capture.backend || 'v4l2' },
      };
    }
    return source;
  }

  throw new Error('管线没有配置输入源');
}

function sourceInputLayout(source) {
  if (source && source.type === 'fallback') {
    return { audioInputIndex: 1, firstVisualInputIndex: 2 };
  }
  const capture = source && source.type === 'capture' ? source.capture || {} : {};
  const hasSeparateAudio = capture.backend !== 'decklink' && Boolean(capture.audioDevice && capture.audioDevice !== 'disabled');
  return {
    audioInputIndex: hasSeparateAudio ? 1 : 0,
    firstVisualInputIndex: hasSeparateAudio ? 2 : 1,
  };
}

function normalizePullTimeline(source, encodingPlan) {
  return Boolean(
    source
    && source.type === 'pull'
    && encodingPlan
    && encodingPlan.videoEncoder !== 'copy'
    && encodingPlan.audioEncoder !== 'copy'
  );
}

function visualOverlayPlan(settings, source, { resetPullTimeline = false } = {}) {
  const merged = mergeSettings(settings);
  const { firstVisualInputIndex } = sourceInputLayout(source);
  const customFallback = source && source.type === 'fallback' && source.fallbackKind === 'custom';
  const layers = [
    ...merged.watermarks.map(item => ({ ...item, kind: 'static' })),
    ...(merged.slideshow.preparedPath
      ? [{
        path: merged.slideshow.preparedPath,
        layout: merged.slideshow.layout,
        kind: merged.slideshow.images.length > 1 ? 'slideshow-cache' : 'static-slide',
      }]
      : merged.slideshow.images.length === 1
        ? [{ ...merged.slideshow.images[0], layout: merged.slideshow.layout, kind: 'static-slide' }]
        : []),
  ];
  if (!layers.length && !customFallback && !resetPullTimeline) return null;

  const inputArgs = [];
  const sourceFilter = customFallback
    ? (() => {
      if (source.fallbackImagePrepared) {
        return `[0:v]setsar=1,fps=${filterFrameRate(merged.video.fps)},settb=AVTB[source0]`;
      }
      const [width, height] = String(merged.video.outputResolution || '1920x1080').split('x').map(Number);
      const safeWidth = Number.isFinite(width) && width > 0 ? width : 1920;
      const safeHeight = Number.isFinite(height) && height > 0 ? height : 1080;
      return `[0:v]scale=${safeWidth}:${safeHeight}:force_original_aspect_ratio=decrease,pad=${safeWidth}:${safeHeight}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${filterFrameRate(merged.video.fps)},settb=AVTB,setpts=PTS-STARTPTS[source0]`;
    })()
    : `[0:v]fps=${filterFrameRate(merged.video.fps)},settb=AVTB${resetPullTimeline ? ',setpts=PTS-STARTPTS' : ''}[source0]`;
  const filters = [sourceFilter];
  let sourceLabel = 'source0';
  layers.forEach((layer, index) => {
    if (layer.kind === 'slideshow-cache') inputArgs.push('-stream_loop', '-1', '-i', String(layer.path));
    else inputArgs.push('-loop', '1', '-framerate', '1', '-i', String(layer.path));
    const inputIndex = firstVisualInputIndex + index;
    const layout = normalizeOverlayLayout(layer.layout);
    const scaleWidth = layout ? `main_w*${formatFilterNumber(layout.width / 1920)}` : 'main_w';
    const scaleHeight = layout ? '-1' : 'main_h';
    const overlayX = layout ? `main_w*${formatFilterNumber(layout.x / 1920)}` : '0';
    const overlayY = layout ? `main_h*${formatFilterNumber(layout.y / 1080)}` : '0';
    filters.push(`[${inputIndex}:v]settb=AVTB,setpts=PTS-STARTPTS[layerInput${index}]`);
    if (layer.kind === 'static-slide' && layout) {
      filters.push(
        `[layerInput${index}][${sourceLabel}]scale2ref=w=main_w:h=main_h:force_original_aspect_ratio=decrease[slideFit${index}][slideBase${index}]`,
        `[slideFit${index}]format=rgba,pad=w='if(gt(a,16/9),iw,ih*16/9)':h='if(gt(a,16/9),iw/(16/9),ih)':x=(ow-iw)/2:y=(oh-ih)/2:color=black@0[slideFrame${index}]`,
        `[slideFrame${index}][slideBase${index}]scale2ref=w=${scaleWidth}:h=${scaleHeight}[layer${index}][base${index}]`,
      );
    } else {
      filters.push(
        `[layerInput${index}][${sourceLabel}]scale2ref=w=${scaleWidth}:h=${scaleHeight}[layer${index}][base${index}]`,
      );
    }
    const isLast = index === layers.length - 1;
    const outputLabel = isLast ? 'vout' : `composite${index}`;
    filters.push(
      `[base${index}][layer${index}]overlay=${overlayX}:${overlayY}:format=auto:shortest=0:eof_action=repeat:repeatlast=1${isLast ? ',format=yuv420p' : ''}[${outputLabel}]`,
    );
    sourceLabel = outputLabel;
  });
  if (!layers.length) filters.push('[source0]format=yuv420p[vout]');
  return {
    layers,
    args: [...inputArgs, '-filter_complex', filters.join(';')],
    overlayActive: Boolean(layers.length || customFallback),
  };
}

function pullTimelineAudioArgs(source, encodingPlan) {
  return normalizePullTimeline(source, encodingPlan)
    ? ['-filter:a:0', 'asetpts=PTS-STARTPTS']
    : [];
}

function mapArgs(source, hasWatermark = false) {
  const { audioInputIndex } = sourceInputLayout(source);
  return ['-map', hasWatermark ? '[vout]' : '0:v:0?', '-map', `${audioInputIndex}:a:0?`];
}

function audioArgs(settings, encodingPlan) {
  const merged = mergeSettings(settings);
  const audio = merged.audio;
  const bitrate = audio.tracks && audio.tracks[0] && audio.tracks[0].bitrateKbps ? audio.tracks[0].bitrateKbps : 320;
  const channels = audio.channels === 'mono' ? '1' : '2';
  if (encodingPlan.audioEncoder === 'copy') return ['-c:a', 'copy'];
  return ['-c:a', encodingPlan.audioEncoder, '-ar', String(audio.sampleRate || '48000'), '-ac', channels, '-b:a', `${bitrate}k`];
}

function videoArgs(settings, encodingPlan, overlayActive = false) {
  const merged = mergeSettings(settings);
  const live = merged.live;
  const video = merged.video;
  if (encodingPlan.videoEncoder === 'copy') return ['-c:v', 'copy'];
  const encoder = encodingPlan.videoEncoder;
  const bitrate = Number(live.bitrateKbps || 8000);
  const args = [
    ...(encoder === 'libx264' || encoder === 'h264_nvenc' ? ['-pix_fmt', 'yuv420p'] : []),
    '-c:v', encoder,
    '-b:v', `${bitrate}k`,
    '-minrate', `${bitrate}k`,
    '-maxrate', `${bitrate}k`,
    '-bufsize', `${bitrate * 2}k`,
  ];
  if (video.outputResolution) args.push('-s', String(video.outputResolution));
  if (video.fps) args.push('-r', String(video.fps));
  if (live.keyframeSec && video.fps) {
    const fps = Number.parseFloat(video.fps);
    if (Number.isFinite(fps)) args.push('-g', String(Math.round(fps * Number(live.keyframeSec))));
  }
  if (encoder === 'libx264') {
    args.push(
      '-preset', overlayActive ? 'superfast' : String(live.preset || 'veryfast'),
      '-profile:v', String(live.profile || 'high'),
      '-x264-params', 'nal-hrd=cbr:force-cfr=1',
    );
  }
  if (encoder === 'h264_nvenc') {
    args.push(
      '-preset', 'p4',
      '-tune', 'll',
      '-rc', 'cbr',
      '-cbr', '1',
      '-spatial_aq', '1',
      '-zerolatency', '1',
    );
  }
  return args;
}

function createRelayPlan(source, settings) {
  const merged = mergeSettings(settings);
  const encodingPlan = resolveEncodingPlan(source, merged);
  const hash = hashId(source && source.id);
  const third = (hash % 250) + 1;
  const fourth = ((hash >>> 8) % 250) + 1;
  const port = 24000 + (hash % 10000);
  const group = `239.101.${third}.${fourth}`;
  const outputUrl = `udp://${group}:${port}?pkt_size=1316&ttl=1`;
  const inputUrl = `udp://@${group}:${port}?fifo_size=4096&overrun_nonfatal=1&buffer_size=1048576`;
  const args = [
    '-hide_banner', '-nostdin', '-stats_period', '1',
    ...buildInputArgs(source),
    ...mapArgs(source),
    ...videoArgs(merged, encodingPlan),
    ...audioArgs(merged, encodingPlan),
    '-f', 'mpegts', outputUrl,
  ];
  return { inputUrl, outputUrl, args, multicast: group, port };
}

function createRelayChannels(pipelineId, destinations, { transport = 'udp' } = {}) {
  const usedPorts = new Set();
  return (destinations || []).map(destination => {
    if (!destination || !destination.id) throw new Error('Relay destination id is required');
    let port = 30000 + (hashId(`${pipelineId}:${destination.id}`) % 20000);
    while (usedPorts.has(port)) port = port >= 49999 ? 30000 : port + 1;
    usedPorts.add(port);
    return {
      destinationId: destination.id,
      port,
      transport,
      outputUrl: transport === 'tcp' ? '' : `udp://127.0.0.1:${port}?pkt_size=1316`,
      inputUrl: transport === 'tcp'
        ? `tcp://127.0.0.1:${port}`
        : `udp://127.0.0.1:${port}?fifo_size=4096&overrun_nonfatal=1&buffer_size=1048576`,
    };
  });
}

function createPreviewMirrorChannel(pipelineId) {
  const port = 50000 + (hashId(`${pipelineId}:preview`) % 10000);
  return {
    id: 'preview-mirror',
    port,
    outputUrl: `udp://127.0.0.1:${port}?pkt_size=1316`,
    inputUrl: `udp://127.0.0.1:${port}?fifo_size=4096&overrun_nonfatal=1&buffer_size=1048576`,
  };
}

function createRecordingMirrorChannel(pipelineId) {
  const port = 20000 + (hashId(`${pipelineId}:recording`) % 4000);
  return {
    id: 'recording-mirror',
    port,
    outputUrl: `udp://127.0.0.1:${port}?pkt_size=1316`,
    inputUrl: `udp://127.0.0.1:${port}?fifo_size=8192&overrun_nonfatal=1&buffer_size=2097152`,
  };
}

function createLiveDelayChannel(pipelineId) {
  const port = 60000 + (hashId(`${pipelineId}:live-delay`) % 5000);
  return {
    id: 'live-delay',
    port,
    transport: 'tcp',
    outputUrl: `tcp://127.0.0.1:${port}?tcp_nodelay=1`,
  };
}

function sourceFingerprint(source) {
  const capture = source && source.capture || {};
  const value = source && source.type === 'capture'
    ? {
      type: 'capture',
      backend: capture.backend || 'v4l2',
      device: capture.device || '',
      videoDevice: capture.videoDevice || '',
      audioDevice: capture.audioDevice || '',
      formatCode: capture.formatCode || 'auto',
      rawFormat: capture.rawFormat || 'uyvy422',
      audioChannels: Number(capture.audioChannels || 2),
      resolution: capture.resolution || '1920x1080',
      fps: capture.fps || '59.94',
    }
    : source && source.type === 'playlist'
      ? {
        type: 'playlist',
        mediaIds: Array.isArray(source.mediaIds) ? source.mediaIds.map(String) : [],
        manifestPath: String(source.manifestPath || ''),
      }
      : {
      type: source && source.type || 'pull',
      url: source && (source.url || source.inputUrl || source.path) || '',
      loop: Boolean(source && source.loop),
    };
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function outputFormatFor(destination) {
  const protocol = String(destination.protocol || destination.type || '').toLowerCase();
  const url = String(destination.url || destination.server || '');
  if (protocol === 'srt' || url.startsWith('srt://')) return 'mpegts';
  if (protocol === 'file' || destination.kind === 'record') return null;
  return 'flv';
}

function buildOutputArgs(sourceOrRelay, destination, settings) {
  const merged = mergeSettings(settings);
  const encodingPlan = resolveEncodingPlan(sourceOrRelay, merged);
  const overlays = visualOverlayPlan(merged, sourceOrRelay, {
    resetPullTimeline: normalizePullTimeline(sourceOrRelay, encodingPlan),
  });
  const overlayActive = Boolean(overlays && overlays.overlayActive);
  const format = outputFormatFor(destination);
  const target = destination.kind === 'record' || destination.protocol === 'file'
    ? String(destination.path || destination.url)
    : buildDestinationUrl(destination);
  const args = [
    '-hide_banner', '-nostdin', '-stats_period', '1',
    ...buildInputArgs(sourceOrRelay),
    ...(overlays ? overlays.args : []),
    ...mapArgs(sourceOrRelay, Boolean(overlays)),
    ...videoArgs(merged, encodingPlan, overlayActive),
    ...pullTimelineAudioArgs(sourceOrRelay, encodingPlan),
    ...audioArgs(merged, encodingPlan),
  ];
  if (format) args.push('-f', format);
  args.push(target);
  return args;
}

function buildSharedRelayArgs(
  source,
  channels,
  settings,
  previewMirror = null,
  recordingMirror = null,
  options = {},
) {
  if (!Array.isArray(channels) || !channels.length) throw new Error('Shared relay requires at least one local channel');
  if (previewMirror && !previewMirror.outputUrl) throw new Error('Preview mirror output is required');
  if (recordingMirror && !recordingMirror.outputUrl) throw new Error('Recording mirror output is required');
  const merged = mergeSettings(settings);
  const encodingPlan = resolveEncodingPlan(source, merged);
  const overlays = visualOverlayPlan(merged, source, {
    resetPullTimeline: normalizePullTimeline(source, encodingPlan),
  });
  const overlayActive = Boolean(overlays && overlays.overlayActive);
  const teeChannels = [
    ...channels,
    ...(previewMirror ? [previewMirror] : []),
    ...(recordingMirror ? [recordingMirror] : []),
  ];
  const teeOptions = teeChannels.length === 1
    ? SHARED_RELAY_MPEGTS_OPTIONS
    : `${SHARED_RELAY_MPEGTS_OPTIONS}:onfail=ignore`;
  return [
    '-hide_banner', '-nostdin', '-stats_period', '1',
    ...buildInputArgs(source),
    ...(overlays ? overlays.args : []),
    ...mapArgs(source, Boolean(overlays)),
    ...videoArgs(merged, encodingPlan, overlayActive),
    ...(options.denseStartupKeyframes === true && encodingPlan.videoEncoder !== 'copy'
      ? [
        '-force_key_frames', 'expr:if(lt(n_forced,6),gte(t,n_forced*0.5),0)',
        ...(encodingPlan.videoEncoder === 'h264_nvenc' ? ['-forced-idr', '1'] : []),
      ]
      : []),
    ...pullTimelineAudioArgs(source, encodingPlan),
    ...audioArgs(merged, encodingPlan),
    ...(encodingPlan.videoEncoder === 'copy' ? [] : ['-bsf:v', 'dump_extra=freq=keyframe']),
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'tee',
    teeChannels.map(channel => `[${teeOptions}]${escapeTeeTarget(channel.outputUrl)}`).join('|'),
  ];
}

function previewOutputArgs({ audio = false, format = 'mpjpeg' } = {}) {
  const wantsMp4 = String(format || '').toLowerCase() === 'mp4';
  return [
    '-map', '0:v:0?',
    ...(wantsMp4 && audio ? ['-map', '0:a:0?'] : ['-an']),
    '-vf', 'scale=trunc(min(1280\\,iw)/2)*2:-2:force_original_aspect_ratio=decrease',
    ...(wantsMp4
      ? [
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
        ...(audio ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'] : ['-an']),
        '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      ]
      : ['-c:v', 'mjpeg', '-q:v', '5', '-f', 'mpjpeg']),
    'pipe:1',
  ];
}

function buildDirectPreviewArgs(source, options = {}) {
  return [
    '-hide_banner', '-nostdin', '-stats_period', '1',
    ...buildInputArgs(source),
    ...previewOutputArgs(options),
  ];
}

function buildRelayPreviewArgs(channel, options = {}) {
  if (!channel || !channel.inputUrl) throw new Error('Preview relay channel input is required');
  return [
    '-hide_banner', '-nostdin', '-stats_period', '1',
    '-fflags', '+genpts',
    '-flags', 'low_delay',
    '-max_delay', '0',
    '-dts_delta_threshold', '0.1',
    '-i', channel.inputUrl,
    ...previewOutputArgs(options),
  ];
}

function buildRelayOutputArgs(channel, destination) {
  if (!channel || !channel.inputUrl) throw new Error('Relay channel input is required');
  const format = outputFormatFor(destination);
  const target = destination.kind === 'record' || destination.protocol === 'file'
    ? String(destination.path || destination.url)
    : buildDestinationUrl(destination);
  const args = [
    '-hide_banner', '-nostdin', '-stats_period', '1',
    '-fflags', '+genpts',
    '-flags', 'low_delay',
    '-max_delay', '0',
    '-i', channel.inputUrl,
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-c', 'copy',
    '-flush_packets', '1',
  ];
  if (format) args.push('-f', format);
  args.push(target);
  return args;
}

function teeFormatFor(destination) {
  const format = outputFormatFor(destination);
  return format || 'flv';
}

function escapeTeeTarget(value) {
  return String(value || '').replace(/([\\|\[\]])/g, '\\$1');
}

function teeDestinationSpec(destination) {
  const target = destination.kind === 'record' || destination.protocol === 'file'
    ? String(destination.path || destination.url)
    : buildDestinationUrl(destination);
  if (!target) throw new Error('Tee destination requires a target');
  return `[f=${teeFormatFor(destination)}:onfail=ignore]${escapeTeeTarget(target)}`;
}

function buildTeeOutputArgs(source, destinations, settings) {
  const enabledDestinations = (destinations || []).filter(item => item && item.enabled !== false);
  if (!enabledDestinations.length) throw new Error('Tee output requires at least one destination');
  const merged = mergeSettings(settings);
  const encodingPlan = resolveEncodingPlan(source, merged);
  const overlays = visualOverlayPlan(merged, source, {
    resetPullTimeline: normalizePullTimeline(source, encodingPlan),
  });
  const overlayActive = Boolean(overlays && overlays.overlayActive);
  return [
    '-hide_banner', '-nostdin', '-stats_period', '1',
    ...buildInputArgs(source),
    ...(overlays ? overlays.args : []),
    ...mapArgs(source, Boolean(overlays)),
    ...videoArgs(merged, encodingPlan, overlayActive),
    ...pullTimelineAudioArgs(source, encodingPlan),
    ...audioArgs(merged, encodingPlan),
    '-f', 'tee',
    enabledDestinations.map(teeDestinationSpec).join('|'),
  ];
}

module.exports = {
  DEFAULT_SETTINGS,
  mergeSettings,
  buildDestinationUrl,
  buildInputArgs,
  resolvePipelineSource,
  createRelayPlan,
  createRelayChannels,
  createPreviewMirrorChannel,
  createRecordingMirrorChannel,
  createLiveDelayChannel,
  createFallbackSource,
  sourceFingerprint,
  buildOutputArgs,
  buildSharedRelayArgs,
  buildRelayOutputArgs,
  buildDirectPreviewArgs,
  buildRelayPreviewArgs,
  buildTeeOutputArgs,
  resolveEncodingPlan,
};
