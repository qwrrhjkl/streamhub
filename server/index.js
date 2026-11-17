const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { URL } = require('node:url');
const { StreamHubStore, createId } = require('./lib/store');
const { ProcessManager } = require('./lib/processManager');
const { PreviewManager } = require('./lib/previewManager');
const { listDevices, probeInput } = require('./lib/devices');
const { validatePublishRequest, extractPublishFields } = require('./lib/rooms');
const { parseMonitorQuery } = require('./lib/monitorQuery');
const { saveWatermark, findWatermark } = require('./lib/watermarks');
const { createSystemStatusCollector } = require('./lib/systemStatus');
const { MediaAssetManager } = require('./lib/mediaAssets');
const { StudioManager } = require('./lib/studioManager');
const { createLogManager } = require('./lib/logManager');
const { createPipelineReport } = require('./lib/pipelineReport');
const { detectEncoderCapabilities } = require('./lib/encoderCapabilities');
const {
  createAuthManager,
  tokenFromCookie,
  sessionCookie,
  expiredSessionCookie,
} = require('./lib/auth');

const ROOT = process.env.STREAMHUB_ROOT || path.resolve(__dirname, '..');
const HOST = process.env.STREAMHUB_HOST || '0.0.0.0';
const PORT = Number(process.env.STREAMHUB_PORT || 18080);
const execFileAsync = promisify(execFile);

async function startPoweroffUnit() {
  await execFileAsync('/usr/bin/systemctl', [
    '--no-block', 'start', 'streamhub-poweroff.service',
  ], { timeout: 10_000 });
}

