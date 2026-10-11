// Prints status/expiry metadata only; credentials remain in memory.
import { setTimeout as delay } from 'node:timers/promises';
import { issueSession, exchange, endpoint } from './issuer.mjs';
try {
  await exchange(issueSession());
  console.log('Fresh exchange: HTTP 200; apiAuthToken validated (not displayed).');
  // Mint a real short-lived credential accepted by the same backend contract.
  // Start the expiry clock only after a cold-start wakeup above.
  // Allow five seconds for ordinary machine/server clock skew; no backend checks are relaxed.
  const issued = Math.floor(Date.now() / 1000) - 5;
  const lifetime = 15;
  const shortSession = issueSession(process.env, { now: issued, lifetime });
  await exchange(shortSession);
  console.log('Short-lived backend credential: accepted before expiry.');
  await delay(Math.max(0, (issued + lifetime + 1) * 1000 - Date.now()));
  const expired = await fetch(endpoint(), { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${shortSession}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(55000) });
  await expired.body?.cancel();
  if (expired.status !== 401) throw new Error('Expired credential did not return HTTP 401.');
  console.log('Same credential after real expiry: HTTP 401.');
  await exchange(issueSession());
  console.log('Renewed credential after expiry: HTTP 200; apiAuthToken validated (not displayed).');
} catch (error) {
  console.error(error.message.startsWith('Token endpoint HTTP ') ? error.message : 'Live renewal verification failed.');
  process.exitCode = 1;
}
