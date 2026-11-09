const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { LiveDelayBuffer, LiveDelayMemoryBudget } = require('../server/lib/liveDelayBuffer');

class FakeSocket extends EventEmitter {
  constructor(role, { deferSendCallbacks = false, deferClose = false } = {}) {
    super();
    this.role = role;
    this.deferSendCallbacks = deferSendCallbacks;
    this.deferClose = deferClose;
    this.bound = null;
    this.closed = false;
    this.sent = [];
    this.sendCallbacks = [];
    this.closeCallbacks = [];
  }

  bind(port, host) {
    this.bound = { port, host };
    this.emit('listening');
  }

  send(packet, port, host, callback) {
    this.sent.push({ packet: Buffer.from(packet), port, host });
    if (!callback) return;
    if (this.deferSendCallbacks) this.sendCallbacks.push(callback);
    else callback();
  }

  completeSends(error) {
    for (const callback of this.sendCallbacks.splice(0)) callback(error);
  }

  close(callback) {
    this.closed = true;
    if (this.deferClose) {
      if (callback) this.closeCallbacks.push(callback);
      return;
    }
    this.emit('close');
    if (callback) callback();
  }

  completeClose() {
    this.emit('close');
    for (const callback of this.closeCallbacks.splice(0)) callback();
  }
}

class FakeTcpSocket extends EventEmitter {
  constructor({ deferWriteCallbacks = false, deferEndCallback = false, backpressure = false } = {}) {
    super();
    this.deferWriteCallbacks = deferWriteCallbacks;
    this.deferEndCallback = deferEndCallback;
    this.backpressured = backpressure;
    this.destroyed = false;
    this.ended = false;
    this.writes = [];
    this.writeCallbacks = [];
    this.endCallbacks = [];
  }

  setNoDelay() {}

  write(packet, callback) {
    this.writes.push(Buffer.from(packet));
    if (this.deferWriteCallbacks) this.writeCallbacks.push(callback);
    else callback();
    return !this.backpressured;
  }

  releaseBackpressure() {
    this.backpressured = false;
    this.emit('drain');
  }

  completeWrites(error) {
    for (const callback of this.writeCallbacks.splice(0)) callback(error);
  }

  end(callback) {
    this.ended = true;
    if (this.deferEndCallback) this.endCallbacks.push(callback);
    else callback();
  }

  completeEnd() {
    for (const callback of this.endCallbacks.splice(0)) callback();
  }

  destroy() {
    this.destroyed = true;
  }
}

class FakeTcpServer extends EventEmitter {
  constructor({ deferListening = false, deferClose = false } = {}) {
    super();
    this.deferListening = deferListening;
    this.deferClose = deferClose;
    this.bound = null;
    this.closed = false;
    this.closeCallbacks = [];
  }

  listen(port, host) {
    this.bound = { port, host };
    if (!this.deferListening) this.emit('listening');
  }

  markListening() {
    this.emit('listening');
  }

  connect(socket) {
    this.emit('connection', socket);
  }

  close(callback) {
    this.closed = true;
    if (this.deferClose) {
      if (callback) this.closeCallbacks.push(callback);
      return;
    }
    this.emit('close');
    if (callback) callback();
  }

  completeClose() {
    this.emit('close');
    for (const callback of this.closeCallbacks.splice(0)) callback();
  }
}

