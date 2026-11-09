const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRoomRecord,
  roomPublishInfo,
  validatePublishRequest,
} = require('../server/lib/rooms');

test('createRoomRecord generates stable publish fields and OBS-style settings', () => {
  const room = createRoomRecord({
    name: '赛事直播间 A',
    streamName: 'PGM 主信号',
    settings: {
      live: { bitrateKbps: 12000 },
      video: { outputResolution: '1280x720', fps: '50' },
      audio: { channels: 'mono', tracks: [{ bitrateKbps: 192 }] },
    },
  });

  assert.match(room.id, /^room-/);
  assert.equal(room.name, '赛事直播间 A');
  assert.equal(room.streamName, 'pgm-zhu-xin-hao');
  assert.match(room.publishSecret, /^[a-f0-9]{24}$/);
  assert.equal(room.status, 'idle');
  assert.equal(room.settings.live.bitrateKbps, 12000);
  assert.equal(room.settings.video.outputResolution, '1280x720');
  assert.equal(room.settings.video.fps, '50');
  assert.equal(room.settings.audio.channels, 'mono');
  assert.equal(room.settings.audio.tracks[0].bitrateKbps, 192);
});

test('roomPublishInfo exposes server, key, full URL, and localhost playback URL', () => {
  const room = createRoomRecord({
    id: 'room-main',
    name: '主直播间',
    streamName: 'main',
    publishSecret: 'secret123',
  });

  const info = roomPublishInfo(room, { rtmpPort: 1935 }, '192.168.11.231');

  assert.equal(info.publishServer, 'rtmp://192.168.11.231:1935/live');
  assert.equal(info.streamKey, 'main?secret=secret123');
  assert.equal(info.publishUrl, 'rtmp://192.168.11.231:1935/live/main?secret=secret123');
  assert.equal(info.localPlaybackUrl, 'rtmp://127.0.0.1:1935/live/main');
  assert.equal(info.lanPlaybackUrl, 'rtmp://192.168.11.231:1935/live/main');
});

test('validatePublishRequest accepts enabled room with matching secret', () => {
  const room = createRoomRecord({
    id: 'room-main',
    name: '主直播间',
    streamName: 'main',
    publishSecret: 'secret123',
  });

  assert.equal(validatePublishRequest({ name: 'main', secret: 'secret123' }, [room]).ok, true);
  assert.equal(validatePublishRequest({ name: 'main?secret=secret123' }, [room]).ok, true);
  assert.equal(validatePublishRequest({ name: 'main', arg_secret: 'secret123' }, [room]).ok, true);
});

test('validatePublishRequest rejects disabled room and invalid secret', () => {
  const room = createRoomRecord({
    id: 'room-main',
    name: '主直播间',
    streamName: 'main',
    publishSecret: 'secret123',
  });
  const disabled = { ...room, enabled: false };

  assert.equal(validatePublishRequest({ name: 'missing', secret: 'secret123' }, [room]).ok, false);
  assert.equal(validatePublishRequest({ name: 'main', secret: 'wrong' }, [room]).ok, false);
  assert.equal(validatePublishRequest({ name: 'main', secret: 'secret123' }, [disabled]).ok, false);
});
