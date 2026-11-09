const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseFFmpegStatsLine,
  parseFFmpegStreamInfoLine,
  updateDropRate,
  createFFmpegProgressAccumulator,
  mergeFFmpegProgressSnapshot,
  isReportableFFmpegError,
  isRelayTransportWarning,
} = require('../server/lib/metrics');

test('FFmpeg progress accumulator buffers fragmented CR-delimited records', () => {
  const accumulator = createFFmpegProgressAccumulator();

  assert.deepEqual(accumulator.push('frame=   60 fps=60 size= 1000kB ti'), []);
  assert.deepEqual(accumulator.push('me=00:00:01.00 bitrate=8192.0kbits/s drop=0\rframe=  120 fps=60 size='), [
    'frame=   60 fps=60 size= 1000kB time=00:00:01.00 bitrate=8192.0kbits/s drop=0',
  ]);
  assert.deepEqual(accumulator.push(' 2000kB time=00:00:02.00 bitrate=8192.0kbits/s drop=0\r'), [
    'frame=  120 fps=60 size= 2000kB time=00:00:02.00 bitrate=8192.0kbits/s drop=0',
  ]);
});

test('FFmpeg progress accumulator flushes one final unterminated record once', () => {
  const accumulator = createFFmpegProgressAccumulator();
  const finalRecord = 'frame= 60 fps=60 size=1000kB time=00:00:01.00 drop=0';

  assert.deepEqual(accumulator.push(finalRecord), []);
  assert.deepEqual(accumulator.flush(), [finalRecord]);
  assert.deepEqual(accumulator.flush(), []);
});

test('FFmpeg progress snapshots do not carry counters omitted by the current record', () => {
  const previous = {
    frame: 120,
    sizeBytes: 2_000_000,
    timeSec: 2,
    drop: 3,
    fps: 60,
  };

  const snapshot = mergeFFmpegProgressSnapshot(previous, { bitrateKbps: 15000 }, {
    udpOverruns: 4,
    corruptPackets: 2,
  });

  assert.equal(snapshot.bitrateKbps, 15000);
  assert.equal(snapshot.udpOverruns, 4);
  assert.equal(snapshot.corruptPackets, 2);
  assert.equal('frame' in snapshot, false);
  assert.equal('sizeBytes' in snapshot, false);
  assert.equal('timeSec' in snapshot, false);
  assert.equal('drop' in snapshot, false);
});

test('parseFFmpegStatsLine extracts bitrate fps frame and drop values', () => {
  const parsed = parseFFmpegStatsLine('frame=  180 fps=59.8 q=24.0 size=  10240kB time=00:00:03.00 bitrate=27962.7kbits/s dup=2 drop=3 speed=1.0x');
  assert.equal(parsed.frame, 180);
  assert.equal(parsed.fps, 59.8);
  assert.equal(parsed.bitrateKbps, 27962.7);
  assert.equal(parsed.dup, 2);
  assert.equal(parsed.drop, 3);
  assert.equal(parsed.time, '00:00:03.00');
  assert.equal(parsed.timeSec, 3);
  assert.equal(parsed.sizeBytes, 10 * 1024 * 1024);
});

test('parseFFmpegStatsLine keeps the latest carriage-return progress values', () => {
  const parsed = parseFFmpegStatsLine('size=  100kB time=00:00:01.00 bitrate= 819.2kbits/s speed=1.0x\rsize=  625kB time=00:00:02.00 bitrate=2560.0kbits/s speed=0.5x');

  assert.equal(parsed.sizeBytes, 625 * 1024);
  assert.equal(parsed.timeSec, 2);
  assert.equal(parsed.bitrateKbps, 2560);
  assert.equal(parsed.speed, 0.5);
});

test('updateDropRate calculates percentage from deltas', () => {
  const previous = { frame: 100, drop: 1 };
  const next = updateDropRate(previous, { frame: 200, drop: 3 });
  assert.equal(next.dropDelta, 2);
  assert.equal(next.frameDelta, 100);
  assert.equal(Number(next.dropRatePercent.toFixed(2)), 1.96);
});

test('parseFFmpegStreamInfoLine extracts fallback bitrate and fps from stream descriptions', () => {
  assert.deepEqual(parseFFmpegStreamInfoLine('  Stream #0:0: Video: h264 (Main), yuv420p, 1920x1080, 15360 kb/s, 59 fps, 59.94 tbr'), {
    type: 'video',
    bitrateKbps: 15360,
    fps: 59,
  });
  assert.deepEqual(parseFFmpegStreamInfoLine('  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo, fltp, 320 kb/s'), {
    type: 'audio',
    bitrateKbps: 320,
  });
});

test('local relay workers ignore transient H264 attach errors but retain real connection failures', () => {
  const relayArgs = ['-i', 'udp://127.0.0.1:45470?fifo_size=4096', '-c', 'copy'];

  assert.equal(isReportableFFmpegError('output', relayArgs, '[h264 @ 0x123] decode_slice_header error'), false);
  assert.equal(isReportableFFmpegError('output', relayArgs, 'Connection refused'), true);
  assert.equal(isReportableFFmpegError('output', ['-i', 'rtmp://origin/live'], 'decode_slice_header error'), true);
});

test('local relay transport warnings identify UDP overruns and corrupt packets', () => {
  const relayArgs = ['-i', 'udp://127.0.0.1:45470?fifo_size=4096', '-c', 'copy'];

  assert.equal(isRelayTransportWarning('output', relayArgs, 'Circular buffer overrun. Surviving due to overrun_nonfatal option'), true);
  assert.equal(isRelayTransportWarning('output', relayArgs, 'corrupt input packet in stream 0'), true);
  assert.equal(isRelayTransportWarning('output', ['-i', 'rtmp://origin/live'], 'corrupt input packet in stream 0'), false);
});

test('local TCP relay corruption remains reportable', () => {
  const args = ['-i', 'tcp://127.0.0.1:47662', '-c', 'copy'];

  assert.equal(isReportableFFmpegError(
    'output',
    args,
    '[h264 @ 0x123] concealing 355 DC, 355 AC, 355 MV errors in I frame',
  ), true);
  assert.equal(isReportableFFmpegError('output', args, 'Packet corrupt (stream = 0)'), true);
});
