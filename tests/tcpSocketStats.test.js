const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSsOutput,
  selectOutboundSocket,
  destinationSupportsTcpStats,
  TcpSocketStatsCollector,
} = require('../server/lib/tcpSocketStats');

const SS_FIXTURE = [
  'ESTAB 0 0 10.0.0.2:41000 10.0.0.3:1935 users:(("ffmpeg",pid=4242,fd=7))',
  ' cubic wscale:7,7 rto:204 rtt:1.2/0.4 bytes_sent:12000 bytes_acked:11800 bytes_retrans:200 data_segs_out:30 data_segs_in:900',
  'ESTAB 0 0 10.0.0.2:42000 10.0.0.4:443 users:(("ffmpeg",pid=4242,fd=8))',
  ' cubic wscale:7,7 rto:204 rtt:1.1/0.3 bytes_sent:9000000 bytes_acked:8800000 bytes_retrans:12000 data_segs_out:7200 data_segs_in:40',
  'ESTAB 0 0 10.0.0.2:43000 10.0.0.5:1935 users:(("ffmpeg",pid=5252,fd=9))',
  ' cubic bytes_sent:4000000 bytes_acked:3900000 data_segs_out:3500 data_segs_in:25',
].join('\n');

test('ss parser maps cumulative TCP counters to the owning PID without endpoints', () => {
  const records = parseSsOutput(SS_FIXTURE);

  assert.equal(records.length, 3);
  assert.deepEqual(records[1], {
    pid: 4242,
    bytesSent: 9000000,
    bytesAcked: 8800000,
    bytesRetrans: 12000,
    dataSegsOut: 7200,
    dataSegsIn: 40,
  });
  assert.equal(JSON.stringify(records).includes('10.0.0.'), false);
  assert.equal(records[2].bytesRetrans, 0);
});

test('outbound socket selection rejects an input-dominant connection', () => {
  const selected = selectOutboundSocket(parseSsOutput(SS_FIXTURE), 4242);

  assert.equal(selected.bytesAcked, 8800000);
  assert.equal(selected.dataSegsOut, 7200);
  assert.equal(selectOutboundSocket(parseSsOutput(SS_FIXTURE), 9999), null);
});

test('transport counter support is limited to RTMP and RTMPS destinations', () => {
  assert.equal(destinationSupportsTcpStats({ protocol: 'rtmp' }), true);
  assert.equal(destinationSupportsTcpStats({ type: 'RTMPS' }), true);
  assert.equal(destinationSupportsTcpStats({ url: 'rtmps://push.example/live/key' }), true);
  assert.equal(destinationSupportsTcpStats({ url: 'srt://push.example:9000' }), false);
  assert.equal(destinationSupportsTcpStats({ protocol: 'file', path: '/data/out.flv' }), false);
});

test('collector coalesces concurrent samples and returns the selected PID counters', async () => {
  let calls = 0;
  let complete;
  const execFile = (_command, _args, _options, callback) => {
    calls += 1;
    complete = callback;
  };
  const collector = new TcpSocketStatsCollector({ execFile, now: () => 1000 });

  const first = collector.sample(4242);
  const second = collector.sample(5252);
  assert.equal(calls, 1);
  complete(null, SS_FIXTURE, '');

  assert.deepEqual(await first, {
    status: 'available',
    tcpSentBytes: 9000000,
    tcpAckedBytes: 8800000,
    tcpRetransBytes: 12000,
  });
  assert.deepEqual(await second, {
    status: 'available',
    tcpSentBytes: 4000000,
    tcpAckedBytes: 3900000,
    tcpRetransBytes: 0,
  });
});

test('collector contains command, malformed, missing PID, and stale snapshot failures', async () => {
  const diagnostics = [];
  const logger = { error(message) { diagnostics.push(message); } };
  const commandFailure = new TcpSocketStatsCollector({
    execFile: (_command, _args, _options, callback) => callback(new Error('permission denied'), '', ''),
    logger,
  });
  assert.deepEqual(await commandFailure.sample(4242), { status: 'unavailable' });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].includes('permission denied'), true);

  const malformed = new TcpSocketStatsCollector({
    execFile: (_command, _args, _options, callback) => callback(null, 'not an ss record', ''),
  });
  assert.deepEqual(await malformed.sample(4242), { status: 'unavailable' });

  const missingPid = new TcpSocketStatsCollector({
    execFile: (_command, _args, _options, callback) => callback(null, SS_FIXTURE, ''),
  });
  assert.deepEqual(await missingPid.sample(9999), { status: 'unavailable' });

  let now = 0;
  let complete;
  const stale = new TcpSocketStatsCollector({
    execFile: (_command, _args, _options, callback) => { complete = callback; },
    now: () => now,
    staleAfterMs: 2500,
  });
  const pending = stale.sample(4242);
  now = 3000;
  complete(null, SS_FIXTURE, '');
  assert.deepEqual(await pending, { status: 'unavailable' });
});
