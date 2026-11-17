const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { PreviewManager } = require('../server/lib/previewManager');

function createChild() {
  const child = new EventEmitter();
  child.pid = 4321;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    child.killed = true;
  };
  return child;
}

function createResponse() {
  return {
    writes: [],
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk) {
      this.writes.push(Buffer.from(chunk).toString('utf8'));
      return true;
    },
    end() {
      this.ended = true;
    },
  };
}

function createPreviewHarness({ previewSource = null } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-preview-'));
  const child = createChild();
  const spawned = [];
  const timers = [];
  const clearedTimers = [];
  let sequence = 0;
  const previews = new PreviewManager({
    rootDir,
    store: {
      getState() {
        return { settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] };
      },
    },
    processManager: {
      findPreviewSource() {
        return previewSource;
      },
    },
    mediaBinaries: { ffmpeg: '/opt/ffmpeg', ffprobe: '/opt/ffprobe' },
    createId: () => `preview-${++sequence}`,
    spawnProcess(command, args, options) {
      spawned.push({ command, args, options });
      return child;
    },
    scheduleTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearScheduledTimeout(timer) {
      timer.cleared = true;
      clearedTimers.push(timer);
    },
  });
  return { previews, child, spawned, timers, clearedTimers };
}

test('reuses one preview process for identical normalized input', () => {
  const { previews, spawned } = createPreviewHarness();
  const first = previews.start({ input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' } });
  const second = previews.start({ input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' } });

  assert.equal(first.id, second.id);
  assert.equal(spawned.length, 1);
});

test('starts a separate fragmented MP4 preview and serves it with the matching media type', () => {
  const { previews, spawned } = createPreviewHarness();
  const input = { type: 'url', url: 'rtmp://origin.example.com/live/pgm' };
  const mjpeg = previews.start({ input });
  const mp4 = previews.start({ input, format: 'mp4' });
  const response = createResponse();

  assert.notEqual(mjpeg.id, mp4.id);
  assert.equal(spawned.length, 2);
  assert.equal(spawned[0].args.includes('-c:v'), true);
  assert.equal(spawned[0].args.includes('mpjpeg'), true);
  assert.equal(spawned[1].args.includes('frag_keyframe+empty_moov+default_base_moof'), true);
  previews.attach(mp4.id, response);
  assert.equal(response.headers['content-type'], 'video/mp4');
});

test('uses a running shared-relay mirror instead of reopening the source', () => {
  const mirror = {
    id: 'preview-mirror',
    inputUrl: 'udp://127.0.0.1:50123?fifo_size=4096&overrun_nonfatal=1&buffer_size=1048576',
    outputUrl: 'udp://127.0.0.1:50123?pkt_size=1316',
  };
  const { previews, spawned } = createPreviewHarness({ previewSource: { kind: 'relay', previewMirror: mirror } });

  previews.start({ input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' } });

  assert.equal(spawned[0].args.includes(mirror.inputUrl), true);
  assert.equal(spawned[0].args.includes('rtmp://origin.example.com/live/pgm'), false);
});

test('uses a direct fallback generator instead of reopening the unavailable source', () => {
  const fallback = {
    type: 'fallback',
    settings: {
      video: { outputResolution: '1280x720', fps: '30' },
      audio: { sampleRate: '48000', channels: 'stereo' },
    },
  };
  const { previews, spawned } = createPreviewHarness({ previewSource: { kind: 'fallback', source: fallback } });

  previews.start({ input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' } });

  assert.equal(spawned[0].args.includes('color=c=black:s=1280x720:r=30'), true);
  assert.equal(spawned[0].args.includes('rtmp://origin.example.com/live/pgm'), false);
});

test('refuses a second reader for an active direct capture task', () => {
  const { previews, spawned } = createPreviewHarness({ previewSource: { kind: 'direct-capture' } });

  assert.throws(
    () => previews.start({ input: { type: 'capture', capture: { backend: 'decklink', device: 'DeckLink Duo 2 (1)' } } }),
    error => error.statusCode === 409 && /共享转推/.test(error.message),
  );
  assert.equal(spawned.length, 0);
});

test('fans out one MJPEG process to attached clients and cleans it up after thirty idle seconds', () => {
  const { previews, child, timers, clearedTimers } = createPreviewHarness();
  const preview = previews.start({ input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' } });
  const first = createResponse();
  const second = createResponse();

  previews.attach(preview.id, first);
  previews.attach(preview.id, second);
  child.stdout.emit('data', Buffer.from('frame-data'));
  previews.detach(preview.id, first);
  child.stdout.emit('data', Buffer.from('next-frame'));
  previews.detach(preview.id, second);

  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'multipart/x-mixed-replace; boundary=streamhub-preview');
  assert.deepEqual(first.writes, ['frame-data']);
  assert.deepEqual(second.writes, ['frame-data', 'next-frame']);
  assert.equal(clearedTimers.length >= 1, true);
  assert.equal(timers.at(-1).delay, 30_000);
  timers.at(-1).callback();
  assert.equal(child.killCalls, 1);
  assert.throws(() => previews.describe(preview.id), error => error.statusCode === 404);
});

test('explicit release waits for the final attached client before stopping a shared preview', () => {
  const { previews, child } = createPreviewHarness();
  const preview = previews.start({ input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' } });
  const response = createResponse();

  previews.attach(preview.id, response);
  assert.deepEqual(previews.stop(preview.id), { ok: true, status: 'in-use' });
  assert.equal(child.killCalls, 0);
  previews.detach(preview.id, response);

  assert.equal(child.killCalls, 1);
  assert.throws(() => previews.describe(preview.id), error => error.statusCode === 404);
});

test('publishes bounded Chinese diagnostics without source addresses or process arguments', () => {
  const { previews, child } = createPreviewHarness();
  const preview = previews.start({ input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm?token=secret' } });
  child.stderr.emit('data', Buffer.from('Error opening input rtmp://origin.example.com/live/pgm?token=secret\n'));

  const descriptor = previews.describe(preview.id);

  assert.deepEqual(Object.keys(descriptor).sort(), [
    'audioCodec', 'audioState', 'bitrateKbps', 'bitrateSource', 'fps', 'height', 'id',
    'latencyMs', 'message', 'sourceLabel', 'state', 'videoCodec', 'width',
  ]);
  assert.equal(descriptor.state, 'failed');
  assert.match(descriptor.message, /预览进程启动失败/);
  assert.doesNotMatch(JSON.stringify(descriptor), /origin|secret|args/i);
});

test('monitor preview is a separate one-frame session and publishes input metadata', () => {
  const { previews, child, spawned } = createPreviewHarness();
  const input = { type: 'url', url: 'rtmp://origin.example.com/live/pgm' };
  const full = previews.start({ input });
  const monitor = previews.start({ input, monitor: true });

  assert.notEqual(full.id, monitor.id);
  assert.equal(spawned.length, 2);
  assert.match(spawned[1].args[spawned[1].args.indexOf('-vf') + 1], /^fps=1,scale=.*480/);
  child.stderr.emit('data', Buffer.from('Stream #0:0: Video: h264, yuv420p, 1920x1080, 8000 kb/s, 59.94 fps\n'));
  const descriptor = previews.describe(monitor.id);
  assert.equal(descriptor.width, 1920);
  assert.equal(descriptor.height, 1080);
  assert.equal(descriptor.fps, 59.94);
  assert.equal(descriptor.bitrateKbps, 8000);
  assert.equal(descriptor.bitrateSource, 'input');
  assert.equal(descriptor.videoCodec, 'h264');
  assert.equal(descriptor.latencyMs, 1500);
  assert.equal(descriptor.audioState, 'disabled');
});

test('audio preview reports present and absent input tracks without making audio mandatory', () => {
  const withAudio = createPreviewHarness();
  const present = withAudio.previews.start({
    input: { type: 'url', url: 'rtmp://origin.example.com/live/with-audio' },
    format: 'mp4',
    audio: true,
  });
  withAudio.child.stderr.emit('data', Buffer.from([
    'Stream #0:1: Audio: aac, 48000 Hz, stereo, fltp, 128 kb/s',
    'Output #0, mp4, to pipe:1:',
    '',
  ].join('\n')));
  assert.equal(withAudio.previews.describe(present.id).audioState, 'present');
  assert.equal(withAudio.previews.describe(present.id).audioCodec, 'aac');

  const withoutAudio = createPreviewHarness();
  const absent = withoutAudio.previews.start({
    input: { type: 'url', url: 'rtmp://origin.example.com/live/video-only' },
    format: 'mp4',
    audio: true,
  });
  withoutAudio.child.stderr.emit('data', Buffer.from('Output #0, mp4, to pipe:1:\n'));
  assert.equal(withoutAudio.previews.describe(absent.id).audioState, 'absent');
  assert.equal(withoutAudio.spawned[0].args.includes('0:a:0?'), true);
});

test('relay preview ignores transient H264 attach errors while direct input still reports them', () => {
  const mirror = {
    inputUrl: 'udp://127.0.0.1:50123?fifo_size=4096&overrun_nonfatal=1&buffer_size=1048576',
    outputUrl: 'udp://127.0.0.1:50123?pkt_size=1316',
  };
  const relay = createPreviewHarness({ previewSource: { kind: 'relay', previewMirror: mirror } });
  const relayPreview = relay.previews.start({ input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' } });
  relay.child.stderr.emit('data', Buffer.from('[h264 @ 0x123] decode_slice_header error\n'));
  assert.equal(relay.previews.describe(relayPreview.id).state, 'connecting');

  const direct = createPreviewHarness();
  const directPreview = direct.previews.start({ input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' } });
  direct.child.stderr.emit('data', Buffer.from('[h264 @ 0x123] decode_slice_header error\n'));
  assert.equal(direct.previews.describe(directPreview.id).state, 'failed');
});

test('classifies a missing input signal separately from a failed process', () => {
  const { previews, child } = createPreviewHarness();
  const preview = previews.start({ input: { type: 'capture', capture: { backend: 'decklink', device: 'DeckLink Duo 2 (1)' } } });
  child.stderr.emit('data', Buffer.from('No input signal detected\n'));

  const descriptor = previews.describe(preview.id);
  assert.equal(descriptor.state, 'no-signal');
  assert.equal(descriptor.message, '暂无输入源');
});

test('classifies the DeckLink autodetect message as no input source', () => {
  const { previews, child } = createPreviewHarness();
  const preview = previews.start({ input: { type: 'capture', capture: { backend: 'decklink', device: 'DeckLink Duo 2 (1)' } } });
  child.stderr.emit('data', Buffer.from([
    '[decklink] Cannot Autodetect input stream or No signal',
    '[in#0] Error opening input: Input/output error',
    'Error opening input files: Input/output error',
    '',
  ].join('\n')));

  const descriptor = previews.describe(preview.id);
  assert.equal(descriptor.state, 'no-signal');
  assert.equal(descriptor.message, '暂无输入源');
});
