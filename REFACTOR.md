# Nanocodex refactor

This is the design record for the Nanocodex monorepo refactor. It captures the
decisions that produced the current implementation slices. The active plan
that originally accompanied this record has been retired.

## Outcome

Nanocodex is a collection of high-quality reusable building blocks for
frontier OpenAI agents:

1. a Tower-native OpenAI Responses API;
2. a typed tool contract plus built-ins, MCP, `tool_search`, and Code Mode;
3. batteries-included context and response-session management;
4. one owned agent lifecycle;
5. isolated, pre-snapshotted VMs;
6. a headed browser running inside those VMs;
7. host-owned MPP and secret-aware VM egress;
8. a typed evaluation runtime exposed through `nanocodex eval`; and
9. Nanocentaur as the durable managed-agent product built from these pieces.

The refactor succeeds when the components have useful standalone APIs, the
facade is thin, existing behavior is preserved, performance contracts are
measured, and Nanoeval's supported workflows run from this repository through
`nanocodex eval ...`.

`master` is the behavioral parity baseline. A slice may deliberately redesign
an API, but it may not remove a working capability, target, transport, tool,
consumer, event, or operational workflow without an explicit replacement
decision. Compatibility surfaces remain only long enough to move real
consumers; deletion follows a focused parity test or smoke proving the new
owner.

## Design rules

### Building blocks

- Each implementation crate has a sensible API without importing a higher
  orchestration crate.
- Stateful async lifecycle methods live on the struct that owns the state.
- Public builders expose policy, not queue sizes, socket tasks, replay
  bookkeeping, or other mechanics.
- Prefer moving ownership and deleting adapters over adding compatibility
  layers.
- The top-level `nanocodex` crate contains no runtime implementation.

### Harness and model co-design

- Ground model-facing behavior in the local Codex implementation.
- Preserve instructions, tool shapes, ordering, cache identity, history
  continuation, compaction semantics, reconnect replay, and cancellation.
- Do not introduce provider portability, a generic scheduler, or a second
  runtime mode.
- Client-owned typed history is authoritative; provider checkpoints are opaque
  accelerators.

### Public API quality

- Every public item has a useful Rustdoc comment.
- Crate-level docs begin with the smallest complete example, then disclose
  lifecycle, policy, and extension details progressively.
- Every public example supplies real values. It must not contain placeholders
  such as `.instructions(instructions)`.
- Public examples compile in CI.
- `missing_docs` and broken intra-doc links are denied.
- Defaults, cancellation behavior, error semantics, and ownership are
  documented rather than inferred.

### Performance

- Benchmarks live beside the crate that owns the measured behavior.
- Every hot public operation gets a representative fixture, metric, baseline,
  and regression budget.
- Structural and asymptotic budgets are hard gates immediately.
- Numeric gates begin only after a reproducible local baseline exists.
- Live provider measurements retain raw inputs, events, timings, usage, and
  environment metadata; they are trend evidence rather than deterministic CI
  tests.
- No performance claim is made from a synthetic microbenchmark alone.
- The normal-turn target is model and network latency dominating the critical
  path. A trace must separate queueing, encoding, transport, first-token wait,
  parsing, event delivery, tool work, and aggregation before making that claim.
- Independent MCP discovery, tool calls, VM preparation, browser work, and eval
  attempts run as bounded sibling branches. Conversation mutation, response
  commit, and externally visible ordering retain one deterministic owner.

### Tracing

- Follow init4-style topology: one root span is one bounded operation, never a
  long-lived driver or session.
- Carry explicit parents with work sent across channels and instrument futures
  before spawning them. Concurrent work appears as overlapping sibling
  branches.
- Put complete ordered prompts, responses, reasoning, tool arguments, and tool
  results in span events. Span attributes remain structural and searchable.
- Retained traces are also performance evidence: they must make harness
  overhead, provider wait, parallel work, backpressure, and cancellation
  visible without adding a second observation path.

## Target crate graph

