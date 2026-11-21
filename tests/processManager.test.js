const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { ProcessManager, sourceFailureFallbackDelay } = require('../server/lib/processManager');

test('capture fallback waits for startup grace and debounces brief signal loss', () => {
  assert.equal(sourceFailureFallbackDelay({ status: 'running', startedAt: 1000 }, 2000), 9000);
  assert.equal(sourceFailureFallbackDelay({ status: 'running', startedAt: 1000 }, 12000), 4000);
  assert.equal(sourceFailureFallbackDelay({ status: 'fallback', startedAt: 1000 }, 2000), 4000);
});

test('a capture process that exits during startup schedules fallback after the startup grace', () => {
  const startedAt = Date.now();
  const process = { lastSourceError: 'No input signal detected' };
  const session = {
    pipelineId: 'pipe-capture',
    mode: 'direct',
    status: 'running',
    startedAt,
    source: { type: 'capture' },
    pipelineProcess: process,
    intentionalStop: false,
    transitioning: false,
    sourceFailureTimer: null,
    sourceFailureProcess: null,
  };
  const scheduled = [];
  const fakeManager = {
    sessions: new Map([[session.pipelineId, session]]),
    scheduleStartupSourceRetry() { return false; },
    scheduleSourceFailureFallback: ProcessManager.prototype.scheduleSourceFailureFallback,
    clearSourceFailureDebounce(target) {
      target.sourceFailureTimer = null;
      target.sourceFailureProcess = null;
    },
    scheduleTimeout(callback, delay) {
      const timer = { callback, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
  };

  ProcessManager.prototype.handleSourceProcessExit.call(fakeManager, session, process);

  assert.equal(scheduled.length, 1);
  assert.ok(scheduled[0].delay >= 9_900 && scheduled[0].delay <= 10_000);
  assert.equal(session.sourceFailureProcess, process);
});

test('a shared relay capture exit retries the original source before falling back', () => {
  const process = { lastSourceError: 'Cannot Autodetect input stream or No signal' };
  const session = {
    pipelineId: 'pipe-capture',
    mode: 'shared-relay',
    status: 'running',
    startedAt: Date.now(),
    source: { type: 'capture' },
    liveDelayChannel: { port: 12345 },
    pipelineProcess: process,
    intentionalStop: false,
    transitioning: false,
    sourceFailureTimer: null,
    sourceFailureProcess: null,
    startupSourceRetries: 0,
    startupSourceRetryTimer: null,
  };
  const scheduled = [];
  let relayStarts = 0;
  let fallbackSchedules = 0;
  const fakeManager = {
    sessions: new Map([[session.pipelineId, session]]),
    store: { patches: [], patch(collection, id, patch) { this.patches.push({ collection, id, patch }); } },
    clearSourceFailureDebounce: ProcessManager.prototype.clearSourceFailureDebounce,
    canRetryStartupSource: ProcessManager.prototype.canRetryStartupSource,
    scheduleStartupSourceRetry: ProcessManager.prototype.scheduleStartupSourceRetry,
    scheduleSourceFailureFallback() { fallbackSchedules += 1; },
    clearScheduledTimeout(timer) { timer.cleared = true; },
    scheduleTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    startSharedRelaySource(targetSession) {
      relayStarts += 1;
      targetSession.pipelineProcess = { status: 'running' };
    },
  };

  ProcessManager.prototype.handleSourceProcessExit.call(fakeManager, session, process);

  assert.equal(fallbackSchedules, 0);
  assert.equal(session.startupSourceRetries, 1);
  assert.equal(scheduled[0].delay, 1500);
  scheduled[0].callback();
  assert.equal(relayStarts, 1);
  assert.equal(fakeManager.store.patches.length, 1);
  assert.equal(fakeManager.store.patches[0].patch.status, 'running');
});

function createFakeStore(state) {
  const patches = [];
  if (!state.monitorDisplay) state.monitorDisplay = { dropBaselines: {} };
  return {
    getState() {
      return state;
    },
    patch(collection, id, payload) {
      patches.push({ collection, id, payload });
      const list = state[collection] || [];
      const item = list.find(entry => entry.id === id);
      if (item) Object.assign(item, payload);
      return item;
    },
    update(mutator) {
      const draft = JSON.parse(JSON.stringify(state));
      const result = mutator(draft) || draft;
      Object.keys(state).forEach(key => delete state[key]);
      Object.assign(state, result);
      return state;
    },
    patches,
  };
}

function createManager(state, rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-manager-')), options = {}) {
  return new ProcessManager({
    rootDir,
    store: createFakeStore(state),
    tcpStatsCollector: { async sample() { return { status: 'unavailable' }; } },
    ...options,
  });
}

test('spawnFFmpeg uses the configured deployment binary', () => {
  let invocation;
  const child = new EventEmitter();
  child.pid = 42;
  child.killed = false;
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] }, undefined, {
    mediaBinaries: { ffmpeg: '/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg', ffprobe: '/opt/StreamHub/runtime/ffmpeg/bin/ffprobe' },
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      return child;
    },
  });
  manager.appendLog = () => {};

  assert.equal(typeof manager.spawnProcess, 'function');
  manager.spawnFFmpeg('output', 'output-a', ['-version'], 'output-a.log');

  assert.deepEqual(invocation, {
    command: '/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg',
    args: ['-version'],
    options: { stdio: ['ignore', 'ignore', 'pipe'] },
  });
});

test('DeckLink preflight failure blocks pipeline startup before FFmpeg spawns', () => {
  const state = {
    settings: {},
    rooms: [],
    sources: [],
    destinations: [
      { id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'main' },
    ],
    pipelines: [{
      id: 'pipe-decklink',
      name: 'DeckLink input',
      input: {
        type: 'capture',
        capture: { backend: 'decklink', device: 'DeckLink Mini Recorder 4K', formatCode: 'Hp59' },
      },
      destinationIds: ['dest-a'],
      mode: 'direct',
      settings: { live: { videoEncoder: 'libx264' } },
    }],
  };
  let spawnCount = 0;
  let checkCount = 0;
  const manager = createManager(state, undefined, {
    checkDecklink() {
      checkCount += 1;
      return { ok: false, diagnostic: '未找到设备 DeckLink Mini Recorder 4K' };
    },
  });
  manager.spawnFFmpeg = () => {
    spawnCount += 1;
    throw new Error('DeckLink preflight failure must stop startup');
  };

  assert.throws(() => manager.startPipeline('pipe-decklink'), /Blackmagic DeckLink 不可用.*未找到设备/);
  assert.equal(checkCount, 1);
  assert.equal(spawnCount, 0);
});

function createNvencPipelineFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-manager-nvenc-'));
  const watermarkPath = path.join(rootDir, 'data', 'watermarks', 'station.png');
  fs.mkdirSync(path.dirname(watermarkPath), { recursive: true });
  fs.writeFileSync(watermarkPath, 'static watermark validation only');
  return {
    rootDir,
    state: {
      settings: {},
      rooms: [],
      sources: [],
      destinations: [
        { id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'main' },
      ],
      pipelines: [{
        id: 'pipe-a',
        name: 'NVENC preflight',
        status: 'stopped',
        input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' },
        destinationIds: ['dest-a'],
        mode: 'direct',
        settings: {
          live: { videoEncoder: 'auto' },
          watermarks: [{ id: 'wm-a', path: watermarkPath }],
        },
      }],
    },
  };
}

function createStubProcess(role, id, args, logName) {
  return {
    role,
    id,
    args,
    logFile: logName,
    pid: 1,
    status: 'running',
    startedAt: Date.now(),
    metrics: {},
    lastError: '',
    stop() {},
  };
}

function createManualScheduler() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    scheduleInterval(callback, intervalMs) {
      const handle = { callback, intervalMs, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    clearScheduledInterval(handle) {
      cleared.push(handle);
    },
  };
}

function createLiveDelayStub(overrides = {}) {
  return {
    started: 0,
    discarded: 0,
    drainCalls: 0,
    status: 'buffering',
    start() {
      this.started += 1;
      this.status = 'buffering';
      if (this.onReady) this.onReady();
      return this;
    },
    discard() { this.discarded += 1; this.status = 'stopped'; return Promise.resolve({ status: 'stopped' }); },
    beginDrain() { this.drainCalls += 1; this.status = 'draining'; return Promise.resolve({ status: 'stopped' }); },
    describe() {
      return {
        enabled: true,
        delaySeconds: 20,
        status: this.status,
        bufferedBytes: 4096,
        bufferedPackets: 3,
        remainingSeconds: 12,
      };
    },
    ...overrides,
  };
}

function createDelayedPipelineHarness({
  liveDelay = createLiveDelayStub(),
} = {}) {
  const state = {
    settings: {}, rooms: [], sources: [],
    destinations: [
      { id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://push-a.example.com/live', streamKey: 'main' },
      { id: 'dest-b', enabled: true, protocol: 'rtmp', server: 'rtmp://push-b.example.com/live', streamKey: 'backup' },
    ],
    pipelines: [{
      id: 'pipe-delay', name: 'Delayed PGM', status: 'stopped',
      input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' },
      destinationIds: ['dest-a', 'dest-b'], mode: 'direct',
      settings: {
        live: { videoEncoder: 'libx264', delayEnabled: true, delaySeconds: 20 },
        video: { outputResolution: '1920x1080', fps: '30' },
      },
    }],
  };
  const delayFactoryCalls = [];
  const manager = createManager(state, undefined, {
    scheduleInterval: () => null,
    liveDelayFactory(options) {
      delayFactoryCalls.push(options);
      liveDelay.onReady = options.onReady;
      return liveDelay;
    },
  });
  const spawned = [];
  manager.spawnFFmpeg = (role, id, args, logName, onMetric, onExit) => {
    const process = {
      role, id, args, logFile: logName, pid: spawned.length + 1,
      status: 'running', startedAt: Date.now(), metrics: {}, lastError: '', stopCalls: 0,
      onExit,
      stop() { this.stopCalls += 1; this.status = 'stopped'; },
    };
    spawned.push(process);
    return process;
  };
  return { manager, state, spawned, liveDelay, delayFactoryCalls };
}

test('live delay forces one shared relay buffer before all destination workers', () => {
  const { manager, spawned, liveDelay, delayFactoryCalls } = createDelayedPipelineHarness();

  const session = manager.startPipeline('pipe-delay');

  assert.equal(session.mode, 'shared-relay');
  assert.equal(liveDelay.started, 1);
  assert.equal(delayFactoryCalls.length, 1);
  assert.equal(delayFactoryCalls[0].delaySeconds, 20);
  assert.ok(delayFactoryCalls[0].inputPort >= 60000 && delayFactoryCalls[0].inputPort <= 64999);
  assert.equal(delayFactoryCalls[0].outputPorts.length, 2);
  assert.equal(delayFactoryCalls[0].inputTransport, 'tcp-server');
  assert.equal(delayFactoryCalls[0].outputTransport, 'tcp-server');
  assert.equal(delayFactoryCalls[0].memoryBudget, manager.liveDelayMemoryBudget);
  assert.equal(spawned.filter(process => process.role === 'pipeline').length, 1);
  assert.equal(spawned.filter(process => process.role === 'output').length, 2);
  assert.equal(spawned.filter(process => process.role === 'output').every(process => (
    /^tcp:\/\/127\.0\.0\.1:\d+$/.test(process.args[process.args.indexOf('-i') + 1])
  )), true);
  const relayArgs = spawned.find(process => process.role === 'pipeline').args.join(' ');
  assert.match(relayArgs, new RegExp(`tcp://127\\.0\\.0\\.1:${delayFactoryCalls[0].inputPort}`));
  for (const outputPort of delayFactoryCalls[0].outputPorts) {
    assert.doesNotMatch(relayArgs, new RegExp(`udp://127\\.0\\.0\\.1:${outputPort}`));
  }
  assert.equal(session.liveDelay.remainingSeconds, 12);
});

test('delayed source and workers start only after every delay listener is ready', () => {
  const liveDelay = createLiveDelayStub({
    start() { this.started += 1; this.status = 'buffering'; return this; },
  });
  const { manager, spawned, delayFactoryCalls } = createDelayedPipelineHarness({ liveDelay });

  manager.startPipeline('pipe-delay');

  assert.equal(spawned.length, 0);
  assert.equal(spawned.filter(process => process.role === 'output').length, 0);

  delayFactoryCalls[0].onReady();

  assert.equal(spawned[0].role, 'pipeline');
  assert.equal(spawned.filter(process => process.role === 'output').length, 2);
});

test('live delay destination reconciliation waits for old processes and ports before restarting', async () => {
  let resolveDiscard;
  const liveDelay = createLiveDelayStub({
    discard() {
      this.discarded += 1;
      this.status = 'stopped';
      return new Promise(resolve => { resolveDiscard = resolve; });
    },
  });
  const { manager, state, spawned } = createDelayedPipelineHarness({ liveDelay });
  manager.startPipeline('pipe-delay');
  const originalProcesses = spawned.slice();
  const exitResolvers = originalProcesses.map(process => {
    let resolveExit;
    process.exitPromise = new Promise(resolve => { resolveExit = resolve; });
    return resolveExit;
  });
  state.destinations.find(item => item.id === 'dest-b').enabled = false;

  const result = manager.reconcileDestination('dest-b');

  assert.equal(result.reconciled[0].action, 'restarting-pipeline');
  assert.equal(liveDelay.discarded, 1);
  assert.equal(liveDelay.started, 1);
  assert.equal(originalProcesses.every(process => process.stopCalls === 1), true);
  assert.equal(manager.sessions.has('pipe-delay'), false);

  resolveDiscard({ status: 'stopped' });
  exitResolvers.forEach(resolve => resolve());
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(liveDelay.started, 2);
  assert.deepEqual(Array.from(manager.sessions.get('pipe-delay').outputs.keys()), ['dest-a']);
});

test('destination reconciliation cannot restart a pipeline while delay is draining', async () => {
  const { manager, spawned } = createDelayedPipelineHarness();
  manager.startPipeline('pipe-delay');
  const session = manager.sessions.get('pipe-delay');
  manager.stopPipeline('pipe-delay', { mode: 'drain' });

  const result = manager.reconcileDestination('dest-a');

  assert.equal(result.reconciled[0].action, 'ignored-stopping');
  assert.equal(manager.sessions.get('pipe-delay'), session);
  assert.equal(session.status, 'draining');
  assert.equal(spawned.length, 3);
  await session.stopPromise;
});

test('delayed destination worker exit fails the pipeline before TCP attachment', () => {
  const { manager, state, spawned, liveDelay } = createDelayedPipelineHarness();
  manager.startPipeline('pipe-delay');
  const output = spawned.find(process => process.role === 'output');

  assert.equal(typeof output.onExit, 'function');
  output.status = 'exited';
  output.onExit(output);

  assert.equal(liveDelay.discarded, 1);
  assert.equal(state.pipelines[0].status, 'error');
  assert.match(state.pipelines[0].lastError, /延时输出进程/);
  assert.equal(spawned.every(process => process.stopCalls === 1 || process === output), true);
});

test('starting an already running delayed pipeline requires an explicit stop', () => {
  const { manager, spawned, liveDelay } = createDelayedPipelineHarness();
  manager.startPipeline('pipe-delay');

  assert.throws(
    () => manager.startPipeline('pipe-delay'),
    error => error.statusCode === 409 && /先停止/.test(error.message),
  );
  assert.equal(spawned.length, 3);
  assert.equal(liveDelay.discarded, 0);
});

test('a discarded delayed pipeline cannot restart before shutdown completes', async () => {
  let resolveDiscard;
  const liveDelay = createLiveDelayStub({
    discard() {
      this.discarded += 1;
      this.status = 'stopped';
      return new Promise(resolve => { resolveDiscard = resolve; });
    },
  });
  const { manager, spawned } = createDelayedPipelineHarness({ liveDelay });
  manager.startPipeline('pipe-delay');
  const exitResolvers = spawned.map(process => {
    let resolveExit;
    process.exitPromise = new Promise(resolve => { resolveExit = resolve; });
    return resolveExit;
  });

  manager.stopPipeline('pipe-delay', { mode: 'discard' });

  assert.throws(
    () => manager.startPipeline('pipe-delay'),
    error => error.statusCode === 409 && /旧进程退出/.test(error.message),
  );

  resolveDiscard({ status: 'stopped' });
  exitResolvers.forEach(resolve => resolve());
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(manager.startPipeline('pipe-delay').status, 'running');
});

test('drain stop keeps output workers until delayed content is released', async () => {
  let resolveDrain;
  const drainPromise = new Promise(resolve => { resolveDrain = resolve; });
  const liveDelay = createLiveDelayStub({
    beginDrain() { this.drainCalls += 1; this.status = 'draining'; return drainPromise; },
  });
  const { manager, state, spawned } = createDelayedPipelineHarness({ liveDelay });
  manager.startPipeline('pipe-delay');
  const relay = spawned.find(process => process.role === 'pipeline');
  const outputs = spawned.filter(process => process.role === 'output');

  const result = manager.stopPipeline('pipe-delay', { mode: 'drain' });
  await Promise.resolve();

  assert.equal(result.status, 'draining');
  assert.equal(relay.stopCalls, 1);
  assert.equal(outputs.every(output => output.stopCalls === 0), true);
  assert.equal(liveDelay.drainCalls, 1);
  assert.equal(state.pipelines[0].status, 'draining');
  assert.equal(manager.monitor({ historyMode: 'none' }).activePipelines[0].liveDelay.remainingSeconds, 12);

  resolveDrain({ status: 'stopped' });
  await manager.sessions.get('pipe-delay').stopPromise;

  assert.equal(outputs.every(output => output.stopCalls === 1), true);
  assert.equal(manager.sessions.has('pipe-delay'), false);
  assert.equal(state.pipelines[0].status, 'stopped');
});

test('drain stop waits for delayed output workers to consume the UDP tail', async () => {
  let resolveDrain;
  const liveDelay = createLiveDelayStub({
    beginDrain() { this.drainCalls += 1; this.status = 'draining'; return new Promise(resolve => { resolveDrain = resolve; }); },
  });
  const { manager, spawned } = createDelayedPipelineHarness({ liveDelay });
  manager.startPipeline('pipe-delay');
  const outputs = spawned.filter(process => process.role === 'output');
  const resolveOutputExits = outputs.map(output => {
    let resolveExit;
    output.exitPromise = new Promise(resolve => { resolveExit = resolve; });
    return () => {
      output.status = 'exited';
      resolveExit(output);
    };
  });

  manager.stopPipeline('pipe-delay', { mode: 'drain' });
  await Promise.resolve();
  resolveDrain({ status: 'stopped' });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(manager.sessions.has('pipe-delay'), true);
  assert.equal(outputs.every(output => output.stopCalls === 0), true);

  resolveOutputExits.forEach(resolveExit => resolveExit());
  await manager.sessions.get('pipe-delay').stopPromise;

  assert.equal(manager.sessions.has('pipe-delay'), false);
  assert.equal(outputs.every(output => output.stopCalls === 0), true);
});

test('discard stop drops delayed content and closes all processes immediately', () => {
  const { manager, state, spawned, liveDelay } = createDelayedPipelineHarness();
  manager.startPipeline('pipe-delay');

  const result = manager.stopPipeline('pipe-delay', { mode: 'discard' });

  assert.equal(result.status, 'stopped');
  assert.equal(liveDelay.discarded, 1);
  assert.equal(spawned.every(process => process.stopCalls === 1), true);
  assert.equal(manager.sessions.has('pipe-delay'), false);
  assert.equal(state.pipelines[0].status, 'stopped');
});

test('live delay failures discard the buffer before stopping the pipeline', () => {
  const { manager, state, spawned, liveDelay, delayFactoryCalls } = createDelayedPipelineHarness();
  manager.startPipeline('pipe-delay');

  delayFactoryCalls[0].onError(new Error('udp output failed'));

  assert.equal(liveDelay.discarded, 1);
  assert.equal(spawned.every(process => process.stopCalls === 1), true);
  assert.equal(state.pipelines[0].status, 'error');
  assert.match(state.pipelines[0].lastError, /udp output failed/);
});

test('manager initialization asks the persistent store to reset transient pipeline states', () => {
  const state = { settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] };
  const store = createFakeStore(state);
  let resetCalls = 0;
  store.resetTransientPipelineStatuses = () => { resetCalls += 1; };

  new ProcessManager({
    rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-manager-reset-')),
    store,
    tcpStatsCollector: { async sample() { return { status: 'unavailable' }; } },
  });

  assert.equal(resetCalls, 1);
});

