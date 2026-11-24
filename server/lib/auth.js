const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_TTL_OPTIONS = [15, 30, 60, 120, 240, 480, 720, 1440].map(minutes => minutes * 60 * 1000);
const FAILURE_WINDOW_MS = 60 * 1000;
const MAX_FAILURES = 5;
const COOKIE_NAME = 'streamhub_session';
const ROLES = ['admin', 'operator', 'viewer'];
const ROLE_LABELS = { admin: '管理员', operator: '操作员', viewer: '观察员' };
const INVALID_LOGIN = Object.freeze({
  ok: false,
  code: 'invalid',
  message: '\u7528\u6237\u540d\u6216\u5bc6\u7801\u9519\u8bef',
});

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function passwordMatches(password, encoded) {
  if (String(password ?? '').length > 256) return false;
  const [, salt, expectedHex] = String(encoded || '').split('$');
  if (!salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  if (expected.length !== 64) return false;
  const actual = crypto.scryptSync(String(password ?? ''), salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    roleLabel: ROLE_LABELS[user.role] || user.role,
    enabled: user.enabled !== false,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || '',
  };
}

function createAuthManager({ username, password, now = Date.now, tokenFactory, filePath } = {}) {
  if ((!filePath || !fs.existsSync(filePath))
    && (typeof username !== 'string' || !username || typeof password !== 'string' || !password)) {
    throw new Error('StreamHub authentication credentials are required');
  }
  const createToken = tokenFactory || (() => crypto.randomBytes(32).toString('base64url'));
  const sessions = new Map();
  const failuresByIp = new Map();
  let data = { sessionTtlMs: SESSION_TTL_MS, users: [] };

  if (filePath && fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && Array.isArray(parsed.users) && parsed.users.length) {
        data = {
          sessionTtlMs: SESSION_TTL_OPTIONS.includes(Number(parsed.sessionTtlMs))
            ? Number(parsed.sessionTtlMs)
            : SESSION_TTL_MS,
          users: parsed.users.filter(user => user && typeof user.username === 'string' && user.passwordHash),
        };
      }
    } catch (error) {
      throw new Error(`Unable to read authentication data: ${error.message}`);
    }
  }

  if (!data.users.length) {
    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
      throw new Error('StreamHub authentication credentials are required');
    }
    const initialUsername = String(username || '').trim();
    data.users = [{
      id: crypto.randomUUID(),
      username: initialUsername,
      passwordHash: hashPassword(password),
      role: 'admin',
      enabled: true,
      createdAt: new Date(Number(now())).toISOString(),
      lastLoginAt: '',
    }];
  }

  function persist() {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
  }

  function findUserById(id) {
    return data.users.find(user => user.id === String(id));
  }

  function findUserByName(name) {
    const normalized = String(name || '').trim().toLocaleLowerCase();
    return data.users.find(user => user.username.toLocaleLowerCase() === normalized);
  }

  function currentFailures(ip, currentTime) {
    const cutoff = currentTime - FAILURE_WINDOW_MS;
    const failures = (failuresByIp.get(ip) || []).filter(timestamp => timestamp > cutoff);
    if (failures.length) failuresByIp.set(ip, failures);
    else failuresByIp.delete(ip);
    return failures;
  }

  function sessionFor(token) {
    return token ? sessions.get(String(token)) : null;
  }

  function invalidateUserSessions(userId, exceptToken = '') {
    for (const [token, session] of sessions) {
      if (session.userId === userId && token !== exceptToken) sessions.delete(token);
    }
  }

  function validateNewPassword(value) {
    if (typeof value !== 'string' || value.length < 12 || value.length > 256) {
      const error = new Error('密码长度须为 12 至 256 个字符');
      error.statusCode = 400;
      throw error;
    }
  }

  function ensureLastAdminRemains(candidateUsers) {
    if (!candidateUsers.some(user => user.role === 'admin' && user.enabled !== false)) {
      const error = new Error('至少需要保留一个启用状态的管理员');
      error.statusCode = 409;
      throw error;
    }
  }

  return {
    login({ username: suppliedUsername, password: suppliedPassword, ip = 'unknown' } = {}) {
      const currentTime = Number(now());
      const clientIp = String(ip || 'unknown');
      const failures = currentFailures(clientIp, currentTime);
      if (failures.length >= MAX_FAILURES) {
        return {
          ok: false,
          code: 'rate-limited',
          message: INVALID_LOGIN.message,
          retryAfterSec: Math.max(1, Math.ceil((failures[0] + FAILURE_WINDOW_MS - currentTime) / 1000)),
        };
      }

      const user = findUserByName(suppliedUsername);
      const valid = user && user.enabled !== false && passwordMatches(suppliedPassword, user.passwordHash);
      if (!valid) {
        failures.push(currentTime);
        failuresByIp.set(clientIp, failures);
        return { ...INVALID_LOGIN };
      }

      failuresByIp.delete(clientIp);
      const token = String(createToken());
      const session = {
        id: crypto.randomUUID(),
        userId: user.id,
        username: user.username,
        role: user.role,
        createdAt: currentTime,
        expiresAt: currentTime + data.sessionTtlMs,
        lastSeenAt: currentTime,
        ip: clientIp,
      };
      user.lastLoginAt = new Date(currentTime).toISOString();
      persist();
      sessions.clear();
      sessions.set(token, session);
      return { ok: true, token, username: user.username, role: user.role, expiresAt: session.expiresAt };
    },

    resolve(token) {
      if (!token) return null;
      const key = String(token);
      const session = sessions.get(key);
      if (!session) return null;
      const currentTime = Number(now());
      const user = findUserById(session.userId);
      if (!user || user.enabled === false || session.expiresAt <= currentTime) {
        sessions.delete(key);
        return null;
      }
      session.username = user.username;
      session.role = user.role;
      session.lastSeenAt = currentTime;
      session.expiresAt = currentTime + data.sessionTtlMs;
      return { ...session };
    },

    logout(token) {
      return token ? sessions.delete(String(token)) : false;
    },

    listUsers() {
      return data.users.map(publicUser).sort((left, right) => left.username.localeCompare(right.username));
    },

    createUser({ username: suppliedUsername, password: suppliedPassword, role = 'operator' } = {}) {
      const normalized = String(suppliedUsername || '').trim();
      if (!/^[\p{L}\p{N}._-]{3,32}$/u.test(normalized)) {
        const error = new Error('用户名须为 3 至 32 个字母、数字、点、下划线或连字符');
        error.statusCode = 400;
        throw error;
      }
      if (findUserByName(normalized)) {
        const error = new Error('用户名已存在');
        error.statusCode = 409;
        throw error;
      }
      if (!ROLES.includes(role)) {
        const error = new Error('用户角色无效');
        error.statusCode = 400;
        throw error;
      }
      validateNewPassword(suppliedPassword);
      const user = {
        id: crypto.randomUUID(), username: normalized, passwordHash: hashPassword(suppliedPassword), role,
        enabled: true, createdAt: new Date(Number(now())).toISOString(), lastLoginAt: '',
      };
      data.users.push(user);
      persist();
      return publicUser(user);
    },

    updateUser(id, patch) {
      const user = findUserById(id);
      if (!user) {
        const error = new Error('用户不存在');
        error.statusCode = 404;
        throw error;
      }
      const role = patch && patch.role !== undefined ? patch.role : user.role;
      const enabled = patch && patch.enabled !== undefined ? Boolean(patch.enabled) : user.enabled !== false;
      if (!ROLES.includes(role)) {
        const error = new Error('用户角色无效');
        error.statusCode = 400;
        throw error;
      }
      const candidateUsers = data.users.map(item => item.id === user.id ? { ...item, role, enabled } : item);
      ensureLastAdminRemains(candidateUsers);
      user.role = role;
      user.enabled = enabled;
      persist();
      if (!enabled) invalidateUserSessions(user.id);
      return publicUser(user);
    },

    deleteUser(id) {
      const user = findUserById(id);
      if (!user) {
        const error = new Error('用户不存在');
        error.statusCode = 404;
        throw error;
      }
      ensureLastAdminRemains(data.users.filter(item => item.id !== user.id));
      data.users = data.users.filter(item => item.id !== user.id);
      invalidateUserSessions(user.id);
      persist();
      return { ok: true };
    },

    resetPassword(id, newPassword) {
      const user = findUserById(id);
      if (!user) {
        const error = new Error('用户不存在');
        error.statusCode = 404;
        throw error;
      }
      validateNewPassword(newPassword);
      user.passwordHash = hashPassword(newPassword);
      invalidateUserSessions(user.id);
      persist();
      return { ok: true };
    },

    changePassword(token, currentPassword, newPassword) {
      const session = sessionFor(token);
      const user = session && findUserById(session.userId);
      if (!user || !passwordMatches(currentPassword, user.passwordHash)) {
        const error = new Error('当前密码不正确');
        error.statusCode = 400;
        throw error;
      }
      validateNewPassword(newPassword);
      user.passwordHash = hashPassword(newPassword);
      invalidateUserSessions(user.id, String(token));
      persist();
      return { ok: true };
    },

    listSessions(actorToken, all = false) {
      const actor = sessionFor(actorToken);
      const currentTime = Number(now());
      for (const [token, session] of sessions) {
        if (session.expiresAt <= currentTime || !findUserById(session.userId)?.enabled) sessions.delete(token);
      }
      return Array.from(sessions.values())
        .filter(session => all || session.userId === (actor && actor.userId))
        .map(session => ({
          id: session.id,
          username: session.username,
          role: session.role,
          current: session.id === (actor && actor.id),
          createdAt: new Date(session.createdAt).toISOString(),
          lastSeenAt: new Date(session.lastSeenAt).toISOString(),
          expiresAt: new Date(session.expiresAt).toISOString(),
          ip: session.ip,
        }))
        .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
    },

    revokeSession(sessionId, actorToken) {
      const actor = sessionFor(actorToken);
      const entry = Array.from(sessions.entries()).find(([, session]) => session.id === String(sessionId));
      if (!entry || !actor || (actor.role !== 'admin' && entry[1].userId !== actor.userId)) {
        const error = new Error('会话不存在或无权撤销');
        error.statusCode = 404;
        throw error;
      }
      sessions.delete(entry[0]);
      return { ok: true, current: entry[0] === String(actorToken) };
    },

    revokeOtherSessions(token) {
      const actor = sessionFor(token);
      if (!actor) return { count: 0 };
      let count = 0;
      for (const [sessionToken, session] of sessions) {
        if (session.userId === actor.userId && sessionToken !== String(token)) {
          sessions.delete(sessionToken);
          count += 1;
        }
      }
      return { count };
    },

    getSettings() {
      return { sessionTtlMs: data.sessionTtlMs };
    },

    updateSettings(patch) {
      const sessionTtlMs = Number(patch && patch.sessionTtlMs);
      if (!SESSION_TTL_OPTIONS.includes(sessionTtlMs)) {
        const error = new Error('会话超时时间无效');
        error.statusCode = 400;
        throw error;
      }
      data.sessionTtlMs = sessionTtlMs;
      const currentTime = Number(now());
      for (const session of sessions.values()) session.expiresAt = currentTime + sessionTtlMs;
      persist();
      return this.getSettings();
    },
  };
}

function tokenFromCookie(header, name = COOKIE_NAME) {
  if (typeof header !== 'string' || !header) return '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function sessionCookie(token, { secure = false, maxAgeSec = 43_200 } = {}) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(String(token || ''))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(Number(maxAgeSec) || 0))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function expiredSessionCookie({ secure = false } = {}) {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

module.exports = {
  SESSION_TTL_MS,
  SESSION_TTL_OPTIONS,
  FAILURE_WINDOW_MS,
  MAX_FAILURES,
  ROLES,
  ROLE_LABELS,
  createAuthManager,
  tokenFromCookie,
  sessionCookie,
  expiredSessionCookie,
};