async function stopActiveStreamHubWork({ manager, previewManager, studio }) {
  const operations = [];
  const pipelineIds = manager?.sessions && typeof manager.sessions.keys === 'function'
    ? Array.from(manager.sessions.keys())
    : [];
  for (const id of pipelineIds) {
    if (typeof manager.stopPipeline === 'function') {
      operations.push(Promise.resolve().then(() => manager.stopPipeline(id, {
        mode: 'discard',
        waitForExit: true,
      })));
    }
  }

  const previewIds = previewManager?.sessions && typeof previewManager.sessions.keys === 'function'
    ? Array.from(previewManager.sessions.keys())
    : [];
  for (const id of previewIds) {
    if (typeof previewManager.stopAndWait === 'function') {
      operations.push(Promise.resolve().then(() => previewManager.stopAndWait(id)));
    }
  }

  const recordingIds = studio?.activeRecordings && typeof studio.activeRecordings.keys === 'function'
    ? Array.from(studio.activeRecordings.keys())
    : [];
  for (const id of recordingIds) {
    if (typeof studio.stopRecording === 'function') {
      operations.push(Promise.resolve().then(() => studio.stopRecording(id)));
    }
  }

  const results = await Promise.allSettled(operations);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body);
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        const error = new Error('请求体太大');
        error.statusCode = 413;
        reject(error);
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (contentType.includes('application/x-www-form-urlencoded')) {
        return resolve(Object.fromEntries(new URLSearchParams(body)));
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function safeStaticPath(requestPath, appDir) {
  const pathname = decodeURIComponent(requestPath.split('?')[0]);
  const target = pathname === '/' ? path.join(appDir, 'index.html') : path.join(appDir, pathname.replace(/^\/+/, ''));
  const normalized = path.normalize(target);
  if (!normalized.startsWith(appDir)) return null;
  return normalized;
}

function serveStatic(req, res, appDir) {
  const file = safeStaticPath(req.url || '/', appDir);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return text(res, 404, 'Not found');
  const ext = path.extname(file);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
  };
  res.writeHead(200, {
    'content-type': types[ext] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

function collectionFor(segment) {
  if (segment === 'rooms') return ['rooms', 'room'];
  if (segment === 'sources') return ['sources', 'src'];
  if (segment === 'destinations') return ['destinations', 'dest'];
  if (segment === 'pipelines') return ['pipelines', 'pipe'];
  return null;
}

function requestIp(req) {
  return String(req.socket && req.socket.remoteAddress || 'unknown');
}

function requestIsSecure(req) {
  return Boolean(req.socket && req.socket.encrypted)
    || String(req.headers['x-forwarded-proto'] || '').split(',', 1)[0].trim().toLowerCase() === 'https';
}

async function handleRtmpNotify(req, res, url, store) {
  const body = await readBody(req);

  if (url.pathname === '/api/rtmp/on_publish') {
    const result = validatePublishRequest(body, store.list('rooms'));
    if (!result.ok) return text(res, result.status || 403, result.error || 'Forbidden');

    store.patch('rooms', result.room.id, {
      status: 'live',
      publisher: {
        addr: body.addr || '',
        app: body.app || '',
        name: body.name || '',
        clientId: body.clientid || body.clientId || '',
      },
      lastPublishAt: new Date().toISOString(),
    });
    return text(res, 200, 'OK');
  }

  if (url.pathname === '/api/rtmp/on_publish_done') {
    const fields = extractPublishFields(body);
    const room = store.list('rooms').find(item => item.streamName === fields.name);
    if (room) {
      store.patch('rooms', room.id, {
        status: 'idle',
        publisher: null,
        lastPublishDoneAt: new Date().toISOString(),
      });
    }
    return text(res, 200, 'OK');
  }

  return text(res, 404, 'Not found');
}

async function handleApi(req, res, url, {
  rootDir, store, manager, previewManager, mediaAssets, studio, systemStatus, auth, logManager, port,
  shutdownState, startShutdown,
}) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const parts = url.pathname.split('/').filter(Boolean).slice(1);

  if (url.pathname === '/api/health') {
    return json(res, 200, { ok: true, name: 'StreamHub', time: new Date().toISOString(), port });
  }

  if (url.pathname.startsWith('/api/rtmp/')) {
    if (req.method === 'POST') return handleRtmpNotify(req, res, url, store);
    return json(res, 405, { error: 'Method not allowed' });
  }

  const sessionToken = tokenFromCookie(req.headers.cookie);
  if (url.pathname === '/api/auth/session' && req.method === 'GET') {
    const session = auth.resolve(sessionToken);
    return json(res, 200, session
      ? { authenticated: true, username: session.username }
      : { authenticated: false });
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    const result = auth.login({
      username: body.username,
      password: body.password,
      ip: requestIp(req),
    });
    if (!result.ok) {
      if (result.code === 'rate-limited') {
        res.setHeader('retry-after', String(result.retryAfterSec));
        return json(res, 429, { error: result.message, retryAfterSec: result.retryAfterSec });
      }
      return json(res, 401, { error: result.message });
    }
    res.setHeader('set-cookie', sessionCookie(result.token, { secure: requestIsSecure(req) }));
    return json(res, 200, { authenticated: true, username: result.username });
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    auth.logout(sessionToken);
    res.setHeader('set-cookie', expiredSessionCookie({ secure: requestIsSecure(req) }));
    return json(res, 200, { ok: true });
  }

  if (url.pathname.startsWith('/api/auth/')) return json(res, 404, { error: 'Not found' });

  const session = auth.resolve(sessionToken);
  if (!session) return json(res, 401, { error: '\u767b\u5f55\u72b6\u6001\u5df2\u5931\u6548' });

  if (url.pathname === '/api/system/shutdown') {
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
    await readBody(req);
    if (shutdownState.inProgress) return json(res, 409, { error: '关机流程已在执行中' });
    shutdownState.inProgress = true;
    try {
      await stopActiveStreamHubWork({ manager, previewManager, studio });
      await startShutdown();
      return json(res, 202, { ok: true, shuttingDown: true });
    } catch (error) {
      shutdownState.inProgress = false;
      return json(res, error.statusCode || 503, {
        error: error.message || '无法启动服务器关机流程',
      });
    }
  }

  if (url.pathname === '/api/system-status' && req.method === 'GET') {
    return json(res, 200, await systemStatus.snapshot());
  }

  if (url.pathname === '/api/encoding-capabilities' && req.method === 'GET') {
    const encoders = detectEncoderCapabilities(undefined, manager.mediaBinaries, {
      nvencEnabled: process.env.STREAMHUB_NVENC_ENABLED !== '0',
    });
    const nvenc = encoders.find(item => item.id === 'h264_nvenc');
    return json(res, 200, {
      encoders,
      nvencAvailable: Boolean(nvenc && nvenc.available),
      message: nvenc && nvenc.available ? '' : String(nvenc && nvenc.reason || 'NVIDIA NVENC 不可用'),
    });
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const monitorOptions = { ...parseMonitorQuery(url.searchParams), historyMode: 'memory' };
    return json(res, 200, {
      ...store.getState(),
      mediaAssets: mediaAssets.list(),
      programs: typeof manager.programStates === 'function' ? manager.programStates() : {},
      monitor: typeof manager.publicMonitor === 'function'
        ? manager.publicMonitor(monitorOptions)
        : manager.monitor(monitorOptions),
    });
  }

  if (parts[0] === 'monitor' && parts[1] === 'outputs' && parts[2] && parts[3] === 'reset-drops' && req.method === 'POST') {
    return json(res, 200, manager.resetOutputDropDisplay(decodeURIComponent(parts[2])));
  }

  if (url.pathname === '/api/monitor' && req.method === 'GET') {
    const options = parseMonitorQuery(url.searchParams);
    if (options.historyMode !== 'persistent' || typeof manager.monitorPersistent !== 'function') {
      const monitor = typeof manager.publicMonitor === 'function'
        ? manager.publicMonitor(options)
        : manager.monitor(options);
      return json(res, 200, monitor);
    }
    const controller = new AbortController();
    const abortDisconnectedQuery = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abortDisconnectedQuery);
    res.once('close', abortDisconnectedQuery);
    try {
      const monitor = await manager.monitorPersistent(options, { signal: controller.signal });
      if (!res.destroyed) return json(res, 200, monitor);
      return undefined;
    } finally {
      req.removeListener('aborted', abortDisconnectedQuery);
      res.removeListener('close', abortDisconnectedQuery);
    }
  }

  if (url.pathname === '/api/media-assets' && req.method === 'GET') {
    return json(res, 200, mediaAssets.list());
  }

  if (url.pathname === '/api/media-assets' && req.method === 'POST') {
    const name = url.searchParams.get('name') || 'video.mp4';
    const asset = await mediaAssets.upload(req, {
      name,
      mimeType: String(req.headers['content-type'] || ''),
    });
    return json(res, 201, asset);
  }

  if (parts[0] === 'media-assets' && parts[1] && parts[2] === 'content' && ['GET', 'HEAD'].includes(req.method)) {
    return mediaAssets.serve(req, res, decodeURIComponent(parts[1]));
  }

  if (parts[0] === 'media-assets' && parts[1] && !parts[2] && req.method === 'DELETE') {
    const id = decodeURIComponent(parts[1]);
    if (typeof manager.isMediaInProgram === 'function' && manager.isMediaInProgram(id)) {
      const error = new Error('该视频素材正在播出，请先恢复直播源或切换到其他场景');
      error.statusCode = 409;
      throw error;
    }
    return json(res, 200, mediaAssets.remove(id));
  }

  if (url.pathname === '/api/scenes' && req.method === 'GET') {
    return json(res, 200, studio.listScenes());
  }

  if (url.pathname === '/api/scenes' && req.method === 'POST') {
    return json(res, 201, studio.createScene(await readBody(req)));
  }

  if (parts[0] === 'scenes' && parts[1] && !parts[2] && req.method === 'PUT') {
    return json(res, 200, studio.updateScene(decodeURIComponent(parts[1]), await readBody(req)));
  }

  if (parts[0] === 'scenes' && parts[1] && !parts[2] && req.method === 'DELETE') {
    return json(res, 200, studio.removeScene(decodeURIComponent(parts[1])));
  }

  if (parts[0] === 'pipelines' && parts[1] && parts[2] === 'switch-scene' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, await studio.switchScene(decodeURIComponent(parts[1]), String(body.sceneId || '')));
  }

  if (parts[0] === 'pipelines' && parts[1] && parts[2] === 'restore-program' && req.method === 'POST') {
    return json(res, 200, await studio.restoreProgram(decodeURIComponent(parts[1])));
  }

  if (url.pathname === '/api/recordings' && req.method === 'GET') {
    return json(res, 200, studio.listRecordingJobs());
  }

  if (url.pathname === '/api/recordings/capacity' && req.method === 'GET') {
    return json(res, 200, studio.recordingCapacity(String(url.searchParams.get('pipelineId') || '')));
  }

  if (url.pathname === '/api/recordings' && req.method === 'POST') {
    return json(res, 201, studio.startRecording(await readBody(req)));
  }

  if (parts[0] === 'recordings' && parts[1] && !parts[2] && req.method === 'DELETE') {
    return json(res, 200, studio.removeRecordingJob(decodeURIComponent(parts[1])));
  }

  if (parts[0] === 'recordings' && parts[1] && parts[2] === 'stop' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, await studio.stopRecording(decodeURIComponent(parts[1]), { replay: body.replay === true }));
  }

  if (url.pathname === '/api/watermarks' && req.method === 'POST') {
    const watermark = saveWatermark(rootDir, await readBody(req, 16 * 1024 * 1024));
    return json(res, 201, watermark);
  }

  if (url.pathname.startsWith('/api/watermarks/') && req.method === 'GET') {
    const id = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || '');
    const watermark = findWatermark(rootDir, id);
    if (!watermark) return json(res, 404, { error: '未找到水印文件' });
    res.writeHead(200, {
      'content-type': watermark.mimeType,
      'cache-control': 'private, max-age=3600',
      'content-length': fs.statSync(watermark.path).size,
    });
    return fs.createReadStream(watermark.path).pipe(res);
  }
  if (url.pathname === '/api/devices' && req.method === 'GET') {
    return json(res, 200, await listDevices({
      decklinkDevice: url.searchParams.get('decklinkDevice') || '',
    }));
  }

  if (url.pathname === '/api/logs' && req.method === 'GET') {
    const logs = logManager.list();
    const files = logs.map(item => item.file);
    const selected = url.searchParams.get('file');
    if (selected) {
      return json(res, 200, { files, logs, selected, content: logManager.read(selected) });
    }
    return json(res, 200, { files, logs, content: '' });
  }

  if (url.pathname === '/api/logs' && req.method === 'DELETE') {
    const selected = url.searchParams.get('file');
    if (!selected) {
      const error = new Error('请选择要删除的日志');
      error.statusCode = 400;
      throw error;
    }
    return json(res, 200, logManager.delete(selected));
  }

  if (parts[0] === 'reports' && parts[1] === 'pipelines' && parts[2] && req.method === 'GET') {
    const pipelineId = decodeURIComponent(parts[2]);
    const destinationId = String(url.searchParams.get('destinationId') || '');
    const pdf = createPipelineReport({ store, manager, logManager, pipelineId, destinationId });
    const filename = destinationId
      ? `streamhub-output-report-${pipelineId}-${destinationId}.pdf`
      : `streamhub-pipeline-report-${pipelineId}.pdf`;
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'content-length': pdf.length,
    });
    return res.end(pdf);
  }

  if (url.pathname === '/api/probe' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, await probeInput(body));
  }

  if (url.pathname === '/api/previews' && req.method === 'POST') {
    const body = await readBody(req);
    const format = url.searchParams.get('format');
    return json(res, 201, previewManager.start(format ? { ...body, format } : body));
  }

  if (parts[0] === 'previews' && parts[1]) {
    const id = decodeURIComponent(parts[1]);
    if (parts[2] === 'stream' && req.method === 'GET') {
      previewManager.attach(id, res);
      const detach = () => previewManager.detach(id, res);
      req.once('close', detach);
      res.once('close', detach);
      return;
    }
    if (!parts[2] && req.method === 'GET') return json(res, 200, previewManager.describe(id));
    if (parts[2] === 'stop' && req.method === 'POST') return json(res, 200, await previewManager.stopAndWait(id));
  }

  const collection = collectionFor(parts[0]);
  if (collection) {
    const [name, prefix] = collection;
    const id = parts[1];
    const action = parts[2];

    if (!id && req.method === 'GET') return json(res, 200, store.list(name));
    if (!id && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 201, store.create(name, name === 'rooms' ? body : { ...body, id: createId(prefix) }, prefix));
    }
    if (id && !action && req.method === 'PUT') {
      const body = await readBody(req);
      const updated = store.patch(name, id, body);
      if (name === 'destinations') manager.reconcileDestination(id);
      if (name === 'rooms' && (Object.hasOwn(body, 'enabled') || Object.hasOwn(body, 'streamName'))) manager.reconcileRoom(id);
      return json(res, 200, updated);
    }
    if (id && !action && req.method === 'DELETE') {
      if (name === 'pipelines') manager.stopPipeline(id);
      const removed = store.remove(name, id);
      if (name === 'destinations') manager.reconcileDestination(id);
      if (name === 'rooms') manager.reconcileRoom(id);
      return json(res, 200, removed);
    }
    if (name === 'pipelines' && id && action === 'start' && req.method === 'POST') return json(res, 200, manager.startPipeline(id));
    if (name === 'pipelines' && id && action === 'stop' && req.method === 'POST') {
      const body = await readBody(req);
      const mode = body.mode || 'discard';
      if (!['drain', 'discard'].includes(mode)) {
        const error = new Error('停止模式必须是 drain 或 discard');
        error.statusCode = 400;
        throw error;
      }
      return json(res, 200, manager.stopPipeline(id, { mode }));
    }
  }

  return json(res, 404, { error: '未找到接口' });
}

