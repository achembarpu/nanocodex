# Managed durable-agent Worker

This Worker is Nanocodex's account-owned hosted-agent surface on Cloudflare. It
authenticates public requests, projects the caller's authority, and routes work
to durable, account-scoped services.

## Ownership and security

`DurableAgentSession` exclusively owns an agent's mutable runtime: retained
history, turn admission and completion, ordered events, client sockets, tools,
and recovery. The edge Worker owns routing and authorization; an agent ID is a
routing identifier, never authority. Each agent route reauthenticates the
account or grant and forwards only its permitted slice.

Provider credentials never enter this Worker, browser state, durable agent
state, or tool configuration. Model and connector access crosses the private
`NANOCODEX` Service Binding to `nanocodex-egress`, which owns credential routing
and injection.

## Public journeys and protocol boundaries

- Passkey/account and API-key routes establish the account identity that owns
  agents, organizations, connectors, memory, and history.
- `/v1/agents` lists or creates agents. Agent routes create turns, read state,
  cancel or steer work, delete an agent, and support explicit durability import
  and export. Stable `Idempotency-Key` values make create and turn retries safe.
- Agent events are a durable, ordered cursor stream. SSE resumes with `cursor`
  or `Last-Event-ID`; same-origin browser WebSockets carry the typed
  prompt/steer/cancel protocol. Realtime calls and sideband transport have
  separate agent-scoped WebSocket routes.
- `/v1/history/*` and `/v1/memory` expose organization- and team-scoped
  retained context. `/v1/credentials` and `/v1/connectors` manage brokered
  credentials, OAuth connections, and MCP connections without exposing secrets.
- `/v1/rooms` creates, joins, observes, and deletes multiplayer rooms. A
  `MultiplayerRoom` owns room chat and its private agent; `MultiplayerQuota`
  enforces deployment-wide room and turn limits. Room WebSockets use their own
  replay cursor and `say`/`ack` protocol.

The small root page is an operator surface; it is not a second application
protocol. `/health` is the service health endpoint.

## Cloudflare bindings

| Binding | Role |
| --- | --- |
| `NANOCODEX` | Private Service Binding to `nanocodex-egress`. |
| `NANOCODEX_SESSIONS` | One `DurableAgentSession` per managed agent. |
| `NANOCODEX_ROOMS`, `NANOCODEX_MULTIPLAYER_QUOTA` | Multiplayer state and global quota. |
| `NANOCODEX_AUTH`, `NANOCODEX_USERS`, `NANOCODEX_API_KEYS`, `NANOCODEX_ORGANIZATIONS`, `NANOCODEX_MEMORY` | Account, key, organization, and durable-memory ownership. |
| `NANOCODEX_HISTORY`, `HISTORY_AI_SEARCH` | R2 history archive and production history retrieval. |
| `NANOCODEX_COMPUTE_SANDBOX` | Production Cloudflare Sandbox container for managed compute. |

`wrangler.jsonc` is the binding and migration source of truth. Development
uses the same Worker role with local Durable Objects, local egress binding, R2,
and shorter idle timing; AI Search and the Sandbox container are production
bindings.

## Development and operation

This package participates in the checkout-isolated local platform rather than
running as an independent product surface. Use the repository operator commands,
deployment order, secret handling, and required browser evidence in
[`../../AGENTS.md`](../../AGENTS.md). The package scripts provide its focused
typecheck, test, and Wrangler dry-run build when that boundary changes.