function createFallbackHarness({ mode = 'shared-relay' } = {}) {
  const scheduler = createManualScheduler();
  const probeResults = [];
  const state = {
    settings: {}, rooms: [], sources: [],
    destinations: [
      { id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://push-a.example.com/live', streamKey: 'main' },
      { id: 'dest-b', enabled: true, protocol: 'rtmp', server: 'rtmp://push-b.example.com/live', streamKey: 'backup' },
    ],
    pipelines: [{
      id: 'pipe-a', name: 'Fallback pipeline', status: 'stopped',
      input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' },
      destinationIds: ['dest-a', 'dest-b'], mode,
      settings: { live: { videoEncoder: 'libx264' }, video: { outputResolution: '1280x720', fps: '30' } },
    }],
  };
  const manager = createManager(state, undefined, {
    ...scheduler,
    probeSource() {
      return probeResults.shift() || false;
    },
  });
  const spawned = [];
  manager.spawnFFmpeg = (role, id, args, logName, onMetric, onExit) => {
    const process = {
      role, id, args, logFile: logName, onMetric, onExit,
      pid: spawned.length + 1, status: 'running', startedAt: Date.now(), metrics: {}, lastError: '', stopCalls: 0,
      stop() { this.stopCalls += 1; this.status = 'stopped'; },
      emitExit(code = 1, signal = null) {
        this.status = 'exited';
        this.exitCode = code;
        this.signal = signal;
        if (this.onExit) this.onExit(this);
      },
    };
    spawned.push(process);
    return process;
  };
  return { manager, scheduler, spawned, probeResults, state };
}

test('a started shared relay switches to fallback without dropping configured destinations', () => {
  const { manager, spawned } = createFallbackHarness();
  manager.startPipeline('pipe-a');
  const originalRelay = spawned[0];
  const originalWorkers = spawned.filter(process => process.role === 'output');

  originalRelay.lastError = 'Cannot Autodetect input stream or No signal';
  originalRelay.emitExit();

  const session = manager.monitor({ historyMode: 'none' }).activePipelines[0];
  assert.equal(session.status, 'fallback');
  assert.equal(session.source.type, 'fallback');
  assert.equal(session.outputs.length, 2);
  assert.equal(manager.monitor({ historyMode: 'none' }).outputs[0].pipelineStatus, 'fallback');
  assert.equal(spawned.filter(process => process.role === 'pipeline').length, 2);
  assert.equal(spawned.filter(process => process.role === 'output').length, 2);
  assert.equal(originalWorkers.every(process => process.stopCalls === 0), true);
  assert.equal(spawned.filter(process => process.role === 'pipeline').at(-1).args.includes('color=c=black:s=1280x720:r=30'), true);
});

test('fallback probes every three seconds and restores the original source only after success', () => {
  const { manager, scheduler, spawned, probeResults } = createFallbackHarness();
  manager.startPipeline('pipe-a');
  const originalWorkers = spawned.filter(process => process.role === 'output');
  spawned[0].lastError = 'Input/output error';
  spawned[0].emitExit();
  probeResults.push(false, true);

  const recovery = scheduler.scheduled.find(item => item.intervalMs === 3000);
  assert.ok(recovery);
  recovery.callback();
  assert.equal(manager.monitor({ historyMode: 'none' }).activePipelines[0].status, 'fallback');
  recovery.callback();

  const restored = manager.monitor({ historyMode: 'none' }).activePipelines[0];
  assert.equal(restored.status, 'running');
  assert.equal(restored.source.type, 'pull');
  assert.equal(scheduler.cleared.includes(recovery), true);
  assert.equal(spawned.filter(process => process.role === 'output').length, 2);
  assert.equal(originalWorkers.every(process => process.stopCalls === 0), true);
  assert.equal(spawned.filter(process => process.role === 'pipeline').at(-1).args.includes('color=c=black:s='), false);
});

test('explicit stop clears the fallback recovery timer', () => {
  const { manager, scheduler, spawned } = createFallbackHarness();
  manager.startPipeline('pipe-a');
  spawned[0].lastError = 'End of file';
  spawned[0].emitExit();
  const recovery = scheduler.scheduled.find(item => item.intervalMs === 3000);

  manager.stopPipeline('pipe-a');

  assert.ok(recovery);
  assert.equal(scheduler.cleared.includes(recovery), true);
  assert.equal(manager.monitor({ historyMode: 'none' }).activePipelines.length, 0);
});

test('an output destination failure does not replace a healthy source with fallback media', () => {
  const { manager, spawned } = createFallbackHarness({ mode: 'direct' });
  manager.startPipeline('pipe-a');
  spawned[0].lastError = 'Connection refused while writing output';
  spawned[0].emitExit();

  const session = manager.monitor({ historyMode: 'none' }).activePipelines[0];
  assert.equal(session.status, 'running');
  assert.equal(session.source.type, 'pull');
  assert.equal(spawned.some(process => process.args.includes('color=c=black:s=1280x720:r=30')), false);
});

test('a direct fallback exposes its black source for preview without reopening the original input', () => {
  const { manager, spawned } = createFallbackHarness({ mode: 'direct' });
  const original = { type: 'pull', url: 'rtmp://origin.example.com/live/pgm' };
  manager.startPipeline('pipe-a');
  spawned[0].lastError = 'Input/output error';
  spawned[0].emitExit();

  const preview = manager.findPreviewSource(original);
  assert.equal(preview.kind, 'fallback');
  assert.equal(preview.source.type, 'fallback');
  assert.equal(Object.hasOwn(preview.source, 'url'), false);
});

function createCountingHistoryStore() {
  return {
    queryCalls: 0,
    hasHistoryCalls: 0,
    append() { return true; },
    query() { this.queryCalls += 1; return []; },
    hasHistory() { this.hasHistoryCalls += 1; return false; },
  };
}

function monitorState(destinationIds = ['dest-a']) {
  return {
    settings: {},
    rooms: [],
    sources: [],
    destinations: destinationIds.map(id => ({
      id,
      name: id,
      enabled: true,
      protocol: 'rtmp',
      server: `rtmp://push.example.com/${id}`,
      streamKey: 'main',
    })),
    pipelines: [{
      id: 'pipe-a',
      name: 'Pipeline A',
      input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' },
      destinationIds,
      mode: 'shared-relay',
      settings: { live: { videoEncoder: 'copy' } },
    }],
  };
}

function attachMonitorSession(manager, destinationIds = ['dest-a'], encodingMode = 'copy') {
  const outputs = new Map(destinationIds.map(id => [id, {
    id: `pipe-a-${id}`,
    role: 'output',
    status: 'running',
    startedAt: 0,
    destination: { id, name: id },
    encodingMode,
    metrics: {},
    lastError: '',
  }]));
  manager.sessions.set('pipe-a', {
    pipelineId: 'pipe-a',
    name: 'Pipeline A',
    mode: 'shared-relay',
    encodingMode,
    source: { id: 'src-a', name: 'Input A', type: 'url' },
    targetFps: 60,
    expectedBitrateKbps: 15000,
    outputs,
    startedAt: 0,
    status: 'running',
  });
}

function historyPoint(time, bitrateKbps, extra = {}) {
  return {
    time,
    bitrateKbps,
    actualBitrateAvailable: Number.isFinite(Number(bitrateKbps)),
    actualBitrateStatus: Number.isFinite(Number(bitrateKbps)) ? 'available' : 'unavailable',
    transportMetricSource: 'tcp-acked',
    reportedBitrateKbps: bitrateKbps,
    fps: 60,
    targetFps: 60,
    expectedBitrateKbps: 15000,
    encodingMode: 'copy',
    processSessionId: 'session-a',
    dropMetricVersion: 2,
    ...extra,
  };
}

function relayMetric(second, sizeBytes, udpOverruns = 0) {
  return {
    bitrateKbps: 15000,
    fps: 60,
    targetFps: 60,
    expectedBitrateKbps: 15000,
    encodingMode: 'copy',
    relayTransport: true,
    processSessionId: 'session-a',
    timeSec: second,
    udpOverruns,
    corruptPackets: 0,
    transportMetricSource: 'tcp-acked',
    transportSampleAvailable: true,
    tcpSentBytes: sizeBytes,
    tcpAckedBytes: sizeBytes,
    tcpRetransBytes: 0,
    updatedAt: new Date(second * 1000).toISOString(),
  };
}

function tcpMetric({
  second,
  ackedBytes,
  sentBytes = ackedBytes,
  retransBytes = 0,
  udpOverruns = 0,
  corruptPackets = 0,
  expectedBitrateKbps = 15000,
  targetFps = 60,
  processSessionId = 'tcp-session-a',
  transportSampleAvailable = true,
  relayTransport = true,
}) {
  return {
    bitrateKbps: expectedBitrateKbps,
    fps: targetFps,
    targetFps,
    expectedBitrateKbps,
    encodingMode: 'copy',
    relayTransport,
    processSessionId,
    timeSec: second,
    udpOverruns,
    corruptPackets,
    transportMetricSource: 'tcp-acked',
    transportSampleAvailable,
    ...(transportSampleAvailable ? {
      tcpSentBytes: sentBytes,
      tcpAckedBytes: ackedBytes,
      tcpRetransBytes: retransBytes,
    } : {}),
    updatedAt: new Date(second * 1000).toISOString(),
  };
}

function encodedMetric({ frame, drop, dup, timeSec }) {
  return {
    sizeBytes: frame * 32_000,
    bitrateKbps: 15000,
    fps: 60,
    targetFps: 60,
    expectedBitrateKbps: 15000,
    encodingMode: 'cpu',
    processSessionId: 'encoded-session-a',
    frame,
    drop,
    dup,
    timeSec,
    speed: 1,
    udpOverruns: 0,
    corruptPackets: 0,
    updatedAt: new Date(timeSec * 1000).toISOString(),
  };
}

const REMOVED_STALL_KEYS = [
  'encoderDuplicatedFrames',
  'encoderDroppedFrames',
  'encoderFrame',
  'videoStallDelta',
  'videoStallFrames',
  'videoStallRatePercent',
  'recentVideoStallFrames',
  'recentVideoStallRatePercent',
];

const COPY_ENCODER_METRIC_KEYS = [
  'speed',
  'dup',
  'drop',
  'rawDroppedFrames',
  ...REMOVED_STALL_KEYS,
];

function assertCopyMetricsSanitized(metrics) {
  for (const key of COPY_ENCODER_METRIC_KEYS) {
    assert.equal(Object.hasOwn(metrics, key), false, `copy metrics must omit ${key}`);
  }
}

test('live monitor snapshots never query persistent history', () => {
  const historyStore = createCountingHistoryStore();
  const manager = createManager(monitorState(), undefined, { historyStore });
  attachMonitorSession(manager);
  manager.outputHistory.set('pipe-a-dest-a', [historyPoint(10_000, 15000)]);

  const monitor = manager.monitor({ now: 10_000, rangeSec: 900, historyMode: 'none' });

  assert.deepEqual(monitor.outputs[0].history, []);
  assert.equal(monitor.outputs[0].bitrateKbps, 15000);
  assert.equal(historyStore.queryCalls, 0);
  assert.equal(historyStore.hasHistoryCalls, 0);
});

test('first live output metric never queries persistent history', () => {
  const historyStore = createCountingHistoryStore();
  const manager = createManager(monitorState(), undefined, { historyStore });

  manager.recordOutputMetric('pipe-a-dest-a', relayMetric(1, 1_875_000), 1000);

  assert.equal(historyStore.queryCalls, 0);
  assert.equal(historyStore.hasHistoryCalls, 0);
  assert.equal(manager.outputHistory.get('pipe-a-dest-a').at(-1).sessionBoundary, true);
});

test('memory monitor history stays isolated by output id', () => {
  const historyStore = createCountingHistoryStore();
  const manager = createManager(monitorState(['dest-a', 'dest-b']), undefined, { historyStore });
  attachMonitorSession(manager, ['dest-a', 'dest-b']);
  manager.outputHistory.set('pipe-a-dest-a', [historyPoint(9_000, 15000), historyPoint(10_000, 15100)]);
  manager.outputHistory.set('pipe-a-dest-b', [historyPoint(9_000, 7000), historyPoint(10_000, 6900)]);

  const monitor = manager.monitor({ now: 10_000, rangeSec: 2, historyMode: 'memory' });
  const byId = Object.fromEntries(monitor.outputs.map(output => [output.id, output]));

  assert.deepEqual(byId['pipe-a-dest-a'].history.map(item => item.bitrateKbps), [15000, 15100]);
  assert.deepEqual(byId['pipe-a-dest-b'].history.map(item => item.bitrateKbps), [7000, 6900]);
  assert.equal(historyStore.queryCalls, 0);
  assert.equal(historyStore.hasHistoryCalls, 0);
});

test('one throttled output cannot create bitrate dips in another output', () => {
  const manager = createManager(monitorState(['dest-a', 'dest-b']));
  for (let second = 0; second <= 12; second += 1) {
    manager.recordOutputMetric('out-a', relayMetric(second, second * 1_875_000), second * 1000);
    const bytesB = second <= 6
      ? second * 1_875_000
      : 6 * 1_875_000 + (second - 6) * 875_000;
    manager.recordOutputMetric('out-b', relayMetric(second, bytesB, second > 6 ? 1 : 0), second * 1000);
  }

  const stable = manager.outputHistory.get('out-a').slice(-5);
  const throttled = manager.outputHistory.get('out-b').slice(-5);
  assert.equal(stable.every(point => Math.abs(point.bitrateKbps - 15000) < 1), true);
  assert.equal(throttled.some(point => point.bitrateKbps < 8000), true);
});

test('monitor and new history points omit derived video-stall metrics', () => {
  const state = monitorState();
  state.pipelines[0].settings.live.videoEncoder = 'libx264';
  const manager = createManager(state);
  attachMonitorSession(manager, ['dest-a'], 'cpu');
  manager.recordOutputMetric(
    'pipe-a-dest-a',
    encodedMetric({ frame: 60, drop: 0, dup: 0, timeSec: 1 }),
    1000,
  );
  manager.recordOutputMetric(
    'pipe-a-dest-a',
    encodedMetric({ frame: 115, drop: 3, dup: 2, timeSec: 2 }),
    2000,
  );
  const latest = manager.outputHistory.get('pipe-a-dest-a').at(-1);
  const output = manager.outputDescriptorForId('pipe-a-dest-a', {
    now: 2000,
    rangeSec: 60,
    historyMode: 'memory',
  });

  for (const key of REMOVED_STALL_KEYS) {
    assert.equal(Object.hasOwn(latest, key), false, `history still contains ${key}`);
    assert.equal(Object.hasOwn(output, key), false, `monitor still contains ${key}`);
  }
});

test('drop display reset persists only network-loss baselines', () => {
  const state = monitorState();
  const manager = createManager(state);
  attachMonitorSession(manager);
  manager.recordOutputMetric('pipe-a-dest-a', {
    ...historyPoint(1000, 15000),
    sizeBytes: 1_875_000,
    networkDroppedFrames: 12,
    networkExpectedFrames: 600,
  }, 1000);

  const result = manager.resetOutputDropDisplay('pipe-a-dest-a', 5000);
  const baseline = state.monitorDisplay.dropBaselines['pipe-a-dest-a'];

  assert.deepEqual(Object.keys(baseline).sort(), [
    'networkDroppedFrames',
    'networkExpectedFrames',
    'processSessionId',
    'resetAt',
  ]);
  assert.equal(result.dropDisplayResetAt, 5000);
});

function createEncodingModeState({ videoEncoder, mode = 'shared-relay', bitrateKbps = 8000, fps = '30' }) {
  return {
    settings: {},
    rooms: [],
    sources: [],
    destinations: [
      { id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'main' },
    ],
    pipelines: [{
      id: 'pipe-a',
      name: 'Encoding mode propagation',
      input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' },
      destinationIds: ['dest-a'],
      mode,
      settings: {
        live: { videoEncoder, bitrateKbps },
        video: { fps },
      },
    }],
  };
}

test('copy relay uses source-side expectations and excludes encoder-only counters', async () => {
  const state = createEncodingModeState({ videoEncoder: 'auto' });
  const scheduler = createManualScheduler();
  const manager = createManager(state, undefined, { ...scheduler, now: () => 10_000 });
  const calls = [];
  manager.spawnFFmpeg = (role, id, args, logName, onMetric) => {
    const process = {
      role, id, args, logFile: logName, pid: calls.length + 1, status: 'running', startedAt: 0,
      metrics: {}, lastError: '', stop() {},
    };
    calls.push({ process, onMetric });
    return process;
  };

  manager.startPipeline('pipe-a');
  calls[0].process.metrics = {
    bitrateKbps: 15_360,
    fps: 59.94,
    frame: 600,
    timeSec: 10,
    speed: 0.2,
    dup: 500,
    drop: 200,
    updatedAt: new Date(10_000).toISOString(),
  };
  calls[1].process.metrics = {
    speed: 0.2,
    dup: 500,
    drop: 200,
    rawDroppedFrames: 200,
    encoderDroppedFrames: 200,
    encoderDuplicatedFrames: 500,
    videoStallFrames: 700,
    videoStallRatePercent: 87.5,
    networkDroppedFrames: 9,
    udpOverruns: 3,
  };
  calls[1].onMetric({ bitrateKbps: 15_120, sizeBytes: 19_200_000, udpOverruns: 3 });
  await scheduler.scheduled[0].callback();
  calls[1].process.sharedProcess = calls[0].process;

  const session = manager.sessions.get('pipe-a');
  const output = manager.monitor({ now: 10_000, rangeSec: 60 }).outputs[0];
  const latest = manager.outputHistory.get('pipe-a-dest-a').at(-1);
  assert.equal(session.encodingMode, 'copy');
  assert.equal(session.targetFps, 0);
  assert.equal(session.expectedBitrateKbps, 0);
  assert.equal(output.encodingMode, 'copy');
  assert.equal(output.encoderSpeed, 0);
  assert.equal(latest.encodingMode, 'copy');
  assert.equal(latest.expectedBitrateKbps, 15_360);
  assert.equal(latest.targetFps, 59.94);
  assert.equal(latest.speed, undefined);
  assert.equal(latest.dup, undefined);
  assert.equal(latest.drop, undefined);
  assert.equal(latest.frame, 600);
  assert.equal(latest.timeSec, 10);
  assert.equal(latest.udpOverruns, 3);
  assertCopyMetricsSanitized(output.metrics);
  assertCopyMetricsSanitized(latest);
  assert.equal(Object.hasOwn(output.metrics, 'networkDroppedFrames'), true);
  assert.equal(output.metrics.udpOverruns, 3);
});

test('copy relay ignores invalid, terminal, and stale source expectations', async () => {
  const state = createEncodingModeState({ videoEncoder: 'auto' });
  const scheduler = createManualScheduler();
  let now = 20_000;
  const manager = createManager(state, undefined, { ...scheduler, now: () => now });
  const calls = [];
  manager.spawnFFmpeg = (role, id, args, logName, onMetric) => {
    const process = {
      role, id, args, logFile: logName, pid: calls.length + 1, status: 'running', startedAt: 0,
      metrics: {}, lastError: '', stop() {},
    };
    calls.push({ process, onMetric });
    return process;
  };

  manager.startPipeline('pipe-a');
  const relay = calls[0].process;
  const workerMetric = calls[1].onMetric;
  const sample = async ({ status = 'running', bitrateKbps, fps, updatedAt, frame = 600, timeSec = 10 }) => {
    relay.status = status;
    relay.metrics = { bitrateKbps, fps, frame, timeSec, updatedAt };
    workerMetric({ bitrateKbps: 12_000, sizeBytes: now * 1000, udpOverruns: 1 });
    await scheduler.scheduled[0].callback();
    return manager.outputHistory.get('pipe-a-dest-a').at(-1);
  };

  for (const value of [Number.POSITIVE_INFINITY, 0, -1]) {
    const latest = await sample({ bitrateKbps: value, fps: value, updatedAt: new Date(now).toISOString() });
    assert.equal(latest.expectedBitrateKbps, 0);
    assert.equal(latest.targetFps, 0);
    now += 1000;
  }

  const terminal = await sample({
    status: 'exited',
    bitrateKbps: 15_360,
    fps: 59.94,
    updatedAt: new Date(now).toISOString(),
    frame: 900,
    timeSec: 15,
  });
  assert.equal(terminal.expectedBitrateKbps, 0);
  assert.equal(terminal.targetFps, 0);
  assert.equal(terminal.fps, 0);
  assert.equal(terminal.frame, undefined);
  assert.equal(terminal.timeSec, undefined);
  now += 1000;

  const stale = await sample({
    bitrateKbps: 15_360,
    fps: 59.94,
    updatedAt: new Date(now - 6000).toISOString(),
    frame: 960,
    timeSec: 16,
  });
  assert.equal(stale.expectedBitrateKbps, 0);
  assert.equal(stale.targetFps, 0);
  assert.equal(stale.fps, 0);
  assert.equal(stale.frame, undefined);
  assert.equal(stale.timeSec, undefined);
});

for (const terminalStatus of ['exited', 'stopped']) {
  test(`output metric sampler clears itself without recording after ${terminalStatus}`, () => {
    const scheduler = createManualScheduler();
    const manager = createManager(
      { settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] },
      undefined,
      { ...scheduler, now: () => 1000 },
    );
    const output = { status: 'running', stop() {} };
    manager.startOutputMetricSampler(output, `output-${terminalStatus}`, () => ({
      bitrateKbps: 8000,
      processSessionId: `session-${terminalStatus}`,
      encodingMode: 'cpu',
    }));

    output.status = terminalStatus;
    scheduler.scheduled[0].callback();
    scheduler.scheduled[0].callback();

    assert.deepEqual(scheduler.cleared, [scheduler.scheduled[0]]);
    assert.equal(manager.outputHistory.has(`output-${terminalStatus}`), false);
  });
}

