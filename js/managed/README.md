# Nanocodex on Cloudflare Durable Objects

This example runs the real Rust/WASM Nanocodex harness inside one SQLite-backed
Durable Object per managed agent. It also provides the Multiplayer demo: one
SQLite-backed room object coordinates many humans and owns one private managed
agent with room-specific conversational instructions. Both normal and room agents use the
same bounded tool composition. A singleton quota object caps the whole
public demo rather than relying on per-location edge limits. Provider
credentials live in a separate ordinary Worker from the
[credential-broker example](../egress/README.md), never in either
object, WASM, browser state, room events, or managed-agent events.

```text
N humans -> website proxy -> MultiplayerRoom -> private DurableAgentSession
                |                  |                    |- room conversational profile
                |                  |                    |- Rust/WASM typed history
                |                  |                    `- placeholder transport --.
                |                  |- ordered chat + bounded replay + durable outbox |
                |                  `- global MultiplayerQuota -----------------------|
                `- create-only allocator capability                                 |
                                                                                    v
account-authenticated REST/SSE or WebSocket -> DurableAgentSession -> private EGRESS Service Binding
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

One managed deployment represents one credential and billing scope: every raw
agent and every room shares the broker's one API key or Codex account. Room
membership grants quota-bounded authority to spend from that scope; it is not a
provider credential selector or per-member provider identity. Deploy separate
managed/broker pairs when credentials, billing owners, or policy need isolation.

This is the standard-Workers equivalent of the iron-proxy credential boundary,
not transparent egress interception. Ordinary Workers cannot install an
outbound Worker around arbitrary global `fetch()`. Enforcement here comes from
controlling the managed runtime and giving it no provider secret or provider
binding other than the private broker capability.