function createHarness(options = {}) {
  let now = 1_000;
  const sockets = [];
  const inputServers = [];
  const outputServers = [];
  const scheduled = [];
  const buffer = new LiveDelayBuffer({
    delaySeconds: options.delaySeconds || 2,
    inputPort: 60_123,
    outputPorts: options.outputPorts || [31_001, 31_002],
    maxBufferedBytes: options.maxBufferedBytes || 1024,
    now: () => now,
    socketFactory(role) {
      const socket = new FakeSocket(role, {
        deferSendCallbacks: role === 'output' && options.deferSendCallbacks,
        deferClose: options.deferSocketClose,
      });
      sockets.push(socket);
      return socket;
    },
    scheduleTimer(callback, delayMs) {
      const timer = { callback, delayMs, cleared: false, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    onOverflow: options.onOverflow,
    onError: options.onError,
    onReady: options.onReady,
    memoryBudget: options.memoryBudget,
    inputTransport: options.inputTransport,
    outputTransport: options.outputTransport,
    serverFactory(role) {
      const server = new FakeTcpServer({
        deferListening: options.deferTcpListening,
        deferClose: options.deferServerClose,
      });
      if (role === 'input') inputServers.push(server);
      else outputServers.push(server);
      return server;
    },
  });
  return {
    buffer,
    sockets,
    servers: outputServers,
    outputServers,
    get inputServer() { return inputServers[0]; },
    scheduled,
    setNow(value) { now = value; },
  };
}

test('live delay buffer holds packets until their release time and fans out once', () => {
  const harness = createHarness();
  harness.buffer.start();
  const [input, output] = harness.sockets;

  input.emit('message', Buffer.from('packet-a'));

  assert.deepEqual(input.bound, { port: 60_123, host: '127.0.0.1' });
  assert.equal(harness.buffer.describe().bufferedPackets, 1);
  assert.equal(harness.buffer.flushDue(), 0);
  assert.equal(output.sent.length, 0);

  harness.setNow(3_000);
  assert.equal(harness.buffer.flushDue(), 1);
  assert.deepEqual(output.sent.map(item => item.port), [31_001, 31_002]);
  assert.equal(output.sent.every(item => item.packet.toString() === 'packet-a'), true);
  assert.equal(harness.buffer.describe().bufferedPackets, 0);
});

test('TCP delay readiness waits for input and every output listener', () => {
  let readyCalls = 0;
  const harness = createHarness({
    inputTransport: 'tcp-server',
    outputTransport: 'tcp-server',
    deferTcpListening: true,
    onReady() { readyCalls += 1; },
  });

  harness.buffer.start();
  assert.equal(readyCalls, 0);

  harness.inputServer.markListening();
  assert.equal(readyCalls, 0);

  harness.outputServers[0].markListening();
  assert.equal(readyCalls, 0);

  harness.outputServers[1].markListening();
  harness.outputServers[1].markListening();
  assert.equal(readyCalls, 1);
});

test('TCP input preserves arbitrary chunk order byte for byte', () => {
  const harness = createHarness({
    delaySeconds: 1,
    inputTransport: 'tcp-server',
    outputTransport: 'tcp-server',
    outputPorts: [31_001],
  });
  harness.buffer.start();
  const source = new FakeTcpSocket();
  const destination = new FakeTcpSocket();
  harness.inputServer.connect(source);
  harness.outputServers[0].connect(destination);

  source.emit('data', Buffer.from([0x47, 0x01]));
  source.emit('data', Buffer.from([0x02, 0x03, 0x47]));
  harness.setNow(2_000);
  harness.buffer.flushDue();

  assert.deepEqual(
    Buffer.concat(destination.writes),
    Buffer.from([0x47, 0x01, 0x02, 0x03, 0x47]),
  );
});

test('TCP input accepts only one active source client', () => {
  const harness = createHarness({
    inputTransport: 'tcp-server',
    outputTransport: 'tcp-server',
    outputPorts: [31_001],
  });
  harness.buffer.start();
  const first = new FakeTcpSocket();
  const second = new FakeTcpSocket();

  harness.inputServer.connect(first);
  harness.inputServer.connect(second);

  assert.equal(first.listenerCount('data'), 1);
  assert.equal(second.destroyed, true);
  assert.equal(second.listenerCount('data'), 0);
});

test('draining waits for delayed packets before closing the output socket', async () => {
  const harness = createHarness({ delaySeconds: 1, outputPorts: [31_001] });
  harness.buffer.start();
  const [input, output] = harness.sockets;
  input.emit('message', Buffer.from('tail'));

  let resolved = false;
  const draining = harness.buffer.beginDrain().then(() => { resolved = true; });
  await Promise.resolve();

  assert.equal(resolved, false);
  assert.equal(input.closed, true);
  assert.equal(output.closed, false);
  assert.equal(harness.buffer.describe().status, 'draining');

  harness.setNow(2_000);
  harness.buffer.flushDue();
  await draining;

  assert.equal(output.sent.length, 1);
  assert.equal(output.closed, true);
  assert.equal(harness.buffer.describe().status, 'stopped');
});

test('draining waits for asynchronous UDP sends before closing the output socket', async () => {
  const harness = createHarness({ delaySeconds: 1, outputPorts: [31_001], deferSendCallbacks: true });
  harness.buffer.start();
  const [input, output] = harness.sockets;
  input.emit('message', Buffer.from('tail'));

  let resolved = false;
  const draining = harness.buffer.beginDrain().then(() => { resolved = true; });
  harness.setNow(2_000);
  harness.buffer.flushDue();
  await Promise.resolve();

  assert.equal(output.sent.length, 1);
  assert.equal(resolved, false);
  assert.equal(output.closed, false);

  output.completeSends();
  await draining;

  assert.equal(output.closed, true);
  assert.equal(harness.buffer.describe().status, 'stopped');
});

test('released packets remain in resident memory accounting until UDP sends complete', () => {
  const harness = createHarness({ delaySeconds: 1, outputPorts: [31_001], deferSendCallbacks: true });
  harness.buffer.start();
  const [input, output] = harness.sockets;
  input.emit('message', Buffer.from('tail'));

  harness.setNow(2_000);
  harness.buffer.flushDue();

  assert.equal(harness.buffer.describe().bufferedBytes, 4);
  assert.equal(harness.buffer.describe().bufferedPackets, 1);

  output.completeSends();

  assert.equal(harness.buffer.describe().bufferedBytes, 0);
  assert.equal(harness.buffer.describe().bufferedPackets, 0);
});

test('discard keeps in-flight UDP memory reserved until send callbacks complete', async () => {
  const memoryBudget = new LiveDelayMemoryBudget(1024);
  const harness = createHarness({
    delaySeconds: 1,
    outputPorts: [31_001],
    deferSendCallbacks: true,
    memoryBudget,
  });
  harness.buffer.start();
  const [input, output] = harness.sockets;
  input.emit('message', Buffer.from('tail'));
  harness.setNow(2_000);
  harness.buffer.flushDue();

  await harness.buffer.discard();

  assert.equal(harness.buffer.describe().bufferedBytes, 4);
  assert.equal(memoryBudget.describe().usedBytes, 4);

  output.completeSends();

  assert.equal(harness.buffer.describe().bufferedBytes, 0);
  assert.equal(memoryBudget.describe().usedBytes, 0);
});

test('TCP delay output sends EOF only after every delayed write is flushed', async () => {
  const harness = createHarness({
    delaySeconds: 1,
    outputPorts: [31_001],
    outputTransport: 'tcp-server',
  });
  harness.buffer.start();
  const [input] = harness.sockets;
  const [server] = harness.servers;
  const client = new FakeTcpSocket({ deferWriteCallbacks: true, deferEndCallback: true });
  server.connect(client);
  input.emit('message', Buffer.from('tail'));

  const draining = harness.buffer.beginDrain();
  harness.setNow(2_000);
  harness.buffer.flushDue();
  await Promise.resolve();

  assert.equal(client.ended, false);
  assert.equal(server.closed, false);

  client.completeWrites();
  await Promise.resolve();

  assert.equal(client.ended, true);
  assert.equal(server.closed, false);

  client.completeEnd();
  await draining;

  assert.equal(server.closed, true);
  assert.equal(harness.buffer.describe().status, 'stopped');
});

test('TCP output pauses later releases until every client drains', () => {
  const harness = createHarness({
    delaySeconds: 1,
    inputTransport: 'tcp-server',
    outputTransport: 'tcp-server',
    outputPorts: [31_001],
  });
  harness.buffer.start();
  const source = new FakeTcpSocket();
  const destination = new FakeTcpSocket({ backpressure: true });
  harness.inputServer.connect(source);
  harness.outputServers[0].connect(destination);
  source.emit('data', Buffer.from('first'));
  source.emit('data', Buffer.from('second'));

  harness.setNow(2_000);
  harness.buffer.flushDue();
  assert.deepEqual(destination.writes.map(packet => packet.toString()), ['first']);

  destination.releaseBackpressure();
  assert.deepEqual(destination.writes.map(packet => packet.toString()), ['first', 'second']);
});

test('TCP disconnect while draining fails instead of waiting forever', async () => {
  const errors = [];
  const harness = createHarness({
    delaySeconds: 1,
    outputPorts: [31_001],
    outputTransport: 'tcp-server',
    onError(error) { errors.push(error); },
  });
  harness.buffer.start();
  const [input] = harness.sockets;
  const [server] = harness.servers;
  const client = new FakeTcpSocket();
  server.connect(client);
  input.emit('message', Buffer.from('tail'));

  const draining = harness.buffer.beginDrain();
  client.emit('close');

  assert.equal(harness.buffer.describe().status, 'error');
  assert.deepEqual(await draining, { status: 'error' });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /TCP.*31001/);
});

test('multiple delay buffers enforce one shared process memory budget', () => {
  const memoryBudget = new LiveDelayMemoryBudget(8);
  const first = createHarness({ outputPorts: [31_001], memoryBudget });
  const secondOverflows = [];
  const second = createHarness({
    outputPorts: [31_002],
    memoryBudget,
    onOverflow(error) { secondOverflows.push(error); },
  });
  first.buffer.start();
  second.buffer.start();

  first.sockets[0].emit('message', Buffer.from('12345'));
  second.sockets[0].emit('message', Buffer.from('6789'));

  assert.equal(first.buffer.describe().bufferedBytes, 5);
  assert.equal(second.buffer.describe().status, 'error');
  assert.equal(secondOverflows.length, 1);
  assert.equal(memoryBudget.describe().usedBytes, 5);
});

test('discarding closes immediately without forwarding buffered packets', async () => {
  const harness = createHarness({ outputPorts: [31_001] });
  harness.buffer.start();
  const [input, output] = harness.sockets;
  input.emit('message', Buffer.from('discard-me'));

  await harness.buffer.discard();

  assert.equal(input.closed, true);
  assert.equal(output.closed, true);
  assert.equal(output.sent.length, 0);
  assert.equal(harness.buffer.describe().bufferedBytes, 0);
  assert.equal(harness.buffer.describe().status, 'stopped');
});

test('discard waits until UDP and TCP listeners release their ports', async () => {
  const harness = createHarness({
    outputPorts: [31_001],
    outputTransport: 'tcp-server',
    deferSocketClose: true,
    deferServerClose: true,
  });
  harness.buffer.start();

  let resolved = false;
  const discarding = harness.buffer.discard().then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);

  harness.sockets[0].completeClose();
  await Promise.resolve();
  assert.equal(resolved, false);

  harness.servers[0].completeClose();
  await discarding;
  assert.equal(resolved, true);
});