```text
nanocodex
├── reexports nanocodex-agent
├── module reexports for oai, tools, macros, observability
└── prelude with only the golden-path traits and types

nanocodex-agent
├── nanocodex-oai-api
└── nanocodex-tools
    └── generated Tool impls reference nanocodex-oai-api

nanocodex-tools-macros
└── proc-macro implementation; no agent dependency
```

Systems and evaluation crates remain below the agent:

```text
nanovm-image ──> nanovm ──> nanocodex-vm
                      └────> nanocodex-browser-vm ──> nanocodex-browser

nanocodex-vm-egress
├── neutral EgressLease composition
├── MPP provider
└── secret gateway provider

nanocodex-eval
├── nanocodex-agent
├── nanovm-image
├── nanocodex-vm
└── nanocodex-eval-harbor

nanocentaur
├── nanocodex-agent
├── nanocodex-vm
└── nanocodex-vm-egress
```

The exact names of the VM image and egress crates remain subject to the
standalone-API review. Their ownership boundaries do not.

## Agreed core APIs

### Facade

`nanocodex` follows the Alloy/Tokio pattern:

- no runtime implementation;
- direct reexports of the golden agent types;
- named modules that reexport component crates; and
- a deliberately small `prelude`.

Using the facade and using `nanocodex-agent` directly produces the same agent.
There is no separate "golden path" implementation.

### Agent construction

```rust,ignore
use nanocodex::{Nanocodex, OpenAi};

let openai = OpenAi::new(std::env::var("OPENAI_API_KEY")?)?;
let (agent, events) = Nanocodex::builder(openai)
    .instructions(
        "You are a Rust coding agent. Make focused changes, preserve unrelated \
         work, and run relevant tests before finishing.",
    )
    .workspace(std::env::current_dir()?)
    .thinking(Thinking::High)
    .reasoning_mode(ReasoningMode::Standard)
    .fast_mode(false)
    .build()?;
```

There is one supported model family with a deliberate public Sol/Terra/Luna
selector. `NanocodexBuilder` is a cloneable recipe. Every `build()` creates
fresh driver, context, transport, tools, and event resources.

### Turns

```rust,ignore
let turn = agent
    .prompt("Find the cause of the failing test and explain it.")
    .await?;
let result = turn.await?;
```

- `prompt(...).await -> Result<Turn, NanocodexError>` means accepted and
  ordered, not completed.
- `Turn` is non-cloneable.
- `Turn::control()` returns a cloneable `TurnControl`.
- `Turn` implements a per-turn typed `Stream`.
- `Turn` implements `Future<Output = Result<TurnResult,
  NanocodexError>>`.
- A named `result()` convenience may remain, with its equivalence to awaiting
  the turn documented.
- `steer(...)` enters the active turn's FIFO and becomes model-visible at the
  next safe response boundary.
- `cancel()` waits until model work, tools, subprocess groups, and descendants
  stop. It produces one terminal cancellation event.

`AgentEvents` is a separate session-wide stream. Its `recv()` method remains as
a documented convenience for consumers that do not use `StreamExt`.
Dropping the event receiver has no lifecycle effect.

### Results and branching

`TurnResult` has private fields and these accessors:

- `final_message() -> &str`;
- `into_final_message() -> String`;
- `usage() -> &TurnUsage`; and
- `snapshot() -> SessionSnapshot`.

`TurnUsage` aggregates all Responses calls in the logical agent turn.
It exposes the exact input, cache-read, cache-write, output, and reasoning
token counts plus a typed estimated USD cost. Nanocodex supports
`gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`; each model's published
standard and priority rates are built in and selected from the turn's model and
`fast_mode` policy. There is no pricing builder, file, environment variable,
catalog, or caller-defined rate surface. `CostStatus::UsageNotReported` keeps
omitted provider accounting distinct from a genuine zero-token result.

- `agent.clone()` targets the same driver, session, and command queue.
- `AgentHandle::spawn()` creates a clean sibling from the same recipe.
- `AgentHandle::fork()` branches from the latest safe committed boundary.
- `agent.fork_from(&result)` branches from that exact completed checkpoint.
- Cross-lineage checkpoints return a typed error.
- Forks receive fresh drivers, transports, tool runtimes, and agent-relative
  weak handles.

