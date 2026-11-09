const fs = require('node:fs');
const path = require('node:path');
const { isMainThread, parentPort } = require('node:worker_threads');
const {
  downsample,
  projectMonitorHistoryPoint,
  projectRetainedMonitorPoint,
} = require('./monitorHistoryStore');

function dateKeysBetween(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const keys = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);
  while (cursor <= end) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

function fileFor(historyDir, outputId, day) {
  const encoded = Buffer.from(String(outputId || ''), 'utf8').toString('base64url');
  const file = path.join(path.resolve(historyDir), day, `${encoded}.jsonl`);
  const relative = path.relative(path.resolve(historyDir), file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid monitor history path');
  return file;
}

async function readCompleteJsonLines(file, onPoint) {
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8' });
    let pending = '';
    for await (const chunk of stream) {
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (line) {
          try {
            onPoint(JSON.parse(line));
          } catch {
          }
        }
        newline = pending.indexOf('\n');
      }
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  } finally {
    if (stream && !stream.destroyed) stream.destroy();
  }
}

async function queryOneOutput({ historyDir, output, range, retentionFrom, maxPoints }) {
  const scanFrom = output.active ? range.from : Math.min(range.from, retentionFrom);
  const scanTo = output.active ? range.to : Math.max(range.to, range.now);
  const pointsByTime = new Map();
  let retainedLatest = null;
  let retainedLatestTime = -Infinity;
  for (const day of dateKeysBetween(scanFrom, scanTo)) {
    await readCompleteJsonLines(fileFor(historyDir, output.id, day), point => {
      const time = Number(point && point.time);
      if (!Number.isFinite(time) || time < scanFrom || time > scanTo) return;
      if (time >= retentionFrom && time >= retainedLatestTime) {
        retainedLatest = projectRetainedMonitorPoint(point);
        retainedLatestTime = time;
      }
      if (time >= range.from && time <= range.to) {
        const projected = projectMonitorHistoryPoint(point);
        if (projected) pointsByTime.set(time, projected);
      }
    });
  }
  const history = downsample(
    Array.from(pointsByTime.values()).sort((left, right) => left.time - right.time),
    maxPoints,
  );
  return {
    id: output.id,
    history,
    retainedLatest,
    hasRetainedHistory: retainedLatestTime > -Infinity,
  };
}

async function queryMonitorHistory({ historyDir, outputs = [], range, retentionFrom, maxPoints = 1200 }) {
  const results = [];
  for (const output of outputs) {
    results.push(await queryOneOutput({ historyDir, output, range, retentionFrom, maxPoints }));
  }
  return results;
}

if (!isMainThread && parentPort) {
  parentPort.once('message', async message => {
    try {
      const outputs = await queryMonitorHistory(message);
      parentPort.postMessage({ type: 'result', requestId: message.requestId, outputs });
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        requestId: message.requestId,
        error: { code: 'MONITOR_HISTORY_QUERY_FAILED', message: String(error && error.message || 'Monitor history query failed') },
      });
    } finally {
      parentPort.close();
    }
  });
}

module.exports = { queryMonitorHistory };
