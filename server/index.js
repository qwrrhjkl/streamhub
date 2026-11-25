const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const net = require('node:net');
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
const { createPipelineReport, listPipelineRunReports } = require('./lib/pipelineReport');
const { detectEncoderCapabilities } = require('./lib/encoderCapabilities');
const { createGithubUpdater } = require('./lib/githubUpdater');
const {
  SESSION_TTL_MS,
  createAuthManager,
  tokenFromCookie,
  sessionCookie,
  expiredSessionCookie,
} = require('./lib/auth');

function authSessionTtl(auth) {
  if (typeof auth.getSettings !== 'function') return SESSION_TTL_MS;
  const configured = Number(auth.getSettings().sessionTtlMs);
  return Number.isFinite(configured) && configured > 0 ? configured : SESSION_TTL_MS;
}

function viewerSafeState(value) {
  if (Array.isArray(value)) return value.map(viewerSafeState);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/^(?:password|publishSecret|secret|streamKey|token|passphrase|url|publishUrl)$/i.test(key)) {
      return [key, ''];
    }
    return [key, viewerSafeState(item)];
  }));
}

function compactTimestamp(iso) {
  return String(iso || '').replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function localTimeLabel(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function reportContentDisposition(displayName, asciiName) {
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(displayName)}`;
}

const ROOT = process.env.STREAMHUB_ROOT || path.resolve(__dirname, '..');
const HOST = process.env.STREAMHUB_HOST || '0.0.0.0';
const PORT = Number(process.env.STREAMHUB_PORT || 18080);
const execFileAsync = promisify(execFile);
const VERSION = fs.existsSync(path.join(ROOT, 'VERSION'))
  ? fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim()
  : 'unknown';

function storageSnapshot(rootDir, mediaAssets) {
  const paths = {
    root: rootDir,
    recordings: path.join(rootDir, 'data', 'videos'),
    logs: path.join(rootDir, 'data', 'logs'),
  };
  const result = { paths, files: { recordings: 0, logs: 0 }, disk: null };
  try {
    const stat = fs.statfsSync(paths.root);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const availableBytes = Number(stat.bavail) * Number(stat.bsize);
    result.disk = { totalBytes, availableBytes, usedBytes: Math.max(0, totalBytes - availableBytes), usagePercent: totalBytes ? (totalBytes - availableBytes) / totalBytes * 100 : null };
  } catch {}
  for (const [key, dir] of [['recordings', paths.recordings], ['logs', paths.logs]]) {
    try { result.files[key] = fs.readdirSync(dir).reduce((sum, file) => sum + fs.statSync(path.join(dir, file)).size, 0); } catch {}
  }
  result.recordings = mediaAssets.list().filter(asset => asset.source === 'recording').length;
  return result;
}

function validateRetentionDays(value, label, max = 3650) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > max) {
    const error = new Error(`${label}须为 1 至 ${max} 天`);
    error.statusCode = 400;
    throw error;
  }
  return days;
}

function cleanupOldRecordings(mediaAssets, manager, retentionDays, now = Date.now) {
  const cutoff = Number(now()) - retentionDays * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const asset of mediaAssets.list().filter(item => item.source === 'recording')) {
    const createdAt = Date.parse(asset.createdAt || '');
    if (!Number.isFinite(createdAt) || createdAt >= cutoff) continue;
    if (typeof manager.isMediaInProgram === 'function' && manager.isMediaInProgram(asset.id)) continue;
    const state = manager.store && typeof manager.store.getState === 'function' ? manager.store.getState() : {};
    if ((state.scenes || []).some(scene => Array.isArray(scene.playlist) && scene.playlist.includes(asset.id))) continue;
    try {
      mediaAssets.remove(asset.id);
      for (const job of (state.recordingJobs || []).filter(item => item.assetId === asset.id)) {
        manager.store.remove('recordingJobs', job.id);
      }
      removed.push(asset.id);
    } catch {}
  }
  return { removed, count: removed.length };
}

function localPortListening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = listening => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

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
  shutdownState, startShutdown, githubUpdater,
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
      ? { authenticated: true, username: session.username, role: session.role, expiresAt: session.expiresAt, sessionTtlMs: authSessionTtl(auth) }
      : { authenticated: false, sessionTtlMs: authSessionTtl(auth) });
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
    res.setHeader('set-cookie', sessionCookie(result.token, {
      secure: requestIsSecure(req),
      maxAgeSec: Math.ceil(authSessionTtl(auth) / 1000),
    }));
    return json(res, 200, {
      authenticated: true,
      username: result.username,
      role: result.role,
      sessionTtlMs: authSessionTtl(auth),
    });
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    auth.logout(sessionToken);
    res.setHeader('set-cookie', expiredSessionCookie({ secure: requestIsSecure(req) }));
    return json(res, 200, { ok: true });
  }

  const session = auth.resolve(sessionToken);
  if (!session) return json(res, 401, { error: '\u767b\u5f55\u72b6\u6001\u5df2\u5931\u6548' });
  res.setHeader('set-cookie', sessionCookie(sessionToken, {
    secure: requestIsSecure(req),
    maxAgeSec: Math.ceil(authSessionTtl(auth) / 1000),
  }));

  const requireAdmin = () => {
    if (session.role !== 'admin') {
      const error = new Error('只有管理员可以执行此操作');
      error.statusCode = 403;
      throw error;
    }
  };
  if (url.pathname === '/api/auth/password' && req.method === 'POST') {
    const body = await readBody(req);
    auth.changePassword(sessionToken, body.currentPassword, body.newPassword);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/auth/sessions' && req.method === 'GET') {
    return json(res, 200, { sessions: auth.listSessions(sessionToken) });
  }
  if (url.pathname === '/api/auth/sessions' && req.method === 'DELETE') {
    return json(res, 200, auth.revokeOtherSessions(sessionToken));
  }
  const sessionMatch = url.pathname.match(/^\/api\/auth\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === 'DELETE') {
    return json(res, 200, auth.revokeSession(decodeURIComponent(sessionMatch[1]), sessionToken));
  }

  if (url.pathname === '/api/auth/users' && req.method === 'GET') {
    requireAdmin();
    return json(res, 200, { users: auth.listUsers() });
  }
  if (url.pathname === '/api/auth/users' && req.method === 'POST') {
    requireAdmin();
    const body = await readBody(req);
    return json(res, 201, { user: auth.createUser(body) });
  }
  const userMatch = url.pathname.match(/^\/api\/auth\/users\/([^/]+)$/);
  if (userMatch && req.method === 'PATCH') {
    requireAdmin();
    const body = await readBody(req);
    const userId = decodeURIComponent(userMatch[1]);
    if (userId === session.userId && (body.role !== undefined || body.enabled === false)) {
      return json(res, 409, { error: '不能修改当前登录账户的角色或停用状态' });
    }
    return json(res, 200, { user: auth.updateUser(userId, body) });
  }
  if (userMatch && req.method === 'DELETE') {
    requireAdmin();
    if (decodeURIComponent(userMatch[1]) === session.userId) {
      return json(res, 409, { error: '不能删除当前登录账户' });
    }
    return json(res, 200, auth.deleteUser(decodeURIComponent(userMatch[1])));
  }
  const resetPasswordMatch = url.pathname.match(/^\/api\/auth\/users\/([^/]+)\/password$/);
  if (resetPasswordMatch && req.method === 'POST') {
    requireAdmin();
    const body = await readBody(req);
    return json(res, 200, auth.resetPassword(decodeURIComponent(resetPasswordMatch[1]), body.newPassword));
  }
  if (url.pathname === '/api/auth/settings' && req.method === 'GET') {
    requireAdmin();
    return json(res, 200, auth.getSettings());
  }
  if (url.pathname === '/api/auth/settings' && ['PUT', 'PATCH'].includes(req.method)) {
    requireAdmin();
    const body = await readBody(req);
    return json(res, 200, auth.updateSettings(body));
  }
  if (url.pathname.startsWith('/api/auth/')) return json(res, 404, { error: 'Not found' });

  if (session.role === 'viewer') {
    const viewerReadable = url.pathname === '/api/state'
      || url.pathname === '/api/monitor'
      || url.pathname === '/api/system-status'
      || url.pathname === '/api/system-network-history'
      || url.pathname === '/api/system-info'
      || url.pathname === '/api/encoding-capabilities'
      || url.pathname === '/api/logs'
      || /^\/api\/reports\//.test(url.pathname);
    if (!['GET', 'HEAD'].includes(req.method) || !viewerReadable) {
      return json(res, 403, { error: '观察员账户只能查看运行状态、监控与日志' });
    }
  }
  if (session.role === 'operator' && url.pathname === '/api/system/shutdown') {
    return json(res, 403, { error: '只有管理员可以关闭服务' });
  }
  if (url.pathname === '/api/system-info' && req.method === 'GET') {
    const rtmpPort = Number(process.env.STREAMHUB_RTMP_PORT || 1935);
    const [webListening, rtmpListening] = await Promise.all([
      localPortListening(port), localPortListening(rtmpPort),
    ]);
    return json(res, 200, {
      version: VERSION,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      webPort: port,
      webListening,
      rtmpPort,
      rtmpListening,
      rtmpHealth: '127.0.0.1:18081',
      srtPort: 10081,
    });
  }
  if (url.pathname === '/api/system-update-check' && req.method === 'GET') {
    requireAdmin();
    try {
      const update = await githubUpdater.check();
      return json(res, 200, {
        currentVersion: VERSION,
        ...update,
      });
    } catch (error) {
      return json(res, 503, { error: error.message || '无法连接发布服务' });
    }
  }
  if (url.pathname === '/api/system-update-status' && req.method === 'GET') {
    requireAdmin();
    return json(res, 200, githubUpdater.status());
  }
  if (url.pathname === '/api/system-update' && req.method === 'POST') {
    requireAdmin();
    const body = await readBody(req);
    if (body.confirm !== true) return json(res, 400, { error: '请先确认更新和服务重启' });
    const activeWork = [
      manager && manager.sessions,
      previewManager && previewManager.sessions,
      studio && studio.activeRecordings,
    ].some(collection => collection && Number(collection.size) > 0);
    if (activeWork) {
      return json(res, 409, { error: '检测到推流、预览或录制仍在运行，请停止所有任务后重试' });
    }
    try {
      return json(res, 202, await githubUpdater.start(body.targetCommit));
    } catch (error) {
      return json(res, error.statusCode || 503, { error: error.message || '无法启动更新' });
    }
  }
  if (url.pathname === '/api/storage' && req.method === 'GET') {
    requireAdmin();
    const settings = store.getState().settings || {};
    return json(res, 200, {
      ...storageSnapshot(rootDir, mediaAssets),
      logRetentionDays: Number(settings.logRetentionDays) || 7,
      recordingRetentionDays: Number(settings.recordingRetentionDays) || 30,
    });
  }
  if (url.pathname === '/api/storage/cleanup' && req.method === 'POST') {
    requireAdmin();
    const body = await readBody(req);
    if (body.confirm !== true) return json(res, 400, { error: '清理操作需要明确确认' });
    const settings = store.getState().settings || {};
    const result = cleanupOldRecordings(mediaAssets, manager, Number(settings.recordingRetentionDays) || 30);
    result.logs = logManager.cleanup();
    return json(res, 200, { ...result, storage: storageSnapshot(rootDir, mediaAssets) });
  }
  if (url.pathname === '/api/system-settings') {
    requireAdmin();
    if (req.method === 'GET') {
      const settings = store.getState().settings || {};
      if (typeof logManager.setRetentionDays === 'function' && Number.isInteger(Number(settings.logRetentionDays))) {
        try { logManager.setRetentionDays(Number(settings.logRetentionDays)); } catch {}
      }
      return json(res, 200, { settings });
    }
    if (req.method !== 'PUT' && req.method !== 'PATCH') return json(res, 405, { error: 'Method not allowed' });
    const body = await readBody(req);
    const threshold = Number(body.lowBitrateWarningPercent);
    if (!Number.isInteger(threshold) || threshold < 10 || threshold > 70) {
      return json(res, 400, { error: '低码率告警阈值须为 10 至 70 的整数百分比' });
    }
    const current = store.getState().settings || {};
    const logRetentionDays = body.logRetentionDays === undefined
      ? Number(current.logRetentionDays) || 7
      : validateRetentionDays(body.logRetentionDays, '日志保留时间', 90);
    const recordingRetentionDays = body.recordingRetentionDays === undefined
      ? Number(current.recordingRetentionDays) || 30
      : validateRetentionDays(body.recordingRetentionDays, '录制保留时间');
    const updated = store.update(currentState => {
      currentState.settings = {
        ...(currentState.settings || {}), lowBitrateWarningPercent: threshold, logRetentionDays, recordingRetentionDays,
      };
      return currentState;
    });
    if (typeof logManager.setRetentionDays === 'function') logManager.setRetentionDays(logRetentionDays);
    return json(res, 200, { settings: updated.settings });
  }

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

  if (url.pathname === '/api/system-network-history' && req.method === 'GET') {
    const interfaceName = String(url.searchParams.get('interface') || '').trim() || undefined;
    const history = typeof systemStatus.networkHistory === 'function'
      ? systemStatus.networkHistory(interfaceName)
      : { interface: '', points: [] };
    return json(res, 200, history);
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
    const savedState = session.role === 'viewer' ? viewerSafeState(store.getState()) : store.getState();
    return json(res, 200, {
      ...savedState,
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

  if (url.pathname === '/api/reports/runs' && req.method === 'GET') {
    return json(res, 200, { runs: listPipelineRunReports(store) });
  }

  if (parts[0] === 'reports' && parts[1] === 'runs' && parts[2] && req.method === 'GET') {
    const runId = decodeURIComponent(parts[2]);
    const run = listPipelineRunReports(store).find(item => item.id === runId);
    if (!run) {
      const error = new Error('未找到这次运行报告');
      error.statusCode = 404;
      throw error;
    }
    const destinationId = String(url.searchParams.get('destinationId') || '');
    const pdf = createPipelineReport({
      store, manager, logManager, pipelineId: run.pipelineId, destinationId, runId,
    });
    const destination = destinationId
      ? (run.destinations || []).find(item => item.id === destinationId)
      : null;
    const destinationSuffix = destinationId ? `-${destinationId}` : '';
    const timeRange = `${compactTimestamp(run.startedAt)}~${compactTimestamp(run.endedAt)}`;
    const asciiName = `streamhub-run-${run.pipelineId}-${timeRange}${destinationSuffix}.pdf`;
    const displayName = `${run.pipelineName}${destination ? `-${destination.name}` : ''} `
      + `${localTimeLabel(run.startedAt)}~${localTimeLabel(run.endedAt)}.pdf`;
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': reportContentDisposition(displayName, asciiName),
      'cache-control': 'no-store',
      'content-length': pdf.length,
    });
    return res.end(pdf);
  }

  if (parts[0] === 'reports' && parts[1] === 'pipelines' && parts[2] && req.method === 'GET') {
    const pipelineId = decodeURIComponent(parts[2]);
    const destinationId = String(url.searchParams.get('destinationId') || '');
    const pdf = createPipelineReport({ store, manager, logManager, pipelineId, destinationId });
    const state = store.getState();
    const pipeline = (state.pipelines || []).find(item => item.id === pipelineId);
    const pipelineName = (pipeline && pipeline.name) || pipelineId;
    const destination = destinationId
      ? (state.destinations || []).find(item => item.id === destinationId)
      : null;
    const asciiName = destinationId
      ? `streamhub-output-report-${pipelineId}-${destinationId}.pdf`
      : `streamhub-pipeline-report-${pipelineId}.pdf`;
    const displayName = `${pipelineName}${destination ? `-${destination.name}` : ''}.pdf`;
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-disposition': reportContentDisposition(displayName, asciiName),
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
    filePath: path.join(rootDir, 'data', 'auth.json'),
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
  const githubUpdater = options.githubUpdater || createGithubUpdater({ rootDir });
  if (typeof logManager.start === 'function') logManager.start();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, {
        rootDir, store, manager, previewManager, mediaAssets, studio, systemStatus, auth, logManager, port,
        shutdownState, startShutdown, githubUpdater,
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
