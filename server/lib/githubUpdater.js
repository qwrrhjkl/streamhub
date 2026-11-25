const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const REPOSITORY = 'qwrrhjkl/streamhub';
const BRANCH = 'main';

function getLatestMainCommit({ get = https.get, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = get(`https://api.github.com/repos/${REPOSITORY}/commits/${BRANCH}`, {
      headers: {
        'user-agent': 'StreamHub-update-check',
        accept: 'application/vnd.github+json',
      },
      timeout: timeoutMs,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > 1024 * 1024) request.destroy(new Error('GitHub 返回内容过大'));
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(response.statusCode === 404
            ? `无法读取 GitHub 仓库 ${REPOSITORY} 的 ${BRANCH} 分支（HTTP 404）`
            : `GitHub 版本服务返回 HTTP ${response.statusCode}`));
          return;
        }
        try {
          const commit = JSON.parse(body);
          if (!/^[a-f0-9]{40}$/i.test(String(commit.sha || ''))) throw new Error('GitHub 未返回有效提交版本');
          resolve({
            sha: commit.sha.toLowerCase(),
            message: String(commit.commit && commit.commit.message || '').split(/\r?\n/, 1)[0].slice(0, 180),
            committedAt: String(commit.commit && commit.commit.committer && commit.commit.committer.date || ''),
            url: String(commit.html_url || `https://github.com/${REPOSITORY}/commit/${commit.sha}`),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('检查 GitHub 版本超时')));
    request.on('error', reject);
  });
}

function createGithubUpdater({
  rootDir,
  getLatestCommit = getLatestMainCommit,
  getCheckoutInfo,
  runGit = execFileAsync,
  triggerUpdate,
} = {}) {
  const statusFile = path.join(rootDir, 'data', 'update-status.json');
  const requestFile = path.join(rootDir, 'data', 'update-request.json');
  let startPending = false;
  const trigger = triggerUpdate || (async () => {
    await execFileAsync('/usr/bin/systemctl', [
      'start', '--no-block', 'streamhub-update.service',
    ], { timeout: 8000 });
  });

  async function checkoutInfo() {
    if (!fs.existsSync(path.join(rootDir, '.git'))) return { current: '', branch: '', remote: '', workingTreeClean: false };
    try {
      const repoRoot = path.resolve(rootDir);
      const gitArgs = ['-c', `safe.directory=${repoRoot}`, '-C', repoRoot];
      const [currentResult, branchResult, remoteResult, statusResult] = await Promise.all([
        runGit('/usr/bin/git', [...gitArgs, 'rev-parse', '--verify', 'HEAD'], { timeout: 3000 }),
        runGit('/usr/bin/git', [...gitArgs, 'branch', '--show-current'], { timeout: 3000 }),
        runGit('/usr/bin/git', [...gitArgs, 'remote', 'get-url', 'origin'], { timeout: 3000 }),
        runGit('/usr/bin/git', [...gitArgs, 'status', '--porcelain', '--untracked-files=all'], { timeout: 5000 }),
      ]);
      const current = currentResult.stdout.trim().toLowerCase();
      const remote = remoteResult.stdout.trim();
      const officialRemote = [
        'https://github.com/qwrrhjkl/streamhub.git',
        'https://github.com/qwrrhjkl/streamhub',
      ].includes(remote);
      return {
        current: /^[a-f0-9]{40}$/.test(current) ? current : '',
        branch: branchResult.stdout.trim(),
        remote: officialRemote ? remote : '',
        workingTreeClean: statusResult.stdout.trim() === '',
      };
    } catch {
      return { current: '', branch: '', remote: '', workingTreeClean: false };
    }
  }

  async function check() {
    const [latest, checkout] = await Promise.all([
      getLatestCommit(),
      getCheckoutInfo ? getCheckoutInfo() : checkoutInfo(),
    ]);
    const supported = Boolean(checkout.current && checkout.branch === BRANCH && checkout.remote);
    return {
      repository: REPOSITORY,
      branch: BRANCH,
      authenticationRequired: false,
      supported,
      workingTreeClean: checkout.workingTreeClean !== false,
      currentCommit: checkout.current,
      currentBranch: checkout.branch,
      repositoryConfigured: Boolean(checkout.remote),
      latestCommit: latest.sha,
      latestMessage: latest.message,
      committedAt: latest.committedAt,
      commitUrl: latest.url,
      updateAvailable: supported ? checkout.current !== latest.sha : null,
    };
  }

  function status() {
    try {
      const value = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'idle' };
      return {
        state: String(value.state || 'idle'),
        message: String(value.message || ''),
        currentCommit: String(value.currentCommit || ''),
        targetCommit: String(value.targetCommit || ''),
        updatedAt: String(value.updatedAt || ''),
        backupPath: String(value.backupPath || ''),
      };
    } catch {
      return { state: 'idle' };
    }
  }

  function writeStatus(value) {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true, mode: 0o750 });
    const tempFile = `${statusFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(value)}\n`, { mode: 0o640 });
    fs.renameSync(tempFile, statusFile);
  }

  async function start(expectedCommit) {
    if (startPending || ['queued', 'running'].includes(status().state)) {
      const error = new Error('已有版本更新正在执行');
      error.statusCode = 409;
      throw error;
    }
    startPending = true;
    try {
      const expected = String(expectedCommit || '').toLowerCase();
      if (!/^[a-f0-9]{40}$/.test(expected)) {
        const error = new Error('缺少有效的目标版本，请重新检查更新');
        error.statusCode = 400;
        throw error;
      }
      const update = await check();
      if (!update.supported) {
        const error = new Error('当前安装目录不是 main 分支 Git 工作树或受信任仓库，暂不支持在线更新');
        error.statusCode = 409;
        throw error;
      }
      if (!update.workingTreeClean) {
        const error = new Error('检测到服务器工作树有未提交改动或未跟踪文件，请先同步到干净的 Git 版本后再更新');
        error.statusCode = 409;
        throw error;
      }
      if (expected !== update.latestCommit) {
        const error = new Error('云端版本已经变化，请重新检查后再更新');
        error.statusCode = 409;
        throw error;
      }
      if (!update.updateAvailable) {
        const error = new Error('当前已经是 GitHub main 最新版本');
        error.statusCode = 409;
        throw error;
      }
      fs.mkdirSync(path.dirname(requestFile), { recursive: true, mode: 0o750 });
      const requestTemp = `${requestFile}.${process.pid}.tmp`;
      fs.writeFileSync(requestTemp, `${JSON.stringify({ targetCommit: expected, requestedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      fs.renameSync(requestTemp, requestFile);
      writeStatus({
        state: 'queued',
        message: '更新请求已提交，等待系统更新服务处理。',
        currentCommit: update.currentCommit,
        targetCommit: expected,
        updatedAt: new Date().toISOString(),
      });
      try {
        await trigger(expected);
      } catch (error) {
        try { fs.unlinkSync(requestFile); } catch {}
        writeStatus({
          state: 'failed',
          message: error.message || '系统更新服务启动失败。',
          currentCommit: update.currentCommit,
          targetCommit: expected,
          updatedAt: new Date().toISOString(),
        });
        throw error;
      }
      return { started: true, targetCommit: expected };
    } finally {
      startPending = false;
    }
  }

  return { check, start, status };
}

module.exports = {
  BRANCH,
  REPOSITORY,
  createGithubUpdater,
  getLatestMainCommit,
};
