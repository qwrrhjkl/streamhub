const path = require('node:path');
const { Worker } = require('node:worker_threads');

function monitorHistoryQueryError(code, message) {
  const error = new Error(message);
  error.code = code;
  if (code === 'MONITOR_HISTORY_ABORTED' || code === 'MONITOR_HISTORY_SUPERSEDED') error.name = 'AbortError';
  if (code === 'MONITOR_HISTORY_SUPERSEDED') error.statusCode = 409;
  if (code === 'MONITOR_HISTORY_TIMEOUT') error.statusCode = 504;
  if (code === 'MONITOR_HISTORY_CLOSED') error.statusCode = 503;
  return error;
}

class MonitorHistoryQueryCoordinator {
  constructor({
    historyDir,
    workerFactory = workerPath => new Worker(workerPath),
    timeoutMs = 30_000,
  }) {
    this.historyDir = path.resolve(historyDir);
    this.workerPath = path.join(__dirname, 'monitorHistoryQueryWorker.js');
    this.workerFactory = workerFactory;
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.active = null;
    this.queued = null;
    this.closed = false;
  }

  query(options, { signal } = {}) {
    if (this.closed) return Promise.reject(monitorHistoryQueryError('MONITOR_HISTORY_CLOSED', 'Monitor history queries are closed'));
    if (signal && signal.aborted) return Promise.reject(monitorHistoryQueryError('MONITOR_HISTORY_ABORTED', 'Monitor history query was aborted'));
    return new Promise((resolve, reject) => {
      const job = {
        id: `monitor-history-${++this.sequence}`,
        options,
        signal,
        resolve,
        reject,
        worker: null,
        timer: null,
        abortHandler: null,
        settled: false,
      };
      if (!this.active) return this.start(job);
      if (this.queued) this.rejectQueued(this.queued, 'MONITOR_HISTORY_SUPERSEDED', 'Monitor history query was superseded');
      this.queued = job;
      this.attachQueuedAbort(job);
    });
  }

  attachQueuedAbort(job) {
    if (!job.signal) return;
    job.abortHandler = () => {
      if (this.queued !== job) return;
      this.queued = null;
      this.rejectQueued(job, 'MONITOR_HISTORY_ABORTED', 'Monitor history query was aborted');
    };
    job.signal.addEventListener('abort', job.abortHandler, { once: true });
  }

  rejectQueued(job, code, message) {
    if (job.abortHandler && job.signal) job.signal.removeEventListener('abort', job.abortHandler);
    job.abortHandler = null;
    if (!job.settled) {
      job.settled = true;
      job.reject(monitorHistoryQueryError(code, message));
    }
  }

  start(job) {
    if (this.closed) {
      this.rejectQueued(job, 'MONITOR_HISTORY_CLOSED', 'Monitor history queries are closed');
      return;
    }
    if (job.abortHandler && job.signal) job.signal.removeEventListener('abort', job.abortHandler);
    job.abortHandler = null;
    this.active = job;
    let worker;
    try {
      worker = this.workerFactory(this.workerPath);
    } catch (error) {
      this.finish(job, monitorHistoryQueryError('MONITOR_HISTORY_WORKER_START_FAILED', String(error && error.message || 'Unable to start monitor history worker')));
      return;
    }
    job.worker = worker;
    const abort = () => this.finish(job, monitorHistoryQueryError('MONITOR_HISTORY_ABORTED', 'Monitor history query was aborted'), { terminate: true });
    job.abortHandler = abort;
    if (job.signal) job.signal.addEventListener('abort', abort, { once: true });
    job.timer = setTimeout(() => {
      this.finish(job, monitorHistoryQueryError('MONITOR_HISTORY_TIMEOUT', 'Monitor history query timed out'), { terminate: true });
    }, this.timeoutMs);
    if (typeof job.timer.unref === 'function') job.timer.unref();
    worker.once('message', message => {
      if (!message || message.requestId !== job.id) return;
      if (message.type === 'result') this.finish(job, null, { value: message.outputs || [], terminate: true });
      else this.finish(job, monitorHistoryQueryError(
        message.error && message.error.code || 'MONITOR_HISTORY_QUERY_FAILED',
        message.error && message.error.message || 'Monitor history query failed',
      ), { terminate: true });
    });
    worker.once('error', error => this.finish(job, monitorHistoryQueryError(
      'MONITOR_HISTORY_WORKER_FAILED',
      String(error && error.message || 'Monitor history worker failed'),
    ), { terminate: true }));
    worker.once('exit', code => {
      if (this.active === job && !job.settled) {
        this.finish(job, monitorHistoryQueryError('MONITOR_HISTORY_WORKER_EXITED', `Monitor history worker exited with code ${code}`));
      }
    });
    worker.postMessage({
      type: 'query',
      requestId: job.id,
      historyDir: this.historyDir,
      ...job.options,
    });
  }

  finish(job, error, { value, terminate = false } = {}) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    if (job.abortHandler && job.signal) job.signal.removeEventListener('abort', job.abortHandler);
    if (terminate && job.worker) job.worker.terminate().catch(() => {});
    if (this.active === job) this.active = null;
    if (error) job.reject(error);
    else job.resolve(value);
    this.promote();
  }

  promote() {
    if (this.active || !this.queued) return;
    const next = this.queued;
    this.queued = null;
    queueMicrotask(() => {
      if (!this.active) this.start(next);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.queued) {
      const queued = this.queued;
      this.queued = null;
      this.rejectQueued(queued, 'MONITOR_HISTORY_CLOSED', 'Monitor history queries are closed');
    }
    if (this.active) {
      this.finish(this.active, monitorHistoryQueryError('MONITOR_HISTORY_CLOSED', 'Monitor history queries are closed'), { terminate: true });
    }
  }
}

module.exports = { MonitorHistoryQueryCoordinator, monitorHistoryQueryError };
