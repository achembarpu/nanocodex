# Changelog

All notable changes to Nanocodex are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Bug Fixes

- [oai] Retry transient HTTP 403 WebSocket upgrades before falling back to
  HTTPS, and retain gateway diagnostics when the rejection body is empty.

### Features

- [cli] Enable private Brave and complete desktop-profile cookie import by
  default, with compact up-front `tools.browser` discovery in Code Mode.
- [tools] Add bounded MCP pagination, collision-safe Code Mode registration,
  per-tool and per-server exposure policy, and deferred custom-tool wire shapes.
- [parity] Classify Codex through `7ada37a1` and defer the standalone V8 host.
- [model] Support selecting `gpt-5.6-luna` when creating Rust, CLI, Python,
  JavaScript, and Harbor agent threads.
- [vm] Add persistent VM-backed workspace tools, immutable root-image
  preparation, and provider-neutral composable egress leases.

## [0.3.0](https://github.com/gakonst/nanocodex/releases/tag/v0.3.0) - 2026-07-28

### Bug Fixes

- [release] Support Ubuntu Python baseline
- [release] Validate dynamic Python version
- [ci] Satisfy strict Clippy checks
- [ci] Build optimized Python wheels
- [js] Permit immutable preview versions
- [web] Join controller agent shutdown
- [example] Own browser CDN agent creation
- [wasm] Join graceful agent shutdown
- [web] Cancel replaced active turns
- [wasm] Support host-owned browser sockets
- [examples] Consume typed turn results
- [web] Close replaced payment sessions
- [web] Own browser agent lifecycle
- [tui] Deduplicate terminal failures
- [react] Own worker generations
- [wasm] Satisfy target-specific lint gates
- [js] Keep transport mechanics private
- [js] Isolate concurrent event observers
- [js] Preserve configured workspace
- [js] Snapshot hosted tool boundaries
- [js] Bound and release event iterators
- [docs] Honor configured Cargo target directory
- [code-mode] Schedule timers on the host worker
- [react] Accept the current SDK package
- [python] Align binding package version
- [cli] Flush terminal event after interrupt
- [mcp] Bound stdio stderr buffering
- [agent] Fail malformed continuations before terminal
- [oai] Reject empty continuation checkpoints
- [oai] Bound WebSocket pump backlog
- [mcp] Own and bound stdio subprocesses
- [mcp] Stop cross-origin credential redirects
- [wasm] Enable clock support and enforce runtime tests
- [js] Honor configured Cargo target directory
- [oai] Ignore non-assistant final messages
- [bench] Support shared ChatGPT auth
- [oai] Preserve stable item ids in ephemeral requests
- [tui] Bound syntax highlighting work
- [mcp] Send a deterministic HTTP user agent
- [agent] Remove rollout writer locking
- [ci] Include every benchmark target in Harbor builds
- [wasm] Release completed turn controls
- [api] Restore refactored consumer builds
- [agent] Align retained context with Codex
- [release] Package the current crate graph
- [docs] Open facade docs from workspace root
- [release] Tolerate npm propagation delay

### Documentation

- Show per-turn stream consumption
- Show agent event consumption
- Rename the minimal API example
- Streamline the public README
- Finalize the PR 50 public API guide
- [python] Show the owned binding workflow
- [oai] Prepare package changelog
- [parity] Classify Codex through be2e4afc
- [plan] Record PR 50 CI completion
- [perf] Record paired model latency
- [parity] Classify Codex through 3418498f
- [facade] Keep packaged API guides canonical
- [plan] Scope delivery to PR 50
- [tui] Explain event batching
- Frame nanocodex as frontier agent building blocks

### Features

- [python] Expose the owned agent lifecycle
- Stabilize observability and USD cost

### Miscellaneous Tasks

- [release] Prepare 0.3.0
- [consumers] Gate promoted language bindings
- [js] Ship compiled tui entrypoints
- Disable Python bindings on pull requests
- Run preview checks from package directory
- Keep hanging wasm tests non-blocking
- Cancel superseded PR artifact builds
- Build PR binaries on demand
- Ignore local VM caches

### Other

