# Nanocodex development

## Operate

- Keep operator process here, not in launcher, bootstrap, cleanup, probe, or
  verification scripts. Package scripts may call standard tools or build real
  artifacts; they must not hide multi-step development or release ceremony.
- Install only the package whose lockfile changed. The Nanocodex Vite plugin
  generates WASM; invoke its builder directly only for package CI or publication.
- For local web work, apply a changed D1 migration directly with Wrangler, then
  from `web/` start with
  `CLOUDFLARE_ENV=development npx vite --host 127.0.0.1 --port 5173`.
- Use `http://nanocodex.localhost:5173`; stop Vite with Ctrl-C. The Nanocodex
  Vite plugin owns the local OAuth relay.
- Production deploys are direct `wrangler deploy` calls. Do not add deploy,
  preflight, rollout, probe, reconciliation, retry, or test wrappers.
- Build only changed artifacts. Installs, resource creation, D1 migrations,
  secrets, container rollouts, repository publication, and verification are
  separate explicit operations.
- Deploy only the changed checked-in Wrangler configs in binding dependency
  order; deploy the public root last.
- Wrangler success means uploaded, not healthy. Verify affected customer
  behavior on the canonical production URL.

## Behavior matrix

- Root: hydrate and navigate every shipped route on desktop and touch; no
  console, request, or asset failure.
- Account: use a remembered passkey, sign out, reload, and reauthenticate the
  same account; never create a silent replacement.
- Managed: complete two turns, reload/reconnect, retain each committed turn once,
  and continue with prior context.
- MCP: connect Linear in Account, call one granted tool, revoke it, and prove it
  cannot execute again.
- Connect: approve one exact `wallet_connect` request from a minimal client,
  reload, and expose only the granted projection.
- Attachment: attach, become ready, execute once, detach, and fence stale or
  ungranted hosts.
- Isolation: use two independent accounts; prove agents, history, events, and
  tools never cross accounts and ungranted reads fail closed.
- Inspect console, failed requests, sockets/events, storage, CSP/framing, and
  provider-secret absence. Run changed rows during iteration and all rows at a
  milestone; record SHA, accounts, browser/device, and trace.

## Test policy

- Prefer customer browser E2E and real protocol/service-boundary tests.
- Do not add one-off test files, smoke scripts, harnesses, or command wrappers;
  use the owning boundary or direct standard-tool evidence.
- Keep narrow tests for pure policy/parsing, signed grants, durable commits,
  retries, routing, fencing, isolation, and secret redaction.
- Delete tests of source text, command strings, deploy implementation, fake
  health responses, and copied Wrangler topology.
- Builds, typechecks, unit tests, curl, and static health support evidence; none
  replaces the changed browser journey. Run the smallest owning checks.

## Product invariants

- Rust owns the agent lifecycle and product behavior. `nanocodex` is reexports
  only; WASM is a generated export, not a second handwritten runtime.
- Vite/Cloudflare and the managed platform consume that generated WASM. Keep JS
  to unavoidable host callbacks and platform bindings; do not reimplement
  history, tools, retries, durability, orchestration, or policy in adapters.
- During JS or managed-product iteration, do not edit Rust unless the user asks
  for Rust changes. Treat generated WASM as the Rust boundary.
- The managed platform owns only accounts, grants, durable hosted agents,
  memory/history, secret routing, connectors/MCP, and hosted tools.
- One passkey account owns agents, memory, connectors, MCPs, and tools.
  Account and embedded Connect share one implementation.
- `wallet_connect` grants only `agent.run` and binds exact app, origin, account,
  agent, resources, expiry, visibility, memory, connectors, MCPs, and payment cap.
- Provider credentials stay behind the broker and never enter browser/app code,
  storage/network payloads, CLI output, logs, or agent config.
- The private driver owns conversation/model/tool/socket state. Commit completed
  turns only; replay typed committed history; never duplicate retry side effects.
- Keep examples tiny clients. Do not grow demos, alternate backends, language/UI
  adapters, import/export systems, compatibility layers, or experimental
  products in this repository without an explicit product decision.

## Workflow

- Use focused commits and a clean worktree when the primary checkout has
  unrelated changes. Never mix, delete, or reset user work.
- Fix the highest owning boundary. Prefer deletion and direct ownership over
  wrappers, compatibility layers, or speculative abstraction.
- Existing code, docs, tests, and releases are not reasons to preserve a surface
  that no longer fits the product boundary.
- Never commit/print secrets, `.env`, caches, generated builds, retained jobs,
  or another user's untracked files.
- Exercise web/runtime/auth changes through visible controls in the host-managed
  browser and preserve the last complete UI while loading.
- Use local `~/github/openai/codex/codex-rs` before Codex claims; do not maintain
  commit-by-commit parity ledgers or checkpoint archaeology.
