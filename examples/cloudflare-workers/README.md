# Nanocodex on Cloudflare Durable Objects

This example runs the real Rust/WASM Nanocodex harness inside one SQLite-backed
Durable Object per agent session. The front Worker only authenticates session
creation and routes capability URLs; the object owns the agent, OpenAI
Responses WebSocket, client sockets, typed history, tools, and durable commits.

```text
client WebSocket ──> Worker router ──> one NanocodexSession object per session
                                         ├─ Rust/WASM Nanocodex driver
                                         ├─ persistent model WebSocket
                                         ├─ hibernatable client sockets
                                         ├─ SQLite snapshot + terminal turns
                                         └─ Cloudflare Sandbox DO + container
                                              └─ /workspace mounted to per-session R2 prefix

preview capability ──> Worker router ──> session Sandbox container port

ChatGPT subscription ───────────────> one NanocodexSubscriptionAuth object
                                         └─ SQLite token rotation + 401 recovery
```

Hot follow-on turns reuse the same WASM agent, cache identity, typed history,
and upstream socket. Each completed turn atomically commits its Nanocodex
snapshot and terminal client result. Failed partial turns never enter durable
history. Repeating a completed client turn ID returns the stored terminal result
without another model call; duplicates received during cold initialization are
coalesced before the first await for the same reason.

