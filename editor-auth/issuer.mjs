// Trusted operator only. This is not a public login service or a player issuer.
import { createHmac } from 'node:crypto';

export function issueSession(env = process.env, { now = Math.floor(Date.now() / 1000) - 5, lifetime = 900 } = {}) {
  const secret = env.SESSION_SIGNING_SECRET || '';
  const subject = env.EDITOR_SUBJECT || 'tutor-editor-test';
  if (Buffer.byteLength(secret) < 32 || !/^[A-Za-z0-9_-]{1,80}$/.test(subject))
    throw new Error('Local issuer configuration unavailable.');
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 900)
    throw new Error('Invalid session lifetime.');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: subject, iss: env.SESSION_ISSUER || 'vr-statics',
    aud: env.SESSION_AUDIENCE || 'vr-statics-tutor', iat: now, exp: now + lifetime })).toString('base64url');
  const content = `${header}.${payload}`;
  return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`;
}

export function endpoint(env = process.env) {
  const url = new URL(env.TOKEN_ENDPOINT || 'https://vr-statics-tutor.onrender.com/v1/convai/token');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('An HTTPS token endpoint without embedded credentials is required.');
  return url.href;
}

export async function exchange(session, env = process.env) {
  const response = await fetch(endpoint(env), {
    method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(55000),
  });
  if (!response.ok) throw new Error(`Token endpoint HTTP ${response.status}`);
  const data = await response.json();
  if (typeof data.apiAuthToken !== 'string' || !data.apiAuthToken.trim() || data.apiAuthToken.length > 16384)
    throw new Error('Invalid token response.');
  if (data.expirationTime !== undefined && (!Number.isFinite(Date.parse(data.expirationTime)) || Date.parse(data.expirationTime) <= Date.now()))
    throw new Error('Invalid token expiry.');
  return { token: data.apiAuthToken, expirationTime: data.expirationTime };
}
