# Nanocodex on Cloudflare Durable Objects

This example runs the real Rust/WASM Nanocodex harness inside one SQLite-backed
Durable Object per managed agent. It also provides the Multiplayer demo: one
SQLite-backed room object coordinates many humans and owns one private managed
agent with a tool-free room profile. A singleton quota object caps the whole
public demo rather than relying on per-location edge limits. Provider
credentials live in a separate ordinary Worker from the
[credential-broker example](../cloudflare-egress/README.md), never in either
object, WASM, browser state, room events, or managed-agent events.

```text
N humans -> website proxy -> MultiplayerRoom -> private NanocodexSession
                |                  |                    |- tool-free room profile
                |                  |                    |- Rust/WASM typed history
                |                  |                    `- placeholder transport --.
                |                  |- ordered chat + bounded replay + durable outbox |
                |                  `- global MultiplayerQuota -----------------------|
                `- create-only allocator capability                                 |
                                                                                    v
REST/SSE or direct WebSocket -> NanocodexSession -> private EGRESS Service Binding
                                                        |
                                                        v
                                            ordinary credential-broker Worker
                                              |- exact OpenAI/Codex rule
                                              |- static API-key injection, or
                                              `- rotating OAuth Durable Object
```

`NANOCODEX_AUTH_MODE` is deployment-fixed to `api_key` or `chatgpt`. Both use
`Transport.hostManaged`: the managed Worker supplies only
`Bearer NANOCODEX_OPENAI_API_KEY`, or the two Codex OAuth placeholders, to its
private `EGRESS` Service Binding. The broker validates the complete destination,
method, query, upgrade, beta header, header allowlist, and exact placeholders
before injecting a credential. Rejected upstream bodies are consumed at that
boundary and become a typed, non-secret managed transport failure.

This is the standard-Workers equivalent of the iron-proxy credential boundary,
not transparent egress interception. Ordinary Workers cannot install an
outbound Worker around arbitrary global `fetch()`. Enforcement here comes from
controlling the managed runtime and giving it no provider secret or provider
binding other than the private broker capability.

Hot follow-on turns reuse the same WASM agent, cache identity, typed history,
and upstream socket. The Durable Object supplies only atomic load and
compare-and-append over opaque batches. Rust/WASM owns operation deduplication,
typed checkpoints, model-step replay, and tool-step ambiguity. Repeating a
completed client turn ID returns the Rust-journaled terminal result without
another model call; an unsafe tool whose completion was not committed is
reported as ambiguous and is never silently executed twice.

The managed REST API durably commits a normalized request hash, turn row, and
`turn_accepted` cursor before returning HTTP 202. Terminal state and its event
cursor are committed together. `GET /events` first replays SQLite rows strictly
after the supplied cursor and then tails the same log; live publication is only
a wake-up signal. `Last-Event-ID` takes precedence over the query cursor, so a
standard EventSource reconnect cannot miss the replay-to-live handoff.