test('NVENC relay retains configured expectations and encoder speed', async () => {
  const state = createEncodingModeState({ videoEncoder: 'h264_nvenc' });
  const scheduler = createManualScheduler();
  const manager = createManager(state, undefined, {
    ...scheduler,
    now: () => 10_000,
    checkNvenc: () => ({ ok: true, diagnostic: '' }),
  });
  const calls = [];
  manager.spawnFFmpeg = (role, id, args, logName, onMetric) => {
    const process = {
      role, id, args, logFile: logName, pid: calls.length + 1, status: 'running', startedAt: 0,
      metrics: {}, lastError: '', stop() {},
    };
    calls.push({ process, onMetric });
    return process;
  };

  manager.startPipeline('pipe-a');
  calls[0].process.metrics = {
    bitrateKbps: 15_360,
    fps: 59.94,
    frame: 600,
    timeSec: 10,
    speed: 0.2,
    dup: 500,
    drop: 200,
  };
  calls[1].onMetric({ bitrateKbps: 7900, sizeBytes: 10_000_000, udpOverruns: 1 });
  await scheduler.scheduled[0].callback();

  const output = manager.monitor({ now: 10_000, rangeSec: 60 }).outputs[0];
  const latest = manager.outputHistory.get('pipe-a-dest-a').at(-1);
  assert.equal(output.encodingMode, 'nvenc');
  assert.equal(output.encoderSpeed, 0.2);
  assert.equal(latest.encodingMode, 'nvenc');
  assert.equal(latest.expectedBitrateKbps, 8000);
  assert.equal(latest.targetFps, 30);
  assert.equal(latest.speed, 0.2);
  assert.equal(latest.rawDroppedFrames, 200);
  for (const key of REMOVED_STALL_KEYS) assert.equal(Object.hasOwn(latest, key), false);
});

test('explicit libx264 outputs expose CPU encoding mode', () => {
  const state = createEncodingModeState({ videoEncoder: 'libx264', mode: 'direct' });
  const manager = createManager(state);
  manager.spawnFFmpeg = createStubProcess;

  const session = manager.startPipeline('pipe-a');

  assert.equal(session.encodingMode, 'cpu');
  assert.equal(session.outputs[0].encodingMode, 'cpu');
  assert.equal(manager.monitor().outputs[0].encodingMode, 'cpu');
});

test('direct copy is rejected before replacing a running session or starting preparation', () => {
  const state = createEncodingModeState({ videoEncoder: 'auto', mode: 'direct' });
  state.pipelines[0].status = 'running';
  let prepared = 0;
  let spawned = 0;
  const manager = createManager(state, undefined, {
    prepareSlideshow() {
      prepared += 1;
      return {};
    },
  });
  const existingSession = {
    pipelineId: 'pipe-a',
    status: 'running',
    outputs: new Map([['dest-a', createStubProcess('output', 'pipe-a-dest-a', [], 'existing.log')]]),
  };
  manager.sessions.set('pipe-a', existingSession);
  manager.spawnFFmpeg = () => {
    spawned += 1;
    return createStubProcess('output', 'unexpected', [], 'unexpected.log');
  };

  assert.throws(
    () => manager.startPipeline('pipe-a'),
    error => {
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /(?:copy|原样复制).*(?:shared-relay|共享转推)/i);
      return true;
    },
  );
  assert.equal(manager.sessions.get('pipe-a'), existingSession);
  assert.equal(prepared, 0);
  assert.equal(spawned, 0);
  assert.equal(manager.store.patches.length, 0);
  assert.equal(state.pipelines[0].status, 'running');
});

test('direct CPU output exposes encoder speed and restores its mode from history after stopping', async () => {
  const state = createEncodingModeState({ videoEncoder: 'libx264', mode: 'direct' });
  const scheduler = createManualScheduler();
  const manager = createManager(state, undefined, { ...scheduler, now: () => 5000 });
  let outputMetric;
  let directProcess;
  manager.spawnFFmpeg = (role, id, args, logName, onMetric) => {
    outputMetric = onMetric;
    directProcess = createStubProcess(role, id, args, logName);
    return directProcess;
  };

  manager.startPipeline('pipe-a');
  outputMetric({
    bitrateKbps: 15_000,
    sizeBytes: 9_375_000,
    fps: 60,
    frame: 300,
    timeSec: 5,
    speed: 0.25,
    dup: 40,
    drop: 20,
    udpOverruns: 2,
  });
  directProcess.metrics = {
    speed: 0.25,
    dup: 40,
    drop: 20,
    rawDroppedFrames: 20,
    networkDroppedFrames: 7,
    udpOverruns: 2,
  };
  await scheduler.scheduled[0].callback();

  const active = manager.monitor({ now: 5000, rangeSec: 60 }).outputs[0];
  assert.equal(active.encodingMode, 'cpu');
  assert.equal(active.encoderSpeed, 0.25);
  const latest = manager.outputHistory.get('pipe-a-dest-a').at(-1);
  assert.equal(latest.encodingMode, 'cpu');
  assert.equal(latest.rawDroppedFrames, 20);
  for (const key of REMOVED_STALL_KEYS) assert.equal(Object.hasOwn(active, key), false);
  assert.equal(Object.hasOwn(active.metrics, 'networkDroppedFrames'), true);
  assert.equal(active.metrics.udpOverruns, 2);

  manager.stopPipeline('pipe-a');
  const inactive = manager.monitor({ now: 5000, rangeSec: 60 }).outputs[0];
  assert.equal(inactive.status, 'stopped');
  assert.equal(inactive.encodingMode, 'cpu');
  assert.equal(inactive.encoderSpeed, 0.25);
  for (const key of REMOVED_STALL_KEYS) assert.equal(Object.hasOwn(inactive, key), false);
});

