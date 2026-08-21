# Nanocodex web

The public product site, native documentation, live browser-agent consumer,
repository browser, and evaluation evidence for Nanocodex. The coding agent is
the library; this application proves that the same owned Rust lifecycle can sit
behind an opinionated web interface without turning that interface into an SDK
protocol.

## Stack

- Vite + React
- Cloudflare Vite plugin and Workers runtime
- Wrangler for preview and deployment
- just-bash over the thread's OPFS filesystem, with browser `git` and `gh` compatibility commands
- Pierre Trees and Diffs for the file tree, source viewer, and the single virtualized commit stream
- TanStack Virtual for the commit quick-jump and evaluation indexes
- Derived job, trial, trajectory, and verifier views

The visual and content direction is captured in [`DESIGN.md`](DESIGN.md): a
Berkeley Mono-first, black-and-white simplification inspired by fx.sh and shaped
around Nanocodex's library ownership model. Treat that brief as the north star
while the existing surfaces are recomposed incrementally.

## Development

```bash
cd web
npm install
npm run dev
```

The homepage consumes the publishable `nanocodex` and `nanocodex-react`
packages under `../js`; it does not reach into generated WASM artifacts. Its
React integration wraps the terminal in `NanocodexProvider`, creates the
browser agent with `useAgent({ enabled, threadId })`, and observes its typed
event stream with `useAgentEvents`. React owns no Worker lifecycle, agent
history, credential policy, or model-loop state.

The local Worker and Vite client run together at `https://localhost:5173` using
the Cloudflare Vite-plugin layout.

### Documentation

The product guide lives in `docs/src/pages` and is rendered by the lazy native
Docs surface under `/docs`. The Markdown stays the source of truth; the Vite
application supplies the shared shell, responsive navigation, heading links,
code copy controls, and route-aware reading layout. `npm run build` checks that
every page entered the Docs bundle and generates `llms.txt` plus
`llms-full.txt` in the Cloudflare asset tree. The docs are not a second service,
generator, or visual system.

In development, Vite reads repository metadata from Git, serves working-tree
files on demand, and streams history directly from Git only when the commit
view opens. Startup does not generate or rewrite repository blobs. Set
`NANOCODEX_REPO` to point the development view at another checkout.

`npm run build` does not inspect Git or generate repository assets. Production
repository data is published separately to R2 by `npm run
publish:repository`. The publisher derives one coherent generation from a Git
commit, projects only the canonical `master` ref, uploads only
previously unseen source blobs and commit patches, builds one verified clone
pack for exactly those refs, uploads that pack in bounded immutable parts, and
stores new Git objects once in bounded immutable pack-entry shards. The Worker
streams the pack parts byte-for-byte as the complete pack for a fresh clone,
but uses the object graph and reusable shards to send only the closure missing
from an incremental or shallow fetch. Shards are compacted after a bounded
number of generations. Publication advances one
Durable Object pointer only after every referenced R2 object exists, so a failed
or concurrent publisher cannot expose mixed tree, history, or Git data. The
commit view resolves an immutable generation manifest, streams its aggregate
patch from bounded parts instead of issuing a request per commit, then parses
and publishes it in bounded batches while yielding between batches so the
first diff and scrolling stay responsive.

For this single-repository deployment, R2 owns immutable bytes and one Durable
Object owns the current generation with compare-and-swap publication. D1 is
deliberately absent: there is no repository registry, account model, search
index, or relational query to justify it. Publishing requires the same
`GIT_MIRROR_TOKEN` secret on the Worker and `NANOCODEX_GIT_TOKEN` in the
publisher environment. The publisher also requires `/api/health` to attest the
same complete Git SHA before it makes an authenticated request or uploads an
object:

```bash
NANOCODEX_GIT_ORIGIN=https://nanocodex.me-7fb.workers.dev \
NANOCODEX_GIT_TOKEN=... \
npm run publish:repository
```

If the Durable Object contains an obsolete publication shape, the publisher
stops before uploading anything. Repair it atomically after deploying the
current Worker by explicitly opting into a current-format replacement:

```bash
NANOCODEX_GIT_ORIGIN=https://nanocodex.me-7fb.workers.dev \
NANOCODEX_GIT_TOKEN=... \
NANOCODEX_REPAIR_INVALID_PUBLICATION=1 \
npm run publish:repository
```

The replacement is accepted only while the stored publication is invalid; it
cannot overwrite a valid generation or bypass its compare-and-swap head.

Production serves the website indexes, immutable file and patch objects, and a
read-only Git protocol-v2 endpoint from that publication. Clone the mirror with
`git clone https://nanocodex.me-7fb.workers.dev/git`. GitHub remains the write
remote. After each current `master` commit passes CI, the website job deploys
the exact tested Worker with that SHA, waits for `/api/health` to return it as
`deployment_sha`, publishes the repository generation, and verifies both the
snapshot and Git protocol advertise the same SHA. An obsolete queued CI run is
not allowed to deploy or publish.

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
- `nanocodex/tools` owns the framework-independent live React document,
  bounded workspace store, and typed artifact tool used by the web consumer.
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
or Git tools. Shell commands include normal virtual Unix commands plus `git`
and `gh`; `git push origin nanocodex` publishes the same objects the
Commits view reads from the Cloudflare thread remote. Files survive agent,
Worker, and page restarts without being copied into conversation snapshots.
The Cloudflare Worker upgrades `/api/responses` and proxies OpenAI
tool calls. It accepts a user-provided OpenAI key into a one-hour Durable Object
session and returns only an opaque `HttpOnly`, `SameSite=Strict` cookie. The key
is never placed in a URL, local storage, React state, or WASM configuration.

