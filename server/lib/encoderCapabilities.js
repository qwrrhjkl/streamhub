const { spawnSync } = require('node:child_process');
const { resolveMediaBinaries } = require('./mediaBinaries');

const ENCODERS = [
  { id: 'libx264', label: 'x264 软件编码', hardware: false },
  { id: 'h264_nvenc', label: 'NVIDIA NVENC', hardware: true },
  { id: 'h264_qsv', label: 'Intel Quick Sync', hardware: true },
  { id: 'h264_amf', label: 'AMD AMF', hardware: true },
];

function diagnosticText(result) {
  const text = String(result && (result.error?.message || result.stderr) || '').trim();
  const hardwareLine = text.split(/\r?\n/).find(line => (
    /cuda|nvidia|libcuda|no device|driver|quick sync|qsv|amf/i.test(line)
  ));
  if (!hardwareLine) return text.slice(-500);
  const marker = hardwareLine.trim().slice(0, 220);
  const tail = text.slice(-260);
  return `${marker}\n${tail}`.slice(0, 500);
}

function listCompiledEncoders(run = spawnSync, binaries = resolveMediaBinaries()) {
  try {
    const result = run(binaries.ffmpeg, ['-hide_banner', '-encoders'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    return new Set(ENCODERS.filter(item => new RegExp(`\\b${item.id}\\b`).test(output)).map(item => item.id));
  } catch {
    return new Set();
  }
}

function checkEncoderAvailability(encoder, run = spawnSync, binaries = resolveMediaBinaries()) {
  const id = String(encoder || '').trim();
  try {
    const result = run(binaries.ffmpeg, [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'color=c=black:s=256x256:r=1',
      '-frames:v', '1',
      '-an',
      '-c:v', id,
      '-f', 'null',
      '-',
    ], {
      encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    return {
      ok: result.status === 0 && !result.error,
      diagnostic: diagnosticText(result),
    };
  } catch (error) {
    return {
      ok: false,
      diagnostic: String(error?.message || error || '').trim().slice(-500),
    };
  }
}

function checkNvencAvailability(run = spawnSync, binaries = resolveMediaBinaries()) {
  return checkEncoderAvailability('h264_nvenc', run, binaries);
}

function hardwareFailureReason(id, diagnostic) {
  const text = String(diagnostic || '');
  if (id === 'h264_nvenc' && /cuda|nvidia|libcuda|no device|driver/i.test(text)) {
    return 'NVIDIA 驱动未就绪或 GPU 不可见';
  }
  if (id === 'h264_qsv') return 'Intel QSV 设备或驱动未就绪';
  if (id === 'h264_amf') return 'AMD AMF 设备或驱动未就绪';
  return '硬件编码预检失败';
}

function detectEncoderCapabilities(run = spawnSync, binaries = resolveMediaBinaries(), options = {}) {
  const compiled = listCompiledEncoders(run, binaries);
  return ENCODERS.map(item => {
    if (!compiled.has(item.id)) {
      return { ...item, available: false, reason: '当前 FFmpeg 未编译此编码器' };
    }
    if (!item.hardware) return { ...item, available: true, reason: '' };
    if (item.id === 'h264_nvenc' && options.nvencEnabled === false) {
      return { ...item, available: false, reason: '当前主机已禁用 NVIDIA NVENC' };
    }
    const result = checkEncoderAvailability(item.id, run, binaries);
    return {
      ...item,
      available: Boolean(result.ok),
      reason: result.ok ? '' : hardwareFailureReason(item.id, result.diagnostic),
    };
  });
}

module.exports = {
  ENCODERS,
  checkEncoderAvailability,
  checkNvencAvailability,
  detectEncoderCapabilities,
  listCompiledEncoders,
};
