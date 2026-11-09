const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureDir } = require('./store');

const MAX_WATERMARK_BYTES = 10 * 1024 * 1024;
const WATERMARK_FORMATS = {
  'image/png': { extension: '.png', signature: buffer => buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { extension: '.jpg', signature: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  'image/webp': { extension: '.webp', signature: buffer => buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' },
};

function watermarkDirectory(rootDir) {
  return path.join(rootDir, 'data', 'watermarks');
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function parseWatermarkData(payload = {}) {
  const mimeType = String(payload.mimeType || '').toLowerCase();
  const format = WATERMARK_FORMATS[mimeType];
  if (!format) throw validationError('Unsupported watermark format; use PNG, JPEG, or WebP');

  const match = String(payload.data || '').match(/^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) throw validationError('Invalid watermark data');
  if (String(match[1]).toLowerCase() !== mimeType) throw validationError('Watermark MIME type does not match the file data');

  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length || !format.signature(buffer)) throw validationError('Invalid watermark image content');
  if (buffer.length > MAX_WATERMARK_BYTES) throw validationError('Watermark image must not exceed 10 MiB');
  return { mimeType, format, buffer };
}

function saveWatermark(rootDir, payload = {}) {
  const { mimeType, format, buffer } = parseWatermarkData(payload);
  const id = `wm-${crypto.randomUUID().slice(0, 8)}`;
  const directory = watermarkDirectory(rootDir);
  ensureDir(directory);
  const filePath = path.join(directory, `${id}${format.extension}`);
  fs.writeFileSync(filePath, buffer);
  return {
    id,
    name: path.basename(String(payload.name || `watermark${format.extension}`)),
    mimeType,
    size: buffer.length,
    path: filePath,
    url: `/api/watermarks/${id}`,
    position: 'bottom-right',
    createdAt: new Date().toISOString(),
  };
}

function findWatermark(rootDir, id) {
  const safeId = String(id || '');
  if (!/^wm-[a-f0-9]{8}$/i.test(safeId)) return null;
  const directory = watermarkDirectory(rootDir);
  for (const [mimeType, format] of Object.entries(WATERMARK_FORMATS)) {
    const filePath = path.join(directory, `${safeId}${format.extension}`);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return { id: safeId, mimeType, path: filePath };
  }
  return null;
}

module.exports = {
  MAX_WATERMARK_BYTES,
  saveWatermark,
  findWatermark,
};
