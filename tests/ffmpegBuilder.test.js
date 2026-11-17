const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SETTINGS,
  mergeSettings,
  buildDestinationUrl,
  buildInputArgs,
  createRelayPlan,
  createRelayChannels,
  createPreviewMirrorChannel,
  createLiveDelayChannel,
  createFallbackSource,
  sourceFingerprint,
  buildOutputArgs,
  buildSharedRelayArgs,
  buildRelayOutputArgs,
  buildDirectPreviewArgs,
  buildRelayPreviewArgs,
  buildTeeOutputArgs,
  parseCustomEncoderOptions,
  resolvePipelineSource,
} = require('../server/lib/ffmpegBuilder');

function mappedStreams(args) {
  return args.flatMap((arg, index) => arg === '-map' ? [args[index + 1]] : []);
}

test('mergeSettings migrates one legacy watermark into ordered visual layers', () => {
  const merged = mergeSettings({
    watermark: { id: 'wm-old', path: '/tmp/old.png' },
  });

  assert.deepEqual(merged.watermarks.map(item => item.id), ['wm-old']);
  assert.deepEqual(merged.slideshow, {
    images: [], intervalMs: 2000, transitionMs: 700, loop: true,
  });
});

test('mergeSettings keeps explicit watermark order and validates slideshow numbers', () => {
  const merged = mergeSettings({
    watermarks: [
      { id: 'wm-b', path: '/tmp/b.png' },
      { id: 'wm-a', path: '/tmp/a.png' },
    ],
    slideshow: {
      images: [{ id: 'wm-slide', path: '/tmp/slide.png' }],
      intervalMs: 3500,
      transitionMs: 900,
    },
  });

  assert.deepEqual(merged.watermarks.map(item => item.id), ['wm-b', 'wm-a']);
  assert.equal(merged.slideshow.intervalMs, 3500);
  assert.equal(merged.slideshow.transitionMs, 900);
  assert.equal(merged.slideshow.loop, true);
});

test('mergeSettings normalizes null arrays and primitive slideshow values', () => {
  for (const slideshow of [null, [], 42, 'invalid']) {
    assert.deepEqual(mergeSettings({ slideshow }).slideshow, {
      images: [], intervalMs: 2000, transitionMs: 700, loop: true,
    });
  }
});

test('mergeSettings clones provided audio tracks and their objects', () => {
  const input = { audio: { tracks: [{ bitrateKbps: 128, vendorMode: 'future' }] } };
  const first = mergeSettings(input);
  const second = mergeSettings(input);

  assert.notStrictEqual(first.audio.tracks, input.audio.tracks);
  assert.notStrictEqual(first.audio.tracks[0], input.audio.tracks[0]);
  assert.notStrictEqual(first.audio.tracks, second.audio.tracks);
  assert.notStrictEqual(first.audio.tracks[0], second.audio.tracks[0]);

  first.audio.tracks[0].bitrateKbps = 64;
  assert.equal(input.audio.tracks[0].bitrateKbps, 128);
  assert.equal(second.audio.tracks[0].bitrateKbps, 128);
});

test('mergeSettings clones default audio tracks for every result', () => {
  const first = mergeSettings();
  const second = mergeSettings();

  assert.notStrictEqual(first.audio.tracks, DEFAULT_SETTINGS.audio.tracks);
  assert.notStrictEqual(first.audio.tracks[0], DEFAULT_SETTINGS.audio.tracks[0]);
  assert.notStrictEqual(first.audio.tracks, second.audio.tracks);
  assert.notStrictEqual(first.audio.tracks[0], second.audio.tracks[0]);

  first.audio.tracks[0].bitrateKbps = 64;
  assert.equal(DEFAULT_SETTINGS.audio.tracks[0].bitrateKbps, 320);
  assert.equal(second.audio.tracks[0].bitrateKbps, 320);
});

test('mergeSettings accepts nullish input as a request for defaults', () => {
  assert.equal(mergeSettings(null).live.videoEncoder, 'auto');
  assert.equal(mergeSettings(undefined).live.videoEncoder, 'auto');
});

test('mergeSettings defaults live delay off and validates enabled delay seconds', () => {
  assert.equal(mergeSettings().live.delayEnabled, false);
  assert.equal(mergeSettings().live.delaySeconds, 20);
  assert.deepEqual(
    {
      enabled: mergeSettings({ live: { delayEnabled: true, delaySeconds: 45 } }).live.delayEnabled,
      seconds: mergeSettings({ live: { delayEnabled: true, delaySeconds: 45 } }).live.delaySeconds,
    },
    { enabled: true, seconds: 45 },
  );
  assert.throws(
    () => mergeSettings({ live: { delayEnabled: true, delaySeconds: 0 } }),
    /直播延时必须在 1 至 300 秒之间/,
  );
  assert.throws(
    () => mergeSettings({ live: { delayEnabled: true, delaySeconds: 301 } }),
    /直播延时必须在 1 至 300 秒之间/,
  );
});