Custom interfaces use the typed `render_artifact` tool composed by
`nanocodex/tools/browser`, alongside `exec_command`, `web__run`, and
`image_gen__imagegen`. The tool accepts JavaScript source defining a real React
`App`; `React`, an `html` tagged-template helper, and `sendPrompt` are supplied by the isolated iframe
runtime. Published documents live under `.nanocodex/artifacts` in the same Git
working tree and open in a fullscreen dock. Reusing an artifact ID replaces the
interface in place, so voice or text turns can continuously retheme and extend
it. Generated code has no imports, network access, or access to the parent page;
explicit `sendPrompt` actions re-enter the normal queued prompt lifecycle.
The browser agent requires an explicit user OpenAI key or ChatGPT session. A
presented session that cannot be read fails explicitly instead of falling back
to another credential.

The reusable `browser(...)` tool bundle gives the browser agent a bounded
`dataset` tool. It can inspect public
Parquet URLs, Hugging Face dataset/config/split exports, and uncompressed JSONL
URLs without downloading whole datasets into memory. Parquet reads use HTTP
ranges and filter/projection pushdown where possible; JSONL reads incrementally
scan the response stream. Dataset handles are scoped to an agent session. Query
limits and offsets accept any nonnegative safe range; input-byte and output-byte
budgets remain bounded. Partial results report `complete: false` and an opaque
`nextCursor` that retains projection and filters while resuming at the physical
Parquet row batch or JSONL byte position. The implementation and Parquet codecs
are lazy chunks, so ordinary agent sessions do not download them. Direct sources
must permit browser CORS. Parquet sources must honor byte-range requests; JSONL
sources must honor them when continuing from a cursor.

For example, ask the web agent to “inspect the `main` config’s `train` split of
`openai/gsm8k`, show its schema, and find five examples containing arithmetic.”
The resulting tool flow is equivalent to:

```json
{"operation":"open","source":{"kind":"huggingface","dataset":"openai/gsm8k","config":"main","split":"train"}}
{"operation":"query","dataset_id":"<returned id>","columns":["question","answer"],"filters":[{"column":"question","op":"contains","value":"how many"}],"limit":5}
{"operation":"query","dataset_id":"<returned id>","cursor":"<returned nextCursor>","limit":5}
{"operation":"close","dataset_id":"<returned id>"}
```

Run `npm run bench:dataset` in `js/bindings` for the deterministic 100,000-row
Snappy Parquet/JSONL browser-path benchmark. It reports cold and repeated query
latency, pulled bytes, range requests, scanned rows, and cache hits.

Development uses `vite-plugin-mkcert` so the browser Agent exercises its secure
context requirements under the same HTTPS boundary as production.

Local development reads the optional ignored root `.env` through the repository
workflow. BYOK uses the `BYOK_SESSIONS` Durable Object binding; ChatGPT login
uses its separate server-owned session boundary.

The browser agent does not use JavaScript Promise Integration (JSPI). Its
consumer startup gate checks only the platform APIs used by the shipped path:
a secure context, module Worker support, WebAssembly, WebSocket,
`crypto.randomUUID`, OPFS, and Web Locks. These are normal current stable
Safari/iPhone Safari capabilities; the real wasm-bindgen initialization remains
the authority for the shipped module and reports an actionable failure instead
of requiring Safari Technology Preview or a beta-only JSPI API.

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

`master` CI can own production deployment after the `CLOUDFLARE_API_TOKEN`
repository secret, `CLOUDFLARE_ACCOUNT_ID` repository variable, and
`CLOUDFLARE_DEPLOY_ENABLED=true` repository variable are configured. The
existing `NANOCODEX_GIT_TOKEN` publishes the matching repository generation.
Without that explicit enablement, CI still validates the complete production
graph but does not mutate the hosted Worker. Local commands build and preview
it:

```bash
npm run build
npm run preview
```

For a break-glass production deployment, start from a clean commit and preserve
the same attestation contract before running `publish:repository`:

```bash
npm run deploy
```

The deploy command requires `HEAD` to equal the fetched `origin/master`, binds
that full commit SHA into the Worker version, rolls only that version to 100%
without rebuilding unchanged containers, and does not return successfully until
the live health endpoint attests the same revision.

Do not publish repository data until the hosted `/api/health` reports that
exact `deployment_sha`. The publisher enforces this ordering independently. An
authenticated operator can publish the already-deployed master revision with:

```bash
gh workflow run mirror-cloudflare-git.yml --ref master -f revision="$revision"
```

For the one-time invalid-publication repair, add
`-f repair_invalid_publication=true` to that dispatch.