`SessionSnapshot` is opaque, versioned, and serializable. It contains complete
authoritative history but no provider response IDs. Resume creates fresh
runtime resources and performs full replay before returning to healthy
incremental continuation.

`SessionId` is a transparent UUIDv7 newtype.

### Errors

The agent surface returns one `NanocodexError`. Lower-layer errors are
transparent `#[from]` variants that preserve their source and typed
classification. Context-window exhaustion, cancellation, lineage mismatch,
authentication, transport, protocol, tool, and snapshot errors are not
flattened into strings.

### Agent events

```rust,ignore
pub struct AgentEvent {
    pub session_id: SessionId,
    pub sequence: u64,
    pub data: AgentEventData,
}

pub enum AgentEventData {
    Turn(TurnEvent),
    Assistant(AssistantEvent),
    Tool(ToolEvent),
    Context(ContextEvent),
    OpenAi(OpenAiEvent),
}
```

There are three intentional event scopes:

1. `ResponseEvent`: one provider `create` or `compact` stream;
2. `TurnEvent`: one accepted agent prompt spanning model calls and tools; and
3. `AgentEvents`: the entire session firehose.

JSONL, rollout, and OpenTelemetry are adapters over these typed events.
Tracing additionally retains the complete ordered values observed on the
normal runtime path.

## OpenAI API and context

### Client and sessions

There is no `.responses()` namespace because Responses is the only supported
OpenAI API. API operations use the provider's names: `create` and `compact`.

```rust,ignore
let openai = OpenAi::new(std::env::var("OPENAI_API_KEY")?)?;
let mut session = openai
    .instructions(
        "Remember user-provided facts and say when required information is missing.",
    )
    .build()?;
```

`OpenAi` owns authentication, endpoint policy, and the caller-composed concrete
Tower stack. `instructions(...)` starts a builder for a client-side managed
`Session`; it does not claim the provider has a server-side session resource.

`Session` owns:

- immutable instructions and tool definitions;
- authoritative typed committed history;
- token usage;
- delta and previous-response continuation state;
- persistent WebSocket or HTTPS policy;
- reconnect and full-replay behavior; and
- opaque completed checkpoints.

Context management is batteries-included in `nanocodex-oai-api`, not a
separate public context crate. Callers may inspect stable summaries and
completed outputs, but cannot mutate history into an invalid protocol state.

### Logical response turns

```rust,ignore
let mut turn = session.turn();
```

`ResponseTurn<'_>` mutably borrows its `Session` and owns state that must remain
stable for one logical agent turn, including the WebSocket
`x-codex-turn-state`. It may make multiple sequential API calls:

```text
create(user prompt)
create(tool outputs)
create(queued steering)
compact()
create(next input)
```

Only one `Response` may borrow a `ResponseTurn` at a time. Dropping the turn
ends that logical boundary; the next accepted user prompt receives a fresh
turn.

The agent decides *when* compaction is needed. The API session implements the
typed compaction request, response handling, and atomic history replacement.

### Response streams

```rust,ignore
let mut response = turn.create(
    "Remember that the deployment region is us-west-2.",
);

while let Some(event) = response.try_next().await? {
    if let ResponseEvent::OutputTextDelta(delta) = event {
        print!("{delta}");
    }
}

let completed = response.await?;
```

`Response` implements:

```rust,ignore
Stream<Item = Result<ResponseEvent, ResponseError>>
IntoFuture<Output = Result<CompletedResponse, ResponseError>>
```

Therefore:

```rust,ignore
response.try_next().await
    -> Result<Option<ResponseEvent>, ResponseError>
```

There is no required `complete()` method. Awaiting drains and aggregates the
stream. A clean end occurs only after the terminal completion event; premature
closure is an error. Streaming callers see `ResponseEvent::Completed`, and the
completed aggregate remains available when the response is awaited.

`CompletedResponse` exposes:

