# Nanocodex per-user credential broker

This private ordinary Cloudflare Worker owns provider credentials for managed
Nanocodex users. It has `workers_dev = false`, no routes, and is reachable only
through a Service Binding. It does not use Workers for Platforms.

Each local Nanocodex user ID selects one `UserCredentialBroker` Durable Object.
An `AgentSubjectDirectory` stores only the mapping from a hidden opaque Durable
Object subject to that user ID. Agent and room code retain the subject, never a
provider credential or credential selector.

## Private managed contract

These routes are Service-Binding-only. `:subject` is the raw opaque agent DO ID
and `:user` is the user ID resolved from the authenticated Nanocodex session by
managed. Neither value is accepted from a public browser request.

| Method and path | Request | Successful response |
| --- | --- | --- |
| `PUT /subjects/:subject` | `{ "user_id": "..." }` | `200 {"status":"bound"}` or idempotent `unchanged`; `409` if owned by another user |
| `DELETE /subjects/:subject` | `{ "user_id": "..." }` | `204`; `409` on owner mismatch |
| `GET /users/:user/credentials` | none | secret-free status |
| `PUT /users/:user/credentials/openai` | `{ "api_key": "..." }` | `204` |
| `DELETE /users/:user/credentials/openai` | none | `204` |
| `POST /users/:user/credentials/chatgpt/login` | none | pending device-login status |
| `POST /users/:user/credentials/chatgpt/login/status` | none | pending/authenticated/expired status; polling and token exchange stay server-side |
| `DELETE /users/:user/credentials/chatgpt` | none | `204` |
| `POST /users/:user/credentials/chatgpt/local-claim` | none | secret-free status; development only |

The local claim is enabled only when `ENVIRONMENT` is `local`, `development`,
or `test` and `ALLOW_LOCAL_CREDENTIAL_CLAIM=true`. It consumes
`LOCAL_CHATGPT_BOOTSTRAP` from the broker environment, accepts no provider
material in the request, and the subject directory permits one claiming user.
Production returns `404` even if the endpoint is called.
When this local-claim profile is enabled, starting an interactive ChatGPT
device login fails with `409 local_credential_claim_required`.

## Model egress

The managed runtime sends the exact hidden `x-nanocodex-subject` header and the
literal `Authorization: Bearer NANOCODEX_PROVIDER_CREDENTIAL` placeholder.
All model operations target `https://nanocodex.internal/v1/...`; callers cannot
select OpenAI versus ChatGPT or an upstream URL. The broker resolves subject to
user, selects that user's active credential, strips the subject, injects the
credential, and forwards only allowlisted headers to one exact provider URL.

Exact supported paths are `GET /v1/responses` with the required Responses
WebSocket beta/upgrade headers, plus JSON `POST /v1/search`,
`/v1/images/generations`, and `/v1/images/edits`. Queries, redirects, provider
headers, incorrect placeholders, other methods, paths, hosts, schemes, and
ports fail closed. The fixed ChatGPT relay configuration remains supported for
the environments where Cloudflare-to-ChatGPT WebSockets require it.

The approved OpenAI endpoint and configured terminating relay are trusted
credential recipients. Normal HTTP response headers are stripped of known
credential/cookie fields, but a WebSocket peer necessarily controls its frames;
bind the broker only to the owned managed Worker and use only an audited relay
that cannot reflect injected credentials.

All API keys, ChatGPT access/refresh state, device-login state, and refresh
markers are AES-256-GCM encrypted before Durable Object storage. Production
requires `CREDENTIAL_ENCRYPTION_KEY`; `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`
supports online key rotation. Status and control responses never return an API
key, access token, refresh token, device auth ID, verifier, or challenge.

## Validation and deployment

```sh
npm ci
npm run check
```

Production deployment accepts only the encryption key and private readiness
probe token. Provider credentials are provisioned per user through the private
control API after authentication; there is no deployment-global provider mode
or provider bootstrap.
