import crypto from 'node:crypto';

export const COOKIE_NAME = 'fb_access';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// The same value for every user: it proves knowledge of the access code and nothing else.
// Rotating ACCESS_CODE (or SESSION_SECRET) changes it, invalidating every existing cookie.
export function accessToken(sessionSecret, accessCode) {
  return crypto.createHmac('sha256', sessionSecret).update(accessCode).digest('hex');
}

// Hashing both sides first gives equal-length buffers, so timingSafeEqual never throws
// and the comparison time doesn't reveal the expected length.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!name || name in cookies) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function createAuth({ accessCode, sessionSecret, secureCookies = false }) {
  if (!accessCode) throw new Error('ACCESS_CODE is not set');
  if (!sessionSecret) throw new Error('SESSION_SECRET is not set');
  const token = accessToken(sessionSecret, accessCode);

  return {
    checkCode(code) {
      return typeof code === 'string' && safeEqual(code, accessCode);
    },

    isUnlocked(req) {
      const value = parseCookies(req.headers.cookie)[COOKIE_NAME];
      return typeof value === 'string' && safeEqual(value, token);
    },

    setCookie(res) {
      const attrs = [
        `${COOKIE_NAME}=${token}`,
        'Path=/',
        `Max-Age=${MAX_AGE_SECONDS}`,
        'HttpOnly',
        'SameSite=Strict',
      ];
      if (secureCookies) attrs.push('Secure');
      res.setHeader('Set-Cookie', attrs.join('; '));
    },
  };
}