test('shared-relay pipelines run one encoder and one independent worker per destination', () => {
  const state = {
    settings: {},
    rooms: [],
    sources: [],
    destinations: [
      { id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://push-a.example.com/live', streamKey: 'main' },
      { id: 'dest-b', enabled: true, protocol: 'rtmp', server: 'rtmp://push-b.example.com/live', streamKey: 'backup' },
    ],
    pipelines: [{
      id: 'pipe-a',
      name: 'PGM fanout',
      input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' },
      destinationIds: ['dest-a', 'dest-b'],
      mode: 'shared-relay',
      settings: {},
    }],
  };
  const manager = createManager(state);
  const calls = [];
  manager.spawnFFmpeg = (role, id, args, logName, onMetric) => {
    calls.push({ role, id, args, logName, onMetric });
    return {
      role,
      id,
      pid: 1234 + calls.length,
      status: 'running',
      args,
      logFile: logName,
      startedAt: Date.now(),
      metrics: { bitrateKbps: 5000, fps: 30, drop: 0, dropRatePercent: 0 },
      lastError: '',
      stop() {},
    };
  };

  manager.startPipeline('pipe-a');
  const monitor = manager.monitor();

  assert.equal(calls.length, 3);
  assert.equal(calls[0].role, 'pipeline');
  assert.equal(calls[0].args.includes('tee'), true);
  assert.equal(calls[0].args.at(-1).includes('udp://127.0.0.1:'), true);
  assert.deepEqual(calls.slice(1).map(call => call.role), ['output', 'output']);
  assert.equal(calls.slice(1).every(call => call.args.includes('copy')), true);
  assert.equal(monitor.outputs.length, 2);
  assert.deepEqual(monitor.outputs.map(output => output.destination.id), ['dest-a', 'dest-b']);
});

function createUnsampledPublicMonitor() {
  const state = {
    settings: {}, rooms: [], sources: [],
    destinations: [{
      id: 'dest-a', name: 'Public name', enabled: true, protocol: 'rtmp',
      server: 'rtmp://push-secret.example.com/live', streamKey: 'private-key',
    }],
    pipelines: [{
      id: 'pipe-public', name: 'Public monitor', input: { type: 'url', url: 'rtmp://origin/live/pgm' },
      destinationIds: ['dest-a'], mode: 'shared-relay', settings: {},
    }],
  };
  const manager = createManager(state);
  let pid = 7000;
  manager.spawnFFmpeg = (role, id, args, logName) => ({
    role, id, args, logFile: logName, pid: pid += 1, status: 'running', startedAt: Date.now(),
    metrics: { bitrateKbps: 5000, fps: 30 }, lastError: '', stop() {},
  });
  manager.startPipeline('pipe-public');
  return manager.monitor().outputs[0];
}

test('unsampled monitor output keeps actual bitrate unavailable instead of reporting FFmpeg bitrate', () => {
  const output = createUnsampledPublicMonitor();

  assert.equal(output.bitrateKbps, null);
  assert.equal(output.actualBitrateAvailable, false);
  assert.equal(output.actualBitrateStatus, 'unavailable');
});

test('monitor output destination descriptor excludes addresses and stream keys', () => {
  const output = createUnsampledPublicMonitor();

  assert.equal(output.destination.id, 'dest-a');
  assert.equal(output.destination.name, 'Public name');
  assert.equal(Object.hasOwn(output.destination, 'server'), false);
  assert.equal(Object.hasOwn(output.destination, 'url'), false);
  assert.equal(Object.hasOwn(output.destination, 'streamKey'), false);
  assert.equal(JSON.stringify(output).includes('push-secret.example.com'), false);
  assert.equal(JSON.stringify(output).includes('private-key'), false);
});

test('shared-relay session records a reusable preview mirror for its source', () => {
  const state = {
    settings: {}, rooms: [], sources: [],
    destinations: [{ id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'main' }],
    pipelines: [{
      id: 'pipe-preview', name: 'Preview relay', input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' },
      destinationIds: ['dest-a'], mode: 'shared-relay', settings: { live: { videoEncoder: 'libx264' } },
    }],
  };
  const manager = createManager(state, undefined, { scheduleInterval: () => null });
  manager.spawnFFmpeg = (role, id, args, logName) => ({
    role, id, args, logFile: logName, pid: 1, status: 'running', startedAt: Date.now(), metrics: {}, lastError: '', stop() {},
  });

  manager.startPipeline('pipe-preview');
  const found = manager.findPreviewSource({ type: 'pull', url: 'rtmp://origin.example.com/live/pgm' });

  assert.equal(found.kind, 'relay');
  assert.match(found.previewMirror.inputUrl, /^udp:\/\/127\.0\.0\.1:5\d{4}/);
  assert.equal(Object.hasOwn(found, 'destination'), false);
  assert.equal(Object.hasOwn(found.previewMirror, 'streamKey'), false);
});

test('active direct capture cannot be reused for preview', () => {
  const state = {
    settings: {}, rooms: [], sources: [],
    destinations: [{ id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'main' }],
    pipelines: [{
      id: 'pipe-decklink-preview', name: 'Direct DeckLink',
      input: { type: 'capture', capture: { backend: 'decklink', device: 'DeckLink Duo 2 (1)', formatCode: 'auto', rawFormat: 'uyvy422', audioChannels: 2 } },
      destinationIds: ['dest-a'], mode: 'direct', settings: { live: { videoEncoder: 'libx264' } },
    }],
  };
  const source = { type: 'capture', capture: { backend: 'decklink', device: 'DeckLink Duo 2 (1)', formatCode: 'auto', rawFormat: 'uyvy422', audioChannels: 2 } };
  const manager = createManager(state, undefined, {
    checkDecklink: () => ({ ok: true }),
    scheduleInterval: () => null,
  });
  manager.spawnFFmpeg = (role, id, args, logName) => ({
    role, id, args, logFile: logName, pid: 1, status: 'running', startedAt: Date.now(), metrics: {}, lastError: '', stop() {},
  });

  manager.startPipeline('pipe-decklink-preview');

  assert.deepEqual(manager.findPreviewSource(source), { kind: 'direct-capture' });
});

test('shared-relay output metrics combine worker bitrate with current relay frames and fps', async () => {
  const state = {
    settings: {},
    rooms: [],
    sources: [],
    destinations: [
      { id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'main' },
    ],
    pipelines: [{
      id: 'pipe-a',
      name: 'PGM fanout',
      input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' },
      destinationIds: ['dest-a'],
      mode: 'shared-relay',
      settings: { live: { videoEncoder: 'libx264' }, video: { fps: '30' } },
    }],
  };
  let now = 30_000;
  const scheduler = createManualScheduler();
  const manager = createManager(state, undefined, { ...scheduler, now: () => now });
  const calls = [];
  manager.spawnFFmpeg = (role, id, args, logName, onMetric) => {
    const process = {
      role, id, args, logFile: logName, pid: calls.length + 1, status: 'running', startedAt: Date.now(), metrics: {}, lastError: '', stop() {},
    };
    calls.push({ process, onMetric });
    return process;
  };

  manager.startPipeline('pipe-a');
  const relay = calls[0].process;
  relay.metrics = { fps: 29.8, frame: 900, timeSec: 30 };
  calls[1].onMetric({ bitrateKbps: 8010, fps: 0, timeSec: 30 });
  await scheduler.scheduled[0].callback();
  now = 31_000;
  relay.metrics = { fps: 30.1, frame: 930, timeSec: 31 };
  calls[1].onMetric({ bitrateKbps: 8005, fps: 0, timeSec: 31 });
  await scheduler.scheduled[0].callback();

  const output = manager.monitor({ now, rangeSec: 60 }).outputs[0];
  assert.equal(output.bitrateKbps, null);
  assert.equal(output.actualBitrateAvailable, false);
  assert.equal(output.metrics.reportedBitrateKbps, 8005);
  assert.equal(output.fps, 30.1);
  assert.equal(output.recentMeasuredFps, 30);
  assert.equal(output.recentDroppedFrames, 0);
});

test('shared-relay outputs prefer encoder progress and speed from the relay process', async () => {
  const state = {
    settings: {}, rooms: [], sources: [],
    destinations: [{ id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'main' }],
    pipelines: [{
      id: 'pipe-a', name: 'PGM fanout', input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' },
      destinationIds: ['dest-a'], mode: 'shared-relay',
      settings: { live: { videoEncoder: 'libx264' }, video: { fps: '60' } },
    }],
  };
  const scheduler = createManualScheduler();
  const manager = createManager(state, undefined, { ...scheduler, now: () => 1000 });
  const calls = [];
  manager.spawnFFmpeg = (role, id, args, logName, onMetric) => {
    const process = { role, id, args, logFile: logName, pid: calls.length + 1, status: 'running', startedAt: Date.now(), metrics: {}, lastError: '', stop() {} };
    calls.push({ process, onMetric });
    return process;
  };

  manager.startPipeline('pipe-a');
  calls[0].process.metrics = { fps: 60, frame: 60, timeSec: 1, dup: 2, drop: 1, speed: 0.8 };
  calls[1].onMetric({ bitrateKbps: 8000, fps: 60, frame: 58, timeSec: 1, dup: 99, drop: 99, speed: 1 });
  await scheduler.scheduled[0].callback();

  const latest = manager.outputHistory.get('pipe-a-dest-a').at(-1);
  assert.equal(latest.rawDropCounterPresent, true);
  assert.equal(latest.rawDroppedFrames, 1);
  assert.equal(latest.totalDroppedFrames, 0);
  assert.equal(latest.totalDropRatePercent, 0);
  assert.equal(latest.speed, 0.8);
  for (const key of REMOVED_STALL_KEYS) assert.equal(Object.hasOwn(latest, key), false);
});

test('shared-relay fallback keeps relay frame and time as a coherent pair', async () => {
  const state = {
    settings: {}, rooms: [], sources: [],
    destinations: [{ id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'main' }],
    pipelines: [{
      id: 'pipe-a', name: 'PGM fanout', input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' },
      destinationIds: ['dest-a'], mode: 'shared-relay',
      settings: { live: { videoEncoder: 'libx264' }, video: { fps: '30' } },
    }],
  };
  const scheduler = createManualScheduler();
  const manager = createManager(state, undefined, { ...scheduler, now: () => 30_000 });
  const calls = [];
  manager.spawnFFmpeg = (role, id, args, logName, onMetric) => {
    const process = { role, id, args, logFile: logName, pid: calls.length + 1, status: 'running', startedAt: Date.now(), metrics: {}, lastError: '', stop() {} };
    calls.push({ process, onMetric });
    return process;
  };

  manager.startPipeline('pipe-a');
  calls[0].process.metrics = { fps: 30, frame: 900, timeSec: 30 };
  calls[1].onMetric({ bitrateKbps: 8000, fps: 0, timeSec: 300 });
  await scheduler.scheduled[0].callback();

  const latest = manager.outputHistory.get('pipe-a-dest-a').at(-1);
  assert.equal(latest.bitrateKbps, null);
  assert.equal(latest.reportedBitrateKbps, 8000);
  assert.equal(latest.frame, 900);
  assert.equal(latest.timeSec, 30);
});

test('output metric sampler writes one wall-clock point per second and retains a stalled TCP counter', async () => {
  const state = {
    settings: {}, rooms: [], sources: [],
    destinations: [{ id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'main' }],
    pipelines: [{
      id: 'pipe-a', name: 'PGM fanout', input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' },
      destinationIds: ['dest-a'], mode: 'shared-relay',
      settings: { live: { bitrateKbps: 8000 }, video: { fps: '60' } },
    }],
  };
  let now = 1000;
  const scheduler = createManualScheduler();
  const manager = createManager(state, undefined, {
    ...scheduler,
    now: () => now,
    tcpStatsCollector: {
      async sample() {
        return { status: 'available', tcpSentBytes: 1_000_000, tcpAckedBytes: 900_000, tcpRetransBytes: 100_000 };
      },
    },
  });
  const calls = [];
  manager.spawnFFmpeg = (role, id, args, logName, onMetric) => {
    const process = {
      role, id, args, logFile: logName, pid: calls.length + 1, status: 'running', startedAt: now,
      metrics: {}, lastError: '', stopCalls: 0, stop() { this.stopCalls += 1; },
    };
    calls.push({ process, onMetric });
    return process;
  };

  manager.startPipeline('pipe-a');
  assert.equal(scheduler.scheduled.length, 1);
  assert.equal(scheduler.scheduled[0].intervalMs, 1000);

  calls[0].process.metrics = { frame: 60, fps: 60, timeSec: 1, dup: 0, drop: 0 };
  calls[1].onMetric({ sizeBytes: 1_000_000, bitrateKbps: 8000 });
  assert.equal(manager.outputHistory.has('pipe-a-dest-a'), false);

  await scheduler.scheduled[0].callback();
  now = 2000;
  await scheduler.scheduled[0].callback();
  assert.deepEqual(
    manager.outputHistory.get('pipe-a-dest-a').map(point => point.tcpAckedBytes),
    [900_000, 900_000],
  );

  const output = calls[1].process;
  output.stop();
  output.stop();
  assert.equal(scheduler.cleared.length, 1);
  assert.equal(output.stopCalls, 2);
});

test('RTMP transport sampler reads one asynchronous TCP snapshot per output interval', async () => {
  const scheduler = createManualScheduler();
  let sampleCalls = 0;
  let resolveSample;
  const manager = createManager(
    { settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] },
    undefined,
    {
      ...scheduler,
      now: () => 1000,
      tcpStatsCollector: {
        sample(pid) {
          sampleCalls += 1;
          assert.equal(pid, 4321);
          return new Promise(resolve => { resolveSample = resolve; });
        },
      },
    },
  );
  const output = { pid: 4321, status: 'running', stop() {} };
  manager.startOutputMetricSampler(output, 'out-rtmp', () => ({
    bitrateKbps: 8000,
    targetFps: 60,
    expectedBitrateKbps: 8000,
    processSessionId: 'out-rtmp:1',
  }), { protocol: 'rtmp' });

  const first = scheduler.scheduled[0].callback();
  const overlapping = scheduler.scheduled[0].callback();
  assert.equal(sampleCalls, 1);
  resolveSample({
    status: 'available',
    tcpSentBytes: 1_100_000,
    tcpAckedBytes: 1_000_000,
    tcpRetransBytes: 100_000,
  });
  await Promise.all([first, overlapping]);

  const point = manager.outputHistory.get('out-rtmp').at(-1);
  assert.equal(manager.outputHistory.get('out-rtmp').length, 1);
  assert.equal(point.tcpSentBytes, 1_100_000);
  assert.equal(point.tcpAckedBytes, 1_000_000);
  assert.equal(point.tcpRetransBytes, 100_000);
  assert.equal(point.actualBitrateStatus, 'sampling');
});

