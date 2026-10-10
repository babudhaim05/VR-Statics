import { loadConfig, signSession } from './server.mjs';

// Operator-only tool. Run on the trusted server, never in Unity or public CI logs.
try {
  const subject = process.argv[2];
  if (!subject) throw new Error('Usage: npm run issue-session -- participant-session-01');
  console.log(signSession(loadConfig(), subject));
} catch (error) { console.error(error.message); process.exitCode = 1; }
