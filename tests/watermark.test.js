const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { saveWatermark } = require('../server/lib/watermarks');

function captureError(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected action to throw');
}

test('saveWatermark stores a supported image data URL under data/watermarks', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-watermark-'));
  const record = saveWatermark(rootDir, {
    name: 'logo.png',
    mimeType: 'image/png',
    data: 'data:image/png;base64,iVBORw0KGgo=',
  });

  assert.match(record.id, /^wm-/);
  assert.equal(record.mimeType, 'image/png');
  assert.equal(fs.existsSync(record.path), true);
  assert.deepEqual(fs.readFileSync(record.path), Buffer.from('iVBORw0KGgo=', 'base64'));
});

test('saveWatermark rejects unsupported and malformed uploads', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-watermark-'));
  const unsupported = captureError(() => saveWatermark(rootDir, { name: 'logo.svg', mimeType: 'image/svg+xml', data: 'data:image/svg+xml;base64,AA==' }));
  const malformed = captureError(() => saveWatermark(rootDir, { name: 'logo.png', mimeType: 'image/png', data: 'not-a-data-url' }));
  assert.match(unsupported.message, /Unsupported watermark format/);
  assert.match(malformed.message, /Invalid watermark data/);
  assert.equal(unsupported.statusCode, 400);
  assert.equal(malformed.statusCode, 400);
});