test('unsupported output transport is unavailable without invoking TCP collection', async () => {
  const scheduler = createManualScheduler();
  let sampleCalls = 0;
  const manager = createManager(
    { settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] },
    undefined,
    {
      ...scheduler,
      tcpStatsCollector: { async sample() { sampleCalls += 1; return { status: 'available' }; } },
    },
  );
  const output = { pid: 4321, status: 'running', stop() {} };
  manager.startOutputMetricSampler(output, 'out-srt', () => ({
    bitrateKbps: 8000,
    targetFps: 60,
    expectedBitrateKbps: 8000,
    processSessionId: 'out-srt:1',
  }), { protocol: 'srt' });

  await scheduler.scheduled[0].callback();

  const point = manager.outputHistory.get('out-srt').at(-1);
  assert.equal(sampleCalls, 0);
  assert.equal(point.actualBitrateAvailable, false);
  assert.equal(point.actualBitrateStatus, 'unavailable');
  assert.equal(point.bitrateKbps, null);
});

test('shared-relay prepares a slideshow cache before spawning ffmpeg', () => {
  const state = {
    settings: {}, rooms: [], sources: [],
    destinations: [{ id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'main' }],
    pipelines: [{
      id: 'pipe-a', name: 'PGM fanout', input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' },
      destinationIds: ['dest-a'], mode: 'shared-relay',
      settings: {
        live: { videoEncoder: 'libx264' },
        video: { outputResolution: '1920x1080', fps: '30' },
        slideshow: {
          images: [{ path: '/tmp/a.png' }, { path: '/tmp/b.png' }],
          intervalMs: 2000,
          transitionMs: 700,
        },
      },
    }],
  };
  const preparedCalls = [];
  const manager = createManager(state, fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-manager-slides-')), {
    liveDelayFactory(options) {
      const liveDelay = createLiveDelayStub();
      liveDelay.onReady = options.onReady;
      return liveDelay;
    },
    prepareSlideshow: options => {
      preparedCalls.push(options);
      return { preparedPath: '/tmp/slides.mov', key: 'cache-key', cached: true };
    },
  });
  const spawnCalls = [];
  manager.spawnFFmpeg = (role, id, args, logName) => {
    const process = { role, id, args, logFile: logName, pid: spawnCalls.length + 1, status: 'running', startedAt: Date.now(), metrics: {}, lastError: '', stop() {} };
    spawnCalls.push(process);
    return process;
  };

  manager.startPipeline('pipe-a');

  assert.equal(preparedCalls.length, 1);
  assert.equal(preparedCalls[0].resolution, '1920x1080');
  assert.equal(preparedCalls[0].fps, '30');
  assert.equal(spawnCalls[0].args.includes('/tmp/slides.mov'), true);
  assert.equal(spawnCalls[0].args.includes('-stream_loop'), true);
  assert.equal(state.pipelines[0].settings.slideshow.preparedPath, undefined);
});

test('pipeline start rejects a missing static watermark before spawning ffmpeg', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-manager-watermark-'));
  const missingPath = path.join(rootDir, 'data', 'watermarks', 'missing.png');
  const state = {
    settings: {}, rooms: [], sources: [],
    destinations: [{ id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://push.example.com/live', streamKey: 'main' }],
    pipelines: [{
      id: 'pipe-a', name: 'PGM fanout', input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' },
      destinationIds: ['dest-a'], mode: 'shared-relay',
      settings: { watermarks: [{ id: 'wm-missing', path: missingPath }] },
    }],
  };
  const manager = createManager(state, rootDir);
  let spawnCount = 0;
  manager.spawnFFmpeg = () => {
    spawnCount += 1;
    throw new Error('不应创建 FFmpeg 进程');
  };

  assert.throws(() => manager.startPipeline('pipe-a'), /静态水印文件不存在：missing\.png/);
  assert.equal(spawnCount, 0);
});

test('NVENC preflight runs before spawning and caches a successful probe across starts', () => {
  const { rootDir, state } = createNvencPipelineFixture();
  const events = [];
  let checkCount = 0;
  const manager = createManager(state, rootDir, {
    checkNvenc() {
      checkCount += 1;
      events.push('check');
      return { ok: true, diagnostic: '' };
    },
  });
  manager.spawnFFmpeg = (role, id, args, logName) => {
    events.push('spawn');
    return createStubProcess(role, id, args, logName);
  };

  manager.startPipeline('pipe-a');
  const firstSession = manager.sessions.get('pipe-a');
  assert.deepEqual(events, ['check', 'spawn']);
  assert.equal(firstSession.encodingMode, 'nvenc');
  assert.equal(firstSession.encodingPlan.requiresNvenc, true);

  manager.stopPipeline('pipe-a');
  manager.startPipeline('pipe-a');

  assert.equal(checkCount, 1);
  assert.equal(events.filter(event => event === 'spawn').length, 2);
});

test('NVENC preflight failure blocks all workers and reports actionable guidance', () => {
  const { rootDir, state } = createNvencPipelineFixture();
  let spawnCount = 0;
  const manager = createManager(state, rootDir, {
    checkNvenc: () => ({ ok: false, diagnostic: 'Cannot load libcuda.so.1' }),
  });
  manager.spawnFFmpeg = () => {
    spawnCount += 1;
    throw new Error('FFmpeg must not spawn after a failed preflight');
  };

  assert.throws(() => manager.startPipeline('pipe-a'), error => {
    assert.match(error.message, /NVIDIA NVENC/);
    assert.match(error.message, /Cannot load libcuda\.so\.1/);
    assert.match(error.message, /驱动、GPU 可见性和 FFmpeg h264_nvenc 支持/);
    assert.match(error.message, /显式选择 libx264 进行 CPU 测试/);
    return true;
  });
  assert.equal(spawnCount, 0);
  assert.equal(manager.sessions.has('pipe-a'), false);
  assert.equal(state.pipelines[0].status, 'stopped');
  assert.equal(manager.store.patches.some(patch => patch.payload.status === 'running'), false);
});

test('NVENC preflight retries after each failed start attempt', () => {
  const { rootDir, state } = createNvencPipelineFixture();
  let checkCount = 0;
  let spawnCount = 0;
  const manager = createManager(state, rootDir, {
    checkNvenc() {
      checkCount += 1;
      return { ok: false, diagnostic: 'probe failed' };
    },
  });
  manager.spawnFFmpeg = () => {
    spawnCount += 1;
    return createStubProcess('output', 'unexpected', [], 'unexpected.log');
  };

  assert.throws(() => manager.startPipeline('pipe-a'), /NVIDIA NVENC/);
  assert.throws(() => manager.startPipeline('pipe-a'), /NVIDIA NVENC/);

  assert.equal(checkCount, 2);
  assert.equal(spawnCount, 0);
});

test('failed NVENC preflight preserves an existing running session and its workers', () => {
  const { rootDir, state } = createNvencPipelineFixture();
  const pipeline = state.pipelines[0];
  pipeline.mode = 'shared-relay';
  pipeline.settings.live.videoEncoder = 'libx264';
  let checkCount = 0;
  const stopCounts = { pipeline: 0, output: 0 };
  const manager = createManager(state, rootDir, {
    checkNvenc() {
      checkCount += 1;
      return { ok: false, diagnostic: 'Cannot load libcuda.so.1' };
    },
  });
  manager.spawnFFmpeg = (role, id, args, logName) => {
    const process = createStubProcess(role, id, args, logName);
    process.stop = () => {
      stopCounts[role] += 1;
    };
    return process;
  };

  manager.startPipeline('pipe-a');
  const existingSession = manager.sessions.get('pipe-a');
  const existingPipelineProcess = existingSession.pipelineProcess;
  const existingOutput = existingSession.outputs.get('dest-a');
  assert.equal(state.pipelines[0].status, 'running');

  pipeline.settings.live.videoEncoder = 'auto';
  assert.throws(() => manager.startPipeline('pipe-a'), /NVIDIA NVENC.*Cannot load libcuda\.so\.1/);

  assert.equal(checkCount, 1);
  assert.equal(manager.sessions.get('pipe-a'), existingSession);
  assert.equal(manager.sessions.get('pipe-a').pipelineProcess, existingPipelineProcess);
  assert.equal(manager.sessions.get('pipe-a').outputs.get('dest-a'), existingOutput);
  assert.deepEqual(stopCounts, { pipeline: 0, output: 0 });
  assert.equal(existingSession.status, 'running');
  assert.equal(state.pipelines[0].status, 'running');
});

test('output metrics use wall-clock byte throughput and estimate delivery loss for CBR relay overruns', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });

  const base = {
    bitrateKbps: 15000,
    fps: 60,
    dup: 0,
    drop: 0,
    targetFps: 60,
    expectedBitrateKbps: 15000,
    processSessionId: 'session-a',
    relayTransport: true,
    transportMetricSource: 'tcp-acked',
    transportSampleAvailable: true,
  };
  manager.recordOutputMetric('out-limited', { ...base, tcpSentBytes: 0, tcpAckedBytes: 0, tcpRetransBytes: 0, frame: 0, udpOverruns: 0 }, 0);
  for (let second = 1; second <= 5; second += 1) {
    manager.recordOutputMetric('out-limited', {
      ...base,
      tcpSentBytes: second * 625_000,
      tcpAckedBytes: second * 625_000,
      tcpRetransBytes: 0,
      frame: second * 60,
      udpOverruns: second === 5 ? 3 : 0,
      corruptPackets: second === 5 ? 2 : 0,
    }, second * 1000);
  }

  const latest = manager.historyForOutput('out-limited', { now: 5000, rangeSec: 60 }).at(-1);
  const recent = manager.recentDropForOutput('out-limited', { now: 5000, windowSec: 30 });

  assert.equal(latest.udpOverruns, 3);
  assert.equal(latest.corruptPackets, 2);
  assert.equal(Number(latest.measuredFps.toFixed(2)), 60);
  assert.equal(latest.dropMetricVersion, 2);
  assert.equal(latest.networkDropDelta, 40);
  assert.equal(latest.totalDroppedFrames, 40);
  assert.equal(Number(latest.totalDropRatePercent.toFixed(1)), 66.7);
  assert.equal(recent.droppedFrames, 40);
  assert.equal(Number(recent.dropRatePercent.toFixed(1)), 66.7);
  assert.equal(Number(recent.measuredFps.toFixed(2)), 60);
});

test('relay network drops require a local UDP loss signal', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  const base = {
    bitrateKbps: 15000, fps: 60, dup: 0, drop: 0, targetFps: 60,
    expectedBitrateKbps: 15000, processSessionId: 'session-a', relayTransport: true,
    transportMetricSource: 'tcp-acked', transportSampleAvailable: true,
  };
  manager.recordOutputMetric('out-relay-no-overrun', {
    ...base, tcpSentBytes: 0, tcpAckedBytes: 0, tcpRetransBytes: 0, frame: 0, udpOverruns: 0,
  }, 0);
  for (let second = 1; second <= 5; second += 1) {
    manager.recordOutputMetric('out-relay-no-overrun', {
      ...base,
      tcpSentBytes: second * 625_000,
      tcpAckedBytes: second * 625_000,
      tcpRetransBytes: 0,
      frame: second * 60,
      udpOverruns: 0,
    }, second * 1000);
  }

  const latest = manager.outputHistory.get('out-relay-no-overrun').at(-1);
  assert.equal(latest.bitrateKbps, 5000);
  assert.equal(latest.transportShortfallPercent > 60, true);
  assert.equal(latest.networkDroppedFrames, 0);
  assert.equal(latest.totalDroppedFrames, 0);
});

test('version two network drops allow two percent delivery tolerance', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  const base = {
    bitrateKbps: 15000, fps: 60, dup: 0, drop: 0, targetFps: 60,
    expectedBitrateKbps: 15000, processSessionId: 'session-a',
    transportMetricSource: 'tcp-acked', transportSampleAvailable: true,
  };
  manager.recordOutputMetric('out-tolerance', { ...base, tcpSentBytes: 0, tcpAckedBytes: 0, tcpRetransBytes: 0, frame: 0 }, 0);
  for (let second = 1; second <= 5; second += 1) {
    manager.recordOutputMetric('out-tolerance', {
      ...base,
      tcpSentBytes: second * 1_850_000,
      tcpAckedBytes: second * 1_850_000,
      tcpRetransBytes: 0,
      frame: second * 60,
    }, second * 1000);
  }

  const latest = manager.outputHistory.get('out-tolerance').at(-1);
  assert.equal(latest.networkDropDelta, 0);
  assert.equal(latest.totalDroppedFrames, 0);
});

test('version two network drops ignore one-second mux bursts when five-second delivery is healthy', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  const base = {
    bitrateKbps: 8000, fps: 60, dup: 0, drop: 0, targetFps: 60,
    expectedBitrateKbps: 8000, processSessionId: 'session-a',
    transportMetricSource: 'tcp-acked', transportSampleAvailable: true,
  };
  const deltas = [250_000, 2_500_000, 250_000, 2_000_000, 625_000];
  let ackedBytes = 0;
  manager.recordOutputMetric('out-bursty', { ...base, tcpSentBytes: ackedBytes, tcpAckedBytes: ackedBytes, tcpRetransBytes: 0, frame: 0 }, 0);
  deltas.forEach((delta, index) => {
    ackedBytes += delta;
    manager.recordOutputMetric('out-bursty', {
      ...base, tcpSentBytes: ackedBytes, tcpAckedBytes: ackedBytes, tcpRetransBytes: 0, frame: (index + 1) * 60,
    }, (index + 1) * 1000);
  });

  const history = manager.outputHistory.get('out-bursty');
  assert.equal(history.at(-1).bitrateKbps, 9000);
  assert.equal(history.every(point => point.networkDropDelta === 0), true);
  assert.equal(history.at(-1).networkDroppedFrames, 0);
});

test('version two network drops sample stalled bytes once per wall-clock second', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  const base = {
    bitrateKbps: 15000, fps: 60, dup: 0, drop: 0, targetFps: 60,
    expectedBitrateKbps: 15000, processSessionId: 'session-a',
    relayTransport: true, transportMetricSource: 'tcp-acked', transportSampleAvailable: true,
  };
  manager.recordOutputMetric('out-stalled', { ...base, tcpSentBytes: 0, tcpAckedBytes: 0, tcpRetransBytes: 0, frame: 0, udpOverruns: 0 }, 0);
  for (let second = 1; second <= 5; second += 1) {
    manager.recordOutputMetric('out-stalled', {
      ...base, tcpSentBytes: second * 1_875_000, tcpAckedBytes: second * 1_875_000, tcpRetransBytes: 0,
      frame: second * 60, udpOverruns: 0,
    }, second * 1000);
  }
  for (let second = 6; second <= 11; second += 1) {
    manager.recordOutputMetric('out-stalled', {
      ...base, tcpSentBytes: 5 * 1_875_000, tcpAckedBytes: 5 * 1_875_000, tcpRetransBytes: 0,
      frame: second * 60, udpOverruns: 1,
    }, second * 1000);
  }

  const latest = manager.outputHistory.get('out-stalled').at(-1);
  assert.equal(latest.networkDropDelta, 60);
  assert.equal(latest.networkDroppedFrames, 240);
  assert.equal(latest.totalDroppedFrames, 240);
});

test('version two network drops accumulate adjacent samples without rolling-window duplication', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  const base = {
    bitrateKbps: 15000, fps: 60, dup: 0, drop: 0, targetFps: 60,
    expectedBitrateKbps: 15000, processSessionId: 'session-a',
    relayTransport: true, transportMetricSource: 'tcp-acked', transportSampleAvailable: true,
  };
  manager.recordOutputMetric('out-adjacent', { ...base, tcpSentBytes: 0, tcpAckedBytes: 0, tcpRetransBytes: 0, frame: 0, udpOverruns: 0 }, 0);
  for (let second = 1; second <= 6; second += 1) {
    manager.recordOutputMetric('out-adjacent', {
      ...base, tcpSentBytes: second * 625_000, tcpAckedBytes: second * 625_000, tcpRetransBytes: 0,
      frame: second * 60, udpOverruns: second >= 5 ? 1 : 0,
    }, second * 1000);
  }

  const history = manager.outputHistory.get('out-adjacent');
  assert.deepEqual(history.map(point => point.networkDropDelta), [0, 0, 0, 0, 0, 40, 40]);
  assert.equal(history.at(-1).networkDroppedFrames, 80);
  assert.equal(history.at(-1).totalDroppedFrames, 80);
});

