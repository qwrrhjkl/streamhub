const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createAuthManager } = require('../server/lib/auth');
const { createServer } = require('../server');

function createDependencies(overrides = {}) {
  const auth = createAuthManager({
    username: 'admin',
    password: 'test-password',
    tokenFactory: () => 'test-session-token',
  });
  const manager = {
    sessions: new Map(),
    stopPipeline: async () => ({ ok: true }),
    getActiveLogFiles: () => [],
    closeMonitorHistoryQueries() {},
    ...overrides.manager,
  };
  const previewManager = {
    sessions: new Map(),
    stopAndWait: async () => ({ ok: true }),
    getActiveLogFiles: () => [],
    ...overrides.previewManager,
  };
  const studio = {
    activeRecordings: new Map(),
    stopRecording: async () => ({ ok: true }),
    ...overrides.studio,
  };
  const server = createServer({
    port: 0,
    rootDir: __dirname + '/..',
    store: { getState: () => ({}) },
    manager,
    previewManager,
    mediaAssets: {},
    studio,
    systemStatus: { snapshot: async () => ({}) },
    auth,
    logManager: { start() {}, stop() {} },
    startShutdown: overrides.startShutdown || (async () => {}),
  });
  const token = auth.login({ username: 'admin', password: 'test-password' }).token;
  return { server, cookie: `streamhub_session=${encodeURIComponent(token)}` };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

test('authenticated shutdown waits for active work before starting system poweroff', async t => {
  const events = [];
  const { server, cookie } = createDependencies({
    manager: {
      sessions: new Map([['pipeline-1', {}]]),
      stopPipeline: async (id, options) => {
        events.push(`pipeline:${id}:${options.mode}:${options.waitForExit}`);
      },
    },
    previewManager: {
      sessions: new Map([['preview-1', {}]]),
      stopAndWait: async id => events.push(`preview:${id}`),
    },
    studio: {
      activeRecordings: new Map([['recording-1', {}]]),
      stopRecording: async id => events.push(`recording:${id}`),
    },
    startShutdown: async () => events.push('poweroff'),
  });
  t.after(() => close(server));
  const baseUrl = await listen(server);

  const response = await fetch(`${baseUrl}/api/system/shutdown`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: '{}',
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, shuttingDown: true });
  assert.deepEqual(new Set(events), new Set([
    'pipeline:pipeline-1:discard:true',
    'preview:preview-1',
    'recording:recording-1',
    'poweroff',
  ]));
  assert.equal(events.at(-1), 'poweroff');
});

test('unauthenticated shutdown requests cannot stop services or power off', async t => {
  let serviceStopRequested = false;
  let poweroffRequested = false;
  const { server } = createDependencies({
    manager: {
      sessions: new Map([['pipeline-1', {}]]),
      stopPipeline: async () => { serviceStopRequested = true; },
    },
    startShutdown: async () => { poweroffRequested = true; },
  });
  t.after(() => close(server));
  const baseUrl = await listen(server);

  const response = await fetch(`${baseUrl}/api/system/shutdown`, { method: 'POST' });

  assert.equal(response.status, 401);
  assert.equal(serviceStopRequested, false);
  assert.equal(poweroffRequested, false);
});

test('concurrent shutdown requests cannot start a second shutdown sequence', async t => {
  let finishPipelineStop;
  let announcePipelineStop;
  const pipelineStopStarted = new Promise(resolve => { announcePipelineStop = resolve; });
  const pipelineStop = new Promise(resolve => { finishPipelineStop = resolve; });
  let poweroffCount = 0;
  const { server, cookie } = createDependencies({
    manager: {
      sessions: new Map([['pipeline-1', {}]]),
      stopPipeline: async () => {
        announcePipelineStop();
        await pipelineStop;
      },
    },
    startShutdown: async () => { poweroffCount += 1; },
  });
  t.after(() => close(server));
  const baseUrl = await listen(server);
  const firstRequest = fetch(`${baseUrl}/api/system/shutdown`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: '{}',
  });
  await pipelineStopStarted;

  const duplicateResponse = await fetch(`${baseUrl}/api/system/shutdown`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(duplicateResponse.status, 409);
  assert.equal(poweroffCount, 0);

  finishPipelineStop();
  const firstResponse = await firstRequest;
  assert.equal(firstResponse.status, 202);
  assert.equal(poweroffCount, 1);
});

test('user menu places the shutdown control below logout with a two-step confirmation', () => {
  const appDir = path.join(__dirname, '..', 'app');
  const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(appDir, 'styles.css'), 'utf8');
  const userMenu = html.match(/<div class="console-user-menu" id="userMenu"[\s\S]*?<\/div>/)?.[0];

  assert.ok(userMenu, 'the authenticated user menu should be present');
  assert.ok(userMenu.indexOf('id="logoutButton"') < userMenu.indexOf('id="shutdownMenuButton"'));
  assert.match(html, /<h2 id="systemShutdownTitle">确认关机？<\/h2>/);
  assert.match(html, /id="confirmSystemShutdownButton"[^>]*>确认<\/button>/);
  assert.match(html, /id="cancelSystemShutdownButton"[^>]*>取消<\/button>/);
  assert.match(css, /\.shutdown-menu-button/);
  assert.match(css, /\.console-app\[data-theme="night"\] \.console-user-menu \.shutdown-menu-button/);
});

test('poweroff scheduling failures are reported and can be retried', async t => {
  let attempts = 0;
  const { server, cookie } = createDependencies({
    startShutdown: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('关机单元不可用');
    },
  });
  t.after(() => close(server));
  const baseUrl = await listen(server);
  const sendShutdownRequest = () => fetch(`${baseUrl}/api/system/shutdown`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: '{}',
  });

  const failedResponse = await sendShutdownRequest();
  assert.equal(failedResponse.status, 503);
  assert.equal((await failedResponse.json()).error, '关机单元不可用');

  const retryResponse = await sendShutdownRequest();
  assert.equal(retryResponse.status, 202);
  assert.equal(attempts, 2);
});
