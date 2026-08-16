# nanocodex

A from-scratch Codex rewrite for the latest generation of models. The experiment is to keep the
same tools and behavior while making the runtime much smaller; nanocodex makes the implementation
and evaluation record legible.

## Stack

- Vite + React
- Cloudflare Vite plugin and Workers runtime
- Wrangler for preview and deployment
- Pierre Trees and Diffs for the file tree, source viewer, and the single virtualized commit stream
- TanStack Virtual for the commit quick-jump and evaluation indexes
- Derived job, trial, trajectory, and verifier views

The visual system follows the local Paradigm website's semantic tokens,
typography roles, grid, controls, and search treatment while using system font
fallbacks rather than the site's proprietary font files.

## Development

```bash
cd web
npm install
npm run dev
```

The homepage consumes the publishable `nanocodex` and `nanocodex-react`
packages under `../js`; it does not reach into generated WASM artifacts. Its
React integration follows an external-store pattern: create a
`createConfig()` once, pass it to `NanocodexProvider`, and consume
`useNanocodex`, `useNanocodexMessage`, or `useConfig`. React owns no agent
history, credential policy, or model-loop state.

The local Worker and Vite client run together at `https://localhost:5173`, using
the same Cloudflare Vite-plugin layout as Tempo's React MPP examples.

`npm run dev` and `npm run build` first regenerate
`src/data/harness-repository.json` from the parent repository. Override the source or
history depth with `NANOCODEX_REPO` and `NANOCODEX_COMMIT_LIMIT`. The default index
covers the complete repository history and stores it as one streamed patch
asset. The commit view parses complete files in bounded batches and appends
them to one Pierre CodeView, yielding between batches so scrolling stays
responsive.

### Live eval view

`/evals` is part of the same production Vite and React application as the
Nanocodex homepage, embedded TUI, repository tree, and commit history. The
website uses a typed HTTP client and has no SQLite or artifact-path knowledge.
The existing evaluation coordinator owns the durable ledger and exposes its
read-only Axum API alongside the worker routes:

```bash
cd ..
cargo run -p nanocodex-bin -- eval coordinator dx-distributed-k2 \
  --config nanocodex.dx-sweep.toml \
  --state-dir ~/.nanocodex/evals \
  --port 8788
```

For development, the local Worker proxies `/api/evals` to
`http://127.0.0.1:8788`. When the coordinator runs on another box, forward that
loopback port before starting Vite:

```bash
ssh -N -L 127.0.0.1:8788:127.0.0.1:8788 ubuntu@dev-georgios
```

Set `EVALS_API_ORIGIN` to override the local origin. Plain HTTP is accepted only
for a loopback origin in the development environment. In production, set
`EVALS_API_ORIGIN` on the Cloudflare Worker to the HTTPS Cloudflare Tunnel
hostname. Protect that hostname with Cloudflare Access and configure
`EVALS_ACCESS_CLIENT_ID` plus the `EVALS_ACCESS_CLIENT_SECRET` Worker secret.
The Worker forwards only same-origin GET requests under `/api/evals`; SQLite
and retained artifacts remain on the coordinator box.

The API is deliberately workset-oriented: the client loads the retained
workset index, drills into one workset's task summaries, loads one selected
treatment matrix, then requests a single opaque case ID for terminal evidence.
TanStack Query is the only application cache and owns polling, cancellation,
retry, and the overview/workset/task/case query lifetimes. The coordinator and
Cloudflare proxy add no evidence cache. There is no second eval-only HTML entry,
React root, Vite configuration, Node eval server, or browser-side SQL path.

The homepage is also a real embedded-agent demo with three deliberately thin
layers:

- `../js/bindings` publishes `nanocodex`, the viem-v3-style imperative client.
  Runtime entrypoints expose flattened `Agent.create` factories, decorated
  domain actions, standalone `Actions` namespaces, and typed watcher handles.
