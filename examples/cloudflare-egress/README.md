# Cloudflare managed-agent credential broker

This standalone example uses only ordinary Cloudflare Workers. A managed-agent
Worker calls a private egress Worker through a
[Service Binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
The agent receives neither the real Codex OAuth credential nor static API
tokens.

It carries over the relevant
[iron-proxy](https://github.com/paradigmxyz/iron-proxy) invariants: exact
placeholders, real secrets held only at the outbound boundary, and one durable
owner for a rotating OAuth credential. It needs no dispatch namespace, Workers
for Platforms account, DNS interception, private CA, or TLS MITM.

```text
Internet client
  -> authenticated managed-agent Worker (ordinary Worker)
       -> private EGRESS Service Binding
            -> egress broker Worker (ordinary Worker, no public route)
                 -> exact policy + header allowlist + placeholder replacement
                 -> singleton Codex OAuth Durable Object
                 -> approved API, or an optional fixed Codex relay
```

## What is implemented

The broker's `AGENT_ID` and `ALLOWED_POLICIES` are deployment configuration,
not request data. The implementation contains these exact rules:

| Policy | Exact destination | Credential behavior |
| --- | --- | --- |
| `codex` | `GET https://chatgpt.com/backend-api/codex/responses`, no query, WebSocket upgrade, exact beta header | Requires `Bearer NANOCODEX_CODEX_OAUTH` and `NANOCODEX_CODEX_ACCOUNT`, then replaces both from the singleton OAuth owner. |
| `openai` | `GET https://api.openai.com/v1/responses`, no query, WebSocket upgrade, exact beta header | Requires `Bearer NANOCODEX_OPENAI_API_KEY`, then replaces it with the broker Worker's `OPENAI_API_KEY` secret. |
| `github-readonly` | `GET https://api.github.com/user`, no query | Requires `Bearer NANOCODEX_GITHUB_TOKEN`, then replaces it with the broker Worker's `GITHUB_READ_TOKEN` secret. |

Every other scheme, host, port, method, path, query, required header, or
placeholder is denied before credential resolution. Only each rule's explicit
header allowlist is forwarded. Redirects are manual and rejected rather than
followed with an injected credential. The optional Codex relay is a complete,
fixed secret URL in the broker; callers cannot select it.

The checked-in deployment enables only `codex`. For API-key mode, change
`ALLOWED_POLICIES` to only `openai` before deploying. Use a separate broker
deployment/binding for a consumer that needs `github-readonly`; do not give one
bound consumer a union of unrelated credential policies.

The Codex owner in [`src/broker.ts`](src/broker.ts) is one SQLite-backed Durable
Object selected by the fixed name `openai-codex`. It:

- returns access-token snapshots to the egress Worker but never returns its
  refresh token;
- single-flights refreshes across concurrent agent requests;
- durably marks a refresh in flight before posting the rotating token;
- stores the rotated refresh token before serving the new access token;
- performs one revision-guarded refresh and retry after an upstream 401;
- schedules proactive refresh with an alarm; and
- fails the credential dead after an ambiguous post-submit outcome, malformed
  successful response, account change, or failed post-refresh persistence.

A new bootstrap secret with a different fingerprint explicitly reseeds a dead
broker. Logs contain structural policy, status, timing, and credential revision
information, never tokens or response bodies.

## Validate locally

Node.js 22.13 or later is required.

```sh
cd examples/cloudflare-egress
npm ci
npm run check
```

The Worker-native tests cover fixed policy, default deny, exact route and
placeholder checks, header stripping, static injection, redirect blocking,
one-generation 401 recovery, concurrent refresh rotation, durable persistence,
the hidden fixed-relay rewrite, and the managed Worker's Service Binding
contract.

## Deploy two standard Workers

Deploy the private broker first:

```sh
cd examples/cloudflare-egress
npx wrangler login
npm run deploy:broker
```

First select exactly one `ALLOWED_POLICIES` value for this consumer (`codex` or
`openai`), then provision only that rule's secret. For a long-lived Codex
deployment, use a dedicated ChatGPT/Codex login. Do not share
a rotating refresh-token family with a local Codex installation: either side
can invalidate the other's token. At Wrangler's hidden prompt, set
`CODEX_OAUTH_BOOTSTRAP` to a one-line object with this shape:

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "account_id": "...",
  "fedramp": false,
  "expires_at": "2030-01-01T00:00:00Z"
}
```

`expires_at` may instead be epoch seconds or milliseconds. Never commit this
object, put it in shell history, log it, or copy an entire Codex `auth.json`.

```sh
# codex mode:
npx wrangler secret put CODEX_OAUTH_BOOTSTRAP -c wrangler.broker.jsonc
# openai mode instead:
npx wrangler secret put OPENAI_API_KEY -c wrangler.broker.jsonc
npm run deploy:agent
npx wrangler secret put AGENT_TOKEN -c wrangler.agent.jsonc
```

`GITHUB_READ_TOKEN` belongs only in a dedicated `github-readonly` broker. The broker
has `workers_dev = false` and no route. The public agent has no provider secret;
its `EGRESS` binding names the private broker Worker.

Call the example agent:

```sh
curl -i \
  -H 'Authorization: Bearer <agent-token>' \
  https://nanocodex-egress-agent-example.<subdomain>.workers.dev/blocked

curl -i -X POST \
  -H 'Authorization: Bearer <agent-token>' \
  https://nanocodex-egress-agent-example.<subdomain>.workers.dev/codex-handshake
```

The first request returns `403 destination_denied` from the private broker. The
second opens the credentialed Responses WebSocket, then immediately closes it
and returns `authenticated: true`.

## Real Codex smoke

As observed on 2026-08-22, the ChatGPT edge rejects direct Cloudflare Worker
egress with HTTP 403 even when the same subscription credential succeeds from a
native host. For that environment, configure an audited non-Cloudflare relay
with exactly one upstream:
`wss://chatgpt.com/backend-api/codex/responses`.

Store its complete unguessable HTTPS capability URL, including the path, only
in the broker:

```sh
npx wrangler secret put CODEX_RELAY_URL -c wrangler.broker.jsonc
```

The agent still requests the exact ChatGPT URL. Only after the request passes
policy and both placeholders match does the broker substitute the fixed relay
URL. The relay URL must use HTTPS on the default port, contain a non-root path,
and have no query or fragment. The bounded relay in the
[managed Cloudflare example](../cloudflare-workers/scripts/subscription-egress-proxy.mjs)
is a reference implementation, not a runtime dependency.

The managed example's local launcher is the sole exception: it generates a
random-capability relay bound to exact `127.0.0.1`, then sets a separate
development-only broker flag that permits that one cleartext loopback hop.
Without that flag, HTTP, loopback aliases, and explicit ports remain invalid;
the checked-in deployment never sets it.

The disposable live smoke selects only the current access token and account
metadata from a mode-`0600` Codex auth file; it deliberately never copies or
uploads the local refresh token. It deploys two uniquely named ordinary
Workers, verifies ingress auth and broker default-deny, proves the Service
Binding carries the upgraded WebSocket, then deletes both Workers and its
mode-`0600` temporary files:

```sh
NANOCODEX_CODEX_RELAY_URL='https://<relay-host>/v1/<capability>' \
  npm run smoke:codex
```

Without a relay, the same command directly exercises Cloudflare-to-ChatGPT
egress and currently reports the upstream 403.

## Exact security boundary

This standard-Workers design is a credential broker, not transparent runtime
egress interception:

- The managed Worker must deliberately use `env.EGRESS.fetch(...)`. Ordinary
  Workers can still call global `fetch()` to public destinations. Such a call
  has no broker-held credential, but it is not blocked by this example.
- Therefore this fits a managed agent runtime whose Worker code we control. It
  is not an enforced network sandbox for arbitrary tenant-supplied Worker code.
- A Service Binding is a capability. Bind it only to Workers allowed to use the
  configured routes. Cloudflare does not provide the callee a security identity
  for the calling Worker, so use a dedicated broker deployment/binding when
  agents need different policy sets.
- Keep `AGENT_ID` and `ALLOWED_POLICIES` fixed on the broker. Never accept a
  policy, upstream URL, relay URL, or secret template from an agent request.
- Add API routes only as complete scheme/host/port/method/path/query rules. A
  hostname-only rule creates an authenticated confused deputy.
- An allowed endpoint that reflects its authorization header can reveal the
  injected secret. Permit narrow non-reflecting operations, not generic echo,
  proxy, redirect, upload, or callback endpoints.
- R2, D1, Hyperdrive, Queue, Service, and similar bindings are separate
  capabilities. Do not give the managed Worker bindings it does not need.
- The trusted OAuth Durable Object belongs to the broker Worker. Its one direct
  network operation is fixed to `POST https://auth.openai.com/oauth/token`.

The integration in the adjacent
[Durable Objects example](../cloudflare-workers/README.md) gives every managed
agent, including the private agent owned by a Multiplayer room, only this
`EGRESS` Service Binding. Its host-managed Responses transport selects one
fixed endpoint from deployment configuration and sends the matching placeholder
headers. Neither its WASM agent nor the room/browser protocols contain a path
that can request a credential snapshot, choose an upstream URL, or observe the
broker's rejection body.