- `output()`;
- `output_text()`;
- `tool_calls()`;
- `usage()`;
- `end_turn()`; and
- an opaque `checkpoint()`.

The normalized public event set is grounded in the real Responses stream.
Output text and reasoning deltas stream incrementally; complete function and
custom tool calls arrive as completed output items; terminal completion carries
usage and end-turn metadata. Context-length failure is a typed error the agent
can catch and use for compaction policy.

Unknown provider events are retained in the raw OpenAI firehose and telemetry
without turning authoritative typed history into `serde_json::Value`.

### Commit and replay

- Complete client-owned typed history is authoritative.
- Healthy turns send only their new delta with a private continuation ID.
- A replacement connection discards that connection's ID and replays complete
  committed history.
- Only terminally completed responses commit.
- Failed or dropped partial output never executes a tool and never enters
  history.
- Instructions, tool definitions, reasoning configuration, cache identity,
  and other shared prefixes remain byte-stable across turns, retries,
  compaction, forks, and reconnects.

## Tool boundary

The dependency-light contract belongs to `nanocodex-oai-api` so both the API
and agent can accept tools without depending on their implementations:

```rust,ignore
#[async_trait]
pub trait Tool: Send + Sync + 'static {
    fn definition(&self) -> ToolDefinition;

    async fn execute(
        &self,
        input: ToolInput,
        context: ToolContext<'_>,
    ) -> Result<ToolOutput, ToolError>;
}
```

`ToolContext` exposes read-only accessors for:

- `session_id`;
- `call_id`;
- authoritative committed `history`; and
- `output_token_budget`.

It does not expose the workspace, process manager, MCP state, shell sessions,
or agent driver.

`nanocodex-tools` owns:

- `Tools` and the heterogeneous registry;
- built-in filesystem, shell, patch, plan, image, and web tools;
- bounded subprocess and output lifecycle;
- MCP transports, authentication, discovery, and dispatch;
- deferred `tool_search`; and
- Code Mode.

MCP is always compiled into the native tools crate. It is not a feature and
there is no public `nanocodex-mcp` crate after migration.

`nanocodex-tools-macros` implements `#[tool]` and is reexported by
`nanocodex-tools` and the facade:

```rust,ignore
#[tool(
    name = "deployment_region",
    description = "Return the production region for a named service."
)]
async fn deployment_region(
    service: String,
) -> Result<String, std::io::Error> {
    Ok(format!("{service}: us-west-2"))
}
```

The definition is the sole registry-name source. Both this macro path and a
manual `Tool` implementation have compiled examples in their owning crates.
The retained stack-3 parity and performance record is
[`benchmarks/refactor_tools_baseline_2026-07-26.md`](benchmarks/refactor_tools_baseline_2026-07-26.md).

## Systems consolidation

### VM foundation

The useful VM code in the current Nanocodex VM draft and Nanoeval will be
reconciled rather than duplicated.

The low-level VM layer owns:

- a small audited libkrun boundary;
- typed CPU, memory, disk, share, network, and shutdown policy;
- immutable root disks and cheap per-attempt reflinks or snapshots;
- guest process lifetime and descendant cleanup;
- bounded multiplexed host/guest RPC; and
- provider-neutral egress leases.

OCI and Dockerfile materialization becomes a reusable image-building library,
not code buried in the eval CLI. It understands only the explicitly supported
Dockerfile shapes and fails closed on unknown behavior. Cache keys include all
inputs that affect the resulting disk.

`nanocodex-vm` implements ordinary agent tools over one retained VM session.
One root session tree shares the VM workspace; each agent driver still receives
fresh agent-relative tool handlers.

### Browser inside the VM

The browser tool contract and CDP controller remain independent from how
Chromium is hosted. The production VM composition:

1. prepares a content-addressed browser disk once;
2. reflinks a disposable disk;
3. starts headed Chromium under an unprivileged guest user and Xvfb;
4. gives the guest its own network stack;
5. exposes CDP only through a random host-loopback endpoint; and
6. terminates Chromium, gvproxy, the VMM, and its disk together.