- `../js/react` publishes `nanocodex-react`, the wagmi-like headless React owner. Its provider and
  hooks manage the module Worker lifecycle, readiness, commands, and event
  subscriptions without imposing presentation policy.
- `AgentTerminal` is the optimized Ratatui-faithful consumer: native colors,
  rendering hierarchy, queue/steer behavior, `/btw`, historical branch editing,
  branch navigation, per-branch drafts, clipboard images, and key bindings over
  virtualized transcripts.

The module Worker loads the generated `nanocodex-wasm` package, and the Rust
engine owns the persistent Responses session, typed history, event stream, and
tool loop. It also opens the stable `nanocodex-home` OPFS workspace and exposes
that same application-owned handle through bounded file tools and the homepage
file tree/editor. Uploads, downloads, and edits use the same handle, so files
survive agent, Worker, and page restarts without being copied into conversation
snapshots or Cloudflare state. The Cloudflare Worker upgrades `/api/responses` and proxies OpenAI
tool calls. It accepts a user-provided OpenAI key into a one-hour Durable Object
session and returns only an opaque `HttpOnly`, `SameSite=Strict` cookie. The key
is never placed in a URL, local storage, React state, or WASM configuration.
A user key takes precedence over the optional deployment-owned
`OPENAI_API_KEY`; forgetting or expiring it falls back to that deployment key
when present.

OpenAI remains the default agent connection. A user can explicitly select
Tempo MPP instead; only then does React lazy-load Wagmi and Tempo Accounts,
open the standard embedded Tempo Wallet dialog for its account and passkey flow, and
authorize a bounded one-day access key in that same Accounts connection
ceremony. The
module Worker hydrates that delegated signer from Accounts' IndexedDB storage
and gives it to an mppx session manager with a durable channel store. Marking
that manager as Nanocodex's Tempo provider also enables the package's built-in
Mercator MCP. MPPx pays its charge or session challenges with the same signer,
limits, and durable store; its tools remain deferred behind `tool_search` and
Code Mode. The model channel is reused across turns and reloads and is not
closed by Nanocodex. Wallet, payer, delegated signer, channel, model cumulative,
Mercator cumulative, and agent event JSONL are shown only while the MPP route
is selected. The normal OpenAI and ChatGPT routes do not initialize Mercator or
expose any payment state.

Development uses `vite-plugin-mkcert` because the Accounts SDK intentionally
falls back to a popup on plain HTTP. Cross-origin passkeys inside the hosted
Tempo Wallet iframe require a secure context; trusted local HTTPS exercises the
same embedded flow as production.

Local development reads the optional ignored root `.env` through the repository
workflow. For a shared demo fallback, configure the deployed Worker with
`wrangler secret put OPENAI_API_KEY`. BYOK itself uses the `BYOK_SESSIONS`
Durable Object binding declared in `wrangler.jsonc` and does not require a
deployment-owned OpenAI key.

Streaming events are coalesced once per animation frame before updating the
semantic transcript, and each independently scrolling transcript is
virtualized. `npm test` keeps the
event accumulator bounded under a 20,000-delta burst and covers assistant,
reasoning, and tool lifecycle updates.

The homepage also exposes the release contract: the checksum-verifying install
command, in-place `nanocodex update`, the crates.io SDK entry point, and links
to the latest GitHub Release and grouped conventional-commit changelog. GitHub
release notes also credit each pull request contributor.

Navigation stays available whenever an input is not active: `H`, `T`, `C`, `R`,
and `E` switch between Home, Code, Commits, Requests, and Evals. The repository
homepage is the root route. In Code, `Ctrl+P` searches the left tree and `Ctrl+F` opens the
fuzzy all-file jumper. In Commits, `F` searches history. Code and commit
scrolling are left to Pierre CodeView and the browser's native input behavior.

## Production

```bash
npm run build
npm run preview
npm run deploy:preview
npm run deploy
```

The proposal endpoint is intentionally a testnet-preview `402` until a live MPP
recipient and settlement policy are configured.
