const dgram = require('node:dgram');
const net = require('node:net');
const {
  MpegTsSwitchGate,
  MpegTsVideoBoundaryTracker,
  DEFAULT_MAX_BUFFERED_BYTES: DEFAULT_SWITCH_BUFFER_BYTES,
} = require('./mpegTsSwitchGate');
const { MpegTsTimelineNormalizer } = require('./mpegTsTimeline');

const DEFAULT_MAX_BUFFERED_BYTES = 2 * 1024 ** 3;
const DEFAULT_MAX_TCP_OUTPUT_BACKLOG_BYTES = 1024 ** 2;
const RELEASE_GRANULARITY_MS = 5;
const SWITCH_COMMIT_TIMEOUT_MS = 5_000;
const INPUT_RATE_SAMPLE_MS = 2_000;
const SWITCH_PACING_MULTIPLIER = 1.5;
const SWITCH_PACING_INTERVAL_MS = 50;
const SWITCH_PACING_MIN_ACTIVE_MS = 1_000;
const SWITCH_PACING_MAX_ACTIVE_MS = 5_000;

class LiveDelayMemoryBudget {
  constructor(maxBytes = DEFAULT_MAX_BUFFERED_BYTES) {
    this.maxBytes = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BUFFERED_BYTES);
    this.usedBytes = 0;
  }

  reserve(bytes) {
    const amount = Math.max(0, Number(bytes) || 0);
    if (this.usedBytes + amount > this.maxBytes) return false;
    this.usedBytes += amount;
    return true;
  }

  release(bytes) {
    const amount = Math.max(0, Number(bytes) || 0);
    this.usedBytes = Math.max(0, this.usedBytes - amount);
  }

  describe() {
    return {
      maxBytes: this.maxBytes,
      usedBytes: this.usedBytes,
      availableBytes: Math.max(0, this.maxBytes - this.usedBytes),
    };
  }
}

class LiveDelayBuffer {
  constructor({
    delaySeconds,
    inputPort,
    outputPorts,
    udpOutputPorts = [],
    host = '127.0.0.1',
    maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
    maxTcpOutputBacklogBytes = DEFAULT_MAX_TCP_OUTPUT_BACKLOG_BYTES,
    memoryBudget = null,
    inputTransport = 'udp',
    outputTransport = 'udp',
    packetizeMpegTs = false,
    socketFactory = () => dgram.createSocket('udp4'),
    serverFactory = () => net.createServer(),
    scheduleTimer = setTimeout,
    clearTimer = clearTimeout,
    now = Date.now,
    onOverflow = null,
    onError = null,
    onReady = null,
    switchGateFactory = options => new MpegTsSwitchGate(options),
    timelineFactory = () => new MpegTsTimelineNormalizer(),
  } = {}) {
    this.delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
    this.inputPort = Number(inputPort);
    this.outputPorts = Array.from(new Set((outputPorts || []).map(Number).filter(Number.isInteger)));
    this.udpOutputPorts = Array.from(new Set((udpOutputPorts || []).map(Number).filter(Number.isInteger)));
    this.host = host;
    this.maxBufferedBytes = Math.max(1, Number(maxBufferedBytes) || DEFAULT_MAX_BUFFERED_BYTES);
    this.maxTcpOutputBacklogBytes = Math.max(
      1,
      Number(maxTcpOutputBacklogBytes) || DEFAULT_MAX_TCP_OUTPUT_BACKLOG_BYTES,
    );
    this.memoryBudget = memoryBudget || new LiveDelayMemoryBudget(this.maxBufferedBytes);
    this.inputTransport = inputTransport === 'tcp-server' ? 'tcp-server' : 'udp';
    this.outputTransport = outputTransport === 'tcp-server' ? 'tcp-server' : 'udp';
    this.packetizeMpegTs = packetizeMpegTs === true;
    this.socketFactory = socketFactory;
    this.serverFactory = serverFactory;
    this.scheduleTimer = scheduleTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.onOverflow = onOverflow;
    this.onError = onError;
    this.onReady = onReady;
    this.switchGateFactory = switchGateFactory;
    this.timeline = this.packetizeMpegTs ? timelineFactory() : null;
    this.queue = [];
    this.residentEntries = new Set();
    this.head = 0;
    this.bufferedBytes = 0;
    this.pendingSends = 0;
    this.flushing = false;
    this.accepting = false;
    this.status = 'idle';
    this.timer = null;
    this.inputSocket = null;
    this.inputServer = null;
    this.inputClient = null;
    this.inputTransition = null;
    this.inputPacketPending = Buffer.alloc(0);
    this.inputBoundaryTracker = this.packetizeMpegTs ? new MpegTsVideoBoundaryTracker() : null;
    this.activeInputHasMedia = false;
    this.inputRateSampleStartedAt = null;
    this.inputRateSampleBytes = 0;
    this.inputBytesPerMs = 0;
    this.inputPacer = null;
    this.inputListening = false;
    this.outputSocket = null;
    this.udpMirrorPending = Buffer.alloc(0);
    this.outputServers = new Map();
    this.outputClients = new Map();
    this.listeningOutputPorts = new Set();
    this.blockedOutputPorts = new Set();
    this.pendingTcpWrites = new Map();
    this.droppedOutputBytes = new Map(this.outputPorts.map(port => [port, 0]));
    this.transientResetErrors = 0;
    this.readyReported = false;
    this.finishingDrain = false;
    this.drainPromise = null;
    this.resolveDrain = null;
    this.failureReported = false;
    this.shutdownPromise = null;
  }

