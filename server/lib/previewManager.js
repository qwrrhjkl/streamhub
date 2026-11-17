const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  buildDirectPreviewArgs,
  buildRelayPreviewArgs,
  resolvePipelineSource,
  sourceFingerprint,
} = require('./ffmpegBuilder');
const { createFFmpegProgressAccumulator, parseFFmpegStatsLine, parseFFmpegStreamInfoLine } = require('./metrics');
const { resolveMediaBinaries } = require('./mediaBinaries');
const { ensureDir } = require('./store');
const { createRotatingLogWriter } = require('./rotatingLogWriter');

const PREVIEW_BOUNDARY = 'streamhub-preview';
const IDLE_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 3_000;

function previewError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizePreviewOptions(request = {}) {
  const requestedFormat = String(request.format || 'mpjpeg').trim().toLowerCase();
  const format = requestedFormat === 'mjpeg' ? 'mpjpeg' : requestedFormat;
  if (format !== 'mpjpeg' && format !== 'mp4') {
    throw previewError('不支持的预览视频格式', 400);
  }
  return {
    format,
    audio: format === 'mp4' && request.audio === true,
    monitor: format === 'mpjpeg' && request.monitor === true,
  };
}

function diagnosticFor(line) {
  const text = String(line || '');
  if (/no input signal|no signal detected|could not find input format/i.test(text)) {
    return { state: 'no-signal', message: '未检测到输入信号' };
  }
  if (/permission denied|operation not permitted/i.test(text)) {
    return { state: 'failed', message: '没有访问输入设备的权限' };
  }
  if (/device or resource busy|cannot open device|already in use/i.test(text)) {
    return { state: 'failed', message: '输入设备正在被其他任务占用' };
  }
  if (/error|failed|refused|timeout|timed out|could not|invalid data found/i.test(text)) {
    return { state: 'failed', message: '预览进程启动失败，请检查输入源、网络或设备状态' };
  }
  return null;
}

function videoMetadata(line) {
  const match = String(line || '').match(/\b(\d{2,5})x(\d{2,5})\b[^\r\n]*?\b(\d+(?:\.\d+)?)\s*fps\b/i);
  if (!match) return null;
  return {
    width: Number(match[1]),
    height: Number(match[2]),
    fps: Number(match[3]),
  };
}

class PreviewManager {
  constructor({
    rootDir,
    store,
    processManager,
    mediaBinaries = resolveMediaBinaries(),
    spawnProcess = spawn,
    scheduleTimeout = setTimeout,
    clearScheduledTimeout = clearTimeout,
    createId = () => `preview-${crypto.randomUUID().slice(0, 8)}`,
    createLogWriter = createRotatingLogWriter,
  }) {
    this.rootDir = rootDir;
    this.store = store;
    this.processManager = processManager;
    this.mediaBinaries = mediaBinaries;
    this.spawnProcess = spawnProcess;
    this.scheduleTimeout = scheduleTimeout;
    this.clearScheduledTimeout = clearScheduledTimeout;
    this.createId = createId;
    this.createLogWriter = createLogWriter;
    this.logDir = path.join(rootDir, 'data', 'logs');
    ensureDir(this.logDir);
    this.sessions = new Map();
    this.activeLogFiles = new Set();
  }

  appendLog(session, entry) {
    if (session.logClosed) return session.logFile;
    session.logFile = session.logWriter.append(`${new Date().toISOString()} ${entry}\n`);
    return session.logFile;
  }

  closeLog(session) {
    if (session.logClosed) return;
    session.logClosed = true;
    this.activeLogFiles.delete(session.logFile);
    session.logWriter.close();
  }

  getActiveLogFiles() {
    return Array.from(this.activeLogFiles);
  }

  requireSession(id) {
    const session = this.sessions.get(id);
    if (!session) throw previewError('预览会话不存在或已结束', 404);
    return session;
  }

  describe(id) {
    const session = this.requireSession(id);
    return {
      id: session.id,
      sourceLabel: session.source.name,
      state: session.state,
      width: session.width || 0,
      height: session.height || 0,
      fps: session.inputFps || session.fps || 0,
      bitrateKbps: session.inputBitrateKbps || session.previewBitrateKbps || 0,
      bitrateSource: session.inputBitrateKbps ? 'input' : session.previewBitrateKbps ? 'preview' : '',
      videoCodec: session.videoCodec || '',
      audioCodec: session.audioCodec || '',
      latencyMs: session.monitor ? 1500 : 500,
      message: session.message || '',
    };
  }