function createServer(options = {}) {
  const rootDir = options.rootDir || ROOT;
  const store = options.store || new StreamHubStore(rootDir);
  const manager = options.manager || new ProcessManager({ rootDir, store });
  const previewManager = options.previewManager || new PreviewManager({ rootDir, store, processManager: manager });
  const mediaAssets = options.mediaAssets || new MediaAssetManager({ rootDir, store });
  const studio = options.studio || new StudioManager({ rootDir, store, processManager: manager, mediaAssets });
  const systemStatus = options.systemStatus || createSystemStatusCollector();
  const shutdownState = { inProgress: false };
  const startShutdown = options.startShutdown || startPoweroffUnit;
  const auth = options.auth || createAuthManager({
    username: process.env.STREAMHUB_AUTH_USERNAME,
    password: process.env.STREAMHUB_AUTH_PASSWORD,
  });
  const appDir = path.join(rootDir, 'app');
  const port = options.port === undefined ? PORT : Number(options.port);
  const logManager = options.logManager || createLogManager({
    rootDir,
    store,
    activeFiles: () => [
      ...(typeof manager.getActiveLogFiles === 'function' ? manager.getActiveLogFiles() : []),
      ...(typeof previewManager.getActiveLogFiles === 'function' ? previewManager.getActiveLogFiles() : []),
    ],
  });
  if (typeof logManager.start === 'function') logManager.start();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, {
        rootDir, store, manager, previewManager, mediaAssets, studio, systemStatus, auth, logManager, port,
        shutdownState, startShutdown,
      });
      return serveStatic(req, res, appDir);
    } catch (error) {
      if (res.destroyed) return undefined;
      return json(res, error.statusCode || 500, { error: error.message });
    }
  });
  server.once('close', () => {
    if (typeof logManager.stop === 'function') logManager.stop();
    if (typeof manager.closeMonitorHistoryQueries === 'function') manager.closeMonitorHistoryQueries();
  });
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`StreamHub 控制台：http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  });
}

module.exports = { createServer };
