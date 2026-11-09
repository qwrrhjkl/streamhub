const crypto = require('node:crypto');
const { mergeSettings } = require('./ffmpegBuilder');

const PINYIN_MAP = {
  主: 'zhu',
  信: 'xin',
  号: 'hao',
  赛: 'sai',
  事: 'shi',
  直: 'zhi',
  播: 'bo',
  间: 'jian',
  源: 'yuan',
  本: 'ben',
  地: 'di',
  采: 'cai',
  集: 'ji',
  卡: 'ka',
  虚: 'xu',
  拟: 'ni',
  多: 'duo',
  平: 'ping',
  台: 'tai',
};

function createSecret() {
  return crypto.randomBytes(12).toString('hex');
}

function createRoomId() {
  return `room-${crypto.randomUUID().slice(0, 8)}`;
}

function slugify(value, fallback = 'room') {
  const text = String(value || '').trim();
  const parts = [];
  for (const char of text) {
    if (/^[a-z0-9]$/i.test(char)) {
      parts.push(char.toLowerCase());
    } else if (PINYIN_MAP[char]) {
      parts.push(`-${PINYIN_MAP[char]}-`);
    } else if (/[\s._:/\\|]+/.test(char)) {
      parts.push('-');
    } else if (/^[\u4e00-\u9fff]$/.test(char)) {
      parts.push(`-u${char.codePointAt(0).toString(16)}-`);
    } else {
      parts.push('-');
    }
  }
  const slug = parts.join('').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug || `${fallback}-${crypto.randomUUID().slice(0, 6)}`;
}

function normalizeStreamName(value, fallbackName) {
  return slugify(value || fallbackName || 'live-room', 'room');
}

function createRoomRecord(payload = {}) {
  const name = String(payload.name || '本地直播间').trim();
  const streamName = normalizeStreamName(payload.streamName, name);
  return {
    id: payload.id || createRoomId(),
    name,
    streamName,
    publishSecret: payload.publishSecret || createSecret(),
    enabled: payload.enabled !== false,
    status: payload.status || 'idle',
    settings: mergeSettings(payload.settings),
    createdAt: payload.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    publisher: payload.publisher || null,
    lastPublishAt: payload.lastPublishAt || '',
    lastPublishDoneAt: payload.lastPublishDoneAt || '',
    notes: payload.notes || '',
  };
}

function updateRoomRecord(existing, payload = {}) {
  return createRoomRecord({
    ...existing,
    ...payload,
    id: existing.id,
    publishSecret: payload.publishSecret || existing.publishSecret,
    status: payload.status || existing.status || 'idle',
    settings: mergeSettings({
      ...(existing.settings || {}),
      ...(payload.settings || {}),
      live: { ...((existing.settings || {}).live || {}), ...((payload.settings || {}).live || {}) },
      video: { ...((existing.settings || {}).video || {}), ...((payload.settings || {}).video || {}) },
      audio: { ...((existing.settings || {}).audio || {}), ...((payload.settings || {}).audio || {}) },
    }),
    createdAt: existing.createdAt,
  });
}

function roomPublishInfo(room, settings = {}, host = '127.0.0.1') {
  if (!room) throw new Error('直播间不存在');
  const port = Number(settings.rtmpPort || 1935);
  const publishServer = `rtmp://${host}:${port}/live`;
  const streamKey = `${room.streamName}?secret=${room.publishSecret}`;
  return {
    publishServer,
    streamKey,
    publishUrl: `${publishServer}/${streamKey}`,
    localPlaybackUrl: `rtmp://127.0.0.1:${port}/live/${room.streamName}`,
    lanPlaybackUrl: `rtmp://${host}:${port}/live/${room.streamName}`,
  };
}

function extractPublishFields(payload = {}) {
  const rawName = String(payload.name || payload.stream || '').trim();
  const parsed = rawName.includes('?') ? new URLSearchParams(rawName.slice(rawName.indexOf('?') + 1)) : null;
  const name = rawName.includes('?') ? rawName.slice(0, rawName.indexOf('?')) : rawName;
  const secret = String(
    payload.secret ||
    payload.arg_secret ||
    payload.publishSecret ||
    (parsed && parsed.get('secret')) ||
    '',
  ).trim();
  return { name, secret };
}

function validatePublishRequest(payload = {}, rooms = []) {
  const { name, secret } = extractPublishFields(payload);
  const room = rooms.find(item => item.streamName === name);
  if (!room) return { ok: false, status: 404, error: '直播间不存在' };
  if (room.enabled === false) return { ok: false, status: 403, error: '直播间已禁用', room };
  if (!secret || secret !== room.publishSecret) return { ok: false, status: 403, error: '推流密钥不正确', room };
  return { ok: true, room };
}

module.exports = {
  createRoomRecord,
  updateRoomRecord,
  roomPublishInfo,
  extractPublishFields,
  validatePublishRequest,
  slugify,
};
