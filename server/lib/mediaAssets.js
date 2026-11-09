const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { createId, ensureDir } = require('./store');
const { resolveMediaBinaries } = require('./mediaBinaries');

const DEFAULT_MAX_MEDIA_BYTES = 50 * 1024 * 1024 * 1024;

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sanitizeMediaName(value) {
  const base = path.basename(String(value || '').trim());
  const extensionMatch = base.toLowerCase().match(/\.(mp4|mov|mkv|webm|m4v|ts)$/);
  const extension = extensionMatch ? extensionMatch[0] : '.mp4';
  const stem = base.slice(0, extensionMatch ? -extension.length : undefined)
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${stem || 'video'}${extension}`;
}

function displayMediaName(value) {
  const base = path.basename(String(value || '').trim()).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base && base !== '.' && base !== '..' ? base.slice(0, 180) : 'video.mp4';
}

function parseByteRange(header, size) {
  if (!header) return null;
  const match = String(header).match(/^bytes=(\d*)-(\d*)$/);
  if (!match || !Number.isInteger(size) || size < 1) throw httpError('请求的视频范围无效', 416);
  const [, startText, endText] = match;
  if (!startText && !endText) throw httpError('请求的视频范围无效', 416);

  let start;
  let end;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isInteger(suffix) || suffix <= 0) throw httpError('请求的视频范围无效', 416);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
      throw httpError('请求的视频范围无效', 416);
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function mimeTypeFor(name, fallback = '') {
  const extension = path.extname(String(name || '')).toLowerCase();
  return ({
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.ts': 'video/mp2t',
  })[extension] || (String(fallback).startsWith('video/') ? String(fallback) : 'application/octet-stream');
}

function publicAsset(asset) {
  if (!asset) return null;
  const { path: _path, ...record } = asset;
  return record;
}

function probeMediaFile(filePath, ffprobe) {
  return new Promise((resolve, reject) => {
    execFile(ffprobe, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath,
    ], { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(httpError('视频文件无法读取或格式不受支持', 400));
      try {
        const data = JSON.parse(stdout);
        const streams = Array.isArray(data.streams) ? data.streams : [];
        const video = streams.find(stream => stream.codec_type === 'video');
        if (!video) return reject(httpError('文件中没有可用的视频轨道', 400));
        const audio = streams.find(stream => stream.codec_type === 'audio');
        const duration = Number(data.format && data.format.duration || video.duration || 0);
        return resolve({
          durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0,
          width: Number(video.width) || 0,
          height: Number(video.height) || 0,
          videoCodec: String(video.codec_name || ''),
          audioCodec: String(audio && audio.codec_name || ''),
        });
      } catch {
        return reject(httpError('视频探测结果无效', 400));
      }
    });
  });
}

class MediaAssetManager {
  constructor({
    rootDir,
    store,
    maxBytes = DEFAULT_MAX_MEDIA_BYTES,
    probe = null,
    mediaBinaries = resolveMediaBinaries(),
  }) {
    this.rootDir = rootDir;
    this.store = store;
    this.maxBytes = maxBytes;
    this.videoDir = path.resolve(rootDir, 'data', 'videos');
    this.mediaBinaries = mediaBinaries;
    this.probeFile = probe || (filePath => probeMediaFile(filePath, this.mediaBinaries.ffprobe));
    ensureDir(this.videoDir);
  }

  list() {
    return (this.store.list('mediaAssets') || []).map(publicAsset);
  }

  requireRecord(id) {
    const asset = (this.store.list('mediaAssets') || []).find(item => item.id === id);
    if (!asset) throw httpError('未找到视频素材', 404);
    return asset;
  }

  managedPath(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    if (resolved === this.videoDir || !resolved.startsWith(`${this.videoDir}${path.sep}`)) {
      throw httpError('视频素材路径不受系统管理', 400);
    }
    return resolved;
  }

  async inspectedMetadata(filePath) {
    try {
      return await this.probeFile(filePath);
    } catch (error) {
      if (error && error.statusCode) throw error;
      throw httpError('视频文件无法读取或格式不受支持', 400);
    }
  }

  createRecord(filePath, metadata, probe) {
    const stat = fs.statSync(filePath);
    const id = metadata.id || createId('media');
    const record = {
      id,
      name: displayMediaName(metadata.name),
      source: metadata.source || 'upload',
      mimeType: mimeTypeFor(filePath, metadata.mimeType),
      sizeBytes: stat.size,
      durationSec: Number(probe.durationSec) || 0,
      width: Number(probe.width) || 0,
      height: Number(probe.height) || 0,
      videoCodec: String(probe.videoCodec || ''),
      audioCodec: String(probe.audioCodec || ''),
      sourcePipelineId: String(metadata.sourcePipelineId || ''),
      watermarkFingerprint: String(metadata.watermarkFingerprint || ''),
      createdAt: metadata.createdAt || new Date().toISOString(),
      path: filePath,
      url: `/api/media-assets/${id}/content`,
    };
    return this.store.create('mediaAssets', record, 'media');
  }

  async upload(request, metadata = {}) {
    const declaredLength = Number(request.headers && request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
      throw httpError('视频文件超过上传大小限制', 413);
    }
    const id = createId('media');
    const storageName = sanitizeMediaName(metadata.name);
    const extension = path.extname(storageName) || '.mp4';
    const temporaryPath = path.join(this.videoDir, `.upload-${id}${extension}`);
    const finalPath = path.join(this.videoDir, `${id}-${storageName}`);
    let received = 0;
    const counter = new Transform({
      transform: (chunk, _encoding, callback) => {
        received += chunk.length;
        if (received > this.maxBytes) return callback(httpError('视频文件超过上传大小限制', 413));
        callback(null, chunk);
      },
    });

    try {
      await pipeline(request, counter, fs.createWriteStream(temporaryPath, { flags: 'wx' }));
      if (!received) throw httpError('视频文件为空', 400);
      const probe = await this.inspectedMetadata(temporaryPath);
      fs.renameSync(temporaryPath, finalPath);
      return publicAsset(this.createRecord(finalPath, {
        ...metadata,
        id,
        source: 'upload',
        mimeType: metadata.mimeType || request.headers && request.headers['content-type'],
      }, probe));
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch {}
      try { fs.unlinkSync(finalPath); } catch {}
      throw error;
    }
  }

  async registerRecording(filePath, metadata = {}) {
    const sourcePath = this.managedPath(filePath);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      throw httpError('录制文件不存在', 400);
    }
    const probe = await this.inspectedMetadata(sourcePath);
    const id = createId('media');
    const storageName = sanitizeMediaName(`${metadata.name || 'recording'}.mp4`);
    const finalPath = path.join(this.videoDir, `${id}-${storageName}`);
    fs.renameSync(sourcePath, finalPath);
    return publicAsset(this.createRecord(finalPath, {
      ...metadata,
      id,
      source: 'recording',
      mimeType: 'video/mp4',
    }, probe));
  }

  serve(request, response, id) {
    const asset = this.requireRecord(id);
    const filePath = this.managedPath(asset.path);
    if (!fs.existsSync(filePath)) throw httpError('视频素材文件不存在', 404);
    const stat = fs.statSync(filePath);
    let range;
    try {
      range = parseByteRange(request.headers && request.headers.range, stat.size);
    } catch (error) {
      if (error.statusCode === 416) response.setHeader('content-range', `bytes */${stat.size}`);
      throw error;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : stat.size - 1;
    response.writeHead(range ? 206 : 200, {
      'content-type': asset.mimeType || mimeTypeFor(filePath),
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}),
      'cache-control': 'private, max-age=3600',
    });
    if (request.method === 'HEAD') return response.end();
    return fs.createReadStream(filePath, { start, end }).pipe(response);
  }

  remove(id) {
    const asset = this.requireRecord(id);
    const filePath = this.managedPath(asset.path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    this.store.remove('mediaAssets', id);
    return { ok: true, id };
  }
}

module.exports = {
  DEFAULT_MAX_MEDIA_BYTES,
  MediaAssetManager,
  parseByteRange,
  publicAsset,
  sanitizeMediaName,
};
