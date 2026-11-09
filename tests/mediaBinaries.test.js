'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveMediaBinaries } = require('../server/lib/mediaBinaries');

test('resolveMediaBinaries uses PATH commands by default', () => {
  assert.deepEqual(resolveMediaBinaries({}), { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
});

test('resolveMediaBinaries honors deployment paths', () => {
  assert.deepEqual(resolveMediaBinaries({
    STREAMHUB_FFMPEG: '/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg',
    STREAMHUB_FFPROBE: '/opt/StreamHub/runtime/ffmpeg/bin/ffprobe',
  }), {
    ffmpeg: '/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg',
    ffprobe: '/opt/StreamHub/runtime/ffmpeg/bin/ffprobe',
  });
});
