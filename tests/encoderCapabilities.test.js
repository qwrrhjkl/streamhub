const test = require('node:test');
const assert = require('node:assert/strict');

const { checkNvencAvailability } = require('../server/lib/encoderCapabilities');

test('NVENC capability probe uses a hardware-supported 256 pixel frame', () => {
  let invocation;
  const runner = (command, args, options) => {
    invocation = { command, args, options };
    return { status: 0, stderr: '' };
  };

  const result = checkNvencAvailability(runner);

  assert.equal(invocation.command, 'ffmpeg');
  assert.equal(invocation.args[0], '-hide_banner');
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('-loglevel'), invocation.args.indexOf('-loglevel') + 2), ['-loglevel', 'error']);
  assert.equal(invocation.args.includes('lavfi'), true);
  assert.equal(invocation.args.includes('color=c=black:s=256x256:r=1'), true);
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('-frames:v'), invocation.args.indexOf('-frames:v') + 2), ['-frames:v', '1']);
  assert.equal(invocation.args.includes('-an'), true);
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('-c:v'), invocation.args.indexOf('-c:v') + 2), ['-c:v', 'h264_nvenc']);
  assert.deepEqual(invocation.args.slice(-3), ['-f', 'null', '-']);
  assert.deepEqual(invocation.options, { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.deepEqual(result, { ok: true, diagnostic: '' });
});

test('NVENC capability probe uses the configured FFmpeg path', () => {
  let command = '';
  const result = checkNvencAvailability((value) => {
    command = value;
    return { status: 0, stderr: '' };
  }, { ffmpeg: '/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg' });

  assert.equal(result.ok, true);
  assert.equal(command, '/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg');
});

test('NVENC capability probe returns a bounded useful stderr tail on failure', () => {
  const driverMessage = 'Cannot load libcuda.so.1: NVIDIA driver library is unavailable';
  const result = checkNvencAvailability(() => ({
    status: 1,
    stderr: `${'unhelpful preamble '.repeat(100)}${driverMessage}`,
  }));

  assert.equal(result.ok, false);
  assert.match(result.diagnostic, /Cannot load libcuda\.so\.1/);
  assert.match(result.diagnostic, /NVIDIA driver library is unavailable/);
  assert.equal(result.diagnostic.length <= 500, true);
});

test('NVENC capability probe handles a returned runner error without throwing', () => {
  const result = checkNvencAvailability(() => ({
    status: null,
    stderr: 'ignored stderr',
    error: new Error('spawnSync ffmpeg ENOENT'),
  }));

  assert.deepEqual(result, { ok: false, diagnostic: 'spawnSync ffmpeg ENOENT' });
});

test('NVENC capability probe handles a thrown runner error deterministically', () => {
  const result = checkNvencAvailability(() => {
    throw new Error(`runner exploded ${'x'.repeat(600)}`);
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.endsWith('x'.repeat(500)), true);
  assert.equal(result.diagnostic.length, 500);
});