An outbound WebSocket prevents a Durable Object from hibernating while it is
retained. A one-shot idle alarm therefore shuts down Nanocodex after 30 seconds
(configurable), closing the OpenAI socket. Client WebSockets use Cloudflare's
hibernation API and remain connected. Their next command wakes the object and
rebuilds complete client-owned typed history from the Rust journal in SQLite. See Cloudflare's
[Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
and [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
documentation for the underlying behavior.

The default shell has no process, container, host filesystem, PTY, or network
access. Cloudflare Computer supplies only durable SQLite-backed files; the SDK's
host-generic Just Bash adapter mounts that one `/workspace` handle with bounded
commands, file sizes, output, execution time, and entry count. Symbolic links
and every lexical or persisted path escape are rejected. This keeps the common
agent path cheap while preserving files across agent unload and reconstruction.

Container escalation is intentionally absent from the primary Worker graph: a
disabled container SDK still adds megabytes of JavaScript and forces image work
on every deployment. Applications that truly need Linux can register their own
remote tool or deploy the retained `sandbox-tools.ts` adapter as a separate
service. Nanocodex remains the only model and tool-loop owner either way.

## Run locally

From the repository root, build the optimized WASM package and install both
ordinary-Worker examples:

```sh
just build-wasm
npm ci --prefix examples/cloudflare-workers
npm ci --prefix examples/cloudflare-egress
```

The default deployment has no Docker, container, Worker Loader, or R2
requirement. Wrangler emulates the Durable Object and its Computer filesystem
directly.

For OAuth, sign in once with Codex and start the two Workers:

```sh
codex login
npm run dev:subscription --prefix examples/cloudflare-workers
```

For a normal OpenAI API key, put it only in the parent shell and select the
other fixed deployment mode:

```sh
OPENAI_API_KEY='<key>' npm run dev:api-key --prefix examples/cloudflare-workers
```

Open <http://127.0.0.1:8787> for the deliberately thin browser client, or use
the REPL below. The page stores only routing metadata, a bounded transcript, and
an unfinished turn in browser local storage; the scoped agent capability stays
in an HttpOnly cookie. Reloading resubmits the same idempotent turn ID and
rejoins or replays the Durable Object result. Enter `local-admin-token` once to
create a local session; this is the example's
router token, not a model credential. That direct page is a local operator
surface: do not publish it and hand a deployment-wide administrator token to
end users. The production Multiplayer site keeps the managed Worker private and
injects a distinct create-room-only allocator capability in its server-side
Service Binding proxy.

The launcher securely reads `$CODEX_HOME/auth.json` (normally
`~/.codex/auth.json`), requires mode `0600`, and selects only its current access
token and account metadata. It never selects, returns, copies, or uploads the
Codex refresh-token field. Each launcher invocation also uses separate,
disposable Miniflare state roots for the broker and managed Worker. Durable
recovery is preserved for the life of that invocation without reviving stale
room alarms from an earlier local run; deployed Durable Object storage is
unaffected. When no fixed OAuth relay is configured, the launcher also starts
the included bounded relay on a random-capability `127.0.0.1` URL. Only that
launcher sets the broker's explicit loopback-development flag; production relay
configuration remains TLS-only.
For either mode, it writes provider material to a temporary mode-`0600` broker
env file and writes only router policy to a different managed-Worker env file.
It also removes provider variables from the managed Wrangler subprocess. Both
files are deleted when either Worker exits. If the access-only OAuth credential
expires, run `codex login` and restart.

## Multiplayer room API

Create a room with the create-only allocator credential (the administrator is
also accepted for local operator use):

```sh
curl -i -X POST \
  -H 'Authorization: Bearer local-room-allocator-token' \
  -H 'Content-Type: application/json' \
  --data '{"display_name":"Ada"}' \
  http://127.0.0.1:8787/v1/rooms
```

The receipt contains a signed room locator, an invite URL, the selected non-secret auth mode,
and an HttpOnly membership cookie. It does not contain the private agent ID or a
managed turn capability. The invite is in `#invite=...`, never the query string,
so it is not sent in HTTP requests or referrers. `POST /v1/rooms/<id>/join`
exchanges it for another room-scoped `HttpOnly; SameSite=Strict` cookie. Invites
expire after one hour and allow at most 31 guest redemptions; rooms expire after
two hours, and one membership is limited to four simultaneous sockets. The
locator's HMAC proves that the router issued the name before it selects a room
Durable Object, but it is not membership authority. Only the owner membership
cookie (or the server-side administrator during cleanup) may delete a room.

Only the owner may target the shared agent. That agent profile has no shell,
workspace tool, web tool, runtime-info tool, or subagents. Local durable limits
allow six owner turns/minute and 60 room turns/hour. A deployment-wide singleton
adds hard ceilings of 16 active two-hour rooms, 32 allocations/hour, and 240
agent turns/hour across Cloudflare locations. Ordinary chat is separately
metered by member and room event/byte windows before it can fill the durable log.

The public website's `/multiplayer` surface proxies only `/v1/rooms` through a
private Service Binding to this Worker. Its browser protocol is deliberately
smaller than the managed-agent API:

```jsonc
{ "type": "say", "id": "message-1", "text": "hello", "target": "room" }
{ "type": "say", "id": "message-2", "text": "help us", "target": "agent" }
{ "type": "ack", "cursor": "42" } // only after replay_paused at cursor 42
{ "type": "ping" }
```

The room commits a human message and its idempotency key before acknowledging
or broadcasting it. Every client replays the same decimal cursor sequence after
reconnect or Durable Object hibernation. Catch-up sends at most 16 events or 64
KiB, emits `replay_paused`, and waits for an exact cursor acknowledgement before
the next batch, so a cursor-zero client cannot enqueue the whole retained log.
An owner `agent` target also commits an
outbox row in `quota_pending` state. Only after that local transaction commits
does the room idempotently admit the deployment-wide turn and submit one stable
internal managed turn to its private `NanocodexSession`; a failed local commit
therefore cannot consume global turn capacity. The room projects only the final
assistant text or a bounded durable room failure. Projected replies are
UTF-8-bounded to 16 KiB. A definitive global limit appends `rate_limited` and
completes that outbox row, so the room can recover after the quota window.
Ambiguous quota, submit, or observation failures retry with the same stable ID
and then append a durable `blocked` terminal before fencing the outbox, rather
than manufacturing success or letting later work pass silently.
Room deletion deletes exactly that owned agent and its journal before clearing
room state and releasing the quota lease; the Multiplayer profile never creates
a Computer workspace.

Run the three-player end-to-end probe against the local pair. It checks ordered
broadcast, idempotent replay, one real managed-agent answer, reconnect from the
last durable cursor, and absence of provider/agent/turn capabilities in all
public frames:

```sh
npm run smoke:multiplayer --prefix examples/cloudflare-workers
```

## Managed REST and resumable SSE

Create an agent with the router credential. The UUIDv7 is only a routing ID. The
receipt separately returns a 256-bit `agent_token` scoped to that one ID and
also sets it as an HttpOnly cookie for the same-origin browser client. Every
state, turn, event, WebSocket, cancellation, and deletion route requires that
scoped token; knowing an ID is not authorization. Applications should still
replace this example's creation policy with their own authorization boundary.

```sh
curl -fsS -X POST \
  -H 'Authorization: Bearer local-admin-token' \
  http://127.0.0.1:8787/v1/agents
```

The receipt contains `agent_id`, `agent_token`, `events_url`, and
`websocket_url`. In the commands below, set `agent_token` from that receipt.
Start the event stream at cursor zero, or resume after the last event your
consumer fully processed:

```sh
curl -N -H "Authorization: Bearer $agent_token" \
  -H 'Accept: text/event-stream' \
  'http://127.0.0.1:8787/v1/agents/<agent-id>/events?cursor=0'

curl -N -H "Authorization: Bearer $agent_token" \
  -H 'Last-Event-ID: <last-processed-cursor>' \
  'http://127.0.0.1:8787/v1/agents/<agent-id>/events'
```

Every frame has the durable decimal cursor in both `id:` and `data.cursor`, and
its typed message name in `event:`. Delivery is exclusive: cursor 42 resumes at
the first available event greater than 42. A cursor ahead of durable storage is
HTTP 409 rather than a silent wait.

Submit a stable turn ID and/or `Idempotency-Key`. A new request returns 202 only
after durable acceptance; an identical replay returns 200 with the original
turn and cursors; reusing either identifier with different input returns 409.

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $agent_token" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: incoming-request-42' \
  --data '{"id":"turn-42","input":"Use exec_command to inspect /workspace"}' \
  http://127.0.0.1:8787/v1/agents/<agent-id>/turns

curl -fsS \
  -H "Authorization: Bearer $agent_token" \
  http://127.0.0.1:8787/v1/agents/<agent-id>/turns/turn-42

curl -fsS -X POST \
  -H "Authorization: Bearer $agent_token" \
  http://127.0.0.1:8787/v1/agents/<agent-id>/turns/turn-42/cancel

curl -fsS -X DELETE \
  -H "Authorization: Bearer $agent_token" \
  http://127.0.0.1:8787/v1/agents/<agent-id>
```

Cancellation first persists `turn_cancelling`, publishes its cursor, and only
then returns 202. Retryable admission/cancellation failures retain a durable
attempt count and exponential retry time; an ambiguous operation becomes
`turn_blocked` and fences later work until the application explicitly replaces
the agent. Deletion clears the journal, managed rows, event log, and Computer
workspace.

Start workerd in one terminal and run the live probes in another:

```sh
npm run smoke:managed --prefix examples/cloudflare-workers
npm run smoke:multiplayer --prefix examples/cloudflare-workers
npm run repl --prefix examples/cloudflare-workers
npm run smoke --prefix examples/cloudflare-workers
npm run multiclient --prefix examples/cloudflare-workers
npm run stress --prefix examples/cloudflare-workers
npm run soak --prefix examples/cloudflare-workers
npm run fanout --prefix examples/cloudflare-workers
```

The REPL is intentionally disposable. It stores only the session capability
token, routing URL, and an unfinished turn ID/input in
`.nanocodex/cloudflare-repl.json`; the
WASM agent, model socket, history, and execution remain in the Durable Object.
The file is mode `0600` because the scoped token is a bearer capability. Press
Ctrl-C during inference to drop only the local WebSocket. Re-running the same
command reconnects and resubmits the idempotent turn ID, which either joins the
active turn or replays its committed terminal result. Use `/status` or `/exit`
at the prompt. Set `NANOCODEX_REPL_STATE` to isolate another local REPL state
file.

This demonstrates durable client detachment plus step recovery, not a claim
that arbitrary external effects are magically exactly once. A completed model
step is replayed from the journal after Worker loss. A tool start without a
committed completion stops with an explicit ambiguous-outcome error so the
application can reconcile the external system before retrying.

`smoke:managed` drives the complete REST/SSE contract: durable acceptance,
idempotent replay and conflict, strict monotonic cursors, standard
`Last-Event-ID` resume, cold and restored turn timing, `runtimeInfo`, bounded
`exec_command`, Computer workspace persistence across idle agent teardown, and
durable cancellation. It prints one JSON timing record suitable for before/after
TTFT comparisons and deletes its agent in a `finally` block.

The model smoke performs real model turns, verifies duplicate suppression,
detaches its client, waits for idle teardown, reconnects to the durable snapshot,
proves that a follow-on remembers history, and requires completed `runtimeInfo`
and durable `exec_command` tool call/result pairs.
`multiclient` attaches at least two clients before prompting and requires every
client to receive the same accepted turn, assistant-delta stream, event count,
and terminal result without reconnecting.
`stress` drives ping round trips through one object, `soak`
checks parallel sessions for cross-session leakage and duplicate model calls,
and `fanout` broadcasts a bursty model stream to 64 attached clients. Override
their `NANOCODEX_*` environment variables to change the workload.

The Worker-native suite uses an actual local Service Binding to a deterministic
broker Worker. That broker accepts only the fixed OpenAI placeholder handshake
and returns a streamed Responses WebSocket, so tests exercise the real WASM
host-managed transport without placing a credential in the managed Worker's
bindings.

The Worker selects the WASM binding's CSP-safe direct-tool mode because Workers
forbid `eval` and `new Function`. This retains Nanocodex's typed Rust tool
lifecycle and caller-defined handlers without shipping a JavaScript evaluator.
Node-based consumers may continue to use Code Mode when their host permits it.

Set `WEB_TOOL_URL` to install the standard `web__run` definition from
`nanocodex/tools` directly in each Durable Object agent. The binding repairs
common malformed model argument shapes and posts `{ commands, session_id }` to
that HTTPS endpoint; the Worker retains endpoint credentials in the optional
`WEB_TOOL_TOKEN` secret and rejects redirects before a credential can be
forwarded to another origin. No browser OPFS or shell code enters this server-side
Worker graph.

## Validate and deploy

```sh
npm run check --prefix examples/cloudflare-egress
npm run check --prefix examples/cloudflare-workers

cd examples/cloudflare-egress
npm run deploy:broker
# Choose the secret required by the fixed mode:
npx wrangler secret put CODEX_OAUTH_BOOTSTRAP -c wrangler.broker.jsonc
# or: npx wrangler secret put OPENAI_API_KEY -c wrangler.broker.jsonc

cd examples/cloudflare-workers
npx wrangler secret put NANOCODEX_ADMIN_TOKEN
npx wrangler secret put NANOCODEX_ROOM_ALLOCATOR_TOKEN
npx wrangler deploy

cd ../../web
# Use the NANOCODEX_ROOM_ALLOCATOR_TOKEN value, never the administrator value.
npx wrangler secret put MULTIPLAYER_ALLOCATOR_TOKEN
npx wrangler deploy
```

Generate both backend values from at least 32 random bytes. They must be
different: `NANOCODEX_ADMIN_TOKEN` owns raw managed-agent creation/deletion and
derives scoped agent capabilities, while `NANOCODEX_ROOM_ALLOCATOR_TOKEN` can
only create a bounded room. Only the allocator value is copied to the website
Worker.

The checked-in managed-Worker configuration has `workers_dev = false`: it is a
private production backend reached only through the website's
`MULTIPLAYER_BACKEND` Service Binding. The website strips browser
`Authorization` headers and supplies `MULTIPLAYER_ALLOCATOR_TOKEN` only for exact
room creation requests. Join, state, socket, and owner-delete requests use only
room-scoped HttpOnly membership cookies. Use the disposable smoke below when
you need a temporary public test endpoint; it keeps the broker and managed
Worker private, exposes only a third disposable proxy running the exact website
room router, and deletes all three afterward.

The disposable Cloudflare smoke performs that whole deployment with unique
names, runs three real room clients plus one real managed-agent turn, and then
deletes all three ordinary Workers. It sends browser-shaped traffic through the
public proxy and private `MULTIPLAYER_BACKEND` binding, including a forged
browser bearer that must be stripped, while the managed Worker has no public
route. The parent gives the client only lengths and SHA-256 digests of the exact
provider/admin/allocator/relay values; the client scans every public receipt, cookie, and
retained frame and fails if any exact secret appears. In subscription mode it uploads only the current
access token and account metadata, never the local refresh token. It can start a
local bounded relay through `cloudflared` automatically, or use a fixed
`NANOCODEX_CODEX_RELAY_URL`:

```sh
npx wrangler login
npm run smoke:cloudflare:multiplayer -- --auth-mode=chatgpt

OPENAI_API_KEY='<key>' \
  npm run smoke:cloudflare:multiplayer -- --auth-mode=api_key
```

The mode-`0600` broker secrets file and the separate managed-Worker secrets file
are deleted in `finally`; provider variables are also removed from the
three-player smoke subprocess. The output reports only the selected non-secret
mode, replay/model evidence, credential boundary, and cleanup result.

Set `NANOCODEX_AUTH_MODE` in `wrangler.jsonc` to the credential stored in the
broker. The broker has no public route (`workers_dev = false`); the managed
Worker's `EGRESS` Service Binding is its only caller. Never configure
`OPENAI_API_KEY`, a Codex token, an account ID, or an OAuth bootstrap on the
managed Worker.

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
the complete public `https://` capability URL as the broker's
`CODEX_RELAY_URL` secret.
For a disposable personal demo, a Cloudflare Quick Tunnel can expose the local
port; use a stable relay under your control for anything long-lived. The relay
still requires the broker-injected bearer credential in addition to the
unguessable path, never reads `auth.json`, bounds queued data, and forwards only
the allowlisted handshake headers to the fixed
`wss://chatgpt.com/backend-api/codex/responses` destination; no environment
variable can redirect credentials to another upstream. Set
`NANOCODEX_EGRESS_CAPABILITY` from a
protected service environment file to keep the route stable across supervised
restarts; omit it to generate a new route.

An access-only OAuth bootstrap naturally stops authenticating when it expires.
For a long-lived deployment, the broker's singleton OAuth Durable Object stores
a dedicated credential, refreshes it before expiry, and performs one
revision-guarded refresh and retry when an upstream upgrade returns 401. This
avoids a refresh-token race when many managed sessions reconnect together.
Use a dedicated Codex subscription login for the deployment: refresh tokens
rotate, so sharing one between a local Codex installation and a Worker can
invalidate either copy. Do not commit, log, or paste `auth.json` wholesale;
restrict Worker and Durable Object access and follow the account's applicable
terms.

API-key mode uses the same path: the broker alone stores `OPENAI_API_KEY`, and
the managed runtime can present only the exact fixed placeholder.

`npm run check` type-checks, runs the Worker-native Durable Object suite
(including forced eviction with a live hibernatable client socket), and asks
Wrangler to build the complete WASM deployment without uploading it.

`POST /sessions` requires `Authorization: Bearer $NANOCODEX_ADMIN_TOKEN` and
returns a random routing ID, WebSocket URL, and separate per-session
`agent_token` while setting the same capability as an HttpOnly cookie. Every
session subroute requires that scoped token; the ID alone grants nothing.
Production applications can replace this small router policy with their own
authentication while leaving the object and Nanocodex lifecycle unchanged.

Client WebSocket commands are JSON objects:

```jsonc
{ "type": "prompt", "id": "client-turn-1", "input": "Hello" }
{ "type": "steer", "id": "client-turn-1", "input": "Be concise" }
{ "type": "cancel", "id": "client-turn-1" }
{ "type": "status" }
{ "type": "ping", "nonce": "health-1" }
```

The object streams contractual Nanocodex events as `{ "type": "event", ... }`
and emits exactly one application terminal message, `turn_completed`,
`turn_cancelled`, or `turn_failed`, for each accepted client turn. A
`turn_blocked` state is deliberately nonterminal and fences subsequent work
because the application must reconcile the ambiguous side effect or replace the
agent.
