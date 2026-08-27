# Nanocodex development

Read `PLAN.md` for the current phase, exit matrix, and the two parallel
customer-driven tracks.

## Commands

- `just dev` starts one complete instance-isolated local platform.
- `just deploy` builds, deploys, and verifies the complete production topology.
- `just down` stops only the local platform owned by this checkout.

These are the operator interface. Package-local builds, Wrangler calls,
migrations, resource creation, and probes stay inside them. For a requested
direct production rollout, use `just deploy`; do not wait for or repair CI unless
the user asks.

## Product boundary

- Nanocodex is a headless, library-first Rust agent SDK. The managed platform is
  the account, grant, durability, secret-routing, and hosted-tool layer above it.
- Keep the SDK narrow: one supported OpenAI model family, Responses WebSocket,
  one owned agent lifecycle, and caller-defined tools. Do not add provider
  portability or a generic app-server protocol.
- A consumer builds an agent, receives `(Nanocodex, AgentEvents)`, sends prompts
  through the cheap handle, and awaits typed `TurnResult`s. Events remain
  optional and independent from results.
- Follow-on turns reuse retained typed history automatically. Callers never
  replay messages, response IDs, or tool results to preserve a conversation.
- CLI, Nanocodex2, web, extensions, phones, bindings, and game plugins consume
  the same local SDK or hosted-agent contract; none creates a parallel backend.

## Account, Connect, and `wallet_connect`

- One passkey-backed account owns hosted agents, memory, connectors, MCPs,
  imports, and tool entitlements.
- Account is the general Connect surface. Embedded Connect imports the same
  passkey/account/connector components and adds only request context, filtering,
  approval/cancellation hooks, and return behavior. Never maintain UI forks.
- `wallet_connect` supports only the top-level `agent.run` permission. Its signed
  resources enumerate the exact output/history/trace visibility, memory access,
  connector names, MCP IDs, and optional bounded payment authority.
- A grant is bound to the exact app ID, app origin, account, agent, resources,
  and expiry. Server-side projection and tool routing must enforce that slice.
  Account entitlements may make capabilities available, but never broaden an
  existing app grant without approval.
- CLI device authorization and third-party web embedding use this same grant
  protocol. Both must support current, remembered-other, system-selected, and
  new passkeys; missing requested hosted connections can be completed in the
  dialog before approval.
- Show all remembered passkey accounts. Signing out ends the browser session but
  preserves that catalog. An expired persistent session requires passkey
  reauthentication and never silently becomes an anonymous account.
- Account connector actions update in place. Request-scoped Connect may show
  completion and return to its caller. ChatGPT import is optional after account
  creation, never automatic onboarding.
- Logging out does not revoke an app grant; revocation is explicit. Recheck live
  connector/MCP state before minting a grant from an approval.
- Provider credentials remain behind the broker. They never enter app or dialog
  JavaScript, browser storage/network payloads, CLI output, or managed-agent
  configuration.
- Hosted and reverse-attached tools share an account-visible catalog with exact
  source, revision, readiness, fencing, and revocation. Attachment chooses tool
  execution placement; it does not imply local/cloud workspace synchronization.

## Workflow

- Work in focused chronological commits on `master`. If the primary checkout is
  dirty with unrelated work, use a clean worktree and push its reviewed HEAD;
  never mix, delete, reset, or stall on the unrelated changes.
- Build complete vertical slices through a real consumer. Fix failures at the
  highest owning boundary and stop known-pathological work instead of waiting
  for misleading downstream output.
- Use existing dependencies and project patterns. Prefer direct ownership and
  deletion over speculative abstraction or compatibility layers.
- Never commit `.env`, secrets, caches, generated builds, retained jobs, or
  another user's untracked files. Never print secret values while checking or
  applying deployment configuration.
- Keep long-lived processes and logs bounded. Stop or reopen a writer before
  deleting a large log; deleting an open file does not reclaim disk blocks.
- At handoff, run the smallest checks that cover the changed boundary. Broad
  workspace builds are milestone gates, not iteration ceremony.

## Web and production evidence

- Use conventional React/Vite ownership: one `createRoot` per entry, one
  declarative tree, normal components/hooks/context, and Vite-owned module and
  chunk behavior. Do not add imperative sub-roots or a second loader system.
