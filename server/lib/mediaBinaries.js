'use strict';

function resolveMediaBinaries(env = process.env) {
  return {
    ffmpeg: String(env.STREAMHUB_FFMPEG || 'ffmpeg'),
    ffprobe: String(env.STREAMHUB_FFPROBE || 'ffprobe'),
  };
}

module.exports = { resolveMediaBinaries };