test('mergeSettings rejects a non-object settings container with a clear 400 error', () => {
  assert.throws(
    () => mergeSettings('keep-me'),
    error => error.statusCode === 400 && /settings must be a plain object/.test(error.message),
  );
});

test('mergeSettings rejects a non-object live container with a clear 400 error', () => {
  assert.throws(
    () => mergeSettings({ live: ['keep'] }),
    error => error.statusCode === 400 && /settings\.live must be a plain object/.test(error.message),
  );
});

test('mergeSettings rejects more than twenty static watermarks', () => {
  assert.throws(
    () => mergeSettings({
      watermarks: Array.from({ length: 21 }, (_, index) => ({
        id: `wm-${index}`,
        path: `/tmp/${index}.png`,
      })),
    }),
    /静态水印最多添加 20 张图片/,
  );
});

test('buildDestinationUrl joins server and stream key safely', () => {
  assert.equal(
    buildDestinationUrl({ protocol: 'rtmp', server: 'rtmp://push.example.com/live/', streamKey: 'abc?secret=xyz' }),
    'rtmp://push.example.com/live/abc?secret=xyz',
  );
  assert.equal(
    buildDestinationUrl({ url: 'rtmps://push.example.com/app/name?token=1' }),
    'rtmps://push.example.com/app/name?token=1',
  );
});

test('buildDestinationUrl normalizes scheme-less RTMP targets before tee output', () => {
  assert.equal(
    buildDestinationUrl({ protocol: 'rtmp', url: '192.168.16.11/wyll' }),
    'rtmp://192.168.16.11/wyll',
  );
  assert.equal(
    buildDestinationUrl({ protocol: 'rtmp', server: '10.23.101.52/live', streamKey: 'wyl' }),
    'rtmp://10.23.101.52/live/wyl',
  );
});

test('createRelayPlan creates deterministic multicast endpoints for a source', () => {
  const plan = createRelayPlan({ id: 'source-a', type: 'pull', url: 'rtmp://origin.example.com/live/pgm' }, { video: { outputResolution: '1920x1080', fps: '59.94' }, live: { bitrateKbps: 8000 } });
  assert.match(plan.outputUrl, /^udp:\/\/239\.101\.\d+\.\d+:\d+\?pkt_size=1316&ttl=1$/);
  assert.match(plan.inputUrl, /^udp:\/\/@239\.101\.\d+\.\d+:\d+\?fifo_size=4096&overrun_nonfatal=1&buffer_size=1048576$/);
  assert.equal(plan.args.includes('-f'), true);
  assert.equal(plan.args.includes('mpegts'), true);
});

test('live delay channel uses a deterministic localhost TCP endpoint', () => {
  const first = createLiveDelayChannel('pipe-delay');
  const second = createLiveDelayChannel('pipe-delay');

  assert.deepEqual(second, first);
  assert.ok(first.port >= 60000 && first.port <= 64999);
  assert.equal(first.transport, 'tcp');
  assert.match(first.outputUrl, /^tcp:\/\/127\.0\.0\.1:6\d{4}\?tcp_nodelay=1$/);
});

test('buildOutputArgs reads from relay and writes one RTMP destination with monitorable stats', () => {
  const args = buildOutputArgs({ inputUrl: 'udp://@239.101.1.1:24000?fifo_size=4096' }, {
    id: 'dest-1',
    server: 'rtmp://push.example.com/live',
    streamKey: 'room?secret=s1',
  }, {
    live: { videoEncoder: 'copy', audioEncoder: 'aac', bitrateKbps: 6000, keyframeSec: 2, preset: 'veryfast', profile: 'high' },
    audio: { sampleRate: '48000', channels: 'stereo', tracks: [{ bitrateKbps: 320 }] },
  });

  assert.equal(args[0], '-hide_banner');
  assert.equal(args.includes('-stats_period'), true);
  assert.equal(args.includes('udp://@239.101.1.1:24000?fifo_size=4096'), true);
  assert.equal(args.at(-1), 'rtmp://push.example.com/live/room?secret=s1');
});

test('resolvePipelineSource resolves local room input to localhost RTMP playback URL', () => {
  const source = resolvePipelineSource({
    input: { type: 'room', roomId: 'room-main' },
  }, {
    settings: { rtmpPort: 1935 },
    rooms: [{ id: 'room-main', name: '主直播间', streamName: 'main', enabled: true }],
    sources: [],
  });

  assert.equal(source.type, 'pull');
  assert.equal(source.url, 'rtmp://127.0.0.1:1935/live/main');
  assert.equal(source.roomId, 'room-main');
});

