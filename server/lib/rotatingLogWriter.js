const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const SAFE_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function compactUtcTimestamp(value) {
  return new Date(Number(value)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function utcDay(value) {
  return new Date(Number(value)).toISOString().slice(0, 10);
}

function createRotatingLogWriter({
  dir,
  prefix,
  now = Date.now,
  maxBytes = DEFAULT_MAX_BYTES,
  onRotate = () => {},
} = {}) {
  const directory = path.resolve(String(dir || ''));
  const safePrefix = String(prefix || '');
  if (!SAFE_PREFIX.test(safePrefix) || path.basename(safePrefix) !== safePrefix) {
    throw new Error('log prefix must be an ASCII basename');
  }
  fs.mkdirSync(directory, { recursive: true });
  let currentFile = null;
  let currentDay = '';
  let currentBytes = 0;
  let lastTimestamp = '';
  let part = 1;
  let closed = false;

  function nextFile(timestamp) {
    const compact = compactUtcTimestamp(timestamp);
    if (compact === lastTimestamp) part += 1;
    else { lastTimestamp = compact; part = 1; }
    let candidate;
    do {
      const suffix = part === 1 ? '' : `-part-${part}`;
      candidate = path.join(directory, `${safePrefix}-${compact}${suffix}.log`);
      if (fs.existsSync(candidate)) part += 1;
      else break;
    } while (true);
    return candidate;
  }

  function rotate(timestamp) {
    const previous = currentFile;
    currentFile = nextFile(timestamp);
    currentDay = utcDay(timestamp);
    currentBytes = 0;
    onRotate(previous, currentFile);
  }

  return {
    get currentFile() { return currentFile; },
    append(value) {
      if (closed) throw new Error('log writer is closed');
      const text = String(value || '');
      if (!text) return currentFile;
      const timestamp = Number(now());
      const bytes = Buffer.byteLength(text);
      if (!currentFile || currentDay !== utcDay(timestamp) || (currentBytes > 0 && currentBytes + bytes > maxBytes)) {
        rotate(timestamp);
      }
      fs.appendFileSync(currentFile, text, 'utf8');
      currentBytes += bytes;
      return currentFile;
    },
    close() { closed = true; },
  };
}

module.exports = { DEFAULT_MAX_BYTES, createRotatingLogWriter };
