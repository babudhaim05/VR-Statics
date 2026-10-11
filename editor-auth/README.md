# Editor authentication handoff

This package supplies the previously unshared Editor helper and external trusted-operator issuer. It does not replace the integrated guide, graph, narration, hints, or supported Convai authentication-provider interface. It does not implement standalone/Quest login.

## Dependencies and files

Validated with Unity 6000.5.2f1, Convai SDK 4.6.1, `com.unity.nuget.newtonsoft-json` 3.2.2, and Node 24.19.0. Node minimum is 20.19.0; no npm dependencies are required. The backend package is 0.1.0. Keep the existing project package pins.

- `Unity/ConvaiDemoEditorAuth.cs` and its existing `.meta`: the Editor-only provider. Preserve GUID `19e8f187768535c45b36c0f33df7d764`. Replace the existing file at `Assets/Project/Game/Content/ConvaiStoryDemo/Scripts/ConvaiDemoEditorAuth.cs` in place; do not import a second copy. Projects without that helper can add this file and meta together to their owned integration folder. No scene or graph import is necessary.
- `issuer.mjs`: operator issuance and HTTPS exchange; independent of task folders and backend imports.
- `editor-token.mjs`: private subprocess response consumed by Unity.
- `editor-config.example.json`, `issuer.env.example`: placeholders only.
- `issuer.test.mjs`: backend compatibility and invalid-credential tests.
- `verify-live.mjs`: safe status-only fresh/expiry/renewal verification.
- Backend authentication source: `../backend/server.mjs`, especially `verifySession` and `createTokenServer`. This is the repository source, not proof of the currently deployed revision.

## Authorizing another developer

There is currently **no deployed developer login/issuer HTTP endpoint**. A GitHub account, repository membership, or Render account does not authorize calls to the token endpoint. The local issuer requires the backend's signing secret and is suitable only for an already authorized trusted operator. Possession of that secret grants issuance authority; do not distribute it to ordinary clients or put it into a player build.

The backend owner must approve the developer and provision operator signing configuration using the team's existing secure channel/secret manager, outside chat, repository, and Unity Assets. If the developer should not have signing authority, the owner must supply an authenticated issuance service or supervised short-lived credentials instead. That service is not implemented here; do not invent a login URL or share the account key as a workaround.

1. Obtain this non-secret folder and install its Unity source/meta as described above. Keep the issuer source outside Unity Assets (for example in this backend checkout).
2. Create a private directory outside all repositories and outside the Unity project, accessible only to the authorized operator. Save `editor-config.json` there using the placeholder schema. Set `node` to the installed Node executable, `script` to this folder's `editor-token.mjs`, and `workingDirectory` to that private directory.
3. In that private directory, create `.env` using `issuer.env.example`. The owner supplies `SESSION_SIGNING_SECRET`, confirms issuer/audience against deployed configuration, and assigns `EDITOR_SUBJECT`. **No CONVAI_API_KEY is needed locally.** The Convai account key stays on Render.
4. Before starting Unity, set `VR_STATICS_EDITOR_AUTH_CONFIG` to the absolute private JSON path. A per-user environment variable may be used; restart Unity/Hub to inherit it. The legacy `Library/ConvaiDemoEditorAuth.json` path is supported only for migration and is disposable when Library is cleared.
5. Use the guide's existing provider lifecycle. Under `#if UNITY_EDITOR`, create a delegate with `VRStatics.Content.ConvaiStoryDemo.ConvaiDemoEditorAuth.CreateProvider()` and have the existing provider return its `GetTokenAsync(cancellationToken)` result for Editor authentication. Keep its existing registration/unregistration and runtime login path. Do not register two competing providers. The helper's automatic registration skips an already registered provider, so merely copying the file does **not** alter the integrated guide's provider.
6. Remove saved manual Authorization credentials from shared settings after checking your provider uses the delegate. Keep Auth Token mode and the endpoint/response-field configuration. Do not add a raw API key. Generated credentials remain in process memory and the private stdout pipe only.

Example delegation (inside the existing provider, Editor branch only):

```csharp
var issuer = ConvaiDemoEditorAuth.CreateProvider();
return await issuer.GetTokenAsync(cancellationToken);
```

The local checkout available for this handoff contains the original helper, but not the separate cs22 guide's provider source. Its integration branch must be applied there by the owning developer; it has not been silently substituted with the desktop demo.

## Two different credentials

| Credential | Purpose | Lifetime/storage |
| --- | --- | --- |
| Backend access session JWT | Sent as `Authorization: Bearer <session JWT>` to Render; authorizes issuance | HS256 signed, maximum 900 seconds; never stored in Unity assets |
| Temporary Convai token | Returned as `apiAuthToken`; passed to Convai SDK `AuthTokenResult.Succeeded` | Use returned `expirationTime`; memory only, never use as the Render Authorization credential |
| Signing secret | Allows trusted operator to create backend sessions | Owner-provisioned secret outside VCS; never a player credential |
| Convai account key | Render's upstream call to Convai | Server-only; absent from this issuer and Unity |

