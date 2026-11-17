const test = require('node:test');
const assert = require('node:assert/strict');

const { checkNvencAvailability, detectEncoderCapabilities } = require('../server/lib/encoderCapabilities');

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

test('capability detection distinguishes compiled, unavailable, and working encoders', () => {
  const invocations = [];
  const runner = (command, args) => {
    invocations.push(args);
    if (args.includes('-encoders')) {
      return { status: 0, stdout: ' V..... libx264\n V....D h264_nvenc\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const capabilities = detectEncoderCapabilities(runner);
  const byId = Object.fromEntries(capabilities.map(item => [item.id, item]));
  assert.equal(byId.libx264.available, true);
  assert.equal(byId.h264_nvenc.available, true);
  assert.equal(byId.h264_qsv.available, false);
  assert.equal(byId.h264_amf.available, false);
  assert.match(byId.h264_qsv.reason, /未编译/);
  assert.equal(invocations.filter(args => args.includes('-frames:v')).length, 1);
});

test('capability detection exposes concise hardware guidance instead of raw FFmpeg diagnostics', () => {
  const runner = (command, args) => {
    if (args.includes('-encoders')) return { status: 0, stdout: ' V..... libx264\n V....D h264_nvenc\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'cuInit failed: CUDA_ERROR_NO_DEVICE with internal stack details' };
  };
  const nvenc = detectEncoderCapabilities(runner).find(item => item.id === 'h264_nvenc');
  assert.equal(nvenc.available, false);
  assert.equal(nvenc.reason, 'NVIDIA 驱动未就绪或 GPU 不可见');
  assert.doesNotMatch(nvenc.reason, /CUDA_ERROR|stack/i);
});

test('capability detection retains an early GPU diagnostic before a long FFmpeg trailer', () => {
  const runner = (command, args) => {
    if (args.includes('-encoders')) return { status: 0, stdout: ' V..... libx264\n V....D h264_nvenc\n', stderr: '' };
    return {
      status: 1,
      stdout: '',
      stderr: `cuInit failed: CUDA_ERROR_NO_DEVICE\n${'generic encoder shutdown trailer '.repeat(30)}`,
    };
  };
  const nvenc = detectEncoderCapabilities(runner).find(item => item.id === 'h264_nvenc');
  assert.equal(nvenc.available, false);
  assert.equal(nvenc.reason, 'NVIDIA 驱动未就绪或 GPU 不可见');
});
