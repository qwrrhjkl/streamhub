const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createAuthManager } = require('../server/lib/auth');

const previousPort = process.env.STREAMHUB_PORT;
process.env.STREAMHUB_PORT = '0';
const serverModule = require('../server/index');
if (previousPort === undefined) delete process.env.STREAMHUB_PORT;
else process.env.STREAMHUB_PORT = previousPort;

const { createServer } = serverModule;

function createPermissiveAuth() {
  return {
    resolve() { return { username: 'admin' }; },
    login() { return { ok: true, token: 'test-token', username: 'admin' }; },
    logout() { return true; },
  };
}

function createTestServer(options = {}) {
  return createServer({ auth: createPermissiveAuth(), ...options });
}

test.after(() => {
  if (serverModule && typeof serverModule.close === 'function' && serverModule.listening) serverModule.close();
});

function createPreviewManager() {
  const descriptor = {
    id: 'preview-a', sourceLabel: 'URL 输入源', state: 'connecting',
    width: 0, height: 0, fps: 0, latencyMs: 1000, message: '正在连接输入源…',
  };
  return {
    startCalls: [],
    stopCalls: [],
    attachCalls: [],
    start(body) {
      this.startCalls.push(body);
      return descriptor;
    },
    describe(id) {
      assert.equal(id, descriptor.id);
      return descriptor;
    },
    attach(id, response) {
      this.attachCalls.push(id);
      response.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=streamhub-preview' });
      response.end('--streamhub-preview\r\n');
    },
    detach() {},
    stopAndWait(id) {
      this.stopCalls.push(id);
      return { ok: true, status: 'stopped' };
    },
  };
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

test('preview API creates public descriptors, streams MJPEG, and releases sessions', async t => {
  assert.equal(typeof createServer, 'function');
  const previews = createPreviewManager();
  const server = createTestServer({
    rootDir: path.resolve(__dirname, '..'),
    store: { getState: () => ({}), list: () => [] },
    manager: { monitor: () => ({}) },
    previewManager: previews,
  });
  await listen(server);
  t.after(() => server.close());
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const created = await fetch(`${baseUrl}/api/previews?format=mp4`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' } }),
  });
  const payload = await created.json();
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(payload).sort(), ['fps', 'height', 'id', 'latencyMs', 'message', 'sourceLabel', 'state', 'width']);
  assert.equal(JSON.stringify(payload).includes('streamKey'), false);
  assert.deepEqual(previews.startCalls, [{ input: { type: 'url', url: 'rtmp://origin.example.com/live/pgm' }, format: 'mp4' }]);

  const status = await fetch(`${baseUrl}/api/previews/preview-a`);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).id, 'preview-a');

  const stream = await fetch(`${baseUrl}/api/previews/preview-a/stream`);
  assert.equal(stream.headers.get('content-type'), 'multipart/x-mixed-replace; boundary=streamhub-preview');
  await stream.text();
  assert.deepEqual(previews.attachCalls, ['preview-a']);

  const released = await fetch(`${baseUrl}/api/previews/preview-a/stop`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.deepEqual(await released.json(), { ok: true, status: 'stopped' });
  assert.deepEqual(previews.stopCalls, ['preview-a']);
});

