const test = require('node:test');
const assert = require('node:assert/strict');

const {
  visualProcessingActive,
  isRtmpSource,
  resolveEncodingPlan,
} = require('../server/lib/encodingPlan');

test('auto uses stream copy for an RTMP pull without visual processing', () => {
  const source = { type: 'pull', inputUrl: 'RTMPS://origin.example.com/live/main' };
  const expectedPlan = {
    requestedVideoEncoder: 'auto',
    videoEncoder: 'copy',
    audioEncoder: 'copy',
    encodingMode: 'copy',
    requiresNvenc: false,
    filtersAllowed: false,
  };

  assert.equal(isRtmpSource(source), true);
  assert.equal(isRtmpSource(null), false);
  assert.equal(visualProcessingActive(), false);
  assert.equal(visualProcessingActive(null), false);
  assert.deepEqual(resolveEncodingPlan(source), expectedPlan);
  assert.deepEqual(resolveEncodingPlan(source, null), expectedPlan);
  assert.throws(() => resolveEncodingPlan(null, null), /auto.*RTMP.*capture/i);
});

test('auto uses NVENC video and copied audio for an RTMP pull with a watermark', () => {
  const source = { type: 'pull', url: 'rtmp://origin.example.com/live/main' };
  const settings = { watermarks: [{ path: '/tmp/logo.png' }] };
  const preparedSlideshowSettings = {
    slideshow: { images: [], preparedPath: '/tmp/slides.mov' },
  };
  const expectedPlan = {
    requestedVideoEncoder: 'auto',
    videoEncoder: 'h264_nvenc',
    audioEncoder: 'copy',
    encodingMode: 'nvenc',
    requiresNvenc: true,
    filtersAllowed: true,
  };

  assert.equal(isRtmpSource(source), true);
  assert.equal(visualProcessingActive(settings), true);
  assert.equal(visualProcessingActive(preparedSlideshowSettings), true);
  assert.equal(visualProcessingActive({ watermarks: [{ path: '' }] }), false);
  assert.equal(visualProcessingActive({ watermark: { path: '' } }), false);
  assert.equal(visualProcessingActive({ slideshow: { images: [{ path: '' }] } }), false);
  assert.deepEqual(resolveEncodingPlan(source, settings), expectedPlan);
  assert.deepEqual(resolveEncodingPlan(source, preparedSlideshowSettings), expectedPlan);
});

test('auto uses NVENC video and AAC audio for capture input', () => {
  assert.deepEqual(resolveEncodingPlan({ type: 'capture' }), {
    requestedVideoEncoder: 'auto',
    videoEncoder: 'h264_nvenc',
    audioEncoder: 'aac',
    encodingMode: 'nvenc',
    requiresNvenc: true,
    filtersAllowed: true,
  });
});

test('explicit copy rejects RTMP overlays and capture inputs', () => {
  const rtmpSource = { type: 'pull', url: 'rtmp://origin.example.com/live/main' };

  assert.throws(
    () => resolveEncodingPlan(rtmpSource, {
      live: { videoEncoder: 'copy' },
      watermark: { path: '/tmp/legacy-logo.png' },
    }),
    /copy.*watermark.*slideshow/i,
  );
  assert.throws(
    () => resolveEncodingPlan(rtmpSource, {
      live: { videoEncoder: 'copy' },
      slideshow: { images: [{ path: '/tmp/slide.png' }] },
    }),
    /copy.*watermark.*slideshow/i,
  );
  assert.throws(
    () => resolveEncodingPlan({ type: 'capture' }, { live: { videoEncoder: 'copy' } }),
    /copy.*capture/i,
  );
  assert.deepEqual(
    resolveEncodingPlan(rtmpSource, { live: { videoEncoder: 'copy', audioEncoder: 'libopus' } }),
    {
      requestedVideoEncoder: 'copy',
      videoEncoder: 'copy',
      audioEncoder: 'libopus',
      encodingMode: 'copy',
      requiresNvenc: false,
      filtersAllowed: false,
    },
  );
});

test('auto rejects non-RTMP and non-capture inputs without a CPU fallback', () => {
  const conflictingSource = {
    type: 'pull',
    inputUrl: 'srt://origin.example.com:9000',
    url: 'rtmp://origin.example.com/live/main',
  };

  assert.equal(isRtmpSource({ type: 'pull', url: 'srt://origin.example.com:9000' }), false);
  assert.equal(isRtmpSource(conflictingSource), false);
  assert.throws(
    () => resolveEncodingPlan({ type: 'pull', url: 'srt://origin.example.com:9000' }),
    /auto.*RTMP.*capture/i,
  );
  assert.throws(() => resolveEncodingPlan(conflictingSource), /auto.*RTMP.*capture/i);
  assert.throws(
    () => resolveEncodingPlan({ type: 'file', url: 'rtmp://origin.example.com/live/main' }),
    /auto.*RTMP.*capture/i,
  );
  assert.throws(
    () => resolveEncodingPlan(
      { type: 'pull', url: 'rtmp://origin.example.com/live/main' },
      { live: { videoEncoder: 'hevc_nvenc' } },
    ),
    /unsupported.*video encoder/i,
  );
  assert.throws(
    () => resolveEncodingPlan(
      { type: 'pull', url: 'rtmp://origin.example.com/live/main' },
      { live: { videoEncoder: {} } },
    ),
    /videoEncoder.*non-empty string/i,
  );
  assert.throws(
    () => resolveEncodingPlan(
      { type: 'pull', url: 'rtmp://origin.example.com/live/main' },
      { live: { videoEncoder: '' } },
    ),
    /videoEncoder.*non-empty string/i,
  );
  assert.throws(
    () => resolveEncodingPlan(
      { type: 'pull', url: 'rtmp://origin.example.com/live/main' },
      { live: { audioEncoder: [] } },
    ),
    /audioEncoder.*non-empty string/i,
  );
  assert.throws(
    () => resolveEncodingPlan(
      { type: 'pull', url: 'rtmp://origin.example.com/live/main' },
      { live: { audioEncoder: '' } },
    ),
    /audioEncoder.*non-empty string/i,
  );
});

test('explicit libx264 stays on CPU and explicit h264_nvenc stays on NVENC', () => {
  const source = { type: 'file', path: '/tmp/program.mp4' };

  assert.deepEqual(resolveEncodingPlan(source, {
    live: { videoEncoder: 'libx264' },
  }), {
    requestedVideoEncoder: 'libx264',
    videoEncoder: 'libx264',
    audioEncoder: 'aac',
    encodingMode: 'cpu',
    requiresNvenc: false,
    filtersAllowed: true,
  });
  assert.deepEqual(resolveEncodingPlan(source, {
    live: { videoEncoder: 'libx264', audioEncoder: 'libopus' },
  }), {
    requestedVideoEncoder: 'libx264',
    videoEncoder: 'libx264',
    audioEncoder: 'libopus',
    encodingMode: 'cpu',
    requiresNvenc: false,
    filtersAllowed: true,
  });
  assert.deepEqual(resolveEncodingPlan(source, {
    live: { videoEncoder: 'h264_nvenc', audioEncoder: 'libopus' },
  }), {
    requestedVideoEncoder: 'h264_nvenc',
    videoEncoder: 'h264_nvenc',
    audioEncoder: 'libopus',
    encodingMode: 'nvenc',
    requiresNvenc: true,
    filtersAllowed: true,
  });
});