test('resolvePipelineSource supports url file and capture inputs', () => {
  assert.deepEqual(resolvePipelineSource({
    input: { type: 'url', url: 'srt://10.0.0.1:9000?mode=caller' },
  }, { sources: [], rooms: [], settings: {} }), {
    id: 'inline-url',
    name: 'URL 输入源',
    type: 'pull',
    url: 'srt://10.0.0.1:9000?mode=caller',
    sharedRelay: true,
  });

  assert.deepEqual(resolvePipelineSource({
    input: { type: 'file', path: '/data/demo.mp4', loop: true },
  }, { sources: [], rooms: [], settings: {} }), {
    id: 'inline-file',
    name: '本地视频文件',
    type: 'file',
    path: '/data/demo.mp4',
    loop: true,
    sharedRelay: true,
  });

  const capture = resolvePipelineSource({
    input: {
      type: 'capture',
      capture: { videoDevice: '/dev/video2', audioDevice: 'hw:1,0', resolution: '1920x1080', fps: '60' },
    },
  }, { sources: [], rooms: [], settings: {} });

  assert.equal(capture.type, 'capture');
  assert.equal(capture.capture.backend, 'v4l2');
  assert.equal(capture.capture.videoDevice, '/dev/video2');
  assert.equal(capture.capture.audioDevice, 'hw:1,0');
});

test('DeckLink capture uses one embedded audio-video input', () => {
  const args = buildInputArgs({
    type: 'capture',
    capture: {
      backend: 'decklink',
      device: 'DeckLink Mini Recorder 4K',
      formatCode: 'Hp59',
      rawFormat: 'uyvy422',
      audioChannels: 2,
    },
  });

  assert.deepEqual(args, [
    '-thread_queue_size', '1024',
    '-f', 'decklink',
    '-format_code', 'Hp59',
    '-raw_format', 'uyvy422',
    '-channels', '2',
    '-i', 'DeckLink Mini Recorder 4K',
  ]);
  assert.equal(args.filter(value => value === '-i').length, 1);
});

test('DeckLink auto format omits format_code and maps embedded audio from input zero', () => {
  const source = {
    type: 'capture',
    capture: {
      backend: 'decklink',
      device: 'DeckLink Duo 2 (1)',
      formatCode: 'auto',
      rawFormat: 'auto',
      audioChannels: 8,
    },
  };
  const args = buildOutputArgs(source, {
    id: 'dest-1', protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'main',
  }, { live: { videoEncoder: 'libx264', audioEncoder: 'aac' } });

  assert.equal(args.includes('-format_code'), false);
  assert.equal(args.includes('-raw_format'), false);
  assert.equal(args.filter(value => value === '-i').length, 1);
  assert.deepEqual(mappedStreams(args), ['0:v:0?', '0:a:0?']);
});

test('DeckLink 4:2:2 capture converts to yuv420p before H.264 encoding', () => {
  const source = {
    type: 'capture',
    capture: {
      backend: 'decklink',
      device: 'DeckLink Duo 2 (1)',
      rawFormat: 'uyvy422',
      audioChannels: 2,
    },
  };
  const args = buildOutputArgs(source, {
    id: 'dest-1', protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'main',
  }, { live: { videoEncoder: 'libx264', audioEncoder: 'aac' } });

  assert.deepEqual(args.slice(args.indexOf('-pix_fmt'), args.indexOf('-pix_fmt') + 2), ['-pix_fmt', 'yuv420p']);
  assert.equal(args.indexOf('-pix_fmt') < args.indexOf('-c:v'), true);
});

test('DeckLink capture rejects unsupported raw formats and channel counts', () => {
  assert.throws(() => buildInputArgs({
    type: 'capture', capture: { backend: 'decklink', device: 'Card', rawFormat: 'nv12', audioChannels: 2 },
  }), /DeckLink.*像素格式/);
  assert.throws(() => buildInputArgs({
    type: 'capture', capture: { backend: 'decklink', device: 'Card', rawFormat: 'uyvy422', audioChannels: 6 },
  }), /DeckLink.*音频声道/);
});

test('capture output builders map separate ALSA audio and auto encodes it as AAC', () => {
  const source = {
    type: 'capture',
    capture: {
      videoDevice: '/dev/video2',
      audioDevice: 'hw:1,0',
      resolution: '1920x1080',
      fps: '60',
    },
  };
  const destination = {
    id: 'dest-1',
    protocol: 'rtmp',
    server: 'rtmp://push.example.com/live',
    streamKey: 'room',
  };
  const settings = { live: { videoEncoder: 'auto', audioEncoder: 'aac' } };
  const channels = createRelayChannels('pipe-capture-audio', [destination]);
  const cases = [
    ['single output', buildOutputArgs(source, destination, settings)],
    ['shared relay', buildSharedRelayArgs(source, channels, settings)],
    ['tee output', buildTeeOutputArgs(source, [destination], settings)],
  ];

  for (const [label, args] of cases) {
    assert.deepEqual(mappedStreams(args), ['0:v:0?', '1:a:0?'], label);
    assert.equal(args[args.indexOf('-c:a') + 1], 'aac', label);
  }
});