An outbound WebSocket prevents a Durable Object from hibernating while it is
retained. A one-shot idle alarm therefore shuts down Nanocodex after 30 seconds
(configurable), closing the OpenAI socket. Client WebSockets use Cloudflare's
hibernation API and remain connected. Their next command wakes the object and
resumes complete client-owned typed history from SQLite. See Cloudflare's
[Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
and [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
documentation for the underlying behavior.

The caller-defined `sandbox_exec`, `sandbox_start_process`, `sandbox_read_file`,
`sandbox_write_file`, `sandbox_list_files`, and `sandbox_preview` tools run
untrusted work in a separate Cloudflare Sandbox container. The Sandbox uses the
current RPC transport, scopes its R2 mount to the Nanocodex session ID, and
proxies opaque capability-scoped preview URLs through the existing Worker
hostname. The authenticated preview token reveals neither the session capability
nor server credentials, and avoids requiring wildcard DNS or a separate Quick
Tunnel process. Nanocodex remains the only model and tool-loop owner; the
Sandbox SDK supplies execution isolation and storage.

## Run locally

From the repository root, build the optimized WASM package and install the
example:

```sh
just build-wasm
npm ci --prefix examples/cloudflare-workers
```

Docker must be running because Wrangler builds the Sandbox container. Local
R2 bindings are emulated by Wrangler; set `NANOCODEX_SANDBOX_LOCAL=true` in a
local `.dev.vars` file when you want the mounted workspace synchronized through
the local R2 binding path.

Sign in once with Codex, then start the subscription-backed Worker:

```sh
codex login
npm run dev:subscription --prefix examples/cloudflare-workers
```

Open <http://127.0.0.1:8787> for the deliberately thin browser client, or use
the REPL below. The page stores its session capability, bounded transcript, and
unfinished turn in browser local storage. Reloading resubmits the same
idempotent turn ID and rejoins or replays the Durable Object result. Enter
`local-admin-token` once to create a local session; this is the example's
router token, not a model credential.

The launcher securely reads `$CODEX_HOME/auth.json` (normally
`~/.codex/auth.json`), requires it to be mode `0600`, and gives workerd only the
current access token and account metadata through a temporary mode-`0600` env
file. It never reads, copies, rotates, or persists the Codex CLI refresh token.
The temporary file is removed when Wrangler exits. If the access token expires,
run `codex login` and restart this command.

The access token is sent only by the Worker host during the upstream WebSocket
upgrade; it never crosses into WASM or a client event. Local workerd keeps the
access token behind the singleton auth Durable Object and the launcher clears
any credential retained by an older run before accepting the new login.
`GET /auth/chatgpt` reports non-secret status and `DELETE /auth/chatgpt` clears
the durable copy; both routes require the admin bearer token.

`chatgpt.com` can reject serverless-provider egress even when the same
subscription succeeds in Codex. `dev:subscription` therefore starts a
random-capability, loopback-only WebSocket bridge for model egress. The bridge
forwards bounded frames and only the explicit Codex handshake headers; it does
not read the Codex auth file or persist credentials.

Start workerd in one terminal and run the live probes in another:

```sh
npm run repl --prefix examples/cloudflare-workers
npm run smoke:sandbox --prefix examples/cloudflare-workers
npm run smoke --prefix examples/cloudflare-workers
npm run multiclient --prefix examples/cloudflare-workers
npm run stress --prefix examples/cloudflare-workers
npm run soak --prefix examples/cloudflare-workers
npm run fanout --prefix examples/cloudflare-workers
```

The REPL is intentionally disposable. It stores only the session capability
URL and an unfinished turn ID/input in `.nanocodex/cloudflare-repl.json`; the
WASM agent, model socket, history, and execution remain in the Durable Object.
The file is mode `0600` because the session URL is a bearer capability. Press
Ctrl-C during inference to drop only the local WebSocket. Re-running the same
command reconnects and resubmits the idempotent turn ID, which either joins the
active turn or replays its committed terminal result. Use `/status` or `/exit`
at the prompt. Set `NANOCODEX_REPL_STATE` to isolate another local REPL state
file.

This demonstrates durable client detachment, not distributed exactly-once
inference. If the Worker process itself dies before a turn commits, reopening
the REPL resubmits the same turn from the last committed snapshot; a partial
provider response cannot be resumed.

`smoke:sandbox` bypasses the model and directly attacks the same bounded tool
handlers used by the agent. It checks write/exec/read/list behavior, non-zero
exits, output and timeout limits, path traversal and oversized-write rejection,
a managed port-8000 process and preview, and R2 persistence across container
destruction. Its fixed `POST`/`DELETE /admin/sandbox-smoke` flow requires the
admin bearer token; the external probe fetches the preview like a browser, then
the finish request destroys the disposable container and verifies the remount.

The model smoke performs real model turns, verifies duplicate suppression,
detaches its client, waits for idle teardown, reconnects to the durable snapshot,
proves that a follow-on remembers history, and requires completed write, exec,
and read tool call/result pairs.
`multiclient` attaches at least two clients before prompting and requires every
client to receive the same accepted turn, assistant-delta stream, event count,
and terminal result without reconnecting.
`stress` drives ping round trips through one object, `soak`
checks parallel sessions for cross-session leakage and duplicate model calls,
and `fanout` broadcasts a bursty model stream to 64 attached clients. Override
their `NANOCODEX_*` environment variables to change the workload.

For deterministic transport and subscription-refresh development without model
usage, run `npm run mock:openai`, set
`OPENAI_WEBSOCKET_URL=ws://127.0.0.1:8790` in API-key mode, and run the same
probes. The mock speaks the actual streamed Responses protocol. In ChatGPT mode
it also validates the bearer/account headers and serves rotating OAuth tokens,
so the full Rust/WASM driver, snapshot, idle shutdown, restore, and auth-retry
paths execute.

The Worker selects the WASM binding's CSP-safe direct-tool mode because Workers
forbid `eval` and `new Function`. This retains Nanocodex's typed Rust tool
lifecycle and caller-defined handlers without shipping a JavaScript evaluator.
Node-based consumers may continue to use Code Mode when their host permits it.

## Validate and deploy

```sh
npm run check --prefix examples/cloudflare-workers
cd examples/cloudflare-workers
npx wrangler r2 bucket create nanocodex-sandbox-workspaces
npx wrangler secret put CHATGPT_ACCESS_TOKEN
npx wrangler secret put CHATGPT_REFRESH_TOKEN
npx wrangler secret put CHATGPT_ACCOUNT_ID
npx wrangler secret put NANOCODEX_ADMIN_TOKEN
npx wrangler deploy
NANOCODEX_WORKER_URL=https://nanocodex-durable-agent.<subdomain>.workers.dev \
NANOCODEX_ADMIN_TOKEN=<admin-token> npm run smoke:sandbox
```

Create the R2 bucket once per Cloudflare account. Each actor receives only its
`/sessions/<session-id>/` prefix inside the mounted `/workspace`; model
credentials remain in the Worker and are not injected into the container.
After deployment, ask the agent to create a small server on port 8080 in the
background and call `sandbox_preview` to get a public URL on the same Worker
origin. HTTP and WebSocket preview traffic is forwarded to that exact per-session
container and port. The opaque URL is a bearer capability for the preview only;
rotating `NANOCODEX_ADMIN_TOKEN` invalidates outstanding preview URLs.

At the time this example was validated, the ChatGPT edge rejected direct
Cloudflare Worker egress with HTTP 403. That is an upstream egress-policy
boundary, not a WASM or Durable Object failure. A deployed subscription demo
therefore needs a non-Cloudflare WebSocket relay. Run the included bounded,
capability-gated relay on such a host:

```sh
NANOCODEX_EGRESS_PORT=8791 \
NANOCODEX_EGRESS_CAPABILITY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" \
  npm run relay:subscription --prefix examples/cloudflare-workers
```

Expose port 8791 with TLS, preserve the printed `/v1/<capability>` path, and set
the complete public `wss://` URL as `OPENAI_WEBSOCKET_URL` before deployment.
For a disposable personal demo, a Cloudflare Quick Tunnel can expose the local
port; use a stable relay under your control for anything long-lived. The relay
still requires the Worker's bearer credential in addition to the unguessable
path, never reads `auth.json`, bounds queued data, and forwards only the
allowlisted handshake headers. Set `NANOCODEX_EGRESS_CAPABILITY` from a
protected service environment file to keep the route stable across supervised
restarts; omit it to generate a new route.

The real edge validation for this example used only the current subscription
access token and account ID—no API key and no refresh token—and completed three
turns across client detach, object unload, snapshot restore, and a hosted tool
call. That access-token-only deployment naturally stops authenticating when the
token expires. Configure a dedicated refresh token only for a long-lived demo.

For a long-lived deployment, the singleton auth Durable Object stores the
dedicated credential in SQLite, refreshes it five minutes before expiry, and
performs one revision-guarded refresh-and-retry when an upstream upgrade returns
401. This avoids a refresh-token race when many sessions reconnect together.
Use a dedicated Codex subscription login for the deployment: refresh tokens
rotate, so sharing one between a local Codex installation and a Worker can
invalidate either copy. Do not commit, log, or paste `auth.json` wholesale;
restrict Worker and Durable Object access and follow the account's applicable
terms.

API-key mode remains available as an explicit alternative by setting
`NANOCODEX_AUTH_MODE=api_key` and providing `OPENAI_API_KEY`, but it is not used
by this demo.

`npm run check` type-checks, runs the Worker-native Durable Object suite
(including forced eviction with a live hibernatable client socket), and asks
Wrangler to build the complete WASM deployment without uploading it.

`POST /sessions` requires `Authorization: Bearer $NANOCODEX_ADMIN_TOKEN` and
returns a random session ID plus WebSocket URL. The session ID is then a bearer
capability: do not log or expose it. Production applications can replace this
small router policy with their own authentication while leaving the object and
Nanocodex lifecycle unchanged.

Client WebSocket commands are JSON objects:

```jsonc
{ "type": "prompt", "id": "client-turn-1", "input": "Hello" }
{ "type": "steer", "id": "client-turn-1", "input": "Be concise" }
{ "type": "cancel", "id": "client-turn-1" }
{ "type": "status" }
{ "type": "ping", "nonce": "health-1" }
```

The object streams contractual Nanocodex events as `{ "type": "event", ... }`
and emits exactly one application terminal message, `turn_completed` or
`turn_failed`, for each accepted client turn.
