const { execFile: nodeExecFile } = require('node:child_process');

const PID_PATTERN = /\bpid=(\d+)\b/;
const COUNTER_PATTERNS = {
  bytesSent: /\bbytes_sent:(\d+)\b/,
  bytesAcked: /\bbytes_acked:(\d+)\b/,
  bytesRetrans: /\bbytes_retrans:(\d+)\b/,
  dataSegsOut: /\bdata_segs_out:(\d+)\b/,
  dataSegsIn: /\bdata_segs_in:(\d+)\b/,
};

function counterValue(pattern, text, fallback = undefined) {
  const match = String(text || '').match(pattern);
  if (!match) return fallback;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizeRecord(text) {
  const pid = counterValue(PID_PATTERN, text);
  const bytesSent = counterValue(COUNTER_PATTERNS.bytesSent, text);
  const bytesAcked = counterValue(COUNTER_PATTERNS.bytesAcked, text);
  const dataSegsOut = counterValue(COUNTER_PATTERNS.dataSegsOut, text);
  const dataSegsIn = counterValue(COUNTER_PATTERNS.dataSegsIn, text);
  if (![pid, bytesSent, bytesAcked, dataSegsOut, dataSegsIn].every(Number.isFinite)) return null;
  return {
    pid,
    bytesSent,
    bytesAcked,
    bytesRetrans: counterValue(COUNTER_PATTERNS.bytesRetrans, text, 0),
    dataSegsOut,
    dataSegsIn,
  };
}

function parseSsOutput(stdout) {
  const records = [];
  let pending = '';
  const flush = () => {
    if (!pending) return;
    const record = normalizeRecord(pending);
    if (record) records.push(record);
    pending = '';
  };

  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (PID_PATTERN.test(line)) {
      flush();
      pending = line;
    } else if (pending) {
      pending += ` ${line}`;
    }
  }
  flush();
  return records;
}

function selectOutboundSocket(records, pid) {
  const expectedPid = Number(pid);
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) return null;
  return (records || [])
    .filter(record => (
      record &&
      record.pid === expectedPid &&
      Number(record.dataSegsOut) > Number(record.dataSegsIn)
    ))
    .sort((left, right) => {
      const dominance = (right.dataSegsOut - right.dataSegsIn) - (left.dataSegsOut - left.dataSegsIn);
      return dominance || right.bytesSent - left.bytesSent;
    })[0] || null;
}

function destinationSupportsTcpStats(destination) {
  const value = destination || {};
  const declared = String(value.protocol || value.type || '').trim().toLowerCase();
  if (declared === 'rtmp' || declared === 'rtmps') return true;
  const target = String(value.url || value.server || value.target || '').trim().toLowerCase();
  return /^rtmps?:\/\//.test(target);
}

class TcpSocketStatsCollector {
  constructor({
    execFile = nodeExecFile,
    command = '/usr/bin/ss',
    now = Date.now,
    minRefreshMs = 750,
    staleAfterMs = 2500,
    logger = console,
  } = {}) {
    this.execFile = execFile;
    this.command = command;
    this.now = now;
    this.minRefreshMs = minRefreshMs;
    this.staleAfterMs = staleAfterMs;
    this.logger = logger;
    this.lastSnapshot = null;
    this.inFlight = null;
    this.lastDiagnostic = '';
  }

  refresh() {
    const currentTime = Number(this.now());
    if (
      this.lastSnapshot &&
      Number.isFinite(currentTime) &&
      currentTime - this.lastSnapshot.capturedAt < this.minRefreshMs
    ) return Promise.resolve(this.lastSnapshot);
    if (this.inFlight) return this.inFlight;

    const capturedAt = Number.isFinite(currentTime) ? currentTime : Date.now();
    const request = new Promise(resolve => {
      this.execFile(this.command, ['-tinpH'], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        timeout: 2000,
        windowsHide: true,
      }, (error, stdout) => {
        if (error) {
          const diagnostic = String(error.message || error).slice(0, 300);
          if (diagnostic !== this.lastDiagnostic) {
            this.logger.error(`TCP socket statistics unavailable: ${diagnostic}`);
            this.lastDiagnostic = diagnostic;
          }
          this.lastSnapshot = { capturedAt, records: [], failed: true };
        } else {
          this.lastDiagnostic = '';
          this.lastSnapshot = {
            capturedAt,
            records: parseSsOutput(stdout),
            failed: false,
          };
        }
        resolve(this.lastSnapshot);
      });
    });
    this.inFlight = request;
    request.finally(() => {
      if (this.inFlight === request) this.inFlight = null;
    });
    return request;
  }

  async sample(pid) {
    const snapshot = await this.refresh();
    const ageMs = Number(this.now()) - Number(snapshot && snapshot.capturedAt);
    if (
      !snapshot ||
      snapshot.failed ||
      !Number.isFinite(ageMs) ||
      ageMs < 0 ||
      ageMs > this.staleAfterMs
    ) return { status: 'unavailable' };

    const socket = selectOutboundSocket(snapshot.records, pid);
    if (!socket) return { status: 'unavailable' };
    return {
      status: 'available',
      tcpSentBytes: socket.bytesSent,
      tcpAckedBytes: socket.bytesAcked,
      tcpRetransBytes: socket.bytesRetrans,
    };
  }
}

module.exports = {
  parseSsOutput,
  selectOutboundSocket,
  destinationSupportsTcpStats,
  TcpSocketStatsCollector,
};