test('system status API returns the injected server snapshot', async t => {
  const expected = {
    sampledAt: '2026-07-26T12:00:00.000Z',
    cpu: { available: true, usagePercent: 15 },
    memory: { available: true, usagePercent: 76 },
    gpu: { available: false, message: '未检测到可用的 NVIDIA GPU', devices: [] },
    disk: { available: true, devices: [{ id: 'disk-8-1', activityPercent: 10 }] },
    network: { available: true, interfaces: [{ id: 'network-eno1', totalBytesPerSec: 1000 }] },
    processes: {
      available: true,
      byCpu: [{ pid: 42, name: 'ffmpeg' }],
      byMemory: [{ pid: 42, name: 'ffmpeg' }],
    },
  };
  let calls = 0;
  const server = createTestServer({
    rootDir: path.resolve(__dirname, '..'),
    store: { getState: () => ({}), list: () => [] },
    manager: { monitor: () => ({}) },
    previewManager: createPreviewManager(),
    systemStatus: {
      async snapshot() {
        calls += 1;
        return expected;
      },
    },
  });
  await listen(server);
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/system-status`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.equal(calls, 1);
});

test('pipeline stop API forwards validated drain and discard modes', async t => {
  const stopCalls = [];
  const server = createTestServer({
    rootDir: path.resolve(__dirname, '..'),
    store: { getState: () => ({}), list: () => [] },
    manager: {
      monitor: () => ({}),
      stopPipeline(id, options) {
        stopCalls.push({ id, options });
        return { ok: true, status: options.mode === 'drain' ? 'draining' : 'stopped' };
      },
    },
    previewManager: createPreviewManager(),
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const drain = await fetch(`${baseUrl}/api/pipelines/pipe-a/stop`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'drain' }),
  });
  const discard = await fetch(`${baseUrl}/api/pipelines/pipe-a/stop`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'discard' }),
  });
  const invalid = await fetch(`${baseUrl}/api/pipelines/pipe-a/stop`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'later' }),
  });

  assert.deepEqual(await drain.json(), { ok: true, status: 'draining' });
  assert.deepEqual(await discard.json(), { ok: true, status: 'stopped' });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /停止模式必须是 drain 或 discard/);
  assert.deepEqual(stopCalls, [
    { id: 'pipe-a', options: { mode: 'drain' } },
    { id: 'pipe-a', options: { mode: 'discard' } },
  ]);
});

test('run report API lists immutable batches and downloads overall and destination PDFs', async t => {
  const run = {
    id: 'run-report-a',
    pipelineId: 'pipe-a',
    pipeline: {
      id: 'pipe-a', name: '主任务', input: { type: 'url' },
      settings: { live: { bitrateKbps: 6000 }, video: { outputResolution: '1920x1080', fps: '30' } },
    },
    source: { type: 'url', name: '直播源' },
    destinations: [{ id: 'dest-a', name: '平台 A', protocol: 'rtmp', enabled: true }],
    startedAt: '2026-11-24T02:00:00.000Z',
    endedAt: '2026-11-24T02:10:00.000Z',
    status: 'stopped', outcome: 'stopped', stopMode: 'discard',
    outputs: [{
      id: 'pipe-a-dest-a', destination: { id: 'dest-a', name: '平台 A', protocol: 'rtmp' },
      status: 'stopped', lastOperationalStatus: 'running', uptimeSec: 600,
      metrics: { bitrateKbps: 5980, fps: 30, speed: 1 },
    }],
  };
  const server = createTestServer({
    rootDir: path.resolve(__dirname, '..'),
    store: { getState: () => ({ pipelineRuns: [run] }), list: () => [] },
    manager: { monitor: () => ({}) },
    previewManager: createPreviewManager(),
    logManager: { start() {}, stop() {}, list: () => [] },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listed = await fetch(`${baseUrl}/api/reports/runs`);
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).runs[0].destinations, [{ id: 'dest-a', name: '平台 A', protocol: 'rtmp' }]);

  for (const suffix of ['', '?destinationId=dest-a']) {
    const response = await fetch(`${baseUrl}/api/reports/runs/run-report-a${suffix}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  }

  const missing = await fetch(`${baseUrl}/api/reports/runs/missing-run`);
  assert.equal(missing.status, 404);
});