test('a new version two process session resets network counters', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  manager.recordOutputMetric('out-session-v2', {
    sizeBytes: 0, frame: 0, dup: 0, drop: 0, targetFps: 60, expectedBitrateKbps: 15000,
    processSessionId: 'session-a',
  }, 0);
  manager.recordOutputMetric('out-session-v2', {
    sizeBytes: 625_000, frame: 60, dup: 5, drop: 1, targetFps: 60, expectedBitrateKbps: 15000,
    processSessionId: 'session-a',
  }, 1000);
  manager.recordOutputMetric('out-session-v2', {
    sizeBytes: 100, frame: 1, dup: 0, drop: 0, targetFps: 60, expectedBitrateKbps: 15000,
    processSessionId: 'session-b',
  }, 2000);

  const latest = manager.outputHistory.get('out-session-v2').at(-1);
  assert.equal(latest.sessionBoundary, true);
  assert.equal(latest.networkDroppedFrames, 0);
  assert.equal(latest.totalDroppedFrames, 0);
  for (const key of REMOVED_STALL_KEYS) assert.equal(Object.hasOwn(latest, key), false);
});

test('actual output bitrate uses acknowledged TCP bytes and never FFmpeg reported bitrate', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  manager.recordOutputMetric('out-acked', tcpMetric({ second: 0, ackedBytes: 0 }), 0);

  const sampling = manager.outputHistory.get('out-acked').at(-1);
  assert.equal(sampling.bitrateKbps, null);
  assert.equal(sampling.reportedBitrateKbps, 15000);
  assert.equal(sampling.actualBitrateAvailable, false);
  assert.equal(sampling.actualBitrateStatus, 'sampling');

  manager.recordOutputMetric('out-acked', tcpMetric({
    second: 5,
    sentBytes: 6_500_000,
    ackedBytes: 6_250_000,
    retransBytes: 250_000,
  }), 5000);

  const available = manager.outputHistory.get('out-acked').at(-1);
  assert.equal(available.bitrateKbps, 10000);
  assert.equal(available.actualBitrateAvailable, true);
  assert.equal(available.actualBitrateStatus, 'available');
  assert.equal(available.transportMetricSource, 'tcp-acked');
  assert.equal(available.tcpRetransBytes, 250_000);
  assert.equal(available.networkDroppedFrames, 0);
});

test('missing TCP sample is unavailable and never falls back to FFmpeg reported bitrate', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  manager.recordOutputMetric('out-unavailable', tcpMetric({
    second: 0,
    ackedBytes: 0,
    transportSampleAvailable: false,
  }), 0);

  const point = manager.outputHistory.get('out-unavailable').at(-1);
  assert.equal(point.reportedBitrateKbps, 15000);
  assert.equal(point.bitrateKbps, null);
  assert.equal(point.actualBitrateAvailable, false);
  assert.equal(point.actualBitrateStatus, 'unavailable');
  assert.equal(point.transportShortfallPercent, null);
  assert.equal(point.networkDropAvailable, false);
});

test('acknowledged TCP counter regression starts a new sampling boundary', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  manager.recordOutputMetric('out-reconnect', tcpMetric({ second: 0, ackedBytes: 1000, sentBytes: 1100 }), 0);
  manager.recordOutputMetric('out-reconnect', tcpMetric({ second: 5, ackedBytes: 6_251_000, sentBytes: 6_501_000 }), 5000);
  manager.recordOutputMetric('out-reconnect', tcpMetric({ second: 6, ackedBytes: 100, sentBytes: 120 }), 6000);

  const point = manager.outputHistory.get('out-reconnect').at(-1);
  assert.equal(point.counterReset, true);
  assert.equal(point.bitrateKbps, null);
  assert.equal(point.actualBitrateAvailable, false);
  assert.equal(point.actualBitrateStatus, 'sampling');
  assert.equal(point.networkDroppedFrames, 0);
});

test('relay loss begins on UDP overrun and persists until acknowledged bitrate recovery', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  const ackedPerSecond = 937_500;
  manager.recordOutputMetric('out-overrun-state', tcpMetric({ second: 0, ackedBytes: 0 }), 0);
  for (let second = 1; second <= 4; second += 1) {
    manager.recordOutputMetric('out-overrun-state', tcpMetric({
      second,
      ackedBytes: second * ackedPerSecond,
      udpOverruns: 0,
    }), second * 1000);
  }
  manager.recordOutputMetric('out-overrun-state', tcpMetric({
    second: 5,
    ackedBytes: 5 * ackedPerSecond,
    udpOverruns: 1,
  }), 5000);

  const activated = manager.outputHistory.get('out-overrun-state').at(-1);
  assert.equal(activated.bitrateKbps, 7500);
  assert.equal(activated.networkDropAvailable, true);
  assert.equal(activated.networkLossActive, true);
  assert.equal(activated.networkDropDelta, 30);
  assert.equal(activated.networkDroppedFrames, 30);

  manager.recordOutputMetric('out-overrun-state', tcpMetric({
    second: 6,
    ackedBytes: 6 * ackedPerSecond,
    udpOverruns: 1,
  }), 6000);
  const continued = manager.outputHistory.get('out-overrun-state').at(-1);
  assert.equal(continued.networkLossActive, true);
  assert.equal(continued.networkDropDelta, 30);
  assert.equal(continued.networkDroppedFrames, 60);

  manager.recordOutputMetric('out-overrun-state', tcpMetric({
    second: 7,
    ackedBytes: 11_250_000,
    sentBytes: 11_500_000,
    retransBytes: 500_000,
    udpOverruns: 1,
  }), 7000);
  const recovered = manager.outputHistory.get('out-overrun-state').at(-1);
  assert.equal(recovered.bitrateKbps, 15000);
  assert.equal(recovered.networkLossActive, false);
  assert.equal(recovered.networkDropDelta, 0);
  assert.equal(recovered.networkDroppedFrames, 60);
});

test('low ACK bitrate without UDP overrun never estimates dropped frames', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  const ackedPerSecond = 937_500;
  manager.recordOutputMetric('out-no-overrun', tcpMetric({ second: 0, ackedBytes: 0 }), 0);
  for (let second = 1; second <= 5; second += 1) {
    manager.recordOutputMetric('out-no-overrun', tcpMetric({
      second,
      ackedBytes: second * ackedPerSecond,
      udpOverruns: 0,
      corruptPackets: second === 5 ? 4 : 0,
      retransBytes: second * 100_000,
    }), second * 1000);
  }

  const point = manager.outputHistory.get('out-no-overrun').at(-1);
  assert.equal(point.bitrateKbps, 7500);
  assert.equal(point.networkDropAvailable, true);
  assert.equal(point.networkLossActive, false);
  assert.equal(point.networkDropDelta, 0);
  assert.equal(point.networkDroppedFrames, 0);
});

test('active network loss becomes unavailable without inventing another drop interval', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  const ackedPerSecond = 937_500;
  manager.recordOutputMetric('out-drop-unavailable', tcpMetric({ second: 0, ackedBytes: 0 }), 0);
  for (let second = 1; second <= 5; second += 1) {
    manager.recordOutputMetric('out-drop-unavailable', tcpMetric({
      second,
      ackedBytes: second * ackedPerSecond,
      udpOverruns: second === 5 ? 1 : 0,
    }), second * 1000);
  }
  const before = manager.outputHistory.get('out-drop-unavailable').at(-1);
  manager.recordOutputMetric('out-drop-unavailable', tcpMetric({
    second: 6,
    ackedBytes: 0,
    udpOverruns: 1,
    transportSampleAvailable: false,
  }), 6000);

  const unavailable = manager.outputHistory.get('out-drop-unavailable').at(-1);
  assert.equal(unavailable.networkDropAvailable, false);
  assert.equal(unavailable.networkLossActive, true);
  assert.equal(unavailable.networkDropDelta, 0);
  assert.equal(unavailable.networkDroppedFrames, before.networkDroppedFrames);
});

test('legacy unversioned drop points keep the previous raw-counter calculation', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  manager.recordOutputMetric('out-legacy', { frame: 0, timeSec: 0, drop: 0, targetFps: 60 }, 0);
  manager.recordOutputMetric('out-legacy', { frame: 60, timeSec: 1, drop: 2, targetFps: 60 }, 1000);

  const latest = manager.outputHistory.get('out-legacy').at(-1);
  assert.equal(latest.dropMetricVersion, undefined);
  assert.equal(latest.totalDroppedFrames, 2);
  assert.equal(Number(latest.totalDropRatePercent.toFixed(1)), 3.2);
});

test('output bitrate uses a five-second rolling byte-rate window', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  const byteDeltas = [1_000_000, 2_500_000, 1_250_000, 2_250_000, 2_375_000];
  let ackedBytes = 0;

  manager.recordOutputMetric('out-rolling', { ...tcpMetric({ second: 0, ackedBytes }), frame: 0, drop: 0 }, 0);
  byteDeltas.forEach((delta, index) => {
    ackedBytes += delta;
    manager.recordOutputMetric('out-rolling', {
      ...tcpMetric({ second: index + 1, ackedBytes }), frame: (index + 1) * 60, drop: 0,
    }, (index + 1) * 1000);
  });

  const latest = manager.historyForOutput('out-rolling', { now: 5000, rangeSec: 60 }).at(-1);
  assert.equal(latest.bitrateKbps, 15000);
  assert.equal(latest.measuredFps, 60);
  assert.equal(latest.totalDroppedFrames, 0);
  assert.equal(latest.totalDropRatePercent, 0);
});

test('rolling bitrate chooses the retained sample nearest the five-second target', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  manager.recordOutputMetric('out-irregular', { ...tcpMetric({ second: 0, ackedBytes: 0 }), drop: 0 }, 0);
  manager.recordOutputMetric('out-irregular', { ...tcpMetric({ second: 4, ackedBytes: 8_000_000 }), drop: 0 }, 4000);
  manager.recordOutputMetric('out-irregular', { ...tcpMetric({ second: 6, ackedBytes: 11_250_000 }), drop: 0 }, 6000);

  const latest = manager.outputHistory.get('out-irregular').at(-1);
  assert.equal(latest.bitrateKbps, 15000);
});

test('rolling bitrate stays in sampling state when the nearest ACK anchor is stale', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  manager.recordOutputMetric('out-gap', { ...tcpMetric({ second: 0, ackedBytes: 0 }), drop: 0 }, 0);
  manager.recordOutputMetric('out-gap', { ...tcpMetric({ second: 100, ackedBytes: 62_500_000 }), drop: 0 }, 100_000);

  const latest = manager.outputHistory.get('out-gap').at(-1);
  assert.equal(latest.bitrateKbps, null);
  assert.equal(latest.actualBitrateAvailable, false);
  assert.equal(latest.actualBitrateStatus, 'sampling');
  assert.equal(latest.transportShortfallPercent, null);
});

test('bitrate-only records keep optional progress counters absent', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  manager.recordOutputMetric('out-optional', { bitrateKbps: 15000 }, 0);

  const first = manager.outputHistory.get('out-optional').at(-1);
  assert.equal('frame' in first, false);
  assert.equal(first.frame, undefined);
  assert.equal(first.timeSec, undefined);
  assert.equal(first.rawDroppedFrames, undefined);

  manager.recordOutputMetric('out-optional', { bitrateKbps: 15000, fps: 60, frame: 60, timeSec: 1 }, 1000);
  const second = manager.outputHistory.get('out-optional').at(-1);
  assert.equal(second.measuredFps, 60);
  assert.equal(second.counterReset, false);
});

test('partial samples preserve the raw drop baseline without synthesizing a counter', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  manager.recordOutputMetric('out-partial-drop', {
    bitrateKbps: 15000, fps: 60, frame: 60, timeSec: 1, drop: 5,
  }, 1000);
  manager.recordOutputMetric('out-partial-drop', { bitrateKbps: 15000 }, 2000);

  const partial = manager.outputHistory.get('out-partial-drop').at(-1);
  assert.equal(partial.rawDropCounterPresent, false);
  assert.equal('rawDroppedFrames' in partial, false);

  manager.recordOutputMetric('out-partial-drop', {
    bitrateKbps: 15000, fps: 60, frame: 180, timeSec: 3, drop: 5,
  }, 3000);
  let latest = manager.outputHistory.get('out-partial-drop').at(-1);
  let recent = manager.recentDropForOutput('out-partial-drop', { now: 3000, windowSec: 30 });
  assert.equal(latest.dropDelta, 0);
  assert.equal(latest.totalDroppedFrames, 5);
  assert.equal(recent.droppedFrames, 0);

  manager.recordOutputMetric('out-partial-drop', {
    bitrateKbps: 15000, fps: 60, frame: 240, timeSec: 4, drop: 6,
  }, 4000);
  latest = manager.outputHistory.get('out-partial-drop').at(-1);
  recent = manager.recentDropForOutput('out-partial-drop', { now: 4000, windowSec: 30 });
  assert.equal(latest.dropDelta, 1);
  assert.equal(latest.totalDroppedFrames, 6);
  assert.equal(recent.droppedFrames, 1);
});

test('explicit output process sessions persist a reset boundary across manager restart', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-manager-session-'));
  const now = Date.now();
  const state = { settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] };
  const firstManager = createManager(state, rootDir);
  firstManager.recordOutputMetric('out-session', {
    bitrateKbps: 15000, fps: 60, frame: 600, timeSec: 10, drop: 3, processSessionId: 'session-old',
  }, now - 1000);

  const restartedManager = createManager(state, rootDir);
  restartedManager.recordOutputMetric('out-session', {
    bitrateKbps: 15000, fps: 60, frame: 60, timeSec: 1, drop: 0, processSessionId: 'session-new',
  }, now);

  const history = restartedManager.historyForOutput('out-session', { now, rangeSec: 60 });
  assert.deepEqual(history.map(point => point.processSessionId), ['session-old', 'session-new']);
  assert.equal(history[0].sessionBoundary, true);
  assert.equal(history[1].sessionBoundary, true);
  assert.equal(history[1].counterReset, true);
  assert.equal(history[1].totalDroppedFrames, 0);
  assert.equal(history[1].totalDropRatePercent, 0);
});

test('a restarted manager starts a new in-memory boundary without reading persisted history', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-manager-session-repeat-'));
  const now = Date.now();
  const state = { settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] };
  createManager(state, rootDir).recordOutputMetric('out-session', {
    bitrateKbps: 15000, frame: 60, timeSec: 1, drop: 0, processSessionId: 'session-current',
  }, now - 1000);

  const restartedManager = createManager(state, rootDir);
  restartedManager.recordOutputMetric('out-session', {
    bitrateKbps: 15000, frame: 120, timeSec: 2, drop: 0, processSessionId: 'session-current',
  }, now);

  const latest = restartedManager.outputHistory.get('out-session').at(-1);
  assert.equal(latest.sessionBoundary, true);
  assert.equal(latest.counterReset, true);
});