test('capture audio places a watermark at input 2 and keeps audio mapped from input 1', () => {
  const channels = createRelayChannels('pipe-capture-watermark', [{ id: 'dest-1' }]);
  const args = buildSharedRelayArgs({
    type: 'capture',
    capture: { videoDevice: '/dev/video2', audioDevice: 'hw:1,0' },
  }, channels, {
    live: { videoEncoder: 'auto', audioEncoder: 'aac' },
    watermark: { path: '/tmp/logo.png' },
  });
  const filter = args[args.indexOf('-filter_complex') + 1];

  assert.equal(args.filter(item => item === '-i').length, 3);
  assert.match(filter, /\[2:v\]settb=AVTB,setpts=PTS-STARTPTS\[layerInput0\]/);
  assert.deepEqual(mappedStreams(args), ['[vout]', '1:a:0?']);
});

test('capture audio indexes a prepared slideshow after capture inputs and watermarks', () => {
  const destination = {
    id: 'dest-1',
    protocol: 'rtmp',
    server: 'rtmp://push.example.com/live',
    streamKey: 'room',
  };
  const args = buildTeeOutputArgs({
    type: 'capture',
    capture: { videoDevice: '/dev/video2', audioDevice: 'hw:1,0' },
  }, [destination], {
    live: { videoEncoder: 'auto', audioEncoder: 'aac' },
    watermark: { path: '/tmp/logo.png' },
    slideshow: {
      images: [{ path: '/tmp/slide-a.png' }, { path: '/tmp/slide-b.png' }],
      preparedPath: '/tmp/slides.mov',
    },
  });
  const filter = args[args.indexOf('-filter_complex') + 1];

  assert.equal(args.filter(item => item === '-i').length, 4);
  assert.equal(args.indexOf('/tmp/logo.png') < args.indexOf('/tmp/slides.mov'), true);
  assert.match(filter, /\[2:v\]settb=AVTB,setpts=PTS-STARTPTS\[layerInput0\]/);
  assert.match(filter, /\[3:v\]settb=AVTB,setpts=PTS-STARTPTS\[layerInput1\]/);
  assert.deepEqual(mappedStreams(args), ['[vout]', '1:a:0?']);
});

test('buildOutputArgs applies OBS-style audio and video settings when encoding', () => {
  const args = buildOutputArgs({ type: 'pull', url: 'rtmp://127.0.0.1/live/main' }, {
    id: 'dest-1',
    server: 'rtmp://push.example.com/live',
    streamKey: 'room',
  }, {
    live: {
      videoEncoder: 'libx264',
      audioEncoder: 'aac',
      bitrateKbps: 5000,
      keyframeSec: 2,
      preset: 'fast',
      profile: 'main',
    },
    video: { outputResolution: '1280x720', fps: '50' },
    audio: { sampleRate: '48000', channels: 'stereo', tracks: [{ bitrateKbps: 192 }] },
  });

  assert.equal(args.includes('-s'), true);
  assert.equal(args[args.indexOf('-s') + 1], '1280x720');
  assert.equal(args.includes('-r'), true);
  assert.equal(args[args.indexOf('-r') + 1], '50');
  assert.equal(args.includes('-b:v'), true);
  assert.equal(args[args.indexOf('-b:v') + 1], '5000k');
  assert.equal(args[args.indexOf('-minrate') + 1], '5000k');
  assert.equal(args[args.indexOf('-maxrate') + 1], '5000k');
  assert.match(args[args.indexOf('-x264-params') + 1], /^nal-hrd=cbr:force-cfr=1:/);
  assert.equal(args.includes('-g'), true);
  assert.equal(args[args.indexOf('-g') + 1], '100');
  assert.equal(args.includes('-ar'), true);
  assert.equal(args[args.indexOf('-ar') + 1], '48000');
  assert.equal(args.includes('-ac'), true);
  assert.equal(args[args.indexOf('-ac') + 1], '2');
  assert.equal(args.includes('-b:a'), true);
  assert.equal(args[args.indexOf('-b:a') + 1], '192k');
});

test('buildOutputArgs selects NVENC CBR rate control with equal bitrate bounds', () => {
  const args = buildOutputArgs({ type: 'pull', url: 'rtmp://127.0.0.1/live/main' }, {
    id: 'dest-1',
    server: 'rtmp://push.example.com/live',
    streamKey: 'room',
  }, {
    live: { videoEncoder: 'h264_nvenc', audioEncoder: 'aac', bitrateKbps: 8000 },
    video: { outputResolution: '1920x1080', fps: '60' },
  });

  assert.equal(args[args.indexOf('-b:v') + 1], '8000k');
  assert.equal(args[args.indexOf('-minrate') + 1], '8000k');
  assert.equal(args[args.indexOf('-maxrate') + 1], '8000k');
  assert.equal(args[args.indexOf('-rc') + 1], 'cbr');
  assert.equal(args.includes('-x264-params'), false);
});

