'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { listDevices, probeInput } = require('../server/lib/devices');

test('listDevices isolates V4L2 ALSA and DeckLink discovery results', async () => {
  const commands = [];
  const runCommand = async (command, args) => {
    commands.push({ command, args });
    if (command === 'v4l2-ctl') throw new Error('v4l2 unavailable');
    if (command === 'arecord') return { ok: true, stdout: 'card 0: HDMI', stderr: '', error: '' };
    if (args.includes('-sources')) {
      return { ok: true, stdout: '', stderr: '  "DeckLink Duo 2 (1)" [DeckLink Duo 2 (1)]', error: '' };
    }
    return { ok: false, stdout: '', stderr: '[decklink @ 0x1] Hp59 1920x1080 at 60000/1001 fps (progressive)', error: 'listing completed' };
  };

  const result = await listDevices({
    readDevDir: () => ['video2', 'snd', 'video0'],
    runCommand,
    binaries: { ffmpeg: '/custom/ffmpeg', ffprobe: '/custom/ffprobe' },
    decklinkDevice: 'DeckLink Duo 2 (1)',
  });

  assert.deepEqual(result.v4l2.nodes, ['/dev/video0', '/dev/video2']);
  assert.equal(result.v4l2.ok, false);
  assert.match(result.v4l2.error, /v4l2 unavailable/);
  assert.deepEqual(result.alsa, { ok: true, text: 'card 0: HDMI', error: '' });
  assert.deepEqual(result.decklink.devices, ['DeckLink Duo 2 (1)']);
  assert.equal(result.decklink.formats[0].code, 'Hp59');
  assert.equal(commands.filter(call => call.command === '/custom/ffmpeg').length, 2);
});

test('probeInput uses the configured ffprobe path', async () => {
  let command = '';
  const result = await probeInput({ url: 'rtmp://example/live/main' }, {
    binaries: { ffprobe: '/custom/ffprobe' },
    runCommand: async value => {
      command = value;
      return { ok: true, stdout: '{"streams":[]}', stderr: '', error: '' };
    },
  });

  assert.equal(command, '/custom/ffprobe');
  assert.deepEqual(result, { streams: [] });
});