  clearIdleTimer(session) {
    if (!session.idleTimer) return;
    this.clearScheduledTimeout(session.idleTimer);
    session.idleTimer = null;
  }

  scheduleIdleStop(session) {
    if (!this.sessions.has(session.id) || session.clients.size) return;
    this.clearIdleTimer(session);
    session.idleTimer = this.scheduleTimeout(() => {
      session.idleTimer = null;
      if (!session.clients.size) this.destroy(session);
    }, IDLE_TIMEOUT_MS);
    if (session.idleTimer && typeof session.idleTimer.unref === 'function') session.idleTimer.unref();
  }

  destroy(session) {
    if (!this.sessions.has(session.id)) return session.exitPromise;
    this.clearIdleTimer(session);
    this.sessions.delete(session.id);
    session.stopping = true;
    try {
      if (!session.exited && !session.child.killed) session.child.kill('SIGTERM');
    } catch {}
    if (!session.exited) {
      session.stopTimer = this.scheduleTimeout(() => {
        session.stopTimer = null;
        if (session.exited) return;
        try { session.child.kill('SIGKILL'); } catch {}
      }, STOP_TIMEOUT_MS);
      if (session.stopTimer && typeof session.stopTimer.unref === 'function') session.stopTimer.unref();
    }
    for (const response of session.clients) {
      try { response.end(); } catch {}
    }
    session.clients.clear();
    this.appendLog(session, 'STOPPED');
    return session.exitPromise;
  }