The existing deterministic browser-tool draft supplies semantic targeting,
native input, actionability, diagnostics, traces, audits, and file-backed
evidence. Nanoeval's `nanovm-browser` supplies the proven browser-in-VM
lifecycle. The consolidated API composes them instead of running Chrome
host-side as the default.

### VM egress: internet, payments, and secrets

The guest receives capabilities, not host credentials.

An `EgressLease` resolves to compatible network mode, guest-visible
environment, read-only public mounts such as a CA bundle, provisioned files,
and lifecycle guards. Compatible fragments compose; conflicts fail closed.

MPP keeps its wallet, payment state, request replay, and retry safety on the
host. The guest receives only a proxy endpoint and public CA material.

Secret egress adopts the Nanocentaur/Iron design:

- policy authorizes principal, origin, method, and path before resolution;
- a host gateway resolves secrets only for an authorized request;
- credentials are injected into the upstream request and never returned to the
  guest;
- providers sit behind an async `SecretManager` boundary;
- resolved values never enter model context, VMM arguments, guest environment,
  snapshots, logs, or durable session state;
- redirects, bodies, concurrency, and response sizes are bounded; and
- revocation terminates the lease.

MPP and secret gateways compose behind one VM-facing front proxy when both
need `HTTPS_PROXY`.

### Evaluations

Nanoeval is a temporary repository. Its supported functionality moves here
without preserving a second product boundary.

The library layer owns:

- typed immutable tasks and environment recipes;
- one fresh agent/session/workspace per attempt;
- bounded CPU, memory, and concurrency admission;
- deterministic trial identity and durable resumability;
- native and VM execution;
- Terminal-Bench and supported Frontier-Bench shapes;
- verifier execution and artifact handoff;
- typed events, results, sweeps, and comparisons; and
- Harbor and ATIF projection after the typed result is durable.

The main CLI exposes:

```text
nanocodex eval run ...
nanocodex eval prepare ...
nanocodex eval inspect ...
nanocodex eval compare ...
nanocodex eval cleanup ...
```

Python may remain a thin interoperability adapter. Agent decisions, model
calls, tools, VM lifecycle, verification, and mutations stay in Rust.

Success for the consolidation slice requires representative Nanoeval jobs to
run through `nanocodex eval`, produce canonical retained artifacts readable by
Harbor, and require no adjacent Nanoeval checkout or path dependency.

### Nanocentaur

Nanocentaur is the managed, durable agent API built above the library stack. It
owns tenancy, policy, idempotency, durable command/event storage, wake-up,
stream replay, and deployment. Those concepts do not leak downward into the
headless agent SDK.

Reusable secret egress and VM policy move below Nanocentaur. Managed-service
storage and ingress remain above it.

## Benchmark and SLA migration

### Existing evidence to preserve

| Current benchmark or evidence | Target owner |
| --- | --- |
| `nanocodex-core/benches/fork_history.rs` | context/history owner in `nanocodex-oai-api`, plus agent fork benchmark |
| `nanocodex-service/benches/tower_responses.rs` | `nanocodex-oai-api` |
| response transport live benchmark | `nanocodex-oai-api` integration benchmark |
| MCP repeated-search stress test | `nanocodex-tools` search and dispatch Criterion benchmarks |
| TUI retained-trace benchmarks | CLI/TUI consumer |
| Nanoeval VM preparation and concurrency measurements | VM image and eval owners |
| browser canaries and debug benchmarks | browser controller and browser-VM owners |
| Nanocentaur HTTP/SQLite benchmarks | managed-service owner |

Historical reports remain in `benchmarks/` and `docs/`; the refactor does not
rewrite old results under new crate names.

### Hard performance contracts

| Boundary | Contract |
| --- | --- |
| Completed checkpoint | O(1) creation over retained history |
| Fork | O(1) history branch before new appends |
| Healthy continuation | Work and wire history proportional to the new delta |
| Reconnect | One explicit O(history) replay, no deep copy per retry |
| Response aggregation | Bounded streaming buffers; one final materialization |
| Event delivery | Lossless monotonic ordering, shared payloads, and no serialization after receiver drop |
| Tool output | Bounded while produced, not after unbounded capture |
| Process cancellation | Terminates process group and descendants |
| VM attempt | Cheap snapshot/reflink; no unchanged image rebuild |
| Browser attempt | No unchanged browser image rebuild |
| Eval scheduler | Bounded CPU, memory, tasks, and retained disks |

