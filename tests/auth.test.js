const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SESSION_TTL_MS,
  createAuthManager,
  tokenFromCookie,
  sessionCookie,
  expiredSessionCookie,
} = require('../server/lib/auth');

test('authentication requires configured credentials', () => {
  assert.throws(() => createAuthManager(), /credentials/i);
  assert.throws(() => createAuthManager({ username: 'admin', password: '' }), /credentials/i);
});

test('valid credentials create and resolve a twelve-hour opaque session', () => {
  let now = 1_000;
  const auth = createAuthManager({
    username: 'admin',
    password: 'heroesports',
    now: () => now,
    tokenFactory: () => 'opaque-token',
  });

  const login = auth.login({ username: 'admin', password: 'heroesports', ip: '10.0.0.1' });
  assert.equal(login.ok, true);
  assert.equal(login.token, 'opaque-token');
  assert.equal(auth.resolve('opaque-token').username, 'admin');

  now += SESSION_TTL_MS + 1;
  assert.equal(auth.resolve('opaque-token'), null);
});

test('invalid username, invalid password, and different lengths share one public failure', () => {
  const auth = createAuthManager({ username: 'admin', password: 'heroesports' });
  const unknown = auth.login({ username: 'unknown', password: 'heroesports', ip: '10.0.0.1' });
  const wrong = auth.login({ username: 'admin', password: 'x'.repeat(10_000), ip: '10.0.0.2' });

  assert.deepEqual(unknown, wrong);
  assert.deepEqual(wrong, {
    ok: false,
    code: 'invalid',
    message: '\u7528\u6237\u540d\u6216\u5bc6\u7801\u9519\u8bef',
  });
});

test('sixth failed login in one minute is rate limited', () => {
  const auth = createAuthManager({ username: 'admin', password: 'heroesports', now: () => 1_000 });
  for (let index = 0; index < 5; index += 1) {
    assert.equal(auth.login({ username: 'admin', password: 'wrong', ip: '10.0.0.2' }).code, 'invalid');
  }
  assert.deepEqual(auth.login({ username: 'admin', password: 'wrong', ip: '10.0.0.2' }), {
    ok: false,
    code: 'rate-limited',
    message: '\u7528\u6237\u540d\u6216\u5bc6\u7801\u9519\u8bef',
    retryAfterSec: 60,
  });
});

test('successful login clears prior failures and logout invalidates its token', () => {
  let tokenIndex = 0;
  const auth = createAuthManager({
    username: 'admin',
    password: 'heroesports',
    now: () => 1_000,
    tokenFactory: () => `token-${tokenIndex += 1}`,
  });
  for (let index = 0; index < 4; index += 1) {
    auth.login({ username: 'admin', password: 'wrong', ip: '10.0.0.3' });
  }
  const login = auth.login({ username: 'admin', password: 'heroesports', ip: '10.0.0.3' });
  assert.equal(login.ok, true);
  assert.equal(auth.login({ username: 'admin', password: 'wrong', ip: '10.0.0.3' }).code, 'invalid');

  assert.equal(auth.logout(login.token), true);
  assert.equal(auth.resolve(login.token), null);
  assert.equal(auth.logout(login.token), false);
});

test('cookie helpers parse, issue, and expire only the named session cookie', () => {
  assert.equal(tokenFromCookie('theme=dark; streamhub_session=opaque%2Dtoken; other=1'), 'opaque-token');
  assert.equal(tokenFromCookie('streamhub_session=%E0%A4%A'), '');
  assert.equal(tokenFromCookie('other=value'), '');
  assert.equal(tokenFromCookie(null), '');

  const issued = sessionCookie('opaque-token', { secure: true });
  assert.match(issued, /^streamhub_session=opaque-token;/);
  assert.match(issued, /Path=\//);
  assert.match(issued, /HttpOnly/);
  assert.match(issued, /SameSite=Strict/);
  assert.match(issued, /Max-Age=43200/);
  assert.match(issued, /Secure/);

  const expired = expiredSessionCookie();
  assert.match(expired, /^streamhub_session=;/);
  assert.match(expired, /Max-Age=0/);
  assert.doesNotMatch(expired, /Secure/);
});

test('users have fixed roles, passwords are changed securely, and the last admin is protected', () => {
  const auth = createAuthManager({ username: 'admin', password: 'heroesports' });
  const admin = auth.login({ username: 'admin', password: 'heroesports' });
  const observer = auth.createUser({ username: 'observer', password: 'a-secure-password', role: 'viewer' }, 'admin');
  const observerLogin = auth.login({ username: 'observer', password: 'a-secure-password' });

  assert.equal(observer.role, 'viewer');
  assert.equal(observerLogin.role, 'viewer');
  assert.equal(auth.resolve(admin.token), null);
  assert.throws(() => auth.updateUser(auth.listUsers()[0].id, { role: 'invalid' }), /角色无效/);
  assert.throws(() => auth.deleteUser(auth.listUsers()[0].id), /至少需要保留一个/);

  const currentAdmin = auth.login({ username: 'admin', password: 'heroesports' });
  assert.equal(auth.resolve(observerLogin.token), null);
  auth.changePassword(currentAdmin.token, 'heroesports', 'an-even-safer-password');
  assert.equal(auth.resolve(currentAdmin.token).username, 'admin');
  assert.equal(auth.login({ username: 'admin', password: 'heroesports' }).ok, false);
  assert.equal(auth.login({ username: 'admin', password: 'an-even-safer-password' }).ok, true);
});

test('a successful login replaces the sole online session while a failed login leaves it active', () => {
  let tokenIndex = 0;
  const auth = createAuthManager({
    username: 'admin',
    password: 'bootstrap-password',
    tokenFactory: () => `single-session-${tokenIndex += 1}`,
  });
  auth.createUser({ username: 'operator', password: 'operator-password', role: 'operator' });

  const admin = auth.login({ username: 'admin', password: 'bootstrap-password' });
  const failed = auth.login({ username: 'operator', password: 'wrong-password' });
  assert.equal(failed.ok, false);
  assert.equal(auth.resolve(admin.token).username, 'admin');

  const operator = auth.login({ username: 'operator', password: 'operator-password' });
  assert.equal(operator.ok, true);
  assert.equal(auth.resolve(admin.token), null);
  assert.equal(auth.resolve(operator.token).username, 'operator');
  assert.equal(auth.listSessions(operator.token, true).length, 1);
});

test('idle session timeout refreshes on activity and auth data persists as password hashes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'auth.json');
  let now = 1_000;
  const auth = createAuthManager({ username: 'admin', password: 'bootstrap-password', now: () => now, filePath });
  auth.updateSettings({ sessionTtlMs: 15 * 60 * 1000 }, 'admin');
  const login = auth.login({ username: 'admin', password: 'bootstrap-password' });
  now += 14 * 60 * 1000;
  assert.equal(auth.resolve(login.token).username, 'admin');
  now += 14 * 60 * 1000;
  assert.equal(auth.resolve(login.token).username, 'admin');
  now += 16 * 60 * 1000;
  assert.equal(auth.resolve(login.token), null);

  const persisted = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(persisted, /bootstrap-password/);
  assert.doesNotMatch(persisted, /"audit"/);
  const reloaded = createAuthManager({ filePath });
  assert.equal(reloaded.getSettings().sessionTtlMs, 15 * 60 * 1000);
  assert.equal(reloaded.login({ username: 'admin', password: 'bootstrap-password' }).ok, true);
});