  updateFromStderr(session, line) {
    const metadata = videoMetadata(line);
    if (metadata) Object.assign(session, metadata);

    const streamInfo = parseFFmpegStreamInfoLine(line);
    if (streamInfo && streamInfo.type === 'video' && !session.outputDescriptionStarted) {
      if (streamInfo.fps) session.inputFps = streamInfo.fps;
      if (streamInfo.bitrateKbps) session.inputBitrateKbps = streamInfo.bitrateKbps;
      const codec = String(line || '').match(/\bVideo:\s*([^,\s]+)/i);
      if (codec) session.videoCodec = codec[1];
    }
    if (streamInfo && streamInfo.type === 'audio' && !session.outputDescriptionStarted) {
      const codec = String(line || '').match(/\bAudio:\s*([^,\s]+)/i);
      if (codec) session.audioCodec = codec[1];
    }
    if (/^Output #\d+/i.test(String(line || '').trim())) session.outputDescriptionStarted = true;

    const progress = parseFFmpegStatsLine(line);
    if (progress) {
      if (progress.fps) session.fps = progress.fps;
      if (progress.bitrateKbps) session.previewBitrateKbps = progress.bitrateKbps;
      session.state = 'receiving';
      session.message = '';
      this.appendLog(session, 'RECEIVING');
      return;
    }

    const diagnostic = diagnosticFor(line);
    if (!diagnostic) return;
    session.state = diagnostic.state;
    session.message = diagnostic.message;
    this.appendLog(session, diagnostic.state.toUpperCase());
  }

  handleExit(session) {
    if (session.stopTimer) {
      this.clearScheduledTimeout(session.stopTimer);
      session.stopTimer = null;
    }
    if (!session.exited) {
      session.exited = true;
      session.resolveExit();
    }
    const detached = !this.sessions.has(session.id) || session.stopping;
    if (!detached && session.state !== 'no-signal') {
      session.state = 'failed';
      session.message = '预览进程已结束，请检查输入源、网络或设备状态';
      this.appendLog(session, 'EXITED');
    }
    this.closeLog(session);
    if (detached) return;
    for (const response of session.clients) {
      try { response.end(); } catch {}
    }
    session.clients.clear();
    this.scheduleIdleStop(session);
  }

  start(request = {}) {
    const previewOptions = normalizePreviewOptions(request);
    const pipelineId = String(request.pipelineId || '').trim();
    const programPreview = pipelineId && this.processManager && this.processManager.findProgramPreviewSource(pipelineId);
    if (pipelineId && !programPreview) {
      throw previewError('该分发任务当前没有可用的 Program 预览', 409);
    }
    const pipeline = { input: request.input || null, sourceId: request.sourceId || '' };
    const source = programPreview
      ? { id: `program-${pipelineId}`, name: programPreview.sourceLabel || '当前节目', type: 'program' }
      : resolvePipelineSource(pipeline, this.store.getState());
    const sourceFingerprintValue = programPreview
      ? `program:${pipelineId}:${String(programPreview.epoch || '')}`
      : sourceFingerprint(source);
    const fingerprint = `${sourceFingerprintValue}:preview:${previewOptions.format}:${previewOptions.audio ? 'audio' : 'no-audio'}:${previewOptions.monitor ? 'monitor' : 'full'}`;
    const existing = Array.from(this.sessions.values()).find(session => session.fingerprint === fingerprint);
    if (existing) {
      existing.releaseRequested = false;
      this.clearIdleTimer(existing);
      return this.describe(existing.id);
    }

    const reusable = programPreview || (this.processManager && this.processManager.findPreviewSource(source));
    if (reusable && reusable.kind === 'relay-restart-required') {
      throw previewError('该共享转推任务需要重启一次后才能复用输入预览', 409);
    }
    if (reusable && reusable.kind === 'direct-capture') {
      throw previewError('运行中的直连采集任务不能重复读取采集卡，请切换为共享转推并重启任务后再预览', 409);
    }

    const args = reusable && reusable.kind === 'relay'
      ? buildRelayPreviewArgs(reusable.previewMirror, previewOptions)
      : reusable && reusable.kind === 'fallback'
        ? buildDirectPreviewArgs(reusable.source, previewOptions)
      : buildDirectPreviewArgs(source, previewOptions);
    const id = this.createId();
    let child;
    try {
      child = this.spawnProcess(this.mediaBinaries.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      throw previewError('预览进程启动失败，请检查输入源、网络或设备状态', 500);
    }

    let resolveExit;
    const exitPromise = new Promise(resolve => { resolveExit = resolve; });

    const session = {
      id,
      source,
      fingerprint,
      format: previewOptions.format,
      audio: previewOptions.audio,
      monitor: previewOptions.monitor,
      child,
      logFile: '',
      logClosed: false,
      state: 'connecting',
      message: '正在连接输入源…',
      width: 0,
      height: 0,
      fps: 0,
      inputFps: 0,
      inputBitrateKbps: 0,
      previewBitrateKbps: 0,
      videoCodec: '',
      audioCodec: '',
      outputDescriptionStarted: false,
      clients: new Set(),
      idleTimer: null,
      releaseRequested: false,
      stopping: false,
      stopTimer: null,
      exited: false,
      exitPromise,
      resolveExit,
      stderrRecords: createFFmpegProgressAccumulator(),
    };
    session.logWriter = this.createLogWriter({
      dir: this.logDir,
      prefix: id,
      onRotate: (oldFile, newFile) => {
        if (oldFile) this.activeLogFiles.delete(oldFile);
        this.activeLogFiles.add(newFile);
        session.logFile = newFile;
      },
    });
    this.sessions.set(session.id, session);
    const sourceLabel = String(source.name || source.id || '输入源').replace(/[\r\n]+/g, ' ').slice(0, 180);
    this.appendLog(session, `STARTED\nsourceLabel=${sourceLabel}`);

    child.stdout.on('data', chunk => {
      for (const response of [...session.clients]) {
        try { response.write(chunk); } catch { this.detach(session.id, response); }
      }
    });
    child.stderr.on('data', chunk => {
      for (const line of session.stderrRecords.push(chunk.toString('utf8'))) this.updateFromStderr(session, line);
    });
    child.stderr.once('end', () => {
      for (const line of session.stderrRecords.flush()) this.updateFromStderr(session, line);
    });
    child.once('exit', () => this.handleExit(session));

    this.scheduleIdleStop(session);
    return this.describe(session.id);
  }

  attach(id, response) {
    const session = this.requireSession(id);
    this.clearIdleTimer(session);
    response.writeHead(200, {
      'content-type': session.format === 'mp4'
        ? 'video/mp4'
        : `multipart/x-mixed-replace; boundary=${PREVIEW_BOUNDARY}`,
      'cache-control': 'no-store, no-cache, must-revalidate',
      connection: 'keep-alive',
    });
    session.clients.add(response);
  }

  detach(id, response) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.clients.delete(response);
    if (session.clients.size) return;
    if (session.releaseRequested) this.destroy(session);
    else this.scheduleIdleStop(session);
  }

  stop(id) {
    const session = this.sessions.get(id);
    if (!session) return { ok: true, status: 'not-found' };
    session.releaseRequested = true;
    if (session.clients.size) return { ok: true, status: 'in-use' };
    this.destroy(session);
    return { ok: true, status: 'stopped' };
  }

  async stopAndWait(id) {
    const session = this.sessions.get(id);
    if (!session) return { ok: true, status: 'not-found' };
    await this.destroy(session);
    return { ok: true, status: 'stopped' };
  }
}

module.exports = { IDLE_TIMEOUT_MS, PREVIEW_BOUNDARY, PreviewManager };
