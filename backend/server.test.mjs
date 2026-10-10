import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createTokenServer, loadConfig, signSession, verifySession } from './server.mjs';

const config = () => loadConfig({ CONVAI_API_KEY: 'fake-server-secret', AUTH_MODE: 'session', SESSION_SIGNING_SECRET: 's'.repeat(64) });
async function fixture(t, options = {}) {
  const cfg = config();
  const server = createTokenServer(cfg, options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${signSession(cfg, 'test-session')}` };
  return { url, headers, cfg };
}

test('local mode cannot bind publicly; hosted mode requires signing secret', () => {
  assert.throws(() => loadConfig({ CONVAI_API_KEY: 'fake', HOST: '0.0.0.0' }), /127.0.0.1/);
  assert.throws(() => loadConfig({ CONVAI_API_KEY: 'fake', AUTH_MODE: 'session' }), /signing secret/);
  assert.throws(() => loadConfig({}), /CONVAI_API_KEY/);
});

test('sessions reject tampering, expiry, future issue time, and wrong audience', () => {
  const cfg = config();
  const token = signSession(cfg, 'test-session', 1000);
  assert.equal(verifySession(cfg, `Bearer ${token}`, 1001), 'test-session');
  assert.equal(verifySession(cfg, `Bearer ${token}`, 1900), null);
  assert.equal(verifySession(cfg, `Bearer ${token}`, 999), null);
  assert.equal(verifySession({ ...cfg, audience: 'another-game' }, `Bearer ${token}`, 1001), null);
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url');
  assert.equal(verifySession(cfg, `Bearer ${parts.join('.')}`, 1001), null);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: cfg.issuer, aud: cfg.audience, iat: 1000, exp: 1900 })).toString('base64url');
  const content = `${header}.${payload}`;
  const signature = createHmac('sha256', cfg.signingSecret).update(content).digest('base64url');
  assert.equal(verifySession(cfg, `Bearer ${content}.${signature}`, 1001), null);
});

test('missing player auth fails before contacting Convai', async t => {
  let calls = 0;
  const { url } = await fixture(t, { fetchImpl: async () => { calls++; } });
  const res = await fetch(`${url}/v1/convai/token`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  assert.equal(calls, 0);
});

test('returns only fresh token fields; sends private key only to fixed upstream', async t => {
  let calls = 0;
  const expirationTime = new Date(Date.now() + 120000).toISOString();
  const { url, headers } = await fixture(t, { fetchImpl: async (destination, options) => {
    calls++;
    assert.equal(destination, 'https://api.convai.com/user/connect');
    assert.equal(options.headers['CONVAI-API-KEY'], 'fake-server-secret');
    assert.equal(options.body, '{}');
    assert.equal(options.redirect, 'error');
    return Response.json({ apiAuthToken: `fake-short-token-${calls}`, expirationTime, apiKey: 'never-return-this' });
  } });
  for (let i = 1; i <= 2; i++) {
    const res = await fetch(`${url}/v1/convai/token`, { method: 'POST', headers, body: '{}' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { apiAuthToken: `fake-short-token-${i}`, expirationTime });
  }
  assert.equal(calls, 2);
});

test('upstream rejection does not expose its body or secrets', async t => {
  const { url, headers } = await fixture(t, { fetchImpl: async () => new Response('private-upstream-details', { status: 401 }) });
  const res = await fetch(`${url}/v1/convai/token`, { method: 'POST', headers, body: '{}' });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: 'convai_token_unavailable' });
});

test('rejects malformed or expired upstream tokens', async t => {
  let payload = { apiAuthToken: ' ' };
  const { url, headers } = await fixture(t, { fetchImpl: async () => Response.json(payload) });
  const request = () => fetch(`${url}/v1/convai/token`, { method: 'POST', headers, body: '{}' });
  assert.equal((await request()).status, 502);
  payload = { apiAuthToken: 'token', expirationTime: '2000-01-01T00:00:00Z' };
  assert.equal((await request()).status, 502);
});

test('rejects large bodies, wrong methods, browser origins, and client parameters', async t => {
  const { url, headers } = await fixture(t, { fetchImpl: async () => { throw new Error('must not call'); } });
  const endpoint = `${url}/v1/convai/token`;
  assert.equal((await fetch(endpoint)).status, 405);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}' })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: 'x'.repeat(5000) })).status, 413);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: '{"url":"https://untrusted.example"}' })).status, 400);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: '{' })).status, 400);
});

test('rate limit prevents excess minting and resets after one minute', async t => {
  let time = Date.now();
  let calls = 0;
  const { url, headers } = await fixture(t, { now: () => time, fetchImpl: async () => { calls++; return Response.json({ apiAuthToken: 'fake-token' }); } });
  const request = () => fetch(`${url}/v1/convai/token`, { method: 'POST', headers, body: '{}' });
  for (let i = 0; i < 6; i++) assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 429);
  assert.equal(calls, 6);
  time += 60001;
  assert.equal((await request()).status, 200);
});

test('upstream timeout returns a bounded generic failure', async t => {
  const cfg = config();
  cfg.upstreamTimeoutMs = 30;
  const server = createTokenServer(cfg, { fetchImpl: async (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('private-error')), { once: true });
  }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/convai/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signSession(cfg, 'timeout-test')}` }, body: '{}',
  });
  assert.equal(res.status, 504);
  assert.deepEqual(await res.json(), { error: 'convai_timeout' });
});

test('oversized upstream payload is rejected', async t => {
  const { url, headers } = await fixture(t, { fetchImpl: async () => Response.json({ apiAuthToken: 'x'.repeat(70000) }) });
  assert.equal((await fetch(`${url}/v1/convai/token`, { method: 'POST', headers, body: '{}' })).status, 502);
});
