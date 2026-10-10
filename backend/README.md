# VR Statics Convai token backend

Keeps the Convai account API key on the server. Unity calls `POST /v1/convai/token` with `{}`; the server calls `https://api.convai.com/user/connect` using `CONVAI-API-KEY` and returns only `apiAuthToken` and optional `expirationTime`. Each request mints a fresh token. No conversations or student answers pass through this service.

Contract checked against Convai SDK 4.6.1's `Documentation~/SERVER-AUTHENTICATION.md` and `EndpointAuthTokenProvider.cs`. This backend is prepared for the supplied VR-Statics repository; it is not deployed or live-tested against your Convai account yet.

## Local Editor setup

Requires Node 20.19+; no npm dependencies are needed.

1. Copy `.env.example` to `.env` inside this folder.
2. Enter your API key privately in `CONVAI_API_KEY`. Keep `AUTH_MODE=local` and `HOST=127.0.0.1`.
3. Run `npm test`, then `npm start` from this folder. The server listens on port 8787. `/health` reports liveness without secrets.
4. In Unity's Convai settings choose **Auth Token (server)**. Set endpoint URL to `http://127.0.0.1:8787/v1/convai/token`, HTTP method **POST**, response field **apiAuthToken**, and no auth headers for this loopback-only test.
5. Restart Play in TutorTest and test text/voice. Keep the backend process running. Clear the stored project API key before making a distributed build; changing the mode alone does not prove the old key was removed from the asset.

Local mode refuses public interfaces. Quest's `127.0.0.1` refers to the headset, not your PC: use the hosted HTTPS endpoint for standalone Quest tests. Do not expose local mode through a tunnel or proxy.

## Hosted controlled tests

The Dockerfile runs as an unprivileged user. Build it with `docker build -t vr-statics-tutor .`. Use a container host with HTTPS termination and configure these **server-side** environment variables in its secret settings:

- `CONVAI_API_KEY`: your Convai account key.
- `AUTH_MODE=session`, `HOST=0.0.0.0`, `PORT`: the host's assigned port (default 8787).
- `SESSION_SIGNING_SECRET`: a random server-only secret, at least 32 bytes. Generate it locally with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- `SESSION_ISSUER=vr-statics`, `SESSION_AUDIENCE=vr-statics-tutor`.

For a supervised prototype, an operator runs `npm run issue-session -- participant-session-01` on a trusted machine with the same server configuration. It outputs a 15-minute game access token. Give each tester a pseudonymous session ID. Keep signing secrets and Convai keys off Unity devices. Do not run the issuing command in public CI logs.

In Unity choose Auth Token mode, configure `https://YOUR-HOST/v1/convai/token`, POST, response field `apiAuthToken`, and an `Authorization` header whose value is `Bearer GAME_SESSION_TOKEN`. The game access token and the returned Convai token are different credentials. The temporary header is suitable only for controlled local/supervised testing: it expires and should not be baked into distributed builds. For normal participant sessions, the game's login service must provide fresh player access tokens in memory through the SDK's `IConvaiAuthTokenProvider`. No permanent shared client password is provided.

The service accepts only signed, unexpired HS256 sessions for its configured issuer/audience, with a maximum 15-minute lifetime. It limits mint requests to 6 per session/minute and 60 total/minute, with 8 concurrent upstream calls. Request/response sizes are bounded and upstream calls time out at 8 seconds. No credentials or upstream error bodies are logged or returned. Native Unity requests require no CORS; browser origins are rejected.

This is a single-process prototype: do not run multiple replicas without shared rate limits. The operator must gate session issuance and usage budget; rate limits do not cap total Convai spending or restrict token use to one character. Rotating the signing secret invalidates game sessions but does not revoke already minted Convai credentials. Before participant deployment, confirm token scope/expiry, player login, consent/data handling, backend availability and Quest behavior with the team.

## Verification

`npm test` uses mocked Convai responses and fake credentials. It tests auth/tampering/expiry, secret redaction, fresh minting, input bounds, provider rejection, expired response tokens, rate limits and timeout behavior. It does not contact Convai. Live token minting, Unity Auth Token connection, HTTPS hosting and Quest acceptance remain separate checks.

Keep `.env` and the Unity credentials asset out of GitHub. Publish only this reviewed backend folder; the Unity checkout uses its own version-control workflow.