test('buildSharedRelayArgs copies RTMP video and audio for auto without visual layers', () => {
  const channels = createRelayChannels('pipe-auto-copy', [{ id: 'dest-1' }]);
  const args = buildSharedRelayArgs({ type: 'pull', url: 'rtmp://origin.example.com/live/pgm' }, channels, {
    live: { videoEncoder: 'auto', audioEncoder: 'aac' },
    watermarks: [],
    slideshow: { images: [] },
  });

  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  assert.equal(args.includes('-b:v'), false);
  assert.equal(args.includes('-r'), false);
});

test('fallback source generates configured black video and silent audio with an encodable plan', () => {
  const fallback = createFallbackSource({
    live: { videoEncoder: 'auto', audioEncoder: 'aac', bitrateKbps: 8000 },
    video: { outputResolution: '1920x1080', fps: '59.94' },
    audio: { sampleRate: '48000', channels: 'stereo', tracks: [{ bitrateKbps: 320 }] },
  });
  const args = buildSharedRelayArgs(fallback, createRelayChannels('pipe-fallback', [{ id: 'dest-a' }]), fallback.settings);

  assert.deepEqual(buildInputArgs(fallback), [
    '-re', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=59.94',
    '-re', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
  ]);
  assert.deepEqual(mappedStreams(args), ['0:v:0?', '1:a:0?']);
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args[args.indexOf('-s') + 1], '1920x1080');
  assert.equal(args[args.indexOf('-r') + 1], '59.94');
});

test('buildSharedRelayArgs uses low-latency NVENC video and copied audio for auto with a watermark', () => {
  const channels = createRelayChannels('pipe-auto-overlay', [{ id: 'dest-1' }]);
  const args = buildSharedRelayArgs({ type: 'pull', url: 'rtmp://origin.example.com/live/pgm' }, channels, {
    live: { videoEncoder: 'auto', audioEncoder: 'aac' },
    watermark: { path: '/tmp/logo.png' },
  });

  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_nvenc');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  assert.equal(args[args.indexOf('-preset') + 1], 'p4');
  assert.equal(args[args.indexOf('-tune') + 1], 'll');
  assert.equal(args[args.indexOf('-rc') + 1], 'cbr');
  assert.equal(args[args.indexOf('-spatial-aq') + 1], '1');
  assert.equal(args[args.indexOf('-zerolatency') + 1], '1');
});

test('buildSharedRelayArgs treats a prepared slideshow as visual processing without source images', () => {
  const source = { type: 'pull', url: 'rtmp://origin.example.com/live/pgm' };
  const channels = createRelayChannels('pipe-auto-prepared-slideshow', [{ id: 'dest-1' }]);
  const slideshow = { images: [], preparedPath: '/tmp/slides.mov' };
  const args = buildSharedRelayArgs(source, channels, {
    live: { videoEncoder: 'auto', audioEncoder: 'aac' },
    slideshow,
  });

  assert.equal(args.includes('-filter_complex'), true);
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_nvenc');
  assert.throws(
    () => buildSharedRelayArgs(source, channels, {
      live: { videoEncoder: 'copy', audioEncoder: 'aac' },
      slideshow,
    }),
    /copy.*watermark.*slideshow/i,
  );
});

test('output builders reject explicit video copy with a watermark', () => {
  const source = { type: 'pull', url: 'rtmp://origin.example.com/live/pgm' };
  const settings = {
    live: { videoEncoder: 'copy', audioEncoder: 'aac' },
    watermark: { path: '/tmp/logo.png' },
  };
  const destination = {
    id: 'dest-1',
    protocol: 'rtmp',
    server: 'rtmp://push.example.com/live',
    streamKey: 'room',
  };
  const channels = createRelayChannels('pipe-copy-overlay', [destination]);

  assert.throws(
    () => buildOutputArgs(source, destination, settings),
    /copy.*watermark.*slideshow/i,
  );
  assert.throws(
    () => buildSharedRelayArgs(source, channels, settings),
    /copy.*watermark.*slideshow/i,
  );
});

test('shared relay uses deterministic distinct localhost UDP channels', () => {
  const destinations = [
    { id: 'dest-1', protocol: 'rtmp', server: 'rtmp://push-a.example.com/live', streamKey: 'main' },
    { id: 'dest-2', protocol: 'rtmp', server: 'rtmp://push-b.example.com/live/', streamKey: 'backup?secret=abc' },
  ];
  const channels = createRelayChannels('pipe-a', destinations);
  const repeated = createRelayChannels('pipe-a', destinations);

  assert.deepEqual(channels, repeated);
  assert.equal(channels.length, 2);
  assert.notEqual(channels[0].port, channels[1].port);
  for (const channel of channels) {
    assert.match(channel.outputUrl, /^udp:\/\/127\.0\.0\.1:\d+\?pkt_size=1316$/);
    assert.match(channel.inputUrl, /^udp:\/\/127\.0\.0\.1:\d+\?fifo_size=4096&overrun_nonfatal=1&buffer_size=1048576$/);
  }
});