- Do not show transient loading copy, spinners, skeletons, or Suspense
  placeholders. Preserve the last complete interface when possible; otherwise
  render nothing until ready. Render actionable errors after real failures.
- Local stacks are checkout-isolated. Each owns Wrangler state, ports, and app
  hosts. Local WebAuthn uses exact instance origins with the shared parent RP ID
  `nanocodex.localhost` and never shares private Worker state.
- Every web/runtime/route/auth change must pass in the host-managed browser on
  its canonical URL. Unit tests, builds, curl, and source assertions support but
  never replace that pass.
- Exercise the exact changed flow through visible controls. Use desktop and a
  representative touch/mobile viewport for layout/navigation, and independent
  contexts plus reload/reconnect for durable or multi-user behavior.
- Inspect console errors, failed requests, WebSockets/event streams, storage,
  CSP/framing, and secret absence. A browser-discovered failure is authoritative
  and blocks downstream claims.
- A production rollout is successful only when root assets, service bindings,
  container, managed routes, Connect API/dialog/playground, connector boundary,
  exact SHA, and canonical browser flows all work. A healthy static page alone
  is not a platform deployment.

## Runtime ownership

- The private spawned driver solely owns mutable conversation, model, tool,
  socket, and Tower service state. It lives until all command handles drop.
- One agent reuses its WebSocket, typed history, code-mode runtime, shells, cache
  identity, and response chain across turns.
- Client-owned typed history is authoritative. Healthy attempts send a new
  delta with `previous_response_id`; replacement sockets replay complete
  committed history without that ID.
- Commit only completed responses. Failed partial responses execute no tool and
  enter no history. Retries replay owned attempt state without duplicating side
  effects.
- `prompt().await` acknowledges queue admission and returns an independently
  awaitable `Turn`; the driver owns ordering. Cancellation drains turn-owned
  work while explicit runtime shutdown terminates owned subprocess groups.
- One Tower call spans one complete streamed Responses attempt through
  completion or typed failure. The SDK owns retry/reconnect policy while callers
  may wrap the concrete service with non-retrying middleware.
- Typed events are the public stream; JSONL is only an adapter. Tracing is a
  full-fidelity diagnostic copy and must preserve order and explicit lineage.

## Crate boundaries

- `nanocodex-oai-api`: complete OpenAI wire/context/transport/retry boundary.
- `nanocodex-tools`: built-ins, Code Mode, MCP, registry, search, and dispatch.
- `nanocodex-agent`: private driver, lifecycle, branching, snapshots, builders.
- `nanocodex-subagents`: optional task-tree extension above the agent crate.
- `nanocodex`: reexport-only facade; no runtime implementation.
- `bin/nanocodex`: CLI and application policy, including Tempo/MPP behavior.
- Experimental egress and VM crates own their full proxy and isolation
  boundaries. Lower crates remain useful without higher orchestration crates.
- `scripts/check-crate-boundaries.sh` is the executable dependency policy.

## Rust and Codex reference

- Use small typed components, explicit ownership, builders for policy, bounded
  production, contextual errors, and `RawValue` for retained opaque wire data.
  Avoid `unwrap`, `expect`, silent fallbacks, known-shape JSON DOMs, and cloning
  merely to satisfy borrowed interfaces in runtime paths.
- Use local `~/github/openai/codex/codex-rs` before claims about Codex. Codex is
  behavioral evidence, not an API requirement.
- The reviewed checkpoint is
  `openai/codex@7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4`. Review every later
  commit as port/evaluate/defer/out-of-scope and cite adopted behavior before
  advancing it.

## Frontier eval work only

- The benchmark host is `ubuntu@dev-georgios`; canonical state is
  `/mnt/nanocodex-evals/evals/state.sqlite3`.
- Optimize idea-to-host evidence. Avoid broad local Rust builds during the edit
  loop; deploy a coherent slice and inspect exact retained trajectories and
  verifier output.
- High utilization is expected. Judge health by productive throughput, stale
  claims, retries, OOM behavior, and recovery rather than CPU/RAM pressure alone.
- Eval schema is mutable development state with `user_version = 1`; directly
  replace the current layout instead of adding migration ladders or old readers
  unless explicitly requested.