test('GitHub update APIs are admin-only, require confirmation, and block active streaming work', async t => {
  const auth = createAuthManager({
    username: 'admin', password: 'heroesports', tokenFactory: () => 'update-admin-token',
  });
  const running = { sessions: new Map([['pipe-a', { status: 'running' }]]) };
  const previews = { ...createPreviewManager(), sessions: new Map() };
  const studio = { activeRecordings: new Map() };
  const calls = [];
  const githubUpdater = {
    check: async () => ({
      repository: 'qwrrhjkl/streamhub', branch: 'main', supported: true,
      authenticationRequired: false, currentCommit: '1'.repeat(40), latestCommit: '2'.repeat(40),
      updateAvailable: true,
    }),
    status: () => ({ state: 'idle' }),
    start: async commit => { calls.push(commit); return { started: true, targetCommit: commit }; },
  };
  const server = createTestServer({
    auth,
    githubUpdater,
    manager: { ...running, monitor: () => ({ outputs: [] }) },
    previewManager: previews,
    studio,
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${baseUrl}/api/system-update-check`)).status, 401);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'heroesports' }),
  });
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const check = await fetch(`${baseUrl}/api/system-update-check`, { headers: { cookie } });
  assert.equal((await check.json()).authenticationRequired, false);
  assert.deepEqual(await (await fetch(`${baseUrl}/api/system-update-status`, { headers: { cookie } })).json(), { state: 'idle' });

  const missingConfirmation = await fetch(`${baseUrl}/api/system-update`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ targetCommit: '2'.repeat(40) }),
  });
  assert.equal(missingConfirmation.status, 400);

  const activeWork = await fetch(`${baseUrl}/api/system-update`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true, targetCommit: '2'.repeat(40) }),
  });
  assert.equal(activeWork.status, 409);
  running.sessions.clear();

  const started = await fetch(`${baseUrl}/api/system-update`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ confirm: true, targetCommit: '2'.repeat(40) }),
  });
  assert.equal(started.status, 202);
  assert.deepEqual(calls, ['2'.repeat(40)]);
});

test('authentication routes issue and invalidate a protected management session', async t => {
  const auth = createAuthManager({
    username: 'admin',
    password: 'heroesports',
    tokenFactory: () => 'opaque-token',
  });
  let stateCalls = 0;
  const server = createServer({
    rootDir: path.resolve(__dirname, '..'),
    auth,
    store: {
      getState() { stateCalls += 1; return { pipelines: [] }; },
      list: () => [],
    },
    manager: { monitor: () => ({ outputs: [] }) },
    previewManager: createPreviewManager(),
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await fetch(`${baseUrl}/api/state`);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: '\u767b\u5f55\u72b6\u6001\u5df2\u5931\u6548' });
  assert.equal(stateCalls, 0);

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const missingSession = await fetch(`${baseUrl}/api/auth/session`);
  assert.deepEqual(await missingSession.json(), { authenticated: false, sessionTtlMs: 12 * 60 * 60 * 1000 });

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'heroesports' }),
  });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), {
    authenticated: true, username: 'admin', role: 'admin', sessionTtlMs: 12 * 60 * 60 * 1000,
  });
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /streamhub_session=opaque-token/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=43200/);
  assert.doesNotMatch(setCookie, /Secure/);
  const cookie = setCookie.split(';', 1)[0];

  const state = await fetch(`${baseUrl}/api/state`, { headers: { cookie } });
  assert.equal(state.status, 200);
  assert.equal(stateCalls, 1);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.deepEqual(await logout.json(), { ok: true });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${baseUrl}/api/state`, { headers: { cookie } })).status, 401);
});