  start() {
    if (this.status !== 'idle') return this;
    if (!Number.isInteger(this.inputPort) || this.inputPort < 1 || this.inputPort > 65535) {
      throw new Error('直播延时输入端口无效');
    }
    if (!this.outputPorts.length && !this.udpOutputPorts.length) throw new Error('直播延时没有可用的输出端口');

    this.accepting = true;
    this.status = 'buffering';
    if (this.inputTransport === 'tcp-server') this.startTcpInputServer();
    else this.startUdpInput();
    if (this.outputTransport === 'tcp-server') {
      if (this.udpOutputPorts.length) this.startUdpMirrorOutput();
      this.startTcpServers();
    } else {
      this.outputSocket = this.socketFactory('output');
      this.outputSocket.on('error', error => this.fail(error));
      this.reportReady();
    }
    return this;
  }

  startUdpMirrorOutput() {
    const socket = this.socketFactory('output');
    this.outputSocket = socket;
    socket.on('error', error => this.handleUdpMirrorError(socket, error));
    return socket;
  }

  handleUdpMirrorError(socket, error) {
    if (this.outputSocket !== socket) return;
    if (this.delayMs > 0 || this.outputTransport !== 'tcp-server') {
      this.fail(error);
      return;
    }
    this.outputSocket = null;
    try { socket.close(); } catch {}
    if (!this.accepting || ['error', 'stopped'].includes(this.status)) return;
    this.startUdpMirrorOutput();
  }

  startUdpInput() {
    this.inputSocket = this.socketFactory('input');
    this.inputSocket.on('message', packet => this.enqueue(packet));
    this.inputSocket.on('error', error => this.fail(error));
    this.inputSocket.bind(this.inputPort, this.host);
  }

  startTcpInputServer() {
    const server = this.serverFactory('input', this.inputPort);
    server.on('connection', socket => this.attachTcpInputClient(socket));
    server.on('error', error => this.fail(error));
    server.on('listening', () => {
      this.inputListening = true;
      this.reportReady();
    });
    this.inputServer = server;
    server.listen(this.inputPort, this.host);
  }

  attachTcpInputClient(socket) {
    if (!socket || ['error', 'stopped'].includes(this.status)) {
      if (socket && typeof socket.destroy === 'function') socket.destroy();
      return;
    }
    const existing = this.inputClient;
    if (!existing && this.inputTransition && !this.inputTransition.socket) {
      this.attachTcpInputCandidate(socket, this.inputTransition);
      return;
    }
    if (existing && existing !== socket && !existing.destroyed) {
      if (this.inputTransition && !this.inputTransition.socket) {
        this.attachTcpInputCandidate(socket, this.inputTransition);
      } else if (typeof socket.destroy === 'function') socket.destroy();
      return;
    }
    this.inputClient = socket;
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    socket.on('data', chunk => {
      if (this.inputClient === socket) this.enqueueInputData(Buffer.from(chunk));
    });
    socket.on('error', () => {
      // Source processes are intentionally replaced during scene switches.
      // Keep the bridge alive so the next source can reconnect cleanly.
      this.handleActiveInputDisconnect(socket);
    });
    socket.on('close', () => {
      this.handleActiveInputDisconnect(socket);
    });
  }

  handleActiveInputDisconnect(socket) {
    if (this.inputClient !== socket) return false;
    this.inputClient = null;
    const transition = this.inputTransition;
    if (transition && transition.state === 'commit-pending' && transition.gate.ready) {
      this.finishInputSwitch(transition);
    }
    return true;
  }

  attachTcpInputCandidate(socket, transition) {
    if (!transition || this.inputTransition !== transition || transition.socket) {
      if (typeof socket.destroy === 'function') socket.destroy();
      return;
    }
    transition.socket = socket;
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    socket.on('data', chunk => {
      if (this.inputClient === socket) {
        this.enqueueInputData(Buffer.from(chunk));
        return;
      }
      if (this.inputTransition !== transition || transition.socket !== socket) return;
      try {
        const candidateData = Buffer.from(chunk);
        if (['commit-wait-candidate', 'commit-pending'].includes(transition.state)) {
          transition.commitCandidateBytes += candidateData.length;
        }
        transition.gate.push(candidateData);
        if (transition.state === 'armed' && transition.gate.ready && !transition.readySettled) {
          transition.readySettled = true;
          transition.state = 'ready';
          transition.resolveReady();
        } else if (transition.state === 'commit-wait-candidate' && transition.gate.ready) {
          transition.commitCandidateReadyAt = Number(this.now());
          transition.state = 'commit-pending';
          if (!this.inputClient || !this.activeInputHasMedia) this.finishInputSwitch(transition);
        }
      } catch (error) {
        this.failInputSwitch(transition, error);
      }
    });
    socket.on('error', error => {
      if (this.inputClient === socket) {
        this.handleActiveInputDisconnect(socket);
        return;
      }
      this.failInputSwitch(transition, error);
    });
    socket.on('close', () => {
      if (this.inputClient === socket) {
        this.handleActiveInputDisconnect(socket);
        return;
      }
      if (this.inputTransition === transition && transition.socket === socket) {
        this.failInputSwitch(transition, new Error('候选节目在切换前已断开'));
      }
    });
  }

