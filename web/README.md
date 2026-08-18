# nanocodex

A from-scratch Codex rewrite for the latest generation of models. The experiment is to keep the
same tools and behavior while making the runtime much smaller; nanocodex makes the implementation
and evaluation record legible.

## Stack

- Vite + React
- Cloudflare Vite plugin and Workers runtime
- Wrangler for preview and deployment
- just-bash over the thread's OPFS filesystem, with browser `git` and `gh` compatibility commands
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

In development, Vite reads repository metadata from Git, serves working-tree
files on demand, and streams history directly from Git only when the commit
view opens. Startup does not generate or rewrite repository blobs. Set
`NANOCODEX_REPO` to point the development view at another checkout.

`npm run build` does not inspect Git or generate repository assets. Production
repository data is published separately to R2 by `npm run
publish:repository`. The publisher derives one coherent generation from a Git
commit, uploads only previously unseen source blobs and commit patches, uploads
one complete clone pack for exactly the advertised refs, and stores new Git
objects once in bounded immutable pack-entry shards. The Worker streams the
complete pack for a fresh clone, but uses the object graph and reusable shards
to send only the closure missing from an incremental or shallow fetch. Shards
are compacted after a bounded number of generations. Publication advances one
Durable Object pointer only after every referenced R2 object exists, so a failed
or concurrent publisher cannot expose mixed tree, history, or Git data. The
commit view loads only the selected patch and parses it in bounded batches,
yielding between batches so scrolling stays responsive.

For this single-repository deployment, R2 owns immutable bytes and one Durable
Object owns the current generation with compare-and-swap publication. D1 is
deliberately absent: there is no repository registry, account model, search
index, or relational query to justify it. Publishing requires the same
`GIT_MIRROR_TOKEN` secret on the Worker and `NANOCODEX_GIT_TOKEN` in the
publisher environment:

```bash
NANOCODEX_GIT_ORIGIN=https://nanocodex.me-7fb.workers.dev \
NANOCODEX_GIT_TOKEN=... \
npm run publish:repository
```

Production serves the website indexes, immutable file and patch objects, and a
read-only Git protocol-v2 endpoint from that publication. Clone the mirror with
`git clone https://nanocodex.me-7fb.workers.dev/git`. GitHub remains the write
remote; a workflow publishes each new `master` commit to Cloudflare after it is
pushed.

Each browser thread owns an OPFS working tree and an `origin` Cloudflare Git
remote on branch `nanocodex`. The Files and Commits surfaces read that thread's
actual Git objects in the browser; file blobs and commit patches are generated
on demand and released when the view refreshes. Push and pull notifications
cross the page/agent Worker boundary so an open repository view can preserve
its last complete render until the replacement snapshot is ready.

### Live eval view

`/evals` is part of the same production Vite and React application as the
Nanocodex homepage, embedded TUI, repository tree, and commit history. The
website reads its public API directly from the Cloudflare Worker. D1 owns the
task board and normalized result index; R2 owns task packages, case records,
and complete evidence. There is no coordinator host, tunnel, origin override,
or Access credential in the website read path.

Native benchmark hosts are disposable compute clients. They claim R2-backed
tasks from the Worker and authenticate every mutation with
`NANOCODEX_EVALS_WRITE_TOKEN`; they are never an authority for website reads.

The API is deliberately workset-oriented: the client loads the retained
workset index, drills into one workset's task summaries, loads one selected
treatment matrix, then requests a single opaque case ID for terminal evidence.
TanStack Query is the only application cache and owns polling, cancellation,
retry, and the overview/workset/task/case query lifetimes. There is no second eval-only HTML entry,
React root, Vite configuration, Node eval server, or browser-side SQL path.

The homepage is also a real embedded-agent demo with three deliberately thin
layers:

- `../js/bindings` publishes `nanocodex`, the viem-v3-style imperative client.
  Runtime entrypoints expose flattened `Agent.create` factories, decorated
  domain actions, standalone `Actions` namespaces, and typed watcher handles.
- `../js/react` publishes `nanocodex-react`, the wagmi-like headless React owner. Its provider and
  hooks manage the module Worker lifecycle, readiness, commands, and event
  subscriptions without imposing presentation policy.
- `../js/artifacts` publishes `nanocodex-artifacts`, the framework-independent
  live React source document and bounded workspace store.
- `AgentTerminal` is the optimized Ratatui-faithful consumer: native colors,
  rendering hierarchy, queue/steer behavior, `/btw`, historical branch editing,
  branch navigation, per-branch drafts, clipboard images, and key bindings over
  virtualized transcripts.

The module Worker loads the generated `nanocodex-wasm` package, and the Rust
engine owns the persistent Responses session, typed history, event stream, and
tool loop. Each thread opens one OPFS workspace shared by just-bash, Rust
`apply_patch`, isomorphic-git, the file viewer, commit history, uploads,
downloads, and the artifact dock. The model receives the standard
`exec_command` and Rust `apply_patch` tools rather than separate list/read/write
or Git tools. Shell commands include normal virtual Unix commands plus `git`,
`gh`, and `artifact`; `git push origin nanocodex` publishes the same objects the
Commits view reads from the Cloudflare thread remote. Files survive agent,
Worker, and page restarts without being copied into conversation snapshots.
The Cloudflare Worker upgrades `/api/responses` and proxies OpenAI
tool calls. It accepts a user-provided OpenAI key into a one-hour Durable Object
session and returns only an opaque `HttpOnly`, `SameSite=Strict` cookie. The key
is never placed in a URL, local storage, React state, or WASM configuration.

Custom interfaces use the shell instead of a model-specific tool. The agent
writes JavaScript source defining a real React `App`, then runs
`artifact publish <source.js> --id <id> --title "<title>"`. `React`, an `html`
tagged-template helper, and `sendPrompt` are supplied by the isolated iframe
runtime. Published documents live under `.nanocodex/artifacts` in the same Git
working tree and open in a fullscreen dock. Reusing an artifact ID replaces the
interface in place, so voice or text turns can continuously retheme and extend
it. Generated code has no imports, network access, or access to the parent page;
explicit `sendPrompt` actions re-enter the normal queued prompt lifecycle.
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