test('auth endpoints manage users, while viewer sessions cannot write or administer accounts', async t => {
  const auth = createAuthManager({ username: 'admin', password: 'heroesports' });
  const storeState = {
    settings: { lowBitrateWarningPercent: 30 },
    pipelines: [],
    destinations: [{ id: 'dest-a', streamKey: 'must-not-leak', url: 'rtmp://host/live/secret' }],
    rooms: [{ id: 'room-a', publishSecret: 'room-secret' }],
  };
  const server = createServer({
    rootDir: path.resolve(__dirname, '..'),
    auth,
    store: {
      getState: () => storeState,
      list: () => [],
      update(mutator) { mutator(storeState); return storeState; },
    },
    manager: { monitor: () => ({ outputs: [] }) },
    previewManager: createPreviewManager(),
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'heroesports' }),
  });
  const adminCookie = adminLogin.headers.get('set-cookie').split(';', 1)[0];
  const preview = await fetch(`${baseUrl}/api/previews`, {
    method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(preview.status, 201);
  assert.equal((await fetch(`${baseUrl}/api/auth/audit`, { headers: { cookie: adminCookie } })).status, 404);
  const alertSettings = await fetch(`${baseUrl}/api/system-settings`, {
    method: 'PUT', headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ lowBitrateWarningPercent: 45 }),
  });
  assert.equal(alertSettings.status, 200);
  assert.equal((await alertSettings.json()).settings.lowBitrateWarningPercent, 45);
  const invalidAlertSettings = await fetch(`${baseUrl}/api/system-settings`, {
    method: 'PUT', headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ lowBitrateWarningPercent: 80 }),
  });
  assert.equal(invalidAlertSettings.status, 400);
  const created = await fetch(`${baseUrl}/api/auth/users`, {
    method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'observer', password: 'observer-password', role: 'viewer' }),
  });
  assert.equal(created.status, 201);
  const viewer = (await created.json()).user;
  assert.equal(viewer.role, 'viewer');

  const viewerLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'observer', password: 'observer-password' }),
  });
  const viewerCookie = viewerLogin.headers.get('set-cookie').split(';', 1)[0];
  const viewerStateResponse = await fetch(`${baseUrl}/api/state`, { headers: { cookie: viewerCookie } });
  assert.equal(viewerStateResponse.status, 200);
  const viewerState = await viewerStateResponse.json();
  assert.equal(viewerState.destinations[0].streamKey, '');
  assert.equal(viewerState.destinations[0].url, '');
  assert.equal(viewerState.rooms[0].publishSecret, '');
  const write = await fetch(`${baseUrl}/api/pipelines`, {
    method: 'POST', headers: { cookie: viewerCookie, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(write.status, 403);
  assert.equal((await fetch(`${baseUrl}/api/destinations`, { headers: { cookie: viewerCookie } })).status, 403);
  const administer = await fetch(`${baseUrl}/api/auth/users`, {
    method: 'POST', headers: { cookie: viewerCookie, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(administer.status, 403);
});

test('system settings expose service and storage info and require confirmation for cleanup', async t => {
  const password = 'system-settings-test-password';
  const auth = createAuthManager({ username: 'admin', password });
  const oldReferenced = { id: 'media-old-scene', source: 'recording', createdAt: '2020-01-01T00:00:00.000Z' };
  const oldUnused = { id: 'media-old-unused', source: 'recording', createdAt: '2020-01-01T00:00:00.000Z' };
  const state = {
    settings: { lowBitrateWarningPercent: 30, logRetentionDays: 7, recordingRetentionDays: 30 },
    scenes: [{ id: 'scene-a', playlist: [oldReferenced.id] }],
    recordingJobs: [{ id: 'job-a', assetId: oldUnused.id }],
  };
  let removed = 0;
  const mediaAssets = {
    list: () => [oldReferenced, oldUnused],
    remove(id) { removed += 1; assert.equal(id, oldUnused.id); },
  };
  const server = createServer({
    rootDir: path.resolve(__dirname, '..'), auth,
    store: {
      getState: () => state, list: () => [], update(mutator) { mutator(state); return state; },
      remove(collection, id) { state[collection] = state[collection].filter(item => item.id !== id); },
    },
    manager: { monitor: () => ({ outputs: [] }), isMediaInProgram: () => false, store: { getState: () => state, remove(collection, id) { state[collection] = state[collection].filter(item => item.id !== id); } } },
    mediaAssets,
    systemStatus: { async snapshot() { return { network: { available: true, interfaces: [{}] }, cpu: { uptimeSec: 3600 } }; } },
    logManager: { start() {}, stop() {}, list: () => [], cleanup: () => ({ deleted: [], skippedActive: [], protected: [] }), setRetentionDays(days) { this.retentionDays = days; } },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const info = await fetch(`${baseUrl}/api/system-info`, { headers: { cookie } });
  assert.equal(info.status, 200);
  assert.equal((await info.json()).nodeVersion, process.version);
  const storage = await fetch(`${baseUrl}/api/storage`, { headers: { cookie } });
  assert.equal(storage.status, 200);
  assert.equal((await storage.json()).recordingRetentionDays, 30);
  const retention = await fetch(`${baseUrl}/api/system-settings`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ lowBitrateWarningPercent: 30, logRetentionDays: 14, recordingRetentionDays: 90 }),
  });
  assert.equal(retention.status, 200);
  assert.equal(state.settings.logRetentionDays, 14);
  assert.equal(state.settings.recordingRetentionDays, 90);
  const denied = await fetch(`${baseUrl}/api/storage/cleanup`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(denied.status, 400);
  assert.equal(removed, 0);
  const cleaned = await fetch(`${baseUrl}/api/storage/cleanup`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }),
  });
  assert.equal(cleaned.status, 200);
  assert.equal(removed, 1);
  assert.deepEqual(state.recordingJobs, []);
});

test('health, RTMP callbacks, and auth routes stay public while management dependencies stay untouched', async t => {
  const calls = { state: 0, monitor: 0, preview: 0, system: 0, stop: 0 };
  const server = createServer({
    rootDir: path.resolve(__dirname, '..'),
    auth: createAuthManager({ username: 'admin', password: 'heroesports' }),
    store: {
      getState() { calls.state += 1; return {}; },
      list() { return []; },
    },
    manager: {
      monitor() { calls.monitor += 1; return {}; },
      stopPipeline() { calls.stop += 1; return {}; },
    },
    previewManager: {
      ...createPreviewManager(),
      start() { calls.preview += 1; return {}; },
    },
    systemStatus: {
      async snapshot() { calls.system += 1; return {}; },
    },
  });
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/auth/session`)).status, 200);
  const rtmp = await fetch(`${baseUrl}/api/rtmp/on_publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=unknown',
  });
  assert.notEqual(rtmp.status, 401);
  assert.notEqual((await fetch(`${baseUrl}/api/rtmp/on_publish`)).status, 401);

  const protectedRequests = [
    fetch(`${baseUrl}/api/state`),
    fetch(`${baseUrl}/api/monitor`),
    fetch(`${baseUrl}/api/logs`),
    fetch(`${baseUrl}/api/system-status`),
    fetch(`${baseUrl}/api/previews`, { method: 'POST', body: '{}' }),
    fetch(`${baseUrl}/api/pipelines/pipe-a/stop`, { method: 'POST', body: '{}' }),
  ];
  const protectedResponses = await Promise.all(protectedRequests);
  assert.equal(protectedResponses.every(response => response.status === 401), true);
  assert.deepEqual(calls, { state: 0, monitor: 0, preview: 0, system: 0, stop: 0 });
});

test('six failed HTTP logins from one client return rate limiting without account details', async t => {
  const server = createServer({
    rootDir: path.resolve(__dirname, '..'),
    auth: createAuthManager({ username: 'admin', password: 'heroesports' }),
    store: { getState: () => ({}), list: () => [] },
    manager: { monitor: () => ({}) },
    previewManager: createPreviewManager(),
  });
  await listen(server);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/auth/login`;
  const responses = [];
  for (let index = 0; index < 6; index += 1) {
    responses.push(await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' }),
    }));
  }

  assert.deepEqual(responses.map(response => response.status), [401, 401, 401, 401, 401, 429]);
  const payload = await responses.at(-1).json();
  assert.equal(payload.error, '\u7528\u6237\u540d\u6216\u5bc6\u7801\u9519\u8bef');
  assert.equal(payload.retryAfterSec > 0, true);
  assert.equal(JSON.stringify(payload).includes('attempt'), false);
});