Tests should assert structural work counts or allocation/clone behavior where a
wall-clock threshold would be flaky.

### Numeric budgets

For each hot path:

1. select a retained or deterministic representative fixture;
2. record hardware, profile, compiler, command, sample size, and raw result;
3. establish median and tail baseline;
4. set a regression budget large enough to exceed observed noise;
5. run the focused benchmark in its owning PR; and
6. require a written explanation for an accepted regression.

Local deterministic Criterion suites may become CI comparison gates. Provider,
network, VM cold-start, and full eval measurements remain scheduled or release
gates with retained artifacts.

USD cost is derived from the same authoritative per-call usage retained by the
trace. The fixed Sol, Terra, and Luna standard and priority rates come directly
from OpenAI's API pricing documentation. Agent terminal results, the CLI, and
`nanocodex eval` all project the same aggregate instead of recomputing it
independently.

Each refactor PR that moves a hot path must move its benchmark in the same PR.
The stack may not defer all performance evidence until after the architecture
has changed.

## Stacked implementation plan

Every slice is based on the branch immediately above it. Each remains
reviewable, documents migrations, runs its focused gates, and avoids unrelated
product changes.

Before deleting an old owner, the slice records its `master` capability
inventory, maps every item to the new owner, and exercises the replacement
through a real consumer. Unmapped behavior blocks the deletion.

### 1. Frame and contracts

- Rewrite the README around reusable frontier-agent building blocks.
- Establish this living refactor plan.
- Record target APIs, ownership, benchmark migration, and success gates.

### 2. `nanocodex-oai-api`

- Create the crate by moving, not wrapping, the useful typed core and service
  implementation.
- Introduce `OpenAi`, instruction-bound `Session`, `ResponseTurn`, streaming
  `Response`, and `CompletedResponse`.
- Move authoritative context, compaction mechanics, continuation, and replay
  into the session.
- Move and extend request, parser, history, and Tower benchmarks.
- Delete superseded `nanocodex-core` and `nanocodex-service` surfaces when all
  consumers migrate.

### 3. Tools

- Move the `Tool` contract into `nanocodex-oai-api`.
- Colocate the `nanocodex-tools-macros` package under
  `nanocodex-tools/macros`.
- Merge MCP, `tool_search`, and Code Mode into `nanocodex-tools`; MCP is always
  on for native builds.
- Tighten tool context and registry construction.
- Port MCP search/dispatch and process/output benchmarks.
- Remove `nanocodex-mcp` and the old macro crate.

### 4. Agent and facade

- Move the owned driver and lifecycle into `nanocodex-agent`.
- Implement the agreed `Turn` stream/future API and preserve the complete
  session firehose independently from each turn stream.
- Rebase context history, continuation, replay, and compaction installation
  onto one OAI-owned managed session state. Keep the decision to compact and
  `AGENTS.md` discovery in the agent.
- Preserve clone, spawn, fork, fork-from, resume, cancellation, and dynamic
  policy behavior.
- Reduce `nanocodex` to reexports, modules, prelude, and facade documentation.
- Migrate Rust, Python, Node/WASM, CLI, and TUI consumers.

Evidence: the extracted lifecycle retains the `master` capability ledger in
[`benchmarks/refactor_agent_baseline_2026-07-26.md`](benchmarks/refactor_agent_baseline_2026-07-26.md).
The standalone OAI session and agent share the same authoritative state engine,
the facade has no runtime implementation, turn payload mirroring is measured,
and all native and WASM consumers compile against the new owner.

### 5. Observability, cost, and performance stabilization

- Finish the normalized typed agent event projection without weakening the raw
  OpenAI firehose or complete tracing record.