test('shared relay adds one deterministic loopback preview mirror', () => {
  const destination = { id: 'dest-a', protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'main' };
  const source = { type: 'pull', url: 'rtmp://origin.example.com/live/pgm' };
  const first = createPreviewMirrorChannel('pipe-pgm');
  const second = createPreviewMirrorChannel('pipe-pgm');
  const args = buildSharedRelayArgs(source, createRelayChannels('pipe-pgm', [destination]), {}, first);

  assert.deepEqual(first, second);
  assert.match(first.outputUrl, /^udp:\/\/127\.0\.0\.1:5\d{4}\?pkt_size=1316$/);
  assert.equal(args.at(-1).split(first.outputUrl).length - 1, 1);
  assert.equal(
    sourceFingerprint(source),
    sourceFingerprint({ type: 'pull', url: 'rtmp://origin.example.com/live/pgm', name: 'PGM' }),
  );
});

test('preview builders keep full preview at source frame rate and use low-load card monitoring', () => {
  const direct = buildDirectPreviewArgs({ type: 'pull', url: 'rtmp://origin.example.com/live/pgm' });
  const relay = buildRelayPreviewArgs(createPreviewMirrorChannel('pipe-pgm'));
  const monitor = buildDirectPreviewArgs(
    { type: 'pull', url: 'rtmp://origin.example.com/live/pgm' },
    { monitor: true },
  );

  for (const args of [direct, relay]) {
    assert.deepEqual(mappedStreams(args), ['0:v:0?']);
    assert.equal(args.includes('-an'), true);
    assert.equal(args[args.indexOf('-vf') + 1], 'scale=trunc(min(1280\\,iw)/2)*2:-2:force_original_aspect_ratio=decrease');
    assert.deepEqual(args.slice(args.indexOf('-f'), args.indexOf('-f') + 2), ['-f', 'mpjpeg']);
    assert.equal(args[args.indexOf('-boundary_tag') + 1], 'streamhub-preview');
    assert.equal(args.at(-1), 'pipe:1');
  }
  assert.equal(monitor[monitor.indexOf('-vf') + 1], 'fps=2,scale=trunc(min(480\\,iw)/2)*2:-2:force_original_aspect_ratio=decrease');
  assert.equal(monitor[monitor.indexOf('-q:v') + 1], '8');
  assert.equal(monitor.includes('-an'), true);
});

test('professional rate-control modes never pass a quality number as NVENC rc', () => {
  const source = { type: 'pull', url: 'rtmp://origin.example.com/live/pgm' };
  const destination = { id: 'dest-1', server: 'rtmp://push.example.com/live', streamKey: 'room' };
  const nvenc = buildOutputArgs(source, destination, {
    live: { videoEncoder: 'h264_nvenc', rateControl: 'crf', crf: 22, maxBitrateKbps: 12000, bufferSizeKbps: 24000 },
    video: { outputResolution: '1920x1080', fps: '59.94' },
  });
  assert.equal(nvenc[nvenc.indexOf('-rc') + 1], 'vbr');
  assert.notEqual(nvenc[nvenc.indexOf('-rc') + 1], '22');
  assert.equal(nvenc[nvenc.indexOf('-cq') + 1], '22');
  assert.throws(
    () => buildOutputArgs(source, destination, { live: { videoEncoder: 'h264_nvenc', rateControl: 'abr' } }),
    /NVENC.*ABR/,
  );

  for (const mode of ['cbr', 'vbr', 'abr', 'crf']) {
    const args = buildOutputArgs(source, destination, {
      live: { videoEncoder: 'libx264', rateControl: mode, bitrateKbps: 6000, maxBitrateKbps: 8000, bufferSizeKbps: 12000, crf: 21 },
      video: { outputResolution: '1280x720', fps: '30' },
    });
    assert.equal(args.includes('-c:v'), true);
    assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  }
});

test('custom encoder options are tokenized without a shell and cannot replace stream structure', () => {
  assert.deepEqual(parseCustomEncoderOptions('-weighted_pred 1 -coder="cabac"'), ['-weighted_pred', '1', '-coder=cabac']);
  assert.throws(() => parseCustomEncoderOptions('-i rtmp://example.invalid/live'), /不能覆盖结构性选项 -i/);
  assert.throws(() => parseCustomEncoderOptions('-vf scale=1280:720'), /不能覆盖结构性选项 -vf/);
  assert.throws(() => parseCustomEncoderOptions('weighted_pred 1'), /缺少选项名称/);
});

