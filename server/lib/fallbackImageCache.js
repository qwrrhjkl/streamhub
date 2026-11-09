const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ensureDir } = require('./store');
const { resolveMediaBinaries } = require('./mediaBinaries');

const CACHE_VERSION = 2;

function parseResolution(value) {
  const match = String(value || '').match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) throw new Error('Fallback output resolution is invalid');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 16 || height < 16) throw new Error('Fallback output resolution is too small');
  return { width, height, text: `${width}x${height}` };
}

function sourceIdentity(sourcePath) {
  const filePath = String(sourcePath || '').trim();
  if (!filePath) throw new Error('Fallback image path is required');
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`Fallback image does not exist: ${path.basename(filePath) || filePath}`);
  }
  if (!stat.isFile()) throw new Error(`Fallback image is not a file: ${path.basename(filePath) || filePath}`);
  return { path: filePath, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
}

function normalizeLayout(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || width <= 0) return null;
  return { x, y, width };
}

function normalizeWatermarks(watermarks) {
  return (Array.isArray(watermarks) ? watermarks : [])
    .filter(item => item && String(item.path || '').trim())
    .map(item => ({
      path: String(item.path).trim(),
      layout: normalizeLayout(item.layout),
    }));
}

function fallbackImageCacheKey(sourcePath, resolution, watermarks = []) {
  const output = parseResolution(resolution);
  const payload = {
    version: CACHE_VERSION,
    source: sourceIdentity(sourcePath),
    resolution: output.text,
    watermarks: normalizeWatermarks(watermarks).map(item => ({
      source: sourceIdentity(item.path),
      layout: item.layout,
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
}

function filterNumber(value) {
  return String(Number(Number(value).toFixed(10)));
}

function buildFallbackImageArgs(sourcePath, resolution, outputPath, watermarks = []) {
  const { width, height } = parseResolution(resolution);
  const layers = normalizeWatermarks(watermarks);
  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', String(sourcePath),
  ];
  if (!layers.length) {
    return [
      ...args,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,format=rgba`,
      '-frames:v', '1',
      '-c:v', 'png',
      '-pix_fmt', 'rgba',
      String(outputPath),
    ];
  }

  for (const layer of layers) {
    args.push('-loop', '1', '-framerate', '1', '-i', layer.path);
  }
  const filters = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=rgba[fallbackBase]`,
  ];
  let baseLabel = 'fallbackBase';
  layers.forEach((layer, index) => {
    const scale = layer.layout
      ? `${Math.max(1, Math.round(width * layer.layout.width / 1920))}:-1`
      : `${width}:${height}`;
    const x = layer.layout ? filterNumber(width * layer.layout.x / 1920) : '0';
    const y = layer.layout ? filterNumber(height * layer.layout.y / 1080) : '0';
    const outputLabel = `fallbackComposite${index}`;
    filters.push(`[${index + 1}:v]scale=${scale},format=rgba[watermark${index}]`);
    filters.push(`[${baseLabel}][watermark${index}]overlay=${x}:${y}:format=auto:shortest=1:eof_action=pass[${outputLabel}]`);
    baseLabel = outputLabel;
  });
  return [
    ...args,
    '-filter_complex', filters.join(';'),
    '-map', `[${baseLabel}]`,
    '-frames:v', '1',
    '-c:v', 'png',
    '-pix_fmt', 'rgba',
    String(outputPath),
  ];
}

function defaultRunner(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
}

function prepareFallbackImage({
  rootDir,
  sourcePath,
  resolution,
  watermarks = [],
  runner = defaultRunner,
  binaries = resolveMediaBinaries(),
}) {
  const normalizedWatermarks = normalizeWatermarks(watermarks);
  const key = fallbackImageCacheKey(sourcePath, resolution, normalizedWatermarks);
  const cacheDir = path.join(rootDir, 'data', 'fallback-cache');
  ensureDir(cacheDir);
  const outputPath = path.join(cacheDir, `${key}.png`);
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    return { preparedPath: outputPath, cached: true, key, watermarksPrepared: normalizedWatermarks.length > 0 };
  }

  const temporaryPath = path.join(cacheDir, `${key}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp.png`);
  const args = buildFallbackImageArgs(sourcePath, resolution, temporaryPath, normalizedWatermarks);
  const result = runner(binaries.ffmpeg, args);
  if (!result || result.status !== 0 || !fs.existsSync(temporaryPath) || fs.statSync(temporaryPath).size === 0) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    const details = String(result && (result.stderr || result.error && result.error.message) || '').trim().slice(-1200);
    throw new Error(`Fallback image preparation failed${details ? `: ${details}` : ''}`);
  }
  fs.renameSync(temporaryPath, outputPath);
  return { preparedPath: outputPath, cached: false, key, watermarksPrepared: normalizedWatermarks.length > 0 };
}

module.exports = {
  fallbackImageCacheKey,
  buildFallbackImageArgs,
  prepareFallbackImage,
};