test('healthy current FPS and raw zero drops are unaffected by a low bitrate sample', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  manager.recordOutputMetric('out-healthy', {
    ...tcpMetric({ second: 0, ackedBytes: 0 }), frame: 0, drop: 0,
  }, 0);
  manager.recordOutputMetric('out-healthy', {
    ...tcpMetric({ second: 5, ackedBytes: 3_125_000 }), frame: 300, drop: 0,
  }, 5000);

  const latest = manager.historyForOutput('out-healthy', { now: 5000, rangeSec: 60 }).at(-1);
  assert.equal(latest.bitrateKbps, 5000);
  assert.equal(latest.measuredFps, 60);
  assert.equal(latest.totalDroppedFrames, 0);
  assert.equal(latest.totalDropRatePercent, 0);
});

test('raw FFmpeg drop counter is cumulative and resets with a new process', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  manager.recordOutputMetric('out-drops', { fps: 60, frame: 0, timeSec: 0, drop: 0, sizeBytes: 0, targetFps: 60 }, 0);
  manager.recordOutputMetric('out-drops', { fps: 60, frame: 600, timeSec: 10, drop: 3, sizeBytes: 10_000, targetFps: 60 }, 10_000);

  let latest = manager.historyForOutput('out-drops', { now: 10_000, rangeSec: 60 }).at(-1);
  assert.equal(latest.totalDroppedFrames, 3);
  assert.equal(Number(latest.totalDropRatePercent.toFixed(3)), 0.498);

  manager.recordOutputMetric('out-drops', { fps: 60, frame: 60, timeSec: 1, drop: 0, sizeBytes: 1000, targetFps: 60 }, 11_000);
  latest = manager.outputHistory.get('out-drops').at(-1);
  assert.equal(latest.totalDroppedFrames, 0);
  assert.equal(latest.totalDropRatePercent, 0);

  manager.recordOutputMetric('out-drops', { fps: 60, frame: 120, timeSec: 2, drop: 1, sizeBytes: 2000, targetFps: 60 }, 12_000);
  latest = manager.outputHistory.get('out-drops').at(-1);
  assert.equal(latest.totalDroppedFrames, 1);
  assert.equal(Number(latest.totalDropRatePercent.toFixed(3)), 0.826);
});

test('resetOutputDropDisplay persists a display baseline without changing raw history', () => {
  const state = { settings: {}, rooms: [], sources: [], destinations: [], pipelines: [], monitorDisplay: { dropBaselines: {} } };
  const manager = createManager(state);
  const outputId = 'out-display-reset';
  const base = {
    fps: 60, targetFps: 60, expectedBitrateKbps: 15000, processSessionId: 'session-a', speed: 0.8,
    relayTransport: true, transportMetricSource: 'tcp-acked', transportSampleAvailable: true,
  };
  manager.recordOutputMetric(outputId, {
    ...base, tcpSentBytes: 0, tcpAckedBytes: 0, tcpRetransBytes: 0, frame: 0, dup: 0, drop: 0, udpOverruns: 0,
  }, 0);
  for (let second = 1; second <= 5; second += 1) {
    manager.recordOutputMetric(outputId, {
      ...base,
      tcpSentBytes: second * 625_000,
      tcpAckedBytes: second * 625_000,
      tcpRetransBytes: 0,
      frame: second * 60,
      udpOverruns: second === 5 ? 1 : 0,
      dup: second === 5 ? 5 : 0,
      drop: second === 5 ? 1 : 0,
    }, second * 1000);
  }
  const rawBefore = manager.historyForOutput(outputId, { now: 5000, rangeSec: 60 }).at(-1);

  const reset = manager.resetOutputDropDisplay(outputId, 5000);
  assert.equal(reset.totalDroppedFrames, 0);
  assert.equal(reset.totalDropRatePercent, 0);
  assert.equal(reset.dropDisplayResetAt, 5000);
  assert.deepEqual(manager.historyForOutput(outputId, { now: 5000, rangeSec: 60 }).at(-1), rawBefore);
  assert.equal(state.monitorDisplay.dropBaselines[outputId].networkDroppedFrames, 40);
  assert.equal(state.monitorDisplay.dropBaselines[outputId].networkExpectedFrames, 60);

  manager.recordOutputMetric(outputId, {
    ...base,
    tcpSentBytes: 3_750_000,
    tcpAckedBytes: 3_750_000,
    tcpRetransBytes: 0,
    frame: 360,
    dup: 7,
    drop: 2,
    udpOverruns: 1,
  }, 6000);
  const displayed = manager.outputDescriptorForId(outputId, { now: 6000, rangeSec: 60 });
  const rawLatest = manager.historyForOutput(outputId, { now: 6000, rangeSec: 60 }).at(-1);

  assert.equal(displayed.totalDroppedFrames, 40);
  assert.equal(Number(displayed.totalDropRatePercent.toFixed(1)), 66.7);
  assert.equal(displayed.metrics.totalDroppedFrames, 80);
  assert.equal(rawLatest.totalDroppedFrames, 80);
  for (const key of REMOVED_STALL_KEYS) {
    assert.equal(Object.hasOwn(displayed, key), false);
    assert.equal(Object.hasOwn(displayed.metrics, key), false);
    assert.equal(Object.hasOwn(rawLatest, key), false);
  }
});

test('drop display baseline survives manager recreation and is ignored by a new process session', () => {
  const state = { settings: {}, rooms: [], sources: [], destinations: [], pipelines: [], monitorDisplay: { dropBaselines: {} } };
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-display-session-'));
  const now = Date.now();
  const first = createManager(state, rootDir);
  first.recordOutputMetric('out-display', {
    sizeBytes: 0, frame: 0, dup: 0, drop: 0, targetFps: 60, expectedBitrateKbps: 15000,
    processSessionId: 'session-old', speed: 0.8,
  }, now - 1000);
  first.recordOutputMetric('out-display', {
    sizeBytes: 625_000, frame: 60, dup: 4, drop: 1, targetFps: 60, expectedBitrateKbps: 15000,
    processSessionId: 'session-old', speed: 0.8,
  }, now);
  first.resetOutputDropDisplay('out-display', now);

  const restarted = createManager(state, rootDir);
  const retained = restarted.outputDescriptorForId('out-display', { now, rangeSec: 60 });
  assert.equal(retained.totalDroppedFrames, 0);
  restarted.recordOutputMetric('out-display', {
    sizeBytes: 100, frame: 1, dup: 1, drop: 1, targetFps: 60, expectedBitrateKbps: 15000,
    processSessionId: 'session-new', speed: 0.8,
  }, now + 1000);
  const nextSession = restarted.outputDescriptorForId('out-display', { now: now + 1000, rangeSec: 60 });
  assert.equal(nextSession.totalDroppedFrames, 0);
  assert.equal(nextSession.dropDisplayResetAt, undefined);
});

test('resetOutputDropDisplay supports a stopped retained output', () => {
  const state = {
    settings: {}, rooms: [], sources: [], monitorDisplay: { dropBaselines: {} },
    destinations: [{ id: 'dest-a', name: 'Platform A', enabled: true }],
    pipelines: [{ id: 'pipe-a', name: 'PGM', destinationIds: ['dest-a'], status: 'stopped' }],
  };
  const manager = createManager(state);
  const base = {
    targetFps: 60, expectedBitrateKbps: 15000, processSessionId: 'stopped-session', speed: 0.8,
    relayTransport: true, transportMetricSource: 'tcp-acked', transportSampleAvailable: true,
  };
  manager.recordOutputMetric('pipe-a-dest-a', {
    ...base, tcpSentBytes: 0, tcpAckedBytes: 0, tcpRetransBytes: 0, frame: 0, dup: 0, drop: 0, udpOverruns: 0,
  }, 0);
  for (let second = 1; second <= 5; second += 1) {
    manager.recordOutputMetric('pipe-a-dest-a', {
      ...base,
      tcpSentBytes: second * 625_000,
      tcpAckedBytes: second * 625_000,
      tcpRetransBytes: 0,
      frame: second * 60,
      udpOverruns: second === 5 ? 1 : 0,
      dup: second === 5 ? 3 : 0,
      drop: second === 5 ? 1 : 0,
    }, second * 1000);
  }

  const reset = manager.resetOutputDropDisplay('pipe-a-dest-a', 5000);

  assert.equal(reset.status, 'stopped');
  assert.equal(reset.totalDroppedFrames, 0);
  const rawLatest = manager.historyForOutput('pipe-a-dest-a', { now: 5000, rangeSec: 60 }).at(-1);
  assert.equal(rawLatest.totalDroppedFrames, 40);
  for (const key of REMOVED_STALL_KEYS) {
    assert.equal(Object.hasOwn(reset, key), false);
    assert.equal(Object.hasOwn(rawLatest, key), false);
  }
});

test('output metrics keep full delivery when actual CBR throughput is within tolerance', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });

  manager.recordOutputMetric('out-stable', {
    ...tcpMetric({ second: 20, ackedBytes: 0, targetFps: 59.94 }),
    drop: 0,
  }, 20_000);
  manager.recordOutputMetric('out-stable', {
    ...tcpMetric({ second: 25, ackedBytes: 9_250_000, targetFps: 59.94 }),
    drop: 0,
  }, 25_000);

  const latest = manager.historyForOutput('out-stable', { now: 25_000, rangeSec: 60 }).at(-1);
  assert.equal(latest.bitrateKbps, 14800);
  assert.equal(Number(latest.measuredFps.toFixed(2)), 59.94);
  assert.equal(latest.dropDelta, 0);
  assert.equal(latest.dropRatePercent, 0);
});

test('monitor counts a sustained transport bitrate shortfall as an output error', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  const output = {
    id: 'pipe-a-dest-a',
    role: 'output',
    destination: { id: 'dest-a', name: 'Limited output' },
    status: 'running',
    startedAt: 0,
    metrics: {},
    lastError: '',
  };
  manager.sessions.set('pipe-a', {
    pipelineId: 'pipe-a',
    name: 'Limited pipeline',
    mode: 'direct',
    source: { id: 'src-a', name: 'Input', type: 'url' },
    targetFps: 60,
    outputs: new Map([['dest-a', output]]),
    startedAt: 0,
    status: 'running',
  });
  manager.recordOutputMetric(output.id, tcpMetric({ second: 10, ackedBytes: 0, relayTransport: false }), 10_000);
  manager.recordOutputMetric(output.id, tcpMetric({ second: 15, ackedBytes: 3_125_000, relayTransport: false }), 15_000);

  const monitor = manager.monitor({ now: 15_000, rangeSec: 60 });
  assert.equal(monitor.outputs[0].transportShortfallPercent > 60, true);
  assert.equal(monitor.totals.errors, 1);
});

test('monitor error count starts at a thirty percent bitrate shortfall', () => {
  function errorsForBitrate(actualBitrateKbps) {
    const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
    const output = {
      id: 'pipe-a-dest-a', role: 'output', destination: { id: 'dest-a' }, status: 'running',
      startedAt: 0, metrics: {}, lastError: '',
    };
    manager.sessions.set('pipe-a', {
      pipelineId: 'pipe-a', name: 'Pipeline', mode: 'direct', source: { id: 'src-a', name: 'Input', type: 'url' },
      targetFps: 60, outputs: new Map([['dest-a', output]]), startedAt: 0, status: 'running',
    });
    manager.recordOutputMetric(output.id, tcpMetric({ second: 10, ackedBytes: 0, relayTransport: false }), 10_000);
    manager.recordOutputMetric(output.id, tcpMetric({
      second: 15,
      ackedBytes: (actualBitrateKbps * 5000) / 8,
      relayTransport: false,
    }), 15_000);
    return manager.monitor({ now: 15_000, rangeSec: 60 });
  }

  assert.equal(errorsForBitrate(10515).totals.errors, 0);
  assert.equal(errorsForBitrate(10500).totals.errors, 1);
});

test('UDP overrun alone does not increment monitor error totals', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  const output = {
    id: 'pipe-a-dest-a',
    role: 'output',
    destination: { id: 'dest-a' },
    status: 'running',
    startedAt: 0,
    metrics: { udpOverruns: 4, corruptPackets: 1 },
    lastError: '',
  };
  manager.sessions.set('pipe-a', {
    pipelineId: 'pipe-a',
    name: 'Pipeline',
    mode: 'shared-relay',
    source: { id: 'src-a', name: 'Input', type: 'url' },
    targetFps: 60,
    outputs: new Map([['dest-a', output]]),
    startedAt: 0,
    status: 'running',
  });

  const monitor = manager.monitor({ now: 5000, rangeSec: 60 });

  assert.equal(monitor.outputs[0].udpOverruns, 4);
  assert.equal(monitor.totals.errors, 0);
});

test('output metric history is kept per output and can be filtered by range', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  const now = Date.now();

  manager.recordOutputMetric('out-a', { bitrateKbps: 1000, fps: 30, drop: 1, dropRatePercent: 0.1 }, now - 70_000);
  manager.recordOutputMetric('out-b', { bitrateKbps: 2000, fps: 60, drop: 2, dropRatePercent: 0.2 }, now - 60_000);
  manager.recordOutputMetric('out-a', { bitrateKbps: 1500, fps: 30, drop: 1, dropRatePercent: 0 }, now - 10_000);

  assert.deepEqual(manager.historyForOutput('out-a', { now, rangeSec: 30 }).map(point => point.reportedBitrateKbps), [1500]);
  assert.deepEqual(manager.historyForOutput('out-a', { now, rangeSec: 120 }).map(point => point.reportedBitrateKbps), [1000, 1500]);
  assert.deepEqual(manager.historyForOutput('out-b', { now, rangeSec: 120 }).map(point => point.reportedBitrateKbps), [2000]);
});

test('output metric history can be filtered by an exact inclusive time period', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });

  manager.recordOutputMetric('out-a', { bitrateKbps: 1000, fps: 30 }, 10_000);
  manager.recordOutputMetric('out-a', { bitrateKbps: 2000, fps: 30 }, 20_000);
  manager.recordOutputMetric('out-a', { bitrateKbps: 3000, fps: 30 }, 30_000);

  const history = manager.historyForOutput('out-a', { from: 15_000, to: 25_000 });

  assert.deepEqual(history.map(point => point.time), [20_000]);
});

test('output metric history rejects a reversed exact time period', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });

  assert.throws(
    () => manager.historyForOutput('out-a', { from: 25_000, to: 15_000 }),
    /结束时间不能早于开始时间/,
  );
});

test('output drop metrics compare actual output frames against configured output fps', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });

  manager.recordOutputMetric('out-30fps', {
    bitrateKbps: 6300,
    fps: 30,
    frame: 0,
    timeSec: 0,
    targetFps: 30,
  }, 0);
  manager.recordOutputMetric('out-30fps', {
    bitrateKbps: 6300,
    fps: 30,
    frame: 900,
    timeSec: 30,
    targetFps: 30,
  }, 30_000);

  manager.recordOutputMetric('out-slow-30fps', {
    bitrateKbps: 6300,
    fps: 30,
    frame: 0,
    timeSec: 0,
    targetFps: 30,
  }, 0);
  manager.recordOutputMetric('out-slow-30fps', {
    bitrateKbps: 6300,
    fps: 29,
    frame: 870,
    timeSec: 30,
    targetFps: 30,
  }, 30_000);

  const normal = manager.historyForOutput('out-30fps', { now: 30_000, rangeSec: 60 }).at(-1);
  const slow = manager.historyForOutput('out-slow-30fps', { now: 30_000, rangeSec: 60 }).at(-1);

  assert.equal(normal.droppedFrames, 0);
  assert.equal(normal.dropRatePercent, 0);
  assert.equal(slow.droppedFrames, 30);
  assert.equal(Number(slow.dropRatePercent.toFixed(2)), 3.33);
});