test('buildSharedRelayArgs reads one source and fans out MPEG-TS to every local channel', () => {
  const channels = createRelayChannels('pipe-a', [{ id: 'dest-1' }, { id: 'dest-2' }]);
  const args = buildSharedRelayArgs({ type: 'pull', url: 'rtmp://origin.example.com/live/pgm' }, channels, {
    live: { videoEncoder: 'libx264', audioEncoder: 'aac', bitrateKbps: 6000, keyframeSec: 2, preset: 'veryfast', profile: 'high' },
    video: { outputResolution: '1920x1080', fps: '30' },
    audio: { sampleRate: '48000', channels: 'stereo', tracks: [{ bitrateKbps: 192 }] },
  });

  assert.equal(args.filter(item => item === '-i').length, 1);
  assert.equal(args.includes('-f'), true);
  assert.equal(args[args.indexOf('-f') + 1], 'tee');
  assert.match(args.at(-1), /\[f=mpegts:onfail=ignore\]udp:\/\/127\.0\.0\.1:\d+\?pkt_size=1316/);
  assert.match(args.at(-1), /\|/);
  assert.equal(channels.every(channel => args.at(-1).includes(channel.outputUrl)), true);
});

test('shared relay keeps normal channels on UDP and sends the delay channel over TCP', () => {
  const normalChannel = createRelayChannels('pipe-a', [{ id: 'dest-1' }])[0];
  const delayChannel = createLiveDelayChannel('pipe-a');
  const args = buildSharedRelayArgs(
    { type: 'pull', url: 'rtmp://origin.example.com/live/pgm' },
    [normalChannel, delayChannel],
    { live: { videoEncoder: 'libx264', audioEncoder: 'aac' } },
  );

  assert.match(args.at(-1), /\[f=mpegts:onfail=ignore\]udp:\/\/127\.0\.0\.1:\d+\?pkt_size=1316/);
  assert.match(args.at(-1), /\[f=mpegts:onfail=ignore\]tcp:\/\/127\.0\.0\.1:6\d{4}\?tcp_nodelay=1/);
});

test('buildRelayOutputArgs copies one local channel to one remote destination', () => {
  const [channel] = createRelayChannels('pipe-a', [{ id: 'dest-1' }]);
  const args = buildRelayOutputArgs(channel, {
    id: 'dest-1',
    protocol: 'rtmp',
    server: 'rtmp://push-a.example.com/live',
    streamKey: 'main',
  });

  assert.equal(args.includes(channel.inputUrl), true);
  assert.equal(args[args.indexOf('-fflags') + 1], '+genpts+nobuffer');
  assert.equal(args[args.indexOf('-flags') + 1], 'low_delay');
  assert.equal(args[args.indexOf('-max_delay') + 1], '0');
  assert.equal(args[args.indexOf('-c') + 1], 'copy');
  assert.equal(args[args.indexOf('-flush_packets') + 1], '1');
  assert.equal(args.at(-1), 'rtmp://push-a.example.com/live/main');
});

test('buildRelayOutputArgs leaves UDP idle timeout disabled during the initial delay window', () => {
  const [channel] = createRelayChannels('pipe-delay', [{ id: 'dest-1' }]);
  const args = buildRelayOutputArgs(channel, {
    id: 'dest-1',
    protocol: 'rtmp',
    server: 'rtmp://push-a.example.com/live',
    streamKey: 'main',
  });

  assert.equal(args[args.indexOf('-i') + 1], channel.inputUrl);
  assert.doesNotMatch(args[args.indexOf('-i') + 1], /[?&]timeout=/);
});