Hot follow-on turns reuse the same WASM agent, cache identity, typed history,
and upstream socket. The Durable Object supplies only atomic load and
compare-and-replace over one opaque complete state. Rust/WASM owns operation deduplication,
typed checkpoints, and recovery for model, warmup, compaction, and tool steps.
Repeating a completed client turn ID returns the Rust-retained terminal result
without another model call. An unsafe tool whose completion was not committed
becomes one in-band unknown-outcome tool result and is never silently executed
twice.

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
rebuilds complete client-owned typed history from the Rust state in SQLite. See Cloudflare's
[Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
and [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
documentation for the underlying behavior.

The execution boundary is Nanocodex's in-process Just Bash interpreter over the
durable SQLite-backed Cloudflare Computer `/workspace` VFS. Computer supplies
storage only; there is no Computer execution backend, Dynamic Worker, Worker
Loader, container, process, sandbox, or second filesystem. Just Bash provides its core
file/text commands and `curl`, and Nanocodex registers application-owned
commands such as `gh` directly in the interpreter. Output, execution
time, files, and entry counts remain bounded. A host-owned secure Fetcher sends
public HTTP through the gateway. Private managed agents may also use exact
connector destinations; Multiplayer agents receive no connector subject, so
GitHub, Gmail, Drive, and X fail closed. Provider credentials never enter the shell.
The `ssh` command can either open direct Cloudflare TCP with an explicit
workspace identity or use `IdentityRef`; brokered identities execute entirely
inside private egress and are bound there to one target and host fingerprint.

Browser-local agents continue to use OPFS. Managed and Multiplayer agents
cannot use OPFS, while a plain in-memory filesystem would disappear on Durable
Object eviction, so the small Computer VFS is the only retained Computer layer.

## Develop and deploy

Install this package, then use Wrangler directly with the checked-in
configuration:

```sh
npm ci --prefix js/managed
npx wrangler dev --config js/managed/wrangler.jsonc
npx wrangler deploy --config js/managed/wrangler.jsonc
```

The managed Worker receives only its private egress binding. Configure provider
credentials at that egress boundary; they never belong in this Worker, browser
state, or Wrangler vars. Exercise changed routes through the canonical account
application and inspect its browser console, network, storage, streams, and
secret absence as required by the repository behavior matrix.

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

Every authenticated room member may target the shared agent; per-member and
per-room quotas bound shared spend. Only the owner may delete the room. The
agent profile has the standard shell, workspace, web, image, and planning tools,
but no account connector capability. GitHub, Gmail, Drive, and X return
`requires_login` for the owner and every invitee. Local durable limits allow six turns per member/minute and 60 room
turns/hour. A deployment-wide singleton
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
A member `agent` target also commits an
outbox row in `quota_pending` state. Only after that local transaction commits
does the room idempotently admit the deployment-wide turn and submit one stable
internal managed turn to its private `DurableAgentSession`; a failed local commit
therefore cannot consume global turn capacity. The room projects only the final
assistant text or a bounded durable room failure. Projected replies are
UTF-8-bounded to 16 KiB. A definitive global limit appends `rate_limited` and
completes that outbox row, so the room can recover after the quota window.
Ambiguous quota, submit, or observation failures retry with the same stable ID
and then append a durable `blocked` terminal before fencing the outbox, rather
than manufacturing success or letting later work pass silently.
Room deletion deletes exactly that owned agent and its durable state before clearing
room state and releasing the quota lease; the Multiplayer profile never creates
a Computer workspace.

## Managed REST and resumable SSE

Create an agent with an account-issued Nanocodex API key. The UUID is only a
routing ID. Creation and every state, turn, event, WebSocket, cancellation, and
deletion route authenticate the account again; knowing an agent ID is not
authorization. A valid key owned by another account receives the same hidden
not-found result as an unknown ID.

Supply a stable `Idempotency-Key` for every logical create. The account and key
derive one opaque agent ID without a shared allocator, so retrying after a lost
response resumes the same idempotent creation state machine instead of creating
an unknown second agent. Retryable stages retain a refreshed preparation lease
so keyed replay cannot race cleanup; its durable watchdog cleans an abandoned
preparation. Reusing a key after watchdog cleanup or permanent agent deletion
returns a conflict and cannot resurrect it.

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $NANOCODEX_API_KEY" \
  -H 'Idempotency-Key: create-request-42' \
  http://127.0.0.1:8787/v1/agents
```

The token-free receipt contains exactly `agent_id`, `session_id`, `events_url`,
and `websocket_url`. The API key remains caller-owned and is never copied into
the receipt, a cookie, an event, or browser storage. Start the event stream at
cursor zero, or resume after the last event your consumer fully processed:

```sh
curl -N -H "Authorization: Bearer $NANOCODEX_API_KEY" \
  -H 'Accept: text/event-stream' \
  'http://127.0.0.1:8787/v1/agents/<agent-id>/events?cursor=0'

curl -N -H "Authorization: Bearer $NANOCODEX_API_KEY" \
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
  -H "Authorization: Bearer $NANOCODEX_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: incoming-request-42' \
  --data '{"id":"turn-42","input":"Use exec_command to inspect /workspace"}' \
  http://127.0.0.1:8787/v1/agents/<agent-id>/turns

curl -fsS \
  -H "Authorization: Bearer $NANOCODEX_API_KEY" \
  http://127.0.0.1:8787/v1/agents/<agent-id>/turns/turn-42

curl -fsS -X POST \
  -H "Authorization: Bearer $NANOCODEX_API_KEY" \
  http://127.0.0.1:8787/v1/agents/<agent-id>/turns/turn-42/cancel

curl -fsS -X DELETE \
  -H "Authorization: Bearer $NANOCODEX_API_KEY" \
  http://127.0.0.1:8787/v1/agents/<agent-id>
```

Cancellation first persists its intent and only then returns 202. If it arrives
before admission, the session reserves that turn ID (up to 64 outstanding
reservations); a later matching submission enters `turn_cancelling` without
dispatching model or tool work. An admitted cancellation publishes its
resumable cursor. Transient admission/cancellation failures remain `accepted`
or `cancelling` with a durable attempt count and exponential retry time. A
recovered at-most-once tool with an unknown external outcome becomes a failed
tool result without replaying the effect. Deletion clears the durable state, managed
rows, cancellation reservations, event log, and Computer workspace.

## Organization history and memory

The first browser account gets its own unnamed one-user organization and
unnamed root team. All agents created by that principal retain its organization
and team, and one `MemoryScope` Durable Object keyed by the organization ID owns
the shared search projection and explicit durable memories. An owner account
session can read or rename the organization with `GET /v1/organization` or a
same-origin `PATCH /v1/organization` (`{"name":"Research"}`; `null` clears the
name).

Completed turns are projected idempotently into that scope with their team ID,
session and turn IDs, exact user/assistant text, durable source cursor, and
deletion tombstone. Retrieval is authenticated and currently filters to the
principal's exact team:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $account_api_key" \
  -H 'Content-Type: application/json' \
  --data '{"query":"memory scope","limit":8}' \
  http://127.0.0.1:8787/v1/history/sessions/search

curl -fsS -X POST \
  -H "Authorization: Bearer $account_api_key" \
  -H 'Content-Type: application/json' \
  --data '{"turn_ids":["turn-42"]}' \
  http://127.0.0.1:8787/v1/history/sessions/<session-id>/read
```

`find_sessions` and `read_session` expose the same boundary to managed agents.
Search and read responses include citations grouped by session, with exact turn
IDs and source cursors; a completed agent turn carries the citations recorded
by those tools. Hosted deployments may bind AutoVectorize AI Search as
`HISTORY_AI_SEARCH`; results are rehydrated from authoritative SQLite and merged
with local FTS, which remains the fallback while indexing is pending or hosted
search is absent or unavailable. Set `NANOCODEX_HISTORY_AI_SEARCH_INSTANCE` for
the remote binding during local development; otherwise Wrangler is FTS-only.

The `memory` agent tool and authenticated `POST /v1/memory` endpoint expose one
closed Tact-style operation surface: `scan`, `read`, `put`, and `delete`.
Operations are atomic. Queries are limited to 512 UTF-8 bytes and five scan
results; stored values are limited to 1,024 UTF-8 bytes, 512 records, and 256
KiB total organization content. New or replaced memories enter seven-day
probation and are pruned if never read; reading marks them used. Every put
requires a fresh scan by the same principal, exact normalized duplicates and
likely secrets are rejected, and replacement/deletion uses the returned
`{id, version}` key as compare-and-swap.

Every account session and `ncx_live_...` API key resolves to an organization,
team, role, authorization epoch, and explicit capabilities. History requires
`history:read`; memory requires `memory:read`, plus `memory:write` for put and
delete. API keys are created, listed, and revoked through `/v1/api-keys` by the
authenticated browser account and carry its validated organization grant.

The managed JavaScript client mirrors these routes as `Agent.memory`,
`Agent.getOrganization`, and `Agent.updateOrganization`; memory accepts a cookie
or API key according to its capabilities, while organization metadata remains
restricted to an owner account session.

Nested-team creation and membership administration are not yet exposed. The
stored team shape already has a nullable parent link; the intended permission
rule is a tree, not overlapping groups. A grant anchored at a parent team may
act on that team's descendant resources, while a child grant cannot see its
parent or siblings. Explicit capabilities are always intersected with that
team closure. The `Organization` object will remain the sole authority that
computes the closure; clients and models will never submit an authorized-team
list. Session history stays team-owned, while the curated atomic memory corpus
documented above is deliberately organization-wide. This inheritance and its
administration API must be implemented and tested before any child team can be
created.

Durable recovery does not imply exactly-once external effects. A completed model
step is replayed from retained state after Worker loss; a tool start without a
committed completion becomes an explicit unknown-outcome tool result rather
than being repeated.

The Worker selects the WASM binding's CSP-safe direct-tool mode because Workers
forbid `eval` and `new Function`. This retains Nanocodex's typed Rust tool
lifecycle and caller-defined handlers without shipping a JavaScript evaluator.
Node-based consumers may continue to use Code Mode when their host permits it.

Normal Durable Object and Multiplayer Ask agents install the same standard
`exec_command`, `web__run`, `image_gen__imagegen`, `view_image`, and
`update_plan` tools. Only normal private agents attach their account connector
subject to shell egress; Multiplayer shell egress is public-HTTP-only. Web and image
requests go directly through the private `NANOCODEX` Service Binding with the
agent's opaque broker subject; no provider credential or account cookie enters
the tool runtime. Their conversational instructions remain profile-specific.

## Validate and deploy

Run `npm run check --prefix js/managed` for typechecking, the focused policy
and protocol suite, and a non-uploading Wrangler build. Deploy directly with
`npx wrangler deploy --config js/managed/wrangler.jsonc`; follow
`../../AGENTS.md` for deploy order, secret handling, and canonical browser
evidence.

`POST /v1/agents` and every `/v1/agents/<agent-id>` owner route require the same
account session or account-issued API key. The receipt contains only
`agent_id`, `session_id`, `events_url`, and `websocket_url`; it does not mint a
second agent credential or set a credential cookie. Non-browser WebSocket
clients authenticate the upgrade with `Authorization: Bearer
$NANOCODEX_API_KEY`. Browser operators use authenticated REST/SSE unless they
already have the same-origin account session cookie.

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
`turn_cancelled`, or `turn_failed`, for each accepted client turn. A transient
retry emits `turn_retryable` while the row remains `accepted` or `cancelling`;
the event is scheduling information, not another durable state.
