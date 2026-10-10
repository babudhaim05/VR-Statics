import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const CONVAI_URL = 'https://api.convai.com/user/connect';
const MAX_BODY = 4096;
const MAX_UPSTREAM = 65536;

export function loadConfig(env = process.env) {
  const config = {
    apiKey: env.CONVAI_API_KEY?.trim(),
    mode: env.AUTH_MODE || 'local',
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8787),
    signingSecret: env.SESSION_SIGNING_SECRET || '',
    issuer: env.SESSION_ISSUER || 'vr-statics',
    audience: env.SESSION_AUDIENCE || 'vr-statics-tutor',
    upstreamTimeoutMs: 8000,
  };
  if (!config.apiKey) throw new Error('CONVAI_API_KEY must be set on the server.');
  if (!['local', 'session'].includes(config.mode)) throw new Error('Invalid AUTH_MODE.');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid PORT.');
  if (config.mode === 'local' && config.host !== '127.0.0.1')
    throw new Error('Local mode must bind only to 127.0.0.1. Hosted access requires session mode.');
  if (config.mode === 'session' && Buffer.byteLength(config.signingSecret) < 32)
    throw new Error('Session mode requires a server-only signing secret of at least 32 bytes.');
  return config;
}

export function signSession(config, subject, now = Math.floor(Date.now() / 1000)) {
  if (config.mode !== 'session' || Buffer.byteLength(config.signingSecret) < 32)
    throw new Error('Configure session mode and its signing secret first.');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(subject)) throw new Error('Use a pseudonymous session ID (letters, digits, underscore, hyphen).');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: subject, iss: config.issuer, aud: config.audience, iat: now, exp: now + 900 })).toString('base64url');
  const content = `${header}.${payload}`;
  return `${content}.${createHmac('sha256', config.signingSecret).update(content).digest('base64url')}`;
}

export function verifySession(config, authorization, now = Math.floor(Date.now() / 1000)) {
  if (typeof authorization !== 'string' || authorization.length > 4096 || !authorization.startsWith('Bearer ')) return null;
  try {
    const parts = authorization.slice(7).split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    const [header, payload, signature] = parts;
    const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString());
    if (parsedHeader.alg !== 'HS256' || parsedHeader.typ !== 'JWT') return null;
    const expected = createHmac('sha256', config.signingSecret).update(`${header}.${payload}`).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(claims.sub) || claims.iss !== config.issuer || claims.aud !== config.audience ||
        !Number.isInteger(claims.exp) || !Number.isInteger(claims.iat) || claims.iat > now ||
        claims.exp <= now || claims.exp <= claims.iat || claims.exp - claims.iat > 900) return null;
    return claims.sub;
  } catch { return null; }
}

function respond(res, status, payload) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

async function readLimited(stream, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error('body_limit');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createTokenServer(config, { fetchImpl = fetch, now = Date.now } = {}) {
  const buckets = new Map();
  let globalBucket = { started: now(), count: 0 };
  let activeRequests = 0;
  function limited(subject) {
    const time = now();
    for (const [key, value] of buckets) if (time - value.started >= 60000) buckets.delete(key);
    if (time - globalBucket.started >= 60000) globalBucket = { started: time, count: 0 };
    const bucket = buckets.get(subject) || { started: time, count: 0 };
    if (bucket.count >= 6 || globalBucket.count >= 60 || activeRequests >= 8) return true;
    bucket.count++; globalBucket.count++;
    buckets.set(subject, bucket);
    return false;
  }
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return respond(res, 200, { status: 'ok' });
    if (req.url !== '/v1/convai/token') return respond(res, 404, { error: 'not_found' });
    if (req.method !== 'POST') return respond(res, 405, { error: 'method_not_allowed' });
    // Native Unity needs no CORS. Reject browser requests to the unauthenticated local endpoint.
    if (req.headers.origin) return respond(res, 403, { error: 'browser_origin_not_supported' });
    const subject = config.mode === 'local' ? 'local-editor' : verifySession(config, req.headers.authorization, Math.floor(now() / 1000));
    if (!subject) return respond(res, 401, { error: 'invalid_session' });
    if (limited(subject)) return respond(res, 429, { error: 'rate_limited' });
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
      return respond(res, 415, { error: 'json_required' });
    if (Number(req.headers['content-length']) > MAX_BODY) return respond(res, 413, { error: 'request_too_large' });
    activeRequests++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', cancel);
    try {
      let body;
      try { body = JSON.parse((await readLimited(req, MAX_BODY)) || '{}'); }
      catch (error) { return respond(res, error.message === 'body_limit' ? 413 : 400, { error: 'invalid_request' }); }
      // Client cannot choose upstream URL, account key, or extra token scopes.
      if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length)
        return respond(res, 400, { error: 'empty_object_required' });
      const upstream = await fetchImpl(CONVAI_URL, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'CONVAI-API-KEY': config.apiKey }, body: '{}',
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return respond(res, 502, { error: 'convai_token_unavailable' });
      }
      const payload = JSON.parse(await readLimited(upstream.body, MAX_UPSTREAM));
      if (typeof payload.apiAuthToken !== 'string' || !payload.apiAuthToken.trim() || payload.apiAuthToken.length > 16384)
        return respond(res, 502, { error: 'invalid_convai_response' });
      const result = { apiAuthToken: payload.apiAuthToken.trim() };
      if (payload.expirationTime !== undefined) {
        if (typeof payload.expirationTime !== 'string' || !Number.isFinite(Date.parse(payload.expirationTime)) || Date.parse(payload.expirationTime) <= now())
          return respond(res, 502, { error: 'invalid_convai_response' });
        result.expirationTime = payload.expirationTime;
      }
      respond(res, 200, result);
    } catch {
      respond(res, controller.signal.aborted ? 504 : 502, { error: controller.signal.aborted ? 'convai_timeout' : 'convai_token_unavailable' });
    } finally {
      clearTimeout(timeout);
      res.off('close', cancel);
      activeRequests--;
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const server = createTokenServer(config);
    server.on('error', () => { console.error('Backend could not listen. Check HOST and PORT.'); process.exitCode = 1; });
    server.listen(config.port, config.host, () => console.log(`VR Statics token backend listening on ${config.host}:${config.port} (${config.mode}).`));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