test('delayed relay channels use TCP so closing the writer delivers EOF', () => {
  const [channel] = createRelayChannels('pipe-delay', [{ id: 'dest-1' }], { transport: 'tcp' });
  const args = buildRelayOutputArgs(channel, {
    id: 'dest-1',
    protocol: 'rtmp',
    server: 'rtmp://push-a.example.com/live',
    streamKey: 'main',
  });

  assert.match(channel.inputUrl, /^tcp:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(args[args.indexOf('-i') + 1], channel.inputUrl);
});

test('buildOutputArgs overlays a local watermark and maps the filtered video', () => {
  const args = buildOutputArgs({ type: 'pull', url: 'rtmp://origin.example.com/live/pgm' }, {
    id: 'dest-1',
    protocol: 'rtmp',
    server: 'rtmp://push.example.com/live',
    streamKey: 'room',
  }, {
    live: { videoEncoder: 'libx264', audioEncoder: 'aac', bitrateKbps: 6000 },
    watermark: { path: '/opt/StreamHub/data/watermarks/wm-a.png' },
  });

  assert.equal(args.filter(item => item === '-i').length, 2);
  assert.equal(args.includes('-loop'), true);
  assert.equal(args.includes('/opt/StreamHub/data/watermarks/wm-a.png'), true);
  assert.match(args[args.indexOf('-filter_complex') + 1], /\[0:v\]fps=59\.94,settb=AVTB,setpts=PTS-STARTPTS\[source0\]/);
  assert.match(args[args.indexOf('-filter_complex') + 1], /\[1:v\]settb=AVTB,setpts=PTS-STARTPTS\[layerInput0\]/);
  assert.match(args[args.indexOf('-filter_complex') + 1], /\[layerInput0\]\[source0\]scale2ref=w=main_w:h=main_h\[layer0\]\[base0\]/);
  assert.match(args[args.indexOf('-filter_complex') + 1], /\[base0\]\[layer0\]overlay=0:0:format=auto:shortest=0:eof_action=repeat:repeatlast=1,format=yuv420p\[vout\]/);
  assert.equal(args.includes('[vout]'), true);
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
});

test('buildSharedRelayArgs applies a full-frame watermark and ignores saved corner position', () => {
  const channels = createRelayChannels('pipe-a', [{ id: 'dest-1' }]);
  const args = buildSharedRelayArgs({ type: 'pull', url: 'rtmp://origin.example.com/live/pgm' }, channels, {
    live: { videoEncoder: 'libx264', audioEncoder: 'aac', bitrateKbps: 6000 },
    watermark: { path: '/tmp/logo.webp', opacity: 0.7, position: 'top-left' },
  });

  assert.equal(args.filter(item => item === '-i').length, 2);
  assert.match(args[args.indexOf('-filter_complex') + 1], /scale2ref=w=main_w:h=main_h/);
  assert.match(args[args.indexOf('-filter_complex') + 1], /overlay=0:0:format=auto:shortest=0:eof_action=repeat:repeatlast=1,format=yuv420p\[vout\]/);
  assert.doesNotMatch(args[args.indexOf('-filter_complex') + 1], /24:24|W-w|H-h/);
  assert.equal(args[args.indexOf('-preset') + 1], 'superfast');
  assert.equal(args.includes('[vout]'), true);
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
});

test('buildSharedRelayArgs composes ordered watermarks before a prepared slideshow', () => {
  const channels = createRelayChannels('pipe-a', [{ id: 'dest-1' }]);
  const args = buildSharedRelayArgs({ type: 'pull', url: 'rtmp://origin.example.com/live/pgm' }, channels, {
    live: { videoEncoder: 'libx264', audioEncoder: 'aac', bitrateKbps: 6000 },
    watermarks: [
      { id: 'wm-a', path: '/tmp/a.png' },
      { id: 'wm-b', path: '/tmp/b.png' },
    ],
    slideshow: {
      images: [{ id: 'slide-a', path: '/tmp/slide-a.png' }, { id: 'slide-b', path: '/tmp/slide-b.png' }],
      intervalMs: 2000,
      transitionMs: 700,
      preparedPath: '/tmp/slides.mov',
    },
  });
  const filter = args[args.indexOf('-filter_complex') + 1];

  assert.equal(args.filter(item => item === '-i').length, 4);
  assert.equal(args.indexOf('/tmp/a.png') < args.indexOf('/tmp/b.png'), true);
  assert.equal(args.indexOf('/tmp/b.png') < args.indexOf('/tmp/slides.mov'), true);
  assert.equal(args.includes('-stream_loop'), true);
  assert.match(filter, /\[0:v\]fps=59\.94,settb=AVTB,setpts=PTS-STARTPTS\[source0\]/);
  assert.match(filter, /\[layerInput0\]\[source0\]scale2ref=w=main_w:h=main_h\[layer0\]\[base0\]/);
  assert.match(filter, /\[base0\]\[layer0\]overlay=0:0:format=auto:shortest=0:eof_action=repeat:repeatlast=1\[composite0\]/);
  assert.match(filter, /\[layerInput1\]\[composite0\]scale2ref=w=main_w:h=main_h\[layer1\]\[base1\]/);
  assert.match(filter, /\[layerInput2\]\[composite1\]scale2ref=w=main_w:h=main_h\[layer2\]\[base2\]/);
  assert.match(filter, /\[base2\]\[layer2\]overlay=0:0:format=auto:shortest=0:eof_action=repeat:repeatlast=1,format=yuv420p\[vout\]/);
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-preset') + 1], 'superfast');
});

test('non-overlay encoding preserves the saved x264 preset', () => {
  const channels = createRelayChannels('pipe-a', [{ id: 'dest-1' }]);
  const args = buildSharedRelayArgs({ type: 'pull', url: 'rtmp://origin.example.com/live/pgm' }, channels, {
    live: { videoEncoder: 'libx264', preset: 'fast', bitrateKbps: 8000 },
    video: { outputResolution: '1920x1080', fps: '59.94' },
    watermarks: [],
    slideshow: { images: [] },
  });

  assert.equal(args[args.indexOf('-preset') + 1], 'fast');
});