test('recent output drop metrics smooth transient ffmpeg counter jitter', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });

  manager.recordOutputMetric('out-jitter', { bitrateKbps: 6300, fps: 30, frame: 0, timeSec: 0, targetFps: 30 }, 0);
  manager.recordOutputMetric('out-jitter', { bitrateKbps: 6300, fps: 29, frame: 29, timeSec: 1, targetFps: 30 }, 1000);
  manager.recordOutputMetric('out-jitter', { bitrateKbps: 6300, fps: 30, frame: 60, timeSec: 2, targetFps: 30 }, 2000);

  const recent = manager.recentDropForOutput('out-jitter', { now: 2000, windowSec: 30 });

  assert.equal(recent.droppedFrames, 0);
  assert.equal(recent.dropRatePercent, 0);
  assert.equal(recent.frameDelta, 60);
  assert.equal(recent.expectedFrameDelta, 60);
});

test('recent output drop metrics ignore small sampling boundary drift on stable output', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });

  manager.recordOutputMetric('out-boundary-drift', { bitrateKbps: 6300, fps: 30, frame: 0, timeSec: 0, targetFps: 30 }, 0);
  manager.recordOutputMetric('out-boundary-drift', { bitrateKbps: 6300, fps: 30, frame: 900, timeSec: 30.18, targetFps: 30 }, 30_180);

  const recent = manager.recentDropForOutput('out-boundary-drift', { now: 30_180, windowSec: 30 });

  assert.equal(recent.droppedFrames, 0);
  assert.equal(recent.dropRatePercent, 0);
});

test('recent output drop metrics report measured fps for fractional output rates', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });

  manager.recordOutputMetric('out-5994', { bitrateKbps: 8320, fps: 60, frame: 0, timeSec: 0, targetFps: 59.94 }, 0);
  manager.recordOutputMetric('out-5994', { bitrateKbps: 8320, fps: 60, frame: 5994, timeSec: 100, targetFps: 59.94 }, 100_000);

  const recent = manager.recentDropForOutput('out-5994', { now: 100_000, windowSec: 120 });

  assert.equal(recent.droppedFrames, 0);
  assert.equal(Number(recent.measuredFps.toFixed(2)), 59.94);
});

test('output history stores measured fps for fractional chart points', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });

  manager.recordOutputMetric('out-5994', { bitrateKbps: 8320, fps: 60, frame: 0, timeSec: 0, targetFps: 59.94 }, 0);
  manager.recordOutputMetric('out-5994', { bitrateKbps: 8320, fps: 60, frame: 5994, timeSec: 100, targetFps: 59.94 }, 100_000);

  const latest = manager.historyForOutput('out-5994', { now: 100_000 }).at(-1);

  assert.equal(Number(Number(latest.measuredFps).toFixed(2)), 59.94);
});

test('recent output drop metrics report sustained output fps shortfall', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });

  manager.recordOutputMetric('out-slow', { bitrateKbps: 6300, fps: 30, frame: 0, timeSec: 0, targetFps: 30 }, 0);
  manager.recordOutputMetric('out-slow', { bitrateKbps: 6300, fps: 29, frame: 870, timeSec: 30, targetFps: 30 }, 30_000);

  const recent = manager.recentDropForOutput('out-slow', { now: 30_000, windowSec: 30 });

  assert.equal(recent.droppedFrames, 30);
  assert.equal(Number(recent.dropRatePercent.toFixed(2)), 3.33);
});

test('monitor exposes the selected time window for time-scaled charts', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  const monitor = manager.monitor({ now: 80_000, rangeSec: 480 });

  assert.deepEqual(monitor.range, {
    now: 80_000,
    from: -400_000,
    to: 80_000,
    rangeSec: 480,
  });
});

test('monitor filters one output and preserves an exact time period', () => {
  const manager = createManager({ settings: {}, rooms: [], sources: [], destinations: [], pipelines: [] });
  const makeOutput = id => ({
    id,
    role: 'output',
    destination: { id: id.split('-').at(-1), name: id },
    status: 'running',
    startedAt: 10_000,
    metrics: {},
    lastError: '',
  });
  manager.sessions.set('pipe-a', {
    pipelineId: 'pipe-a',
    name: 'PGM',
    mode: 'direct',
    status: 'running',
    source: { id: 'source-a', name: 'PGM source', type: 'url' },
    outputs: new Map([
      ['dest-a', makeOutput('pipe-a-dest-a')],
      ['dest-b', makeOutput('pipe-a-dest-b')],
    ]),
  });
  manager.recordOutputMetric('pipe-a-dest-a', { bitrateKbps: 1000, fps: 30 }, 20_000);
  manager.recordOutputMetric('pipe-a-dest-b', { bitrateKbps: 2000, fps: 30 }, 20_000);

  const monitor = manager.monitor({
    now: 40_000,
    from: 15_000,
    to: 25_000,
    outputId: 'pipe-a-dest-b',
  });

  assert.deepEqual(monitor.outputs.map(output => output.id), ['pipe-a-dest-b']);
  assert.deepEqual(monitor.outputs[0].history.map(point => point.time), [20_000]);
  assert.deepEqual(monitor.range, {
    now: 40_000,
    from: 15_000,
    to: 25_000,
    rangeSec: 10,
    exact: true,
  });
});

test('direct CPU reconciliation preserves the target FPS in replacement snapshots', async () => {
  const state = createEncodingModeState({ videoEncoder: 'libx264', mode: 'direct', fps: '30' });
  const scheduler = createManualScheduler();
  const manager = createManager(state, undefined, { ...scheduler, now: () => 5000 });
  const calls = [];
  manager.spawnFFmpeg = (role, id, args, logName, onMetric) => {
    const process = createStubProcess(role, id, args, logName);
    calls.push({ process, onMetric });
    return process;
  };

  manager.startPipeline('pipe-a');
  manager.reconcileDestination('dest-a');
  calls[1].onMetric({ bitrateKbps: 15_000, sizeBytes: 9_375_000, fps: 60, frame: 300, timeSec: 5 });
  await scheduler.scheduled[1].callback();

  const session = manager.sessions.get('pipe-a');
  const replacement = session.outputs.get('dest-a');
  const latest = manager.outputHistory.get('pipe-a-dest-a').at(-1);
  assert.equal(calls.length, 2);
  assert.equal(session.targetFps, 30);
  assert.equal(replacement.encodingMode, 'cpu');
  assert.equal(latest.encodingMode, 'cpu');
  assert.equal(latest.targetFps, 30);
});

test('direct mode reconciles a disabled destination without stopping other outputs', () => {
  const state = {
    settings: {},
    rooms: [],
    sources: [],
    destinations: [
      { id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://a/live', streamKey: 'a' },
      { id: 'dest-b', enabled: true, protocol: 'rtmp', server: 'rtmp://b/live', streamKey: 'b' },
    ],
    pipelines: [{
      id: 'pipe-direct',
      name: 'Direct',
      input: { type: 'url', url: 'rtmp://origin/live/main' },
      destinationIds: ['dest-a', 'dest-b'],
      mode: 'direct',
      settings: { live: { videoEncoder: 'libx264' } },
    }],
  };
  const manager = createManager(state);
  const stopped = [];
  manager.spawnFFmpeg = (role, id, args, logName) => ({
    role, id, args, logFile: logName, pid: 1, status: 'running', startedAt: Date.now(), metrics: {}, lastError: '',
    stop() { stopped.push(id); this.status = 'stopped'; },
  });

  manager.startPipeline('pipe-direct');
  state.destinations.find(item => item.id === 'dest-b').enabled = false;
  manager.reconcileDestination('dest-b');

  const session = manager.sessions.get('pipe-direct');
  assert.deepEqual(Array.from(session.outputs.keys()), ['dest-a']);
  assert.deepEqual(stopped, ['pipe-direct-dest-b']);
  assert.deepEqual(manager.monitor().outputs.filter(output => output.status !== 'disabled').map(output => output.id), ['pipe-direct-dest-a']);
});

test('shared-relay reconciliation changes only the selected worker and keeps the relay alive', () => {
  const state = {
    settings: {},
    rooms: [],
    sources: [],
    destinations: [
      { id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://a/live', streamKey: 'a' },
      { id: 'dest-b', enabled: true, protocol: 'rtmp', server: 'rtmp://b/live', streamKey: 'b' },
    ],
    pipelines: [{
      id: 'pipe-shared',
      name: 'Shared',
      input: { type: 'url', url: 'rtmp://origin/live/main' },
      destinationIds: ['dest-a', 'dest-b'],
      mode: 'shared-relay',
      settings: {},
    }],
  };
  const manager = createManager(state);
  const calls = [];
  manager.spawnFFmpeg = (role, id, args, logName) => {
    const process = {
      role, id, args, logFile: logName, pid: calls.length + 1, status: 'running', startedAt: Date.now(), metrics: {}, lastError: '', stopCalls: 0,
      stop() { this.stopCalls += 1; this.status = 'stopped'; },
    };
    calls.push(process);
    return process;
  };

  manager.startPipeline('pipe-shared');
  const session = manager.sessions.get('pipe-shared');
  const originalRelay = session.pipelineProcess;
  const originalDestA = session.outputs.get('dest-a');
  const originalDestB = session.outputs.get('dest-b');

  state.destinations.find(item => item.id === 'dest-b').enabled = false;
  manager.reconcileDestination('dest-b');

  assert.equal(calls.length, 3);
  assert.equal(session.pipelineProcess, originalRelay);
  assert.equal(session.outputs.get('dest-a'), originalDestA);
  assert.equal(session.outputs.has('dest-b'), false);
  assert.equal(originalRelay.stopCalls, 0);
  assert.equal(originalDestA.stopCalls, 0);
  assert.equal(originalDestB.stopCalls, 1);
  assert.deepEqual(manager.monitor().outputs.filter(output => output.status !== 'disabled').map(output => output.destination.id), ['dest-a']);

  state.destinations.find(item => item.id === 'dest-a').enabled = false;
  manager.reconcileDestination('dest-a');
  assert.equal(session.outputs.size, 0);
  assert.equal(manager.sessions.has('pipe-shared'), true);
  assert.equal(originalRelay.stopCalls, 0);

  state.destinations.find(item => item.id === 'dest-b').enabled = true;
  manager.reconcileDestination('dest-b');
  assert.equal(calls.length, 4);
  assert.equal(session.pipelineProcess, originalRelay);
  assert.equal(session.outputs.get('dest-b'), calls.at(-1));
  assert.equal(calls.at(-1).args.at(-1), 'rtmp://b/live/b');
});

test('disabling a room stops every pipeline that reads from that room', () => {
  const state = {
    settings: { rtmpPort: 1935 },
    rooms: [{ id: 'room-a', name: 'Room A', streamName: 'room-a', enabled: true }],
    sources: [],
    destinations: [{ id: 'dest-a', enabled: true, protocol: 'rtmp', server: 'rtmp://a/live', streamKey: 'a' }],
    pipelines: [{
      id: 'pipe-room',
      name: 'Room pipeline',
      input: { type: 'room', roomId: 'room-a' },
      destinationIds: ['dest-a'],
      mode: 'direct',
      settings: { live: { videoEncoder: 'libx264' } },
    }],
  };
  const manager = createManager(state);
  let stopCount = 0;
  manager.spawnFFmpeg = (role, id, args, logName) => ({ role, id, args, logFile: logName, pid: 1, status: 'running', startedAt: Date.now(), metrics: {}, lastError: '', stop() { stopCount += 1; } });
  manager.startPipeline('pipe-room');
  state.rooms[0].enabled = false;
  manager.reconcileRoom('room-a');

  assert.equal(stopCount, 1);
  assert.equal(manager.sessions.has('pipe-room'), false);
  assert.equal(state.pipelines[0].status, 'stopped');
});

test('monitor exposes configured disabled outputs without counting them as active', () => {
  const state = {
    settings: {},
    rooms: [],
    sources: [],
    destinations: [{ id: 'dest-off', name: 'Paused platform', enabled: false }],
    pipelines: [{
      id: 'pipe-off',
      name: 'Paused pipeline',
      input: { type: 'url', url: 'rtmp://origin/live/main' },
      destinationIds: ['dest-off'],
      status: 'stopped',
    }],
  };
  const manager = createManager(state);

  const monitor = manager.monitor();

  assert.equal(monitor.outputs.length, 1);
  assert.equal(monitor.outputs[0].id, 'pipe-off-dest-off');
  assert.equal(monitor.outputs[0].status, 'disabled');
  assert.equal(monitor.totals.outputs, 0);
  assert.equal(monitor.totals.disabledOutputs, 1);
});

test('monitor restores stopped output history from disk after a service restart', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-manager-restart-'));
  const now = Date.UTC(2026, 6, 24, 12, 0, 0);
  const state = {
    settings: {},
    rooms: [],
    sources: [],
    destinations: [{ id: 'dest-a', name: 'Platform A', enabled: true }],
    pipelines: [{
      id: 'pipe-a',
      name: 'PGM',
      input: { type: 'url', url: 'rtmp://origin/live/main' },
      destinationIds: ['dest-a'],
      status: 'stopped',
    }],
  };
  const firstManager = createManager(state, rootDir);
  firstManager.recordOutputMetric('pipe-a-dest-a', { bitrateKbps: 4200, fps: 30, targetFps: 30 }, now - 1000);

  const restartedManager = createManager(state, rootDir);
  const monitor = restartedManager.monitor({ now, rangeSec: 900, outputId: 'pipe-a-dest-a' });

  assert.equal(monitor.outputs.length, 1);
  assert.equal(monitor.outputs[0].status, 'stopped');
  assert.equal(monitor.outputs[0].bitrateKbps, null);
  assert.equal(monitor.outputs[0].actualBitrateAvailable, false);
  assert.deepEqual(monitor.outputs[0].history.map(point => point.reportedBitrateKbps), [4200]);
});

test('monitor exposes persisted cumulative drops for an inactive output', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-manager-inactive-drops-'));
  const now = Date.now();
  const state = {
    settings: {},
    rooms: [],
    sources: [],
    destinations: [{ id: 'dest-a', name: 'Platform A', enabled: true }],
    pipelines: [{
      id: 'pipe-a',
      name: 'PGM',
      input: { type: 'url', url: 'rtmp://origin/live/main' },
      destinationIds: ['dest-a'],
      status: 'stopped',
    }],
  };
  createManager(state, rootDir).recordOutputMetric('pipe-a-dest-a', {
    bitrateKbps: 15000,
    fps: 60,
    frame: 600,
    timeSec: 10,
    drop: 5,
  }, now - 1000);

  const monitor = createManager(state, rootDir).monitor({ now, rangeSec: 60 });
  const output = monitor.outputs[0];
  assert.equal(output.status, 'stopped');
  assert.equal(output.bitrateKbps, null);
  assert.equal(output.actualBitrateAvailable, false);
  assert.equal(output.fps, 0);
  assert.equal(output.totalDroppedFrames, 5);
  assert.equal(output.totalDropRatePercent > 0, true);
  assert.equal(output.droppedFrames, 0);
  assert.equal(output.dropRatePercent, 0);
});

test('monitor keeps a stopped output discoverable when its history is older than the selected range', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-manager-stopped-'));
  const now = Date.now();
  const state = {
    settings: {}, rooms: [], sources: [],
    destinations: [{ id: 'dest-a', name: 'Platform A', enabled: true }],
    pipelines: [{ id: 'pipe-a', name: 'PGM', destinationIds: ['dest-a'], status: 'stopped' }],
  };
  const manager = createManager(state, rootDir);
  manager.recordOutputMetric('pipe-a-dest-a', { bitrateKbps: 4200, fps: 30 }, now - 60 * 60 * 1000);

  const overview = createManager(state, rootDir).monitor({ now, rangeSec: 900 });
  const threeDays = createManager(state, rootDir).monitor({ now, rangeSec: 259200, outputId: 'pipe-a-dest-a' });

  assert.equal(overview.outputs.length, 1);
  assert.equal(overview.outputs[0].status, 'stopped');
  assert.deepEqual(overview.outputs[0].history, []);
  assert.deepEqual(threeDays.outputs[0].history.map(point => point.reportedBitrateKbps), [4200]);
});