- Merge pull request [#50](https://github.com/gakonst/nanocodex/issues/50) from gakonst/refactor/05-observability
- Run full leaderboard jobs from PR artifacts

### Performance

- [web] Cap initial bundle request fan-out
- [python] Gate binding resource budgets
- [web] Gate controller lifecycle throughput
- [web] Gate production bundle graph
- [example] Isolate browser mpp runtime
- Gate PR 50 hot paths
- Keep Tempo out of direct CLI builds

### Refactor

- [api] Stabilize Tower and lifecycle boundaries
- [js] Preserve typed turn results
- [oai] Contain agent-only session internals
- [agent] Decompose model lifecycle
- [tools] Decompose runtime ownership
- [agent] Decompose driver control
- [agent] Decompose rollout persistence
- Align agent lifecycle with Codex
- Isolate platform runtime boundaries
- [api] Enforce canonical crate boundaries
- Stabilize public SDK surface
- Extract owned agent lifecycle
- Consolidate tools and MCP
- Consolidate the OpenAI Responses API

### Styling

- [oai] Format final-message regression
- [oai] Format item id policy

### Testing

- [python] Gate lifecycle and binding performance
- [js] Isolate performance gates
- [js] Gate binding overhead and package size
- [wasm] Lock owned session lifecycle
- [js] Validate installed package boundary
- [observability] Isolate tracing capture
- [agent] Expect stable response item ids
- [observability] Verify full-fidelity turn traces
- [oai] Compare tool search arguments semantically
- [mcp] Exercise provider-native discovery
- [tui] Lock lifecycle parity
- [mcp] Verify read-only parallel dispatch
- [tools] Serialize traced runtime integration tests
- [tui] Preserve stored checkpoint branch coverage
## [0.2.0](https://github.com/gakonst/nanocodex/releases/tag/v0.2.0) - 2026-07-26

### Bug Fixes

- Preserve recovered resume and TUI work
- [mpp] Prevent paid request replays
- [cli] Disambiguate Tempo API base argument
- [mpp] Prefer session payments for Responses
- [tui] Show model connection progress
- [bindings] Resume rollout snapshots in Node
- [mpp] Harden paid Responses transports
- [credits] Support primitive Tempo wallet signers
- [wasm] Retain snapshot resume compatibility
- [harbor] Make leaderboard runs non-interactive
- [cli] Retain Tempo session access keys
- [web] Provision scoped Tempo payment keys
- [nanousd] Persist signed mints before broadcast
- [cli] Honor Tempo session deposit default
- Use the Tempo API MCP endpoint
- Harden Harbor run recovery
- Cancel headless turns on interrupt
- Estimate visible context before compaction
- Match Codex tool behavior
- Align Responses request serialization with Codex
- Retry API errors classified by type
- [cli] Bound MPP egress concurrency
- Omit IDs from Responses Lite tools ([#26](https://github.com/gakonst/nanocodex/issues/26))
- [cli] Bound MPP egress origin concurrency ([#20](https://github.com/gakonst/nanocodex/issues/20))
- [cli] Surface terminal MPP payment failures ([#19](https://github.com/gakonst/nanocodex/issues/19))
- Match Codex compaction boundaries
- Compact before follow-on sampling
- [cli] Keep MCP tests last
- [mpp] Correlate paid egress retries ([#15](https://github.com/gakonst/nanocodex/issues/15))
- [tui] Refine running activity presentation
- [cli] Batch Tempo session top-ups
- [cli] Take charge autoswap fixes
- [cli] Avoid replaying Tempo key authorizations
- [tui] Match Amp markdown selection semantics
- [tui] Render live code-mode activity
- [tui] Copy fenced code without chrome
- [ci] Resolve linked website dependencies
- [tui] Highlight TypeScript patches

### Dependencies

- [deps] Finalize Tempo accounts pins
- [deps] Update Tempo Accounts wallet
- [deps] Update Tempo Alloy accounts wallet
- Bump mpp-rs autoswap diagnostics ([#25](https://github.com/gakonst/nanocodex/issues/25))
- Bump mpp-rs session rollback ([#22](https://github.com/gakonst/nanocodex/issues/22))
- Bump mpp-rs session fixes ([#21](https://github.com/gakonst/nanocodex/issues/21))
- Merge pull request [#17](https://github.com/gakonst/nanocodex/issues/17) from gakonst/fix/mpp-rpc-rate-limit-retry
- [mpp] Bump RPC retry support

### Features

- [python] Expose steer, cancel, spawn, and fork controls
- [tempo] Use NanoUSD Charge over HTTPS
- [credits] Support loopback Stripe deployment
- [tui] Restore rollout activity
- [tui] Render resumed rollout messages
- Resume Codex rollouts in Nanocodex
- [mcp] Add OAuth login and hot reload
- Add MPP-backed JavaScript agent sessions
- Add NanoUSD credits service
- Default to high reasoning
- Preserve stable response item IDs
- Align code mode with Codex
- [mcp] Prewarm deferred default servers
- [tui] Add runtime mode controls
- [cli] Autoswap Tempo session deposits
- [cli] Route OpenAI through Tempo MPP
- [agent] Resume sessions from durable snapshots ([#13](https://github.com/gakonst/nanocodex/issues/13))
- [code-mode] Stream nested tool lifecycles
- [tui] Improve tool activity presentation
- [tools] Track nested call start offsets
- [agent] Support dynamic fast mode ([#14](https://github.com/gakonst/nanocodex/issues/14))
- Support HTTPS and Responses replay policies ([#12](https://github.com/gakonst/nanocodex/issues/12))
- [agent] Support changing thinking between turns
- [web] Render plan updates in browser TUI
- [tui] Render plan updates as checklists
- [agent] Load global Codex instructions

### Miscellaneous Tasks

- [release] Prepare 0.2.0
- [tempo] Use final shared SDK revisions
- [tempo] Finalize Accounts dependency stack
- [tempo] Pin Accounts wallet fixes
- Publish Harbor-compatible nightlies
- [mcp] Clarify browser login status
- Raise Rust baseline to 1.97
- Refresh Harbor Rust builder
- [ci] Allow bounded Hudsucker fork
- [mpp] Take expiring session nonces

### Other

- Merge pull request [#44](https://github.com/gakonst/nanocodex/issues/44) from gakonst/chore/tempo-accounts-final
- Merge pull request [#41](https://github.com/gakonst/nanocodex/issues/41) from Ayush7614/feat/python-lifecycle-controls
- Merge pull request [#39](https://github.com/gakonst/nanocodex/issues/39) from gakonst/agent/mpp-charge-runtime-safety
- Merge pull request [#35](https://github.com/gakonst/nanocodex/issues/35) from gakonst/agent/mpp-runtime-fixes
- Merge pull request [#36](https://github.com/gakonst/nanocodex/issues/36) from gakonst/feat/nanousd-http-charge
- Merge pull request [#30](https://github.com/gakonst/nanocodex/issues/30) from gakonst/bench/mcp-oauth-hot-reload
- Merge remote-tracking branch 'origin/master' into bench/mcp-oauth-hot-reload
- Merge pull request [#31](https://github.com/gakonst/nanocodex/issues/31) from gakonst/codex/rollout-resume-bench
- Merge pull request [#29](https://github.com/gakonst/nanocodex/issues/29) from gakonst/agent/harbor-nightly-binary
- Merge pull request [#27](https://github.com/gakonst/nanocodex/issues/27) from gakonst/fix/mpp-egress-resource-bounds
- Merge pull request [#18](https://github.com/gakonst/nanocodex/issues/18) from clabby/cl/compact-before-turn
- Merge pull request [#2](https://github.com/gakonst/nanocodex/issues/2) from gakonst/feat/mpp-integration
- [tui] Gate code-mode completion churn

### Performance

- [tempo] Minimize SDK integration surface
- [tui] Incrementally render reasoning streams
- [web] Defer repository surfaces
- [harbor] Download hosted agents in sandbox
- [harbor] Avoid duplicate event logs
- [mcp] Cache OAuth metadata across reloads
- [cli] Allow 128 concurrent MPP requests
- Preserve COW history during compaction
- [cli] Accelerate Tempo session cold starts
- [tui] Cache nested tools and streaming markdown

### Refactor

- [mpp] Use Tempo Accounts charge provider

### Testing

- Ignore JSON argument key order
- Add xhigh Terminal-Bench presets
- Add stock Codex parity differential
- Stress parallel MPP egress replay ([#24](https://github.com/gakonst/nanocodex/issues/24))
- Synchronize code cell termination output ([#23](https://github.com/gakonst/nanocodex/issues/23))

## [0.1.1](https://github.com/gakonst/nanocodex/releases/tag/v0.1.1) - 2026-07-23

### Bug Fixes

- [wasm] Scope host tools to agent sessions
- [tui] Render images and wrap patches
- [ci] Update dependency policy
- [release] Build Docker images natively
- [shell] Serialize session input and process interrupts
- [code-mode] Preserve tool results across yields
- [tui] Pace newline-heavy stream scrolling
- [tui] Cancel pending scroll on manual input
- [tui] Finish deferred branch switches
- [auth] Disable response storage for ChatGPT
- [cli] Prefer OPENAI_API_KEY by default
- [harbor] Keep hosted build manifest complete
- [ci] Remove typo-triggering auth test
- [install] Handle shell profile update failures

### Documentation

- Record evaluation runner boundaries
- Explain shared prompt caches
- Record evaluation runner boundaries
- Explain Nanocodex design thesis
- [perf] Document runtime profiling results

### Features

- [js] Add CDN previews and package releases
- [web] Embed the reusable wasm agent terminal
- [tui] Add reusable browser terminal packages
- [react] Add typed worker lifecycle bindings
- [js] Redesign runtime-specific agent API
- Support GPT-5.6 Pro reasoning mode
- Share prompt-cache warmups
- Persist Codex-compatible rollouts
- [tui] Polish transcript and composer UX
- Expose VM-ready standard tools
- [release] Add nightly and GHCR delivery
- [web] Add browser agent terminal
- [tui] Refine steering and tool activity
- [agent] Propagate reasoning mode across runtime surfaces
- [bindings] Publish JavaScript and Python clients
- [wasm] Add full agent lifecycle control
- [tools] Align the WASM host runtime contract
- [agent] Add shared cache and resumable rollouts
- [tui] Polish transcript and composer UX
- Expose VM-ready standard tools
- [tui] Improve transcript and clipboard interaction
- [tui] Improve live transcript interaction
- [tools] Allow replacing workspace tools
- [tui] Switch branches from live navigator
- [tui] Add history editing and branch navigation
- [agent] Expose clean sibling spawn
- [tools] Embed QuickJS code mode
- [cli] Add same-session completion audit
- [agent] Refine task execution guidance
- [telemetry] Measure end-to-end TUI stream latency
- [cli] Prefer stored ChatGPT login

### Miscellaneous Tasks

- [release] Prepare 0.1.1
- [web] Refresh repository data
- Add code mode validation batch
- [eval] Remove benchmark-specific tuning

### Other

- Merge remote-tracking branch 'origin/master'
- Merge pull request [#11](https://github.com/gakonst/nanocodex/issues/11) from gakonst/agent/gpt-5-6-pro-config
- Merge pull request [#9](https://github.com/gakonst/nanocodex/issues/9) from gakonst/agent/cloneable-nanocodex-builder
- Make NanocodexBuilder cloneable
- Merge pull request [#8](https://github.com/gakonst/nanocodex/issues/8) from gakonst/agent/embedded-quickjs-code-mode
- Merge pull request [#7](https://github.com/gakonst/nanocodex/issues/7) from gakonst/agent/completion-audit

### Performance

- [tui] Optimize long-session rendering and interaction
- [tui] Make streaming rendering content-size independent

### Refactor

- [service] Exhaustively classify WASM retry errors

### Testing

- [tools] Cover custom tools in code mode
- [cli] Keep subagents opt-in

## [0.1.0](https://github.com/gakonst/nanocodex/releases/tag/v0.1.0) - 2026-07-21

### Bug Fixes

- [observability] Retain yielded tool lineage
- [tools] Preserve live shell session ids
- [tui] Reconcile pending steer state
- [harbor] Provision portable CLI tools
- [tui] Suppress cancellation error rows
- [tui] Distinguish cancelled tools
- Emit completed assistant items from Responses ([#4](https://github.com/gakonst/nanocodex/issues/4))
- Preserve assistant message phases in events ([#3](https://github.com/gakonst/nanocodex/issues/3))
- [cli] Select one command configuration
- [service] Own proxy-aware WebSocket connector
- [service] Honor SSL_CERT_FILE for WebSockets
- [wasm] Align checkpoint turn handling
- [ci] Allow pinned WebSocket forks
- [service] Honor proxy settings for WebSockets
- [eval] Publish Harbor streams from host capture
- [eval] Atomically publish Harbor JSONL
- [eval] Provision Node for canonical task images
- [cli] Satisfy steering UI lints
- [ci] Satisfy observability stress lints
- [observability] Satisfy rustfmt
- [ci] Tolerate OTLP warm-up connections
- [ci] Read complete OTLP test headers
- [ci] Use portable MCP fixture path
- [ci] Support Windows shell tooling
- Include macros crate in agent image build
- Preserve master lifecycle behavior after rebase
- Recover from unsupported direct tools
- Normalize and bound shell sessions
- Preserve canonical context through compaction
- Match Codex context token accounting
- Recover from invalid image requests
- Bound Codex compaction inputs
- Match Codex compacted history retention
- Follow sol context window growth
- Follow sol reasoning summary default
- Identify responses lite websocket sessions
- Validate code mode stored values
- Preserve eval task completion state
- Preserve failed code mode output
- Validate code mode image outputs
- Accept nullable usage details
- Accept completed responses without usage
- Report selected shell in model context
- Match Codex Sol compaction limit
- Keep apply patch compatible with Rust 1.85
- Support Linux artifact Rust version
- Normalize image inputs for the model
- Harden local code mode runtime
- Keep API diagnostics valid JSONL
- Isolate verifier python packages
- Cache scientific verifier dependencies
- Reconnect stale Responses websockets
- Keep api key out of process arguments
- Service websocket keepalives independently
- Preserve Rust 1.85 compatibility

### Dependencies

- Lock fork benchmark dependencies
- Cache system verifier dependencies

### Documentation

- [tui] Record research and keybindings
- Simplify configuration section
- Move example comments above code
- Sharpen repository positioning
- Add complete agent lifecycle example
- Streamline readme presentation
- Center readme on public agent lifecycle
- Document the lifecycle API design
- Lead README with Codex comparison
- Fix Harbor spelling
- [eval] Start Rust runner design log
- Explain checkpoint orchestration tradeoffs
- Record orchestration decision context
- [observability] Add local Jaeger workflow
- Plan efficient steering and branching
- Align roadmap with the library-first SDK
- Lead with the library API
- Record nanocodex terminal bench gate
- Demonstrate detached event handling
- Record Tower validation results
- Plan eval-driven UI tool parity
- Advance Codex review checkpoint
- Track Codex upstream review checkpoint
- Exclude skills from harness scope
- Record intentional runtime boundaries
- Record responses retry rewrite
- Describe Codex session and tool behavior
- Prefer local Codex reference
- Record tune mjcf variance
- Record 33-task eval gate
- Record custom heap crash eval
- Record Coq proof eval
- Record build pmars eval
- Record 30-task eval gate
- Record write compressor eval
- Record constraints scheduling eval
- Record largest eigenvalue eval
- Record 26-task eval gate
- Record schemelike eval
- Record 24-task eval gate
- Record 23-task eval gate
- Record core wars eval
- Record dna assembly eval
- Record 22-task eval gate
- Record 21-task eval gate
- Refine full-suite timing breakdown
- Record cleanup prompt regressions
- Record ambiguous ELF eval boundary
- Record forensic prompt regressions
- Record git recovery baseline
- Record sanitizer benchmark boundary
- Record multibranch benchmark baseline
- Record vulnerability benchmark baseline
- Record Cython benchmark baseline
- Record regex benchmark baseline
- Record headless terminal baseline
- Record three-task eval baseline
- Restore hosted-first runtime contract
- Plan model runtime cleanup
- Restart with Harbor-first plan

### Features

- Add ChatGPT subscription authentication
- [observability] Export full-fidelity agent traces
- [agent] Checkpoint active turn boundaries
- [core] Expose event stream request IDs
- [cli] Add steerable queues and cancellation
- [agent] Add controllable conversation lifecycle
- [cli] Add steerable queues, btw forks, and subagents
- [agent] Add checkpoint forks and active-turn steering
- [web] Add commit navigation rail
- [observability] Add end-to-end OTLP tracing
- [tools] Reuse persistent Node code-mode host
- Add Cloudflare WASM playground
- Add MCP observability and release automation
- Add embedded web and MCP integrations
- Add embedded Python and WASM bindings
- [cli] Add ratatui daily driver
- Unify tool registry and add tool macro
- Support typed custom tools
- Refactor SDK around Tower Responses service
- Improve agent lifecycle parity
- Advance eval guidance and results viewer
- Support Codex-style multimodal task input
- Centralize model context history
- Add Codex image generation
- Support code mode notifications
- Honor server turn continuation
- Match Codex shell selection
- Match Codex apply patch semantics
- Match Codex image preparation
- Align code mode tool shapes with Codex
- Add standalone web search
- [web] Redesign NanoCodex dashboard
- Align task context with Codex
- Add nanocodex web app
- Add PTY shell sessions
- Add resumable code-mode cells
- Align runtime with Codex Responses Lite
- Load dotenv for direct runs
- Align agent system prompt with Codex
- Load project agent instructions
- Add hosted orchestration profiles
- Add hosted response state controls
- Use native shell with programmatic calls
- Expand Harbor eval slice
- Add model-driven Harbor agent loop
- Establish lean Harbor installed-agent baseline
- Establish fast Harbor eval loop

### Miscellaneous Tasks

- [release] Refresh 0.1.0 changelog
- [release] Prepare 0.1.0
- [release] Refresh 0.1.0 changelogs
- [release] Add per-crate changelogs
- [release] Finalize 0.1.0 changelog
- [release] Update 0.1.0 changelog
- [release] Refresh 0.1.0 changelog
- [release] Automate publishing and native updates
- Defer Windows test coverage
- Update repository identity
- Sync Codex Sol base instructions
- Add terminal hyperlink smoke test

### Other

- Add stateful paired parity harness
- Add reproducible Codex parity workload
- Pin leaderboard Terminal-Bench 2.1 configuration
- Compare checkpoint forks with transcript replay
- Harden Harbor adapter for Terminal-Bench 2.1
- Demonstrate dynamic fork orchestration
- Compose subagents with unified events
- Refine tool execution and web search wiring
- Add terminal-bench lifecycle eval cohorts
- Streamline architecture callgraph
- Admit three scientific tasks
- Record Responses Lite parity baseline
- Admit CompCert build task
- Defer unstable mjcf tuning task
- Admit overfull hbox task
- Record green 35-task gate
- Admit build pov ray task
- Admit circuit fibsqrt task
- Exclude unstable core wars task
- Require installable verifier packages
- Add qemu startup benchmark
- Accept qemu verifier package order
- Support legacy Python verifier images
- Add custom heap crash benchmark
- Add Coq proof benchmark
- Add build pmars benchmark
- Add tune mjcf benchmark
- Add write compressor benchmark
- Add constraints scheduling benchmark
- Add largest eigenvalue benchmark
- Defer stale protein assembly benchmark
- Add distribution search benchmark
- Add schemelike benchmark
- Add pypi server benchmark
- Preserve explicit contracts
- Defer unstable dna benchmarks
- Add sparql benchmark
- Add core wars benchmark
- Add dna assembly benchmark
- Add dna insert benchmark
- Add merge diff benchmark
- Defer raman fitting benchmark
- Defer query optimization benchmark
- Add grpc service benchmark
- Preserve background processes after exit
- Add inference scheduler benchmark
- Add sqlite gcov benchmark
- Bootstrap verifier apt over TLS
- Add cobol modernization benchmark
- Preserve forensic inputs first
- Exclude cyber-policy benchmark
- Add binary secret benchmark
- Add log summary benchmark
- Preserve canonical verifier setup
- Add Rust C polyglot benchmark
- Add Python C polyglot benchmark
- Add nginx service benchmark
- Add truncated database recovery benchmark
- Add database WAL recovery benchmark
- Focus ladder on shell code tasks
- Separate image preparation from scored runs
- Add git leak recovery benchmark
- Verify destructive transformations
- Add sanitizer benchmark controls
- Use installed Chromium driver
- Add multibranch deployment benchmark
- Add single-task eval loop
- Add vulnerability benchmark
- Add Cython build benchmark
- Add regex log benchmark
- Add headless terminal benchmark
- Verify external lifecycle boundaries
- Add async cancellation benchmark

### Performance

- [tools] Share code mode history snapshots
- [shell] Share process drain grace deadline
- [tools] Align nested shell yield deadlines
- [service] Profile and trim response hot path
- [tools] Prewarm code mode node host
- [core] Iterate incremental history suffixes
- [tui] Coalesce streaming renders
- Cache guarded texlive verifier setup

### Refactor

- [agent] Simplify error propagation
- [agent] Flatten the public error surface
- [tools] Return typed handler results
- Rename project to nanocodex
- Expose pending turn results
- Simplify owned agent API
- Move code mode failure evidence
- Simplify code mode cell IDs
- Own tool runtime directly
- Store conversation deltas by boundary
- Share response stream ingestion
- Narrow retained compaction history
- Simplify websocket model runtime
- Centralize model run lifecycle
- Remove obsolete runtime modes

### Testing

- [python] Align empty credential error
- [tui] Cover escape cancellation
- [observability] Add retained-session stress coverage
- Stabilize PTY readiness checks

<!-- generated by git-cliff -->