test('buffer overflow drops the queue and reports one protective failure', () => {
  const overflows = [];
  const harness = createHarness({
    maxBufferedBytes: 4,
    onOverflow(error) { overflows.push(error); },
  });
  harness.buffer.start();
  const [input, output] = harness.sockets;

  input.emit('message', Buffer.from('12345'));

  assert.equal(overflows.length, 1);
  assert.match(overflows[0].message, /延时缓冲已超过内存保护上限/);
  assert.equal(harness.buffer.describe().status, 'error');
  assert.equal(harness.buffer.describe().bufferedBytes, 0);
  assert.equal(output.sent.length, 0);
});

test('output socket errors close the buffer and report only one failure', () => {
  const errors = [];
  const harness = createHarness({
    outputPorts: [31_001],
    onError(error) { errors.push(error); },
  });
  harness.buffer.start();
  const [input, output] = harness.sockets;
  input.emit('message', Buffer.from('queued'));

  output.emit('error', new Error('udp output failed'));
  output.emit('error', new Error('duplicate socket error'));

  assert.equal(harness.buffer.describe().status, 'error');
  assert.equal(harness.buffer.describe().bufferedBytes, 0);
  assert.equal(input.closed, true);
  assert.equal(output.closed, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /udp output failed/);
});

test('discard preserves a terminal buffer error status', async () => {
  const harness = createHarness({ outputPorts: [31_001] });
  harness.buffer.start();
  const output = harness.sockets[1];
  output.emit('error', new Error('udp output failed'));

  const result = await harness.buffer.discard();

  assert.deepEqual(result, { status: 'error' });
  assert.equal(harness.buffer.describe().status, 'error');
});
