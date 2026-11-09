'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseDecklinkDevices,
  parseDecklinkFormats,
  listDecklinkDevices,
  listDecklinkFormats,
  checkDecklinkAvailability,
} = require('../server/lib/decklink');

const DEVICE_OUTPUT = `
Auto-detected sources for decklink:
  "DeckLink Mini Recorder 4K" [DeckLink Mini Recorder 4K]
  "DeckLink Duo 2 (1)" [DeckLink Duo 2 (1)]
  "DeckLink Mini Recorder 4K" [duplicate]
`;

const DEVICE_ID_OUTPUT = `
Auto-detected sources for decklink:
  81:610e9870:00000000 [DeckLink Duo (1)] (none)
  81:610e9871:00000000 [DeckLink Duo (2)] (none)
`;

const FORMAT_OUTPUT = `
[decklink @ 0x1] Supported formats for 'DeckLink Mini Recorder 4K':
[decklink @ 0x1] Hp59 1920x1080 at 60000/1001 fps (progressive)
[decklink @ 0x1] Hi50 1920x1080 at 25/1 fps (interlaced)
`;

const FORMAT_TABLE_OUTPUT = `
[decklink @ 0x1] Supported formats for '81:610e9870:00000000':
\tformat_code\tdescription
\tHp50\t\t1920x1080 at 50000/1000 fps
\tHp59\t\t1920x1080 at 60000/1001 fps
\tHi50\t\t1920x1080 at 25000/1000 fps (interlaced, upper field first)
`;

test('parseDecklinkDevices returns unique device names', () => {
  assert.deepEqual(parseDecklinkDevices(DEVICE_OUTPUT), [
    'DeckLink Mini Recorder 4K',
    'DeckLink Duo 2 (1)',
  ]);
});

test('parseDecklinkDevices returns FFmpeg 7 device identifiers for DeckLink selection', () => {
  assert.deepEqual(parseDecklinkDevices(DEVICE_ID_OUTPUT), [
    '81:610e9870:00000000',
    '81:610e9871:00000000',
  ]);
});

test('DeckLink preflight confirms the device and selected format', () => {
  const outputs = [
    { status: 0, stdout: '', stderr: DEVICE_OUTPUT },
    { status: 1, stdout: '', stderr: FORMAT_OUTPUT },
  ];
  const result = checkDecklinkAvailability({
    type: 'capture',
    capture: { backend: 'decklink', device: 'DeckLink Mini Recorder 4K', formatCode: 'Hp59' },
  }, () => outputs.shift(), { ffmpeg: '/custom/ffmpeg' });

  assert.deepEqual(result, { ok: true, diagnostic: '' });
});

test('DeckLink preflight reports missing devices and formats in Chinese', () => {
  const missingDevice = checkDecklinkAvailability({
    type: 'capture', capture: { backend: 'decklink', device: 'Missing Card', formatCode: 'auto' },
  }, () => ({ status: 0, stdout: '', stderr: DEVICE_OUTPUT }), { ffmpeg: '/custom/ffmpeg' });
  assert.equal(missingDevice.ok, false);
  assert.match(missingDevice.diagnostic, /未找到设备.*Missing Card/);

  const outputs = [
    { status: 0, stdout: '', stderr: DEVICE_OUTPUT },
    { status: 1, stdout: '', stderr: FORMAT_OUTPUT },
  ];
  const missingFormat = checkDecklinkAvailability({
    type: 'capture', capture: { backend: 'decklink', device: 'DeckLink Mini Recorder 4K', formatCode: 'Hp50' },
  }, () => outputs.shift(), { ffmpeg: '/custom/ffmpeg' });
  assert.equal(missingFormat.ok, false);
  assert.match(missingFormat.diagnostic, /设备不支持格式.*Hp50/);
});

test('parseDecklinkFormats returns structured format choices', () => {
  assert.deepEqual(parseDecklinkFormats(FORMAT_OUTPUT), [
    { code: 'Hp59', width: 1920, height: 1080, fps: '60000/1001', scan: 'progressive' },
    { code: 'Hi50', width: 1920, height: 1080, fps: '25/1', scan: 'interlaced' },
  ]);
});

test('parseDecklinkFormats reads the FFmpeg 7 format table used by the device selector', () => {
  assert.deepEqual(parseDecklinkFormats(FORMAT_TABLE_OUTPUT), [
    { code: 'Hp50', width: 1920, height: 1080, fps: '50000/1000', scan: '' },
    { code: 'Hp59', width: 1920, height: 1080, fps: '60000/1001', scan: '' },
    { code: 'Hi50', width: 1920, height: 1080, fps: '25000/1000', scan: 'interlaced' },
  ]);
});

test('DeckLink discovery uses the configured FFmpeg and combines stderr output', async () => {
  const calls = [];
  const runCommand = async (command, args, timeout) => {
    calls.push({ command, args, timeout });
    return { ok: false, stdout: '', stderr: args.includes('-sources') ? DEVICE_OUTPUT : FORMAT_OUTPUT, error: 'expected listing exit' };
  };
  const binaries = { ffmpeg: '/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg' };

  const devices = await listDecklinkDevices({ runCommand, binaries });
  const formats = await listDecklinkFormats('DeckLink Mini Recorder 4K', { runCommand, binaries });

  assert.deepEqual(devices.devices, ['DeckLink Mini Recorder 4K', 'DeckLink Duo 2 (1)']);
  assert.deepEqual(formats.formats.map(item => item.code), ['Hp59', 'Hi50']);
  assert.equal(calls[0].command, binaries.ffmpeg);
  assert.deepEqual(calls[0].args, ['-hide_banner', '-sources', 'decklink']);
  assert.deepEqual(calls[1].args, ['-hide_banner', '-f', 'decklink', '-list_formats', '1', '-i', 'DeckLink Mini Recorder 4K']);
  assert.equal(calls.every(call => call.timeout === 10000), true);
});
