const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ensureDir } = require('./store');
const { resolveMediaBinaries } = require('./mediaBinaries');

const MAX_SLIDESHOW_IMAGES = 20;
const MIN_INTERVAL_MS = 500;
const MAX_INTERVAL_MS = 60_000;
const MAX_TRANSITION_MS = 5_000;
const RENDER_FPS = 30;
const CACHE_VERSION = 1;

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function validateSlideshow(value = {}) {
  const images = Array.isArray(value.images) ? value.images.filter(Boolean) : [];
  if (images.length > MAX_SLIDESHOW_IMAGES) throw validationError('幻灯片最多添加 20 张图片');
  const intervalMs = value.intervalMs === undefined ? 2000 : Number(value.intervalMs);
  const transitionMs = value.transitionMs === undefined ? 700 : Number(value.transitionMs);
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw validationError('幻灯片播放间隔必须在 500 至 60000 ms 之间');
  }
  if (!Number.isFinite(transitionMs) || transitionMs < 0 || transitionMs > MAX_TRANSITION_MS) {
    throw validationError('幻灯片淡入淡出时长必须在 0 至 5000 ms 之间');
  }
  if (transitionMs > intervalMs) throw validationError('幻灯片淡入淡出时长不能超过播放间隔');
  return {
    images: images.map(item => ({ ...item, path: String(item.path || '') })),
    intervalMs,
    transitionMs,
    loop: true,
  };
}

function parseResolution(value) {
  const match = String(value || '').match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) throw validationError('幻灯片输出分辨率格式无效');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 16 || height < 16) throw validationError('幻灯片输出分辨率过小');
  return { width, height, text: `${width}x${height}` };
}

function imageIdentity(image) {
  const filePath = String(image.path || '');
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw validationError(`幻灯片图片不存在：${path.basename(filePath) || filePath}`);
  }
  if (!stat.isFile()) throw validationError(`幻灯片图片不是文件：${path.basename(filePath) || filePath}`);
  return { path: filePath, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
}

function slideshowCacheKey(slideshow, resolution) {
  const normalized = validateSlideshow(slideshow);
  const output = parseResolution(resolution);
  const payload = {
    version: CACHE_VERSION,
    images: normalized.images.map(imageIdentity),
    resolution: output.text,
    intervalMs: normalized.intervalMs,
    transitionMs: normalized.transitionMs,
    fps: RENDER_FPS,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
}

function seconds(milliseconds) {
  return Number((milliseconds / 1000).toFixed(3)).toString();
}

function buildSlideshowRenderArgs(slideshow, resolution, outputPath) {
  const normalized = validateSlideshow(slideshow);
  const { width, height } = parseResolution(resolution);
  if (normalized.images.length < 2) throw validationError('至少需要两张图片才能生成幻灯片缓存');
  const inputs = [...normalized.images, normalized.images[0]];
  const inputDurationMs = normalized.intervalMs + normalized.transitionMs;
  const inputArgs = inputs.flatMap(image => [
    '-loop', '1',
    '-framerate', String(RENDER_FPS),
    '-t', seconds(inputDurationMs),
    '-i', String(image.path),
  ]);
  const filters = inputs.map((_, index) => (
    `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0,` +
    `format=rgba,setsar=1[slide${index}]`
  ));
  let previous = 'slide0';
  for (let index = 1; index < inputs.length; index += 1) {
    const output = `fade${index}`;
    const offsetMs = (normalized.intervalMs * index) - normalized.transitionMs;
    filters.push(
      `[${previous}][slide${index}]xfade=transition=fade:duration=${seconds(normalized.transitionMs)}:` +
      `offset=${seconds(Math.max(0, offsetMs))}[${output}]`,
    );
    previous = output;
  }
  const cycleDurationMs = normalized.images.length * normalized.intervalMs;
  filters.push(`[${previous}]trim=duration=${seconds(cycleDurationMs)},setpts=PTS-STARTPTS[outv]`);

  return [
    '-hide_banner', '-nostdin', '-y',
    ...inputArgs,
    '-filter_complex', filters.join(';'),
    '-map', '[outv]',
    '-an',
    '-r', String(RENDER_FPS),
    '-c:v', 'qtrle',
    '-pix_fmt', 'argb',
    String(outputPath),
  ];
}

function defaultRunner(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
}

function prepareSlideshowCache({ rootDir, slideshow, resolution, runner = defaultRunner, binaries = resolveMediaBinaries() }) {
  const normalized = validateSlideshow(slideshow);
  if (!normalized.images.length) return { preparedPath: '', cached: false, key: '' };
  normalized.images.forEach(imageIdentity);
  if (normalized.images.length === 1) {
    return { preparedPath: normalized.images[0].path, cached: false, key: '' };
  }

  const key = slideshowCacheKey(normalized, resolution);
  const cacheDir = path.join(rootDir, 'data', 'slideshow-cache');
  ensureDir(cacheDir);
  const outputPath = path.join(cacheDir, `${key}.mov`);
  if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    return { preparedPath: outputPath, cached: true, key };
  }

  const temporaryPath = path.join(cacheDir, `${key}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp.mov`);
  const args = buildSlideshowRenderArgs(normalized, resolution, temporaryPath);
  const result = runner(binaries.ffmpeg, args);
  if (!result || result.status !== 0 || !fs.existsSync(temporaryPath) || fs.statSync(temporaryPath).size === 0) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    const details = String(result && (result.stderr || result.error && result.error.message) || '').trim().slice(-1200);
    throw new Error(`生成幻灯片缓存失败${details ? `：${details}` : ''}`);
  }
  fs.renameSync(temporaryPath, outputPath);
  return { preparedPath: outputPath, cached: false, key };
}

module.exports = {
  MAX_SLIDESHOW_IMAGES,
  validateSlideshow,
  slideshowCacheKey,
  buildSlideshowRenderArgs,
  prepareSlideshowCache,
};
