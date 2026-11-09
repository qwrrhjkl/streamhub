const { spawnSync } = require('node:child_process');
const { resolveMediaBinaries } = require('./mediaBinaries');

function checkNvencAvailability(run = spawnSync, binaries = resolveMediaBinaries()) {
  try {
    const result = run(binaries.ffmpeg, [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'color=c=black:s=256x256:r=1',
      '-frames:v', '1',
      '-an',
      '-c:v', 'h264_nvenc',
      '-f', 'null',
      '-',
    ], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    return {
      ok: result.status === 0 && !result.error,
      diagnostic: String(result.error?.message || result.stderr || '').trim().slice(-500),
    };
  } catch (error) {
    return {
      ok: false,
      diagnostic: String(error?.message || error || '').trim().slice(-500),
    };
  }
}

module.exports = { checkNvencAvailability };
