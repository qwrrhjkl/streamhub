const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveEncodingPlan } = require('../server/lib/encodingPlan');

test('no-GPU auto capture uses CPU H.264 instead of NVENC', () => {
  assert.deepEqual(resolveEncodingPlan(
    { type: 'capture' },
    {},
    { nvencAvailable: false },
  ), {
    requestedVideoEncoder: 'auto',
    videoEncoder: 'libx264',
    audioEncoder: 'aac',
    encodingMode: 'cpu',
    requiresNvenc: false,
    filtersAllowed: true,
  });
});

test('no-GPU auto RTMP overlays use CPU H.264 and preserve copied audio', () => {
  assert.deepEqual(resolveEncodingPlan(
    { type: 'pull', url: 'rtmp://127.0.0.1/live/main' },
    { watermarks: [{ path: '/opt/StreamHub/data/watermarks/logo.png' }] },
    { nvencAvailable: false },
  ), {
    requestedVideoEncoder: 'auto',
    videoEncoder: 'libx264',
    audioEncoder: 'copy',
    encodingMode: 'cpu',
    requiresNvenc: false,
    filtersAllowed: true,
  });
});

test('no-GPU explicit h264_nvenc is rejected with an actionable error', () => {
  assert.throws(
    () => resolveEncodingPlan(
      { type: 'capture' },
      { live: { videoEncoder: 'h264_nvenc' } },
      { nvencAvailable: false },
    ),
    /h264_nvenc.*NVIDIA GPU.*libx264/i,
  );
});
