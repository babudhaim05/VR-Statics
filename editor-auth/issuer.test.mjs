import test from 'node:test';
import assert from 'node:assert/strict';
import { issueSession, endpoint } from './issuer.mjs';
import { verifySession } from '../backend/server.mjs';
const env = { SESSION_SIGNING_SECRET: 'test-only-'.repeat(5), EDITOR_SUBJECT: 'editor-test' };
const config = { signingSecret: env.SESSION_SIGNING_SECRET, issuer: 'vr-statics', audience: 'vr-statics-tutor' };
test('operator sessions match backend contract, including actual expiry boundary', () => {
  const token = issueSession(env, { now: 100, lifetime: 2 });
  assert.equal(verifySession(config, `Bearer ${token}`, 101), 'editor-test');
  assert.equal(verifySession(config, `Bearer ${token}`, 102), null);
  assert.equal(verifySession(config, `Bearer ${issueSession(env, { now: 102 })}`, 103), 'editor-test');
});
test('reject wrong scheme, signature, issuer, audience and future issuance', () => {
  const token = issueSession(env, { now: 100 });
  for (const header of [`bearer ${token}`, `Bearer  ${token}`, `Bearer ${token} `]) assert.equal(verifySession(config, header, 101), null);
  for (const changes of [{ SESSION_SIGNING_SECRET: 'wrong-key-'.repeat(5) }, { SESSION_ISSUER: 'wrong' }, { SESSION_AUDIENCE: 'wrong' }])
    assert.equal(verifySession(config, `Bearer ${issueSession({ ...env, ...changes }, { now: 100 })}`, 101), null);
  assert.equal(verifySession(config, `Bearer ${token}`, 99), null);
});
test('issuer requires signing configuration and bounded lifetime, no Convai key', () => {
  assert.throws(() => issueSession({}));
  assert.throws(() => issueSession(env, { lifetime: 901 }));
  assert.throws(() => endpoint({ TOKEN_ENDPOINT: 'http://example.com/token' }));
  assert.throws(() => endpoint({ TOKEN_ENDPOINT: 'https://user:password@example.com/token' }));
});