- Derive typed USD estimates from authoritative usage and the selected model's
  built-in standard or priority rates; project the same value through Rust,
  CLI, language bindings, and later eval results.
- Add cross-component retained fixtures.
- Establish numeric baselines and budgets for the newly owning crates.
- Add allocation/work-count checks for asymptotic contracts.
- Publish one reproducible performance report for the refactored stack.

Evidence: [`benchmarks/refactor_observability_baseline_2026-07-26.md`](benchmarks/refactor_observability_baseline_2026-07-26.md)
records the retained 358-event projection and fixed-point pricing baselines.
Retained raw `AgentEvent` records round-trip byte-for-byte, and generated JSONL
preserves the master envelope and terminal fields while adding exact cost
accounting. `AgentEvent::data()` adds a lazy typed domain view. The automatic
`EstimatedUsdCost` is identical through standalone OAI sessions, owned agent
results, terminal events, root/model tracing spans, the CLI/TUI, PyO3, and
Node/browser WASM.

### 6. VM and images

- Reconcile Nanoeval's VM/image code with the Nanocodex VM draft.
- Extract reusable content-addressed OCI/Dockerfile image preparation.
- Land the retained VM tool session and composable neutral egress lease.
- Benchmark warm image lookup, snapshot/reflink, boot, RPC, and shutdown.

### 7. Browser on VM

- Land the deterministic browser controller as its own component.
- Compose it with the headed browser-in-VM lifecycle.
- Keep authentication, policy, and secrets host-owned.
- Benchmark warm boot, first action, semantic snapshot, screenshot, and
  teardown with retained browser fixtures.

### 8. MPP and secret egress

- Consolidate the existing MPP proxy behind the VM egress lease.
- Extract Nanocentaur's policy-aware secret gateway and provider boundary.
- Compose payment and secret routing behind one guest-visible front proxy.
- Prove by test that wallet and secret material never enter guest-visible or
  persisted state.
- Stress concurrency, backpressure, cancellation, replay, and revocation.

### 9. Evaluations

- Move Nanoeval libraries, Harbor projection, task/image preparation, durable
  scheduling, inspection, comparison, and cleanup into this workspace.
- Expose the complete supported surface as `nanocodex eval`.
- Remove adjacent-repository path dependencies and duplicated VM code.
- Run native, Terminal-Bench VM, Frontier-Bench artifact, resume, failure
  retention, and Harbor-view compatibility gates.

### 10. Managed API and release cleanup

- Rebase Nanocentaur on the refactored libraries without leaking durability
  into lower crates.
- Finalize package metadata, changelogs, release ordering, docs.rs, and
  semver-facing migration notes.
- Archive the temporary Nanoeval product boundary after parity evidence is
  retained.

## Stack-wide completion gates

- `cargo fmt --all --check`
- warnings-denied Clippy for workspace, targets, and features
- full workspace tests plus focused deterministic stress tests
- warnings-denied Rustdoc with compiled public examples
- no higher-layer dependency in a lower reusable crate
- no duplicate authoritative history, VM implementation, or eval runtime
- every capability present on `master` is mapped to a replacement and retains
  an executable parity check before its former owner is deleted
- benchmark result attached for every moved hot path
- one live native agent smoke after core slices
- one browser-in-VM smoke after browser composition
- one MPP and one secret-egress non-disclosure smoke
- `nanocodex eval` produces canonical durable output for representative native,
  Terminal-Bench, and Frontier-Bench tasks
- every accepted prompt still emits exactly one terminal event
- no benchmark task or verifier is changed to improve agent results

## Open decisions

These are intentionally not hidden behind provisional APIs:

- final construction spelling for `ToolDefinition` and heterogeneous tool
  registration;
- exact stable normalized `ResponseEvent` variants versus explicitly raw
  OpenAI events;
- final crate names for reusable VM image preparation and composed egress;
- which observability conveniences belong in the facade prelude;
- final feature policy for heavyweight VM, browser, eval, and managed-service
  crates.

Each is resolved in the first implementation slice that needs it, with a
complete consumer example and benchmark where performance-sensitive.
