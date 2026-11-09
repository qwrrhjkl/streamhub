const crypto = require('node:crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 60 * 1000;
const MAX_FAILURES = 5;
const COOKIE_NAME = 'streamhub_session';
const INVALID_LOGIN = Object.freeze({
  ok: false,
  code: 'invalid',
  message: '\u7528\u6237\u540d\u6216\u5bc6\u7801\u9519\u8bef',
});

function digest(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

function credentialMatches(supplied, configured) {
  return crypto.timingSafeEqual(digest(supplied), digest(configured));
}

function createAuthManager({ username, password, now = Date.now, tokenFactory } = {}) {
  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    throw new Error('StreamHub authentication credentials are required');
  }
  const createToken = tokenFactory || (() => crypto.randomBytes(32).toString('base64url'));
  const sessions = new Map();
  const failuresByIp = new Map();

  function currentFailures(ip, currentTime) {
    const cutoff = currentTime - FAILURE_WINDOW_MS;
    const failures = (failuresByIp.get(ip) || []).filter(timestamp => timestamp > cutoff);
    if (failures.length) failuresByIp.set(ip, failures);
    else failuresByIp.delete(ip);
    return failures;
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

      const usernameValid = credentialMatches(suppliedUsername, username);
      const passwordValid = credentialMatches(suppliedPassword, password);
      if (!usernameValid || !passwordValid) {
        failures.push(currentTime);
        failuresByIp.set(clientIp, failures);
        return { ...INVALID_LOGIN };
      }

      failuresByIp.delete(clientIp);
      const token = String(createToken());
      const session = { username, expiresAt: currentTime + SESSION_TTL_MS };
      sessions.set(token, session);
      return { ok: true, token, username, expiresAt: session.expiresAt };
    },

    resolve(token) {
      if (!token) return null;
      const session = sessions.get(String(token));
      if (!session) return null;
      if (session.expiresAt <= Number(now())) {
        sessions.delete(String(token));
        return null;
      }
      return { ...session };
    },

    logout(token) {
      return token ? sessions.delete(String(token)) : false;
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
  FAILURE_WINDOW_MS,
  MAX_FAILURES,
  createAuthManager,
  tokenFromCookie,
  sessionCookie,
  expiredSessionCookie,
};
