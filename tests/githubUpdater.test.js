const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createGithubUpdater, getLatestMainCommit } = require('../server/lib/githubUpdater');

const CURRENT = '1'.repeat(40);
const LATEST = '2'.repeat(40);

test('GitHub version check reads the public main commit without credentials', async () => {
  let requestOptions;
  const get = (url, options, callback) => {
    assert.equal(url, 'https://api.github.com/repos/qwrrhjkl/streamhub/commits/main');
    requestOptions = options;
    const request = new EventEmitter();
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      callback(response);
      response.emit('data', JSON.stringify({
        sha: LATEST,
        html_url: `https://github.com/qwrrhjkl/streamhub/commit/${LATEST}`,
        commit: { message: 'Release update', committer: { date: '2026-11-25T00:00:00Z' } },
      }));
      response.emit('end');
    });
    return request;
  };

  const latest = await getLatestMainCommit({ get });
  assert.equal(latest.sha, LATEST);
  assert.equal(latest.message, 'Release update');
  assert.equal(requestOptions.headers.authorization, undefined);
});

test('updater detects a supported public Git checkout and queues only a checked main commit', async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-github-update-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const triggers = [];
  const updater = createGithubUpdater({
    rootDir,
    getLatestCommit: async () => ({ sha: LATEST, message: 'Release update', committedAt: '', url: '' }),
    getCheckoutInfo: async () => ({
      current: CURRENT,
      branch: 'main',
      remote: 'https://github.com/qwrrhjkl/streamhub.git',
    }),
    triggerUpdate: async target => triggers.push(target),
  });

  const check = await updater.check();
  assert.equal(check.supported, true);
  assert.equal(check.authenticationRequired, false);
  assert.equal(check.updateAvailable, true);
  assert.equal(check.latestCommit, LATEST);

  assert.deepEqual(await updater.start(LATEST), { started: true, targetCommit: LATEST });
  assert.deepEqual(triggers, [LATEST]);
  assert.equal(updater.status().state, 'queued');
  assert.equal(JSON.parse(fs.readFileSync(path.join(rootDir, 'data', 'update-request.json'), 'utf8')).targetCommit, LATEST);
});

test('updater rejects archive installs, non-main checkouts, changed targets, and duplicate requests', async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-github-update-guards-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let checkout = { current: CURRENT, branch: 'develop', remote: 'https://github.com/qwrrhjkl/streamhub.git' };
  let latestSha = LATEST;
  const updater = createGithubUpdater({
    rootDir,
    getLatestCommit: async () => ({ sha: latestSha, message: '', committedAt: '', url: '' }),
    getCheckoutInfo: async () => checkout,
    triggerUpdate: async () => {},
  });

  assert.equal((await updater.check()).supported, false);
  await assert.rejects(updater.start(LATEST), /不是 main 分支 Git 工作树或受信任仓库/);

  checkout = { current: CURRENT, branch: 'main', remote: 'https://github.com/qwrrhjkl/streamhub.git' };
  latestSha = '3'.repeat(40);
  await assert.rejects(updater.start(LATEST), /云端版本已经变化/);

  latestSha = LATEST;
  await updater.start(LATEST);
  await assert.rejects(updater.start(LATEST), /已有版本更新正在执行/);
});

test('updater prevents simultaneous requests while checking GitHub', async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-github-update-race-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let releaseCheck;
  const checkStarted = new Promise(resolve => { releaseCheck = resolve; });
  let continueCheck;
  const waitForCheck = new Promise(resolve => { continueCheck = resolve; });
  let triggerCount = 0;
  const updater = createGithubUpdater({
    rootDir,
    getLatestCommit: async () => {
      releaseCheck();
      await waitForCheck;
      return { sha: LATEST, message: '', committedAt: '', url: '' };
    },
    getCheckoutInfo: async () => ({
      current: CURRENT,
      branch: 'main',
      remote: 'https://github.com/qwrrhjkl/streamhub.git',
    }),
    triggerUpdate: async () => { triggerCount += 1; },
  });

  const firstRequest = updater.start(LATEST);
  await checkStarted;
  await assert.rejects(updater.start(LATEST), /已有版本更新正在执行/);
  continueCheck();
  await firstRequest;
  assert.equal(triggerCount, 1);
});

test('updater reports privileged launcher failures without leaving a queued request', async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-github-update-failure-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const updater = createGithubUpdater({
    rootDir,
    getLatestCommit: async () => ({ sha: LATEST, message: '', committedAt: '', url: '' }),
    getCheckoutInfo: async () => ({ current: CURRENT, branch: 'main', remote: 'https://github.com/qwrrhjkl/streamhub.git' }),
    triggerUpdate: async () => { throw new Error('systemd denied'); },
  });

  await assert.rejects(updater.start(LATEST), /systemd denied/);
  assert.equal(updater.status().state, 'failed');
  assert.equal(fs.existsSync(path.join(rootDir, 'data', 'update-request.json')), false);
});

test('checkout inspection narrowly trusts the service-owned path and blocks dirty worktrees', async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-github-update-safe-directory-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(rootDir, '.git'));
  const gitCalls = [];
  const updater = createGithubUpdater({
    rootDir,
    getLatestCommit: async () => ({ sha: LATEST, message: '', committedAt: '', url: '' }),
    runGit: async (_binary, args) => {
      gitCalls.push(args);
      if (args.includes('rev-parse')) return { stdout: `${CURRENT}\n` };
      if (args.includes('branch')) return { stdout: 'main\n' };
      if (args.includes('remote')) return { stdout: 'https://github.com/qwrrhjkl/streamhub.git\n' };
      return { stdout: ' M app/app.js\n' };
    },
    triggerUpdate: async () => assert.fail('dirty worktrees must not start updates'),
  });

  const check = await updater.check();
  assert.equal(check.supported, true);
  assert.equal(check.currentCommit, CURRENT);
  assert.equal(check.repositoryConfigured, true);
  assert.equal(check.workingTreeClean, false);
  assert.ok(gitCalls.every(args => args.includes(`safe.directory=${path.resolve(rootDir)}`)));
  await assert.rejects(updater.start(LATEST), /工作树有未提交改动或未跟踪文件/);
});
