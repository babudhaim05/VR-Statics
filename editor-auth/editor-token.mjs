import { issueSession, exchange } from './issuer.mjs';
try {
  // Private stdout pipe consumed by the Unity provider. Never run visibly or log stdout.
  process.stdout.write(JSON.stringify(await exchange(issueSession())));
} catch (error) {
  process.stderr.write(error.message.startsWith('Token endpoint HTTP ') ? error.message : 'Editor token renewal failed.');
  process.exitCode = 1;
}