## Issuer and endpoint contracts

The current issuer is a Node subprocess, not HTTP. Input is the private environment configuration above. It issues a fresh session for each request, then calls Render. Success stdout is one JSON object: `{ "token": "<temporary Convai token>", "expirationTime": "<UTC ISO timestamp if supplied>" }`. Failure exits nonzero with a generic error or HTTP status on stderr. Stdout contains a credential: consume it privately, never invoke this script in a visible console, capture it in CI logs, or persist it. The C# provider discards stderr and never logs stdout.

Backend request:

```http
POST /v1/convai/token
Authorization: Bearer <BACKEND_SESSION_JWT>
Content-Type: application/json

{}
```

Success: HTTP 200, no-store JSON `{ "apiAuthToken": "<temporary Convai token>", "expirationTime": "<UTC ISO timestamp, optional>" }`. cs22's configured response field `apiAuthToken` is correct. A 401 is `{ "error": "invalid_session" }`; it means backend authentication failed before the upstream Convai call in this source. An upstream Convai rejection maps to 502, not that 401.

The reviewed source requires exactly `Bearer ` (capital B, one space), three base64url JWT parts without surrounding whitespace, header `alg=HS256` and `typ=JWT`, matching signature, subject `[A-Za-z0-9_-]{1,80}`, exact `iss` and `aud`, integer `iat`/`exp`, `iat <= serverNow`, `exp > serverNow`, `exp > iat`, and lifetime at most 900 seconds. Default issuer/audience are `vr-statics` / `vr-statics-tutor`, but deployed environment overrides must match. There is **no scope check in this source**; verify deployed revision before concluding that applies to production.

Normal issuance uses a 900-second interval and dates `iat` five seconds before local now to accommodate small clock differences (about 895 seconds remaining). Synchronize machine clocks; no server validation is relaxed. Every provider call issues a new backend credential and exchanges it; the temporary Convai token is not cached or reused after expiry. Supply `expirationTime` to the supported SDK result. Reconnection obtains a fresh credential; this helper does not establish transparent renewal of an already connected room or standalone login. Cancellation kills the child process; a 65-second provider deadline bounds the 55-second HTTP timeout. Render cold starts can consume that deadline. Rate limits are six accepted requests per subject/minute, 60 globally/minute, and eight concurrent.

## Verification

Run unit tests from the repository root:

```powershell
node --test backend/server.test.mjs editor-auth/issuer.test.mjs
```

From the private directory containing the provisioned `.env`, run the **status-only** verifier (not editor-token.mjs):

```powershell
node --env-file=.env C:/PATH/TO/VR-Statics/editor-auth/verify-live.mjs
```

It validates a normal fresh exchange, then a real 15-second backend session before expiry, waits until that session actually expires, expects 401, and exchanges a renewed normal session successfully. Tokens are never printed or saved. This checks backend-credential expiry/renewal, **not expiry of the returned Convai token, a 15-minute wall-clock soak, or a live Unity reconnection**. Those are separate checks. Do not repeatedly run it within the per-subject rate limit.

## 401 investigation and evidence (11 October 2026)

- All 15 backend/issuer regression tests passed locally.
- Hosted tests passed: fresh HTTP 200 with validated `apiAuthToken`, short-lived credential accepted, that same credential rejected with 401 after actual expiry, renewed credential HTTP 200.
- A prior just-issued request was rejected; retry with a five-second clock allowance passed. This suggests clock timing is worth checking but does not identify cs22's rejection.
- Local backend source revision before this package: `79b0914afada3e3b02d5ecd3c20def43f3444385`. An earlier screenshot showed that deployment. **The current deployed revision is unconfirmed.**
- Connected Render dashboard redirected to sign-in. Its logs were not accessible in this session. This source logs no authentication reason, so historical 401s may not contain enough evidence even after sign-in.
- cs22's failure time/request correlation and failing header were not available. Its precise rejection remains unconfirmed; do not label it “expired.”

Owner follow-up: confirm service `srv-db585eo473hc73a7g9ag`'s current deployed commit, check logs around the failing request, and compare auth mode/issuer/audience/signing configuration privately. Check header construction, signature/claims, server/client clocks, and any deployed scope policy without sharing tokens. If logs lack reasons, add server-side safe reason codes and a request ID in a separately reviewed change, keep the public 401 generic, and reproduce the rejection. Never log Authorization, JWT payloads, account keys, signing secrets, or returned tokens. No diagnostic backend change or production redeployment is included here.

After authentication passes in the integrated guide, complete stage-change behavior, interrupted-reply handling, scene-exit cleanup, and response-timeout checks. Recorded narration and offline fallback were already reported as passed. Quest login/testing remains separate.