  beginInputSwitch({ timeoutMs = 12_000, maxBufferedBytes = DEFAULT_SWITCH_BUFFER_BYTES } = {}) {
    if (this.inputTransport !== 'tcp-server' || !this.inputServer || ['error', 'stopped'].includes(this.status)) {
      throw new Error('节目切换需要正在运行的 TCP 中继输入');
    }
    if (this.inputTransition) throw new Error('已有候选节目正在预热');
    let resolveReady;
    let rejectReady;
    const normalizedMaxBufferedBytes = Math.max(188 * 3, Number(maxBufferedBytes) || DEFAULT_SWITCH_BUFFER_BYTES);
    const transition = {
      state: 'armed',
      socket: null,
      maxBufferedBytes: normalizedMaxBufferedBytes,
      gate: this.switchGateFactory({ maxBufferedBytes: normalizedMaxBufferedBytes }),
      readySettled: false,
      ready: new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      }),
      resolveReady: () => resolveReady({ status: 'ready' }),
      rejectReady,
      commitPromise: null,
      resolveCommit: null,
      rejectCommit: null,
      commitSettled: false,
      commitCandidateStartedAt: 0,
      commitCandidateReadyAt: 0,
      commitCandidateBytes: 0,
      timer: null,
    };
    this.inputTransition = transition;
    const timeout = Math.max(1, Number(timeoutMs) || 12_000);
    transition.timer = this.scheduleTimer(() => {
      this.failInputSwitch(transition, new Error(`候选节目在 ${timeout} 毫秒内未到达可切换的音视频边界`));
    }, timeout);
    if (transition.timer && typeof transition.timer.unref === 'function') transition.timer.unref();

    return {
      ready: transition.ready,
      commit: options => this.commitInputSwitch(transition, options),
      abort: reason => this.abortInputSwitch(transition, reason),
    };
  }

  clearInputSwitchTimer(transition) {
    if (!transition || !transition.timer) return;
    this.clearTimer(transition.timer);
    transition.timer = null;
  }

  failInputSwitch(transition, error) {
    if (!transition || this.inputTransition !== transition) return false;
    this.clearInputSwitchTimer(transition);
    this.inputTransition = null;
    transition.state = 'failed';
    const candidate = transition.socket;
    transition.socket = null;
    if (candidate && candidate !== this.inputClient && typeof candidate.destroy === 'function') {
      try { candidate.destroy(); } catch {}
    }
    if (!transition.readySettled) {
      transition.readySettled = true;
      transition.rejectReady(error instanceof Error ? error : new Error(String(error || '候选节目预热失败')));
    }
    if (!transition.commitSettled && transition.rejectCommit) {
      transition.commitSettled = true;
      transition.rejectCommit(error instanceof Error ? error : new Error(String(error || '候选节目切换失败')));
    }
    return true;
  }

  abortInputSwitch(transition = this.inputTransition, reason = null) {
    if (!transition || this.inputTransition !== transition) return false;
    this.clearInputSwitchTimer(transition);
    this.inputTransition = null;
    transition.state = 'aborted';
    const candidate = transition.socket;
    transition.socket = null;
    if (candidate && candidate !== this.inputClient && typeof candidate.destroy === 'function') {
      try { candidate.destroy(); } catch {}
    }
    if (!transition.readySettled) {
      transition.readySettled = true;
      transition.rejectReady(reason instanceof Error ? reason : new Error(String(reason || '候选节目切换已取消')));
    }
    if (!transition.commitSettled && transition.rejectCommit) {
      transition.commitSettled = true;
      transition.rejectCommit(reason instanceof Error ? reason : new Error(String(reason || '候选节目切换已取消')));
    }
    return true;
  }

  commitInputSwitch(transition, { discardActive = false } = {}) {
    if (!transition || this.inputTransition !== transition || transition.state !== 'ready' || !transition.socket) {
      throw new Error('候选节目尚未准备完成，无法提交切换');
    }
    if (!this.packetizeMpegTs || discardActive) {
      this.finishInputSwitch(transition);
      return Promise.resolve({ status: 'committed' });
    }
    if (!this.inputClient || !this.activeInputHasMedia) {
      this.finishInputSwitch(transition);
      return Promise.resolve({ status: 'committed' });
    }
    this.clearInputSwitchTimer(transition);
    transition.gate = this.switchGateFactory({ maxBufferedBytes: transition.maxBufferedBytes });
    transition.commitCandidateStartedAt = Number(this.now());
    transition.commitCandidateReadyAt = 0;
    transition.commitCandidateBytes = 0;
    transition.state = 'commit-wait-candidate';
    transition.commitPromise = new Promise((resolve, reject) => {
      transition.resolveCommit = resolve;
      transition.rejectCommit = reject;
    });
    transition.timer = this.scheduleTimer(() => {
      this.failInputSwitch(transition, new Error('等待候选节目新鲜音视频边界或当前节目安全边界超时，已取消切换'));
    }, SWITCH_COMMIT_TIMEOUT_MS);
    if (transition.timer && typeof transition.timer.unref === 'function') transition.timer.unref();
    return transition.commitPromise;
  }

  finishInputSwitch(transition) {
    if (
      !transition
      || this.inputTransition !== transition
      || !['ready', 'commit-pending'].includes(transition.state)
      || !transition.socket
    ) return false;
    this.clearInputSwitchTimer(transition);
    const previous = this.inputClient;
    const candidate = transition.socket;
    const paceCandidate = transition.state === 'commit-pending';
    const cleanPrefix = transition.gate.takeCleanBuffer();
    this.inputTransition = null;
    transition.state = 'committed';
    transition.socket = null;
    this.inputPacketPending = Buffer.alloc(0);
    this.activeInputHasMedia = false;
    if (this.packetizeMpegTs) this.inputBoundaryTracker = new MpegTsVideoBoundaryTracker();
    if (paceCandidate && cleanPrefix.length) this.startInputPacing(transition, cleanPrefix.length);
    if (cleanPrefix.length) this.enqueueInputData(cleanPrefix, 'candidate');
    this.inputClient = candidate;
    if (previous && previous !== candidate && typeof previous.destroy === 'function') {
      try { previous.destroy(); } catch {}
    }
    if (!transition.commitSettled && transition.resolveCommit) {
      transition.commitSettled = true;
      transition.resolveCommit({ status: 'committed' });
    }
    return true;
  }

  enqueueInputData(data, timelineMode = 'active') {
    if (timelineMode === 'active') this.observeInputRate(data.length);
    if (!this.packetizeMpegTs) {
      this.sendUdpMirrorData(data);
      return this.enqueue(data);
    }
    const combined = this.inputPacketPending.length
      ? Buffer.concat([this.inputPacketPending, data])
      : Buffer.from(data);
    let start = 0;
    if (combined.length && combined[0] !== 0x47) {
      start = combined.indexOf(0x47);
      if (start < 0) {
        this.inputPacketPending = combined.subarray(Math.max(0, combined.length - 187));
        return false;
      }
    }
    const available = combined.length - start;
    const alignedBytes = available - (available % 188);
    if (alignedBytes <= 0) {
      this.inputPacketPending = Buffer.from(combined.subarray(start));
      return false;
    }
    let aligned = Buffer.from(combined.subarray(start, start + alignedBytes));
    this.inputPacketPending = Buffer.from(combined.subarray(start + alignedBytes));
    const transition = timelineMode === 'active' ? this.inputTransition : null;
    if (transition && transition.state === 'commit-pending' && this.inputBoundaryTracker) {
      const boundary = this.inputBoundaryTracker.nextVideoPesStart(aligned);
      if (boundary >= 0) {
        const activePrefix = aligned.subarray(0, boundary);
        this.inputPacketPending = Buffer.alloc(0);
        if (activePrefix.length) this.enqueueAlignedInput(activePrefix, timelineMode);
        this.finishInputSwitch(transition);
        return true;
      }
    }
    return this.enqueueAlignedInput(aligned, timelineMode);
  }

  enqueueAlignedInput(aligned, timelineMode) {
    if (aligned.length) this.activeInputHasMedia = true;
    if (this.inputBoundaryTracker) this.inputBoundaryTracker.observe(aligned);
    if (this.timeline) {
      aligned = timelineMode === 'candidate'
        ? this.timeline.normalizeCandidate(aligned)
        : this.timeline.normalizeActive(aligned);
    }
    if (this.inputPacer) return this.enqueuePacedInput(aligned);
    this.sendUdpMirrorData(aligned);
    return this.enqueue(aligned);
  }

  observeInputRate(byteLength) {
    const bytes = Math.max(0, Number(byteLength) || 0);
    if (!bytes) return;
    const now = Number(this.now());
    if (!Number.isFinite(now)) return;
    if (!Number.isFinite(this.inputRateSampleStartedAt)) {
      this.inputRateSampleStartedAt = now;
      this.inputRateSampleBytes = bytes;
      return;
    }
    if (now < this.inputRateSampleStartedAt) {
      this.inputRateSampleStartedAt = now;
      this.inputRateSampleBytes = bytes;
      return;
    }
    this.inputRateSampleBytes += bytes;
    const elapsedMs = now - this.inputRateSampleStartedAt;
    if (elapsedMs < INPUT_RATE_SAMPLE_MS) return;
    const sampledBytesPerMs = this.inputRateSampleBytes / Math.max(1, elapsedMs);
    this.inputBytesPerMs = this.inputBytesPerMs > 0
      ? (this.inputBytesPerMs * 0.8) + (sampledBytesPerMs * 0.2)
      : sampledBytesPerMs;
    this.inputRateSampleStartedAt = now;
    this.inputRateSampleBytes = 0;
  }

  startInputPacing(transition, cleanPrefixBytes) {
    const now = Number(this.now());
    const candidateElapsedMs = Math.max(
      1,
      now - (Number(transition.commitCandidateStartedAt) || now),
    );
    const candidateBytesPerMs = Math.max(0, Number(transition.commitCandidateBytes) || 0) / candidateElapsedMs;
    const sourceBytesPerMs = this.inputBytesPerMs > 0 && candidateBytesPerMs > 0
      ? Math.min(this.inputBytesPerMs, candidateBytesPerMs)
      : Math.max(this.inputBytesPerMs, candidateBytesPerMs);
    const bytesPerMs = Math.max(1, sourceBytesPerMs * SWITCH_PACING_MULTIPLIER);
    const chunkBytes = Math.max(
      188,
      Math.floor((bytesPerMs * SWITCH_PACING_INTERVAL_MS) / 188) * 188,
    );
    const catchUpBytesPerMs = Math.max(1, bytesPerMs - sourceBytesPerMs);
    const minimumActiveMs = Math.min(
      SWITCH_PACING_MAX_ACTIVE_MS,
      Math.max(SWITCH_PACING_MIN_ACTIVE_MS, Number(cleanPrefixBytes) / catchUpBytesPerMs),
    );
    const queuedTail = this.queue.length ? Number(this.queue[this.queue.length - 1].releaseAt) || 0 : 0;
    this.inputPacer = {
      bytesPerMs,
      chunkBytes,
      nextReleaseAt: Math.max(now + this.delayMs, queuedTail),
      minimumActiveUntil: now + minimumActiveMs,
      pendingEntries: 0,
      started: false,
    };
  }

  enqueuePacedInput(aligned) {
    const pacer = this.inputPacer;
    if (!pacer || !aligned.length) return false;
    const now = Number(this.now());
    const immediateReleaseAt = now + this.delayMs;
    if (
      pacer.started
      && now >= pacer.minimumActiveUntil
      && pacer.pendingEntries === 0
      && pacer.nextReleaseAt <= immediateReleaseAt
    ) {
      this.inputPacer = null;
      this.sendUdpMirrorData(aligned);
      return this.enqueue(aligned);
    }
    let enqueued = false;
    for (let offset = 0; offset < aligned.length; offset += pacer.chunkBytes) {
      const chunk = aligned.subarray(offset, Math.min(aligned.length, offset + pacer.chunkBytes));
      const releaseAt = Math.max(pacer.nextReleaseAt, immediateReleaseAt);
      if (!this.enqueueAt(chunk, releaseAt, { mirror: true, pacer })) return false;
      pacer.started = true;
      pacer.nextReleaseAt = releaseAt + (chunk.length / pacer.bytesPerMs);
      enqueued = true;
    }
    return enqueued;
  }

  sendUdpMirrorData(data) {
    if (!this.outputSocket || !this.udpOutputPorts.length) return;
    for (const packet of this.packetizeUdpMirrorData(data)) {
      for (const port of this.udpOutputPorts) this.sendPacket(packet, port);
    }
  }

  startTcpServers() {
    for (const port of this.outputPorts) {
      const server = this.serverFactory('output', port);
      server.on('connection', socket => this.attachTcpClient(port, socket));
      server.on('error', error => this.fail(error));
      server.on('listening', () => this.markTcpServerReady(port));
      this.outputServers.set(port, server);
      server.listen(port, this.host);
    }
  }

  markTcpServerReady(port) {
    this.listeningOutputPorts.add(port);
    this.reportReady();
  }

  listenersReady() {
    const inputReady = this.inputTransport !== 'tcp-server' || this.inputListening;
    const outputsReady = this.outputTransport !== 'tcp-server'
      || this.listeningOutputPorts.size === this.outputPorts.length;
    return inputReady && outputsReady;
  }

  reportReady() {
    if (this.readyReported || !this.listenersReady() || ['error', 'stopped'].includes(this.status)) return;
    this.readyReported = true;
    if (!this.onReady) return;
    try { this.onReady(); } catch (error) { this.fail(error); }
  }

  attachTcpClient(port, socket) {
    if (!socket || ['error', 'stopped'].includes(this.status)) {
      if (socket && typeof socket.destroy === 'function') socket.destroy();
      return;
    }
    const existing = this.outputClients.get(port);
    if (existing && existing !== socket && !existing.destroyed) {
      if (typeof socket.destroy === 'function') socket.destroy();
      return;
    }
    this.outputClients.set(port, socket);
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    socket.on('error', error => this.handleTcpOutputError(port, socket, error));
    socket.on('close', () => {
      this.cancelTcpWritesForSocket(socket);
      if (this.outputClients.get(port) === socket) this.outputClients.delete(port);
      this.blockedOutputPorts.delete(port);
      if (
        this.delayMs > 0
        && (this.status === 'buffering' || (this.status === 'draining' && !this.finishingDrain))
      ) {
        this.fail(new Error(`直播延时 TCP 输出端口 ${port} 已断开`));
      }
    });
    this.flushDue();
  }

  handleTcpOutputError(port, socket, error) {
    this.cancelTcpWritesForSocket(socket);
    if (this.delayMs > 0) {
      this.fail(error);
      return;
    }
    if (this.outputClients.get(port) === socket) this.outputClients.delete(port);
    this.blockedOutputPorts.delete(port);
    if (socket && !socket.destroyed && typeof socket.destroy === 'function') {
      try { socket.destroy(); } catch {}
    }
  }

  outputsReady() {
    if (this.outputTransport !== 'tcp-server') return Boolean(this.outputSocket);
    if (this.delayMs === 0) return true;
    return this.outputPorts.every(port => {
      const socket = this.outputClients.get(port);
      return Boolean(socket && !socket.destroyed && !this.blockedOutputPorts.has(port));
    });
  }

  enqueue(packet) {
    return this.enqueueAt(packet, Number(this.now()) + this.delayMs);
  }

  enqueueAt(packet, releaseAt, { mirror = false, pacer = null } = {}) {
    if (!this.accepting || !Buffer.isBuffer(packet)) return false;
    const data = Buffer.from(packet);
    if (
      this.bufferedBytes + data.length > this.maxBufferedBytes
      || !this.memoryBudget.reserve(data.length)
    ) {
      const error = new Error(`直播延时缓冲已超过内存保护上限 ${this.maxBufferedBytes} 字节`);
      this.stopImmediately('error');
      if (this.onOverflow) this.onOverflow(error);
      return false;
    }
    const entry = {
      releaseAt: Number.isFinite(Number(releaseAt)) ? Number(releaseAt) : Number(this.now()) + this.delayMs,
      data,
      state: 'queued',
      mirror,
      pacer,
    };
    if (pacer) pacer.pendingEntries += 1;
    this.queue.push(entry);
    this.residentEntries.add(entry);
    this.bufferedBytes += data.length;
    this.scheduleRelease();
    return true;
  }

  scheduleRelease() {
    if (this.timer || this.head >= this.queue.length) return;
    const waitMs = Math.max(
      RELEASE_GRANULARITY_MS,
      Math.ceil(this.queue[this.head].releaseAt - Number(this.now())),
    );
    this.timer = this.scheduleTimer(() => {
      this.timer = null;
      this.flushDue();
    }, waitMs);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  flushDue() {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const now = Number(this.now());
    let released = 0;
    this.flushing = true;
    try {
      while (this.head < this.queue.length && this.queue[this.head].releaseAt <= now) {
        if (!this.outputsReady()) break;
        const entry = this.queue[this.head];
        this.head += 1;
        released += 1;
        this.sendEntry(entry);
      }
    } finally {
      this.flushing = false;
    }

    if (this.head >= this.queue.length) {
      this.queue = [];
      this.head = 0;
      this.finishDrainIfReady();
    } else {
      if (this.head >= 4096) {
        this.queue = this.queue.slice(this.head);
        this.head = 0;
      }
      if (this.outputsReady()) this.scheduleRelease();
    }
    return released;
  }

  sendEntry(entry) {
    entry.state = 'in-flight';
    if (entry.mirror) this.sendUdpMirrorData(entry.data);
    if (this.outputTransport === 'tcp-server') {
      this.sendTcpEntry(entry);
      return;
    }
    if (!this.outputSocket || !this.outputPorts.length) {
      this.releaseEntry(entry);
      return;
    }
    let remaining = this.outputPorts.length;
    const complete = error => {
      remaining -= 1;
      if (error) this.fail(error);
      if (remaining === 0) this.releaseEntry(entry);
    };
    for (const port of this.outputPorts) this.sendPacket(entry.data, port, complete);
  }

  registerTcpWrite(socket, entry) {
    const record = { socket, entry, completed: false };
    let records = this.pendingTcpWrites.get(socket);
    if (!records) {
      records = new Set();
      this.pendingTcpWrites.set(socket, records);
    }
    records.add(record);
    if (!entry.pendingTcpWrites) entry.pendingTcpWrites = new Set();
    entry.pendingTcpWrites.add(record);
    return record;
  }

  unregisterTcpWrite(record) {
    if (!record) return;
    const records = this.pendingTcpWrites.get(record.socket);
    if (records) {
      records.delete(record);
      if (!records.size) this.pendingTcpWrites.delete(record.socket);
    }
    if (record.entry && record.entry.pendingTcpWrites) {
      record.entry.pendingTcpWrites.delete(record);
    }
  }

  completeTcpWrite(record, error, onComplete) {
    if (!record || record.completed) return false;
    record.completed = true;
    this.unregisterTcpWrite(record);
    this.pendingSends = Math.max(0, this.pendingSends - 1);
    try {
      if (onComplete) onComplete(error);
    } finally {
      if (!record.entry.pendingTcpWrites || !record.entry.pendingTcpWrites.size) {
        this.releaseEntry(record.entry);
      }
      this.finishDrainIfReady();
    }
    return true;
  }

  cancelTcpWritesForSocket(socket) {
    const records = this.pendingTcpWrites.get(socket);
    if (!records || !records.size) return;
    for (const record of Array.from(records)) {
      if (record.completed) continue;
      record.completed = true;
      this.unregisterTcpWrite(record);
      this.pendingSends = Math.max(0, this.pendingSends - 1);
      if (!record.entry.pendingTcpWrites || !record.entry.pendingTcpWrites.size) {
        this.releaseEntry(record.entry);
      }
    }
    this.finishDrainIfReady();
  }

  cancelAllTcpWrites() {
    for (const socket of Array.from(this.pendingTcpWrites.keys())) {
      this.cancelTcpWritesForSocket(socket);
    }
  }

  sendTcpEntry(entry) {
    const clients = [];
    for (const port of this.outputPorts) {
      const socket = this.outputClients.get(port);
      if (socket && (this.delayMs > 0 || !this.blockedOutputPorts.has(port))) {
        clients.push({ port, socket });
      } else if (this.delayMs === 0) {
        this.recordDroppedOutputBytes(port, entry.data.length);
      }
    }
    if (this.delayMs > 0 && clients.length !== this.outputPorts.length) {
      entry.state = 'queued';
      return;
    }
    if (!clients.length) {
      this.releaseEntry(entry);
      return;
    }
    let remaining = clients.length;
    const complete = (port, socket, error) => {
      remaining -= 1;
      if (error) this.handleTcpOutputError(port, socket, error);
      if (remaining === 0) this.releaseEntry(entry);
    };
    for (const { port, socket } of clients) {
      this.writeTcpPacket(port, socket, entry.data, error => complete(port, socket, error), entry);
    }
  }

  recordDroppedOutputBytes(port, bytes) {
    const outputPort = Number(port);
    if (!this.droppedOutputBytes.has(outputPort)) return;
    const amount = Math.max(0, Number(bytes) || 0);
    this.droppedOutputBytes.set(outputPort, this.droppedOutputBytes.get(outputPort) + amount);
  }

  droppedBytesForOutput(port) {
    return this.droppedOutputBytes.get(Number(port)) || 0;
  }

  packetizeUdpMirrorData(data) {
    const combined = this.udpMirrorPending.length
      ? Buffer.concat([this.udpMirrorPending, data])
      : Buffer.from(data);
    const alignedBytes = combined.length - (combined.length % 188);
    if (alignedBytes <= 0) {
      this.udpMirrorPending = combined;
      return [];
    }
    const packets = [];
    for (let offset = 0; offset < alignedBytes; offset += 1316) {
      packets.push(Buffer.from(combined.subarray(offset, Math.min(alignedBytes, offset + 1316))));
    }
    this.udpMirrorPending = Buffer.from(combined.subarray(alignedBytes));
    return packets;
  }

  writeTcpPacket(port, socket, packet, onComplete, entry = null) {
    const record = entry ? this.registerTcpWrite(socket, entry) : null;
    this.pendingSends += 1;
    let completed = false;
    const complete = error => {
      if (record) {
        this.completeTcpWrite(record, error, onComplete);
        return;
      }
      if (completed) return;
      completed = true;
      this.pendingSends = Math.max(0, this.pendingSends - 1);
      onComplete(error);
      this.finishDrainIfReady();
    };
    try {
      const accepted = socket.write(packet, complete);
      if (!accepted && (this.delayMs > 0 || this.tcpOutputBacklogExceeded(socket))) {
        this.blockTcpOutput(port, socket);
      }
    } catch (error) {
      complete(error);
    }
  }

  tcpOutputBacklogExceeded(socket) {
    const writableLength = Number(socket && socket.writableLength);
    if (!Number.isFinite(writableLength) || writableLength < 0) return true;
    return writableLength >= this.maxTcpOutputBacklogBytes;
  }

  blockTcpOutput(port, socket) {
    if (this.blockedOutputPorts.has(port)) return;
    this.blockedOutputPorts.add(port);
    socket.once('drain', () => {
      if (this.outputClients.get(port) !== socket) return;
      this.blockedOutputPorts.delete(port);
      this.flushDue();
    });
  }

  sendPacket(packet, port, onComplete) {
    if (!this.outputSocket) return false;
    this.pendingSends += 1;
    let completed = false;
    const complete = error => {
      if (completed) return;
      completed = true;
      this.pendingSends = Math.max(0, this.pendingSends - 1);
      if (onComplete) onComplete(error);
      this.finishDrainIfReady();
    };
    try {
      this.outputSocket.send(packet, port, this.host, complete);
    } catch (error) {
      complete(error);
    }
    return true;
  }

  releaseEntry(entry) {
    if (!this.residentEntries.delete(entry)) return;
    this.bufferedBytes = Math.max(0, this.bufferedBytes - entry.data.length);
    this.memoryBudget.release(entry.data.length);
    if (entry.pacer) entry.pacer.pendingEntries = Math.max(0, entry.pacer.pendingEntries - 1);
    this.finishDrainIfReady();
  }

  finishDrainIfReady() {
    if (
      this.status === 'draining'
      && !this.flushing
      && this.head >= this.queue.length
      && this.residentEntries.size === 0
      && this.pendingSends === 0
    ) {
      this.finishDrain();
    }
  }

  beginDrain() {
    if (this.status === 'stopped') return Promise.resolve({ status: 'stopped' });
    if (this.status === 'error') return Promise.resolve({ status: 'error' });
    if (this.drainPromise) return this.drainPromise;
    this.accepting = false;
    this.status = 'draining';
    this.abortInputSwitch(this.inputTransition, new Error('直播任务正在停止'));
    this.closeSocket(this.inputSocket);
    this.inputSocket = null;
    this.closeTcpInput(true);
    this.drainPromise = new Promise(resolve => { this.resolveDrain = resolve; });
    if (this.head >= this.queue.length) this.finishDrainIfReady();
    else this.scheduleRelease();
    return this.drainPromise;
  }

  discard() {
    if (this.status === 'error' || this.status === 'stopped') {
      const result = { status: this.status };
      return this.shutdownPromise ? this.shutdownPromise.then(() => result) : Promise.resolve(result);
    }
    this.stopImmediately('stopped');
    return this.shutdownPromise.then(() => ({ status: 'stopped' }));
  }

  finishDrain() {
    if (
      this.status !== 'draining'
      || this.residentEntries.size > 0
      || this.pendingSends > 0
      || this.finishingDrain
    ) return;
    if (this.outputTransport === 'tcp-server') {
      this.finishTcpDrain();
      return;
    }
    this.closeSocket(this.outputSocket);
    this.outputSocket = null;
    this.completeDrain();
  }

  finishTcpDrain() {
    const clients = this.outputPorts.map(port => this.outputClients.get(port)).filter(Boolean);
    if (clients.length !== this.outputPorts.length) {
      this.fail(new Error('直播延时 TCP 输出未全部连接'));
      return;
    }
    this.finishingDrain = true;
    let remaining = clients.length;
    const complete = () => {
      remaining -= 1;
      if (remaining === 0) this.completeDrain();
    };
    for (const socket of clients) {
      try { socket.end(complete); } catch (error) { this.fail(error); }
    }
  }

  completeDrain() {
    if (this.status !== 'draining') return;
    this.closeSocket(this.outputSocket);
    this.outputSocket = null;
    this.closeTcpOutputs(false);
    this.status = 'stopped';
    if (this.resolveDrain) this.resolveDrain({ status: 'stopped' });
    this.resolveDrain = null;
  }

  stopImmediately(status) {
    this.accepting = false;
    this.status = status;
    this.abortInputSwitch(this.inputTransition, new Error('直播中继已停止'));
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.queue = [];
    this.udpMirrorPending = Buffer.alloc(0);
    this.inputPacketPending = Buffer.alloc(0);
    this.inputPacer = null;
    this.head = 0;
    this.cancelAllTcpWrites();
    for (const entry of Array.from(this.residentEntries)) {
      if (entry.state !== 'in-flight' || entry.pendingTcpWrites) this.releaseEntry(entry);
    }
    const shutdowns = [
      this.closeSocketAndWait(this.inputSocket),
      this.closeSocketAndWait(this.outputSocket),
      this.closeTcpInputAndWait(true),
      this.closeTcpOutputsAndWait(true),
    ];
    this.inputSocket = null;
    this.outputSocket = null;
    this.shutdownPromise = Promise.allSettled(shutdowns).then(() => ({ status }));
    if (this.resolveDrain) this.resolveDrain({ status });
    this.resolveDrain = null;
  }

  fail(error) {
    if (this.status === 'error' || this.status === 'stopped') return;
    if (this.isRecoverableZeroDelayReset(error)) {
      this.transientResetErrors += 1;
      return;
    }
    this.stopImmediately('error');
    this.reportError(error);
  }

  isRecoverableZeroDelayReset(error) {
    if (
      this.delayMs !== 0
      || this.inputTransport !== 'tcp-server'
      || this.outputTransport !== 'tcp-server'
    ) return false;
    const code = String(error && error.code || '').toUpperCase();
    const message = String(error && error.message || error || '');
    return code === 'ECONNRESET' || /\bECONNRESET\b/i.test(message);
  }

  reportError(error) {
    if (this.failureReported) return;
    this.failureReported = true;
    if (this.onError) this.onError(error);
  }

  closeSocket(socket) {
    if (!socket) return;
    try { socket.close(); } catch {}
  }

  closeSocketAndWait(socket) {
    if (!socket) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (typeof socket.once === 'function') socket.once('close', complete);
      try { socket.close(complete); } catch { complete(); }
    });
  }

  closeTcpInput(destroyClient) {
    const server = this.inputServer;
    const client = this.inputClient;
    this.inputServer = null;
    this.inputClient = null;
    this.inputListening = false;
    if (server) {
      try { server.close(); } catch {}
    }
    if (destroyClient && client) {
      try { client.destroy(); } catch {}
    }
  }

  closeTcpInputAndWait(destroyClient) {
    const server = this.inputServer;
    const client = this.inputClient;
    this.inputServer = null;
    this.inputClient = null;
    this.inputListening = false;
    if (destroyClient && client) {
      try { client.destroy(); } catch {}
    }
    if (!server) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (typeof server.once === 'function') server.once('close', complete);
      try { server.close(complete); } catch { complete(); }
    });
  }

  closeTcpOutputs(destroyClients) {
    for (const server of this.outputServers.values()) {
      try { server.close(); } catch {}
    }
    this.outputServers.clear();
    this.listeningOutputPorts.clear();
    this.blockedOutputPorts.clear();
    if (destroyClients) {
      for (const socket of this.outputClients.values()) {
        try { socket.destroy(); } catch {}
      }
    }
    this.outputClients.clear();
  }

  closeTcpOutputsAndWait(destroyClients) {
    const servers = Array.from(this.outputServers.values());
    const clients = Array.from(this.outputClients.values());
    this.outputServers.clear();
    this.listeningOutputPorts.clear();
    this.blockedOutputPorts.clear();
    this.outputClients.clear();
    const closingServers = servers.map(server => new Promise(resolve => {
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (typeof server.once === 'function') server.once('close', complete);
      try { server.close(complete); } catch { complete(); }
    }));
    if (destroyClients) {
      for (const socket of clients) {
        try { socket.destroy(); } catch {}
      }
    }
    return Promise.allSettled(closingServers);
  }

  describe() {
    const last = this.queue[this.queue.length - 1];
    const remainingMs = last ? Math.max(0, last.releaseAt - Number(this.now())) : 0;
    return {
      enabled: true,
      delaySeconds: this.delayMs / 1000,
      status: this.status,
      bufferedBytes: this.bufferedBytes,
      bufferedPackets: this.residentEntries.size,
      remainingSeconds: Math.ceil(remainingMs / 1000),
      transientResetErrors: this.transientResetErrors,
    };
  }
}

module.exports = { LiveDelayBuffer, LiveDelayMemoryBudget, DEFAULT_MAX_BUFFERED_BYTES };
