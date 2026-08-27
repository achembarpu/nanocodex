# Codex parity review: `7ada37a1..50ea8fd4` (ordinals 301–400)

This appendix classifies each commit in the exclusive upstream range
`7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4..50ea8fd411422b3f7bc906bcde6c1c4432019a2e`,
ordered by `git rev-list --reverse --topo-order`. The rows below are the exact
ordinals 301–400 of that 802-commit list. `port` requires current Nanocodex
implementation and regression evidence; `evaluate` is relevant but incomplete;
`defer` is intentionally postponed; `out-of-scope` is outside the SDK/product
boundary.

## Ordered classifications

| Ordinal | SHA | Subject | Classification | Decision / evidence |
|---:|---|---|---|---|
| 301 | 5664a5c07c64 | Expose executor skill roots from `skills.read` | out-of-scope | Executor skill/app-server metadata; Nanocodex has no skills surface. |
| 302 | 842fae26c945 | Add per-thread usage queries to the backend client | out-of-scope | Codex backend account API; Nanocodex exposes per-turn provider usage, not backend thread queries. |
| 303 | 361fe2d202d2 | Stamp conversation history items with creation times | evaluate | Durable typed history exists, but item creation-time metadata is absent and no product evidence requires it. |
| 304 | 4b07886d5935 | Represent persisted world state as JSON objects | out-of-scope | Codex world-state sections/reconstruction are not a Nanocodex protocol. |
| 305 | cbb7e82a8bdd | Unify turn input submission and routing | port | Atomic admission/routing is implemented by `crates/nanocodex-agent/src/agent/handle.rs`; steering and cancellation regressions cover it in `crates/nanocodex-agent/tests/it/model/control/steering.rs` and `cancellation.rs`. |
| 306 | 96e8afbfb881 | Track plugin metrics for background unified exec commands | out-of-scope | Plugin/unified-exec analytics are not owned. |
| 307 | c38d59fca023 | Add app-server coverage for plugin measurement analytics | out-of-scope | App-server plugin analytics tests only. |
| 308 | 27a98dde4d76 | Use protobuf's built-in Bazel proto rule | out-of-scope | Bazel build-system cleanup. |
| 309 | f1a1fce26af0 | Show estimated thread usage in `/status` | out-of-scope | Codex app-server account usage/TUI status. |
| 310 | 1e71e35df61f | Add thread usage to TUI status surfaces | out-of-scope | Codex TUI presentation. |
| 311 | 9579479d288a | Collect plugin metrics from remote executors | out-of-scope | Plugin/exec-server analytics. |
| 312 | e766f7598993 | Move `codex-execpolicy` to protocol dev dependencies | out-of-scope | Dependency placement only; exec policy is not a Nanocodex subsystem. |
| 313 | 5104cb649e65 | Support gRPC code-mode hosts in app server | out-of-scope | App-server gRPC host transport; Nanocodex Code Mode is in-process and has no generic app-server protocol. |
| 314 | 8d637ae3980f | Remove unused apply_patch prompt fallback | out-of-scope | Codex prompt asset/dead-code removal; Nanocodex owns its patch tool. |
| 315 | b1373b74a27d | Add durable reverts for paginated threads | out-of-scope | Nanocodex deliberately rejects paginated history; no equivalent thread-store API. |
| 316 | 357696c5e712 | Route network access through the shared approval pipeline | out-of-scope | Codex approval/network-policy framework is outside the boundary; Nanocodex uses grant/egress policy. |
| 317 | 363427b5e3fe | Add interrupted turn recovery | evaluate | Recovery is relevant, but Nanocodex cancellation commits an interrupted checkpoint and has no same-turn recovery API; see `crates/nanocodex-agent/src/model/run/turn.rs` and `docs/DURABILITY.md`. |
| 318 | 902bd9e06b3e | Protect inline visualization viewers from sandbox writes | out-of-scope | Codex inline visualization/TUI sandbox viewer. |
| 319 | e0de12a126f2 | Make gRPC code-mode yield tests deterministic | out-of-scope | Tests for the out-of-scope app-server gRPC host. |
| 320 | fe614a6304ef | Add Guardian V2 extension scaffold | out-of-scope | Guardian extension/approval surface. |
| 321 | c30a3e49c923 | Support sandboxed file streaming in exec-server | evaluate | Bounded VM/guest file reads are relevant, but exec-server fd-passing and sandbox protocol have no direct Nanocodex implementation/evidence. |
| 322 | 80ceab7aaa25 | Optimize orphan output normalization | evaluate | Equivalent orphan-output repair exists in `crates/nanocodex-oai-api/src/session/context.rs`, but this optimization has no focused benchmark/regression. |
| 323 | 4ca1af77a561 | Test hook rejection for explicitly started queue items | out-of-scope | Codex hooks/queue framework is absent. |
| 324 | 9ed0047a610a | Stabilize exec-server byte-budget tests | out-of-scope | Exec-server test-only stabilization. |
| 325 | 72fa74fbc9c4 | Persist security risk scores in rollout history | out-of-scope | Guardian scoring and filtered Codex rollout records have no Nanocodex counterpart. |
| 326 | a7b8c074b577 | Add the Guardian V2 Luna sampler | out-of-scope | Guardian/Luna extension. |
| 327 | a7e9fb54800f | Constrain Guardian reviews to parent filesystem permissions | out-of-scope | Guardian review permission policy. |
| 328 | d09cf7e5f431 | Preserve user message styling when wrapping long URLs | evaluate | Nanocodex has an independent message renderer, but no focused long-URL styling regression. |
| 329 | 6fc6b9d6d258 | Prevent unread events from blocking in-process requests | out-of-scope | Codex app-server-client unread-event queue behavior. |
| 330 | 911012490ca9 | Return Luna samples when streamed JSON completes | out-of-scope | Guardian sampler behavior. |
| 331 | 5e32f728f1f8 | Refine skill creation guidance and validation | out-of-scope | Codex skills assets/validation; skills are not a Nanocodex surface. |
| 332 | 683716cee958 | Use effective permissions when trusting app-server projects | out-of-scope | App-server project trust/config loading has no Nanocodex equivalent. |
| 333 | ef596c68ca35 | Reject sessions with unloadable required managed hooks | out-of-scope | Codex managed hooks requirements; hooks are not implemented in Nanocodex. |
| 334 | 779e9114ae63 | Reap orphaned processes in Linux sandboxes | out-of-scope | Codex Linux sandbox proxy lifecycle; Nanocodex process-group/VM cleanup is separately owned. |
| 335 | 053dda6b8978 | Include Node REPL results in Guardian reviews | out-of-scope | Guardian review evidence. |
| 336 | 2bd8727a0c07 | Preserve floating-point values when decoding rollout lines | out-of-scope | Codex rollout decoder/security records; no equivalent Nanocodex item. |
| 337 | 6851fae57cf7 | Refresh tracing interest in the token estimate test | out-of-scope | Codex test-only tracing instrumentation. |
| 338 | a70211249ab5 | Expose conversation history to tool lifecycle extensions | out-of-scope | Codex extension API/lifecycle hooks; Nanocodex caller-defined tools have no extension catalog. |
| 339 | 66919805ea08 | Pool Guardian sampling WebSocket connections | out-of-scope | Guardian sampler transport. |
| 340 | d167a3604c40 | Classify tool calls in the Guardian V2 extension | out-of-scope | Guardian extension classification. |
| 341 | 42bb50d5027f | Allow metadata updates without materializing threads | out-of-scope | Codex local paginated thread-store optimization; no Nanocodex thread-store API. |
| 342 | 73862481e52c | Add bounded transcript rendering for Guardian v2 | out-of-scope | Guardian transcript renderer. |
| 343 | 2aba3219e605 | Recognize PowerShell `Get-Content` file reads | out-of-scope | Codex skills/shell-command classification; no Nanocodex equivalent. |
| 344 | 4f7032173e57 | Honor filesystem permissions for app file uploads | out-of-scope | Codex app-server OpenAI file upload path is absent. |
| 345 | f8a3db0b996c | Clarify MCP OAuth reauthentication errors | evaluate | Refresh-token rejection is typed, but Nanocodex lacks Codex's distinct MCP startup failure reason, explicit reauthentication copy, actionable login hint, and integration regression. |
| 346 | 9946da9af182 | Apply Codex attribution to app-created commits | out-of-scope | Codex git-attribution extension; Nanocodex does not create app commits. |
| 347 | 588e18aae52b | Recover capability discovery after executor disconnects | evaluate | Reverse-attached catalog/reconnect/fencing is Nanocodex-owned and tested, but executor capability-cache recovery is not directly ported/evidenced. |
| 348 | 781445f7c692 | Centralize thread environment selection state | out-of-scope | Codex multi-environment/app-server protocol; Nanocodex workspace policy has separate ownership. |
| 349 | 990218bbbd5c | Fail closed when workload identity initialization fails | out-of-scope | Codex workload-identity auth topology; Nanocodex credentials stay behind its broker. |
| 350 | 5ed321ce0029 | Protect workload identity auth in app-server account RPCs | out-of-scope | Codex app-server account RPC protection; no Nanocodex workload-identity RPC. |
| 351 | 507ef0b3715d | Add Guardian guidance for Node REPL tool calls | out-of-scope | Guardian prompt guidance. |
| 352 | f898ebcafdeb | Route curated plugin catalogs by authentication mode | out-of-scope | Codex plugin marketplace/catalog and app-server routing. |
| 353 | 93327c852a1f | Gate Node REPL Guardian guidance on model metadata | out-of-scope | Guardian prompt guidance. |
| 354 | b87327f4e594 | Add rustls fallback for local MCP HTTP requests | out-of-scope | Codex shared route-aware HTTP/TLS client (`O14`); Nanocodex MCP HTTP uses its own established transport boundary. |
| 355 | 1992f8c0183c | Preserve approval policies for auto-reviewed models | out-of-scope | Codex auto-review/approval policy. |
| 356 | 4343b2bdc4e7 | Add app-server support for reverting paginated threads | out-of-scope | App-server persisted-thread API. |
| 357 | 53eaa297e595 | Give Guardian V2 full tool action context | out-of-scope | Guardian extension lifecycle context. |
| 358 | 3ba52d6075bb | Tag current time reminders in model context | out-of-scope | Codex current-time reminder feature is not in the Nanocodex tool/context contract. |
| 359 | bff03ecce582 | Retain client developer messages across context compaction | port | Compaction installs canonical developer context in `crates/nanocodex-agent/src/model/run/state.rs`; cancellation/compaction regressions cover retained accepted prompts in `crates/nanocodex-agent/tests/it/model/control/cancellation.rs`. |
| 360 | 6344a655a596 | Refresh current-time reminders for full-history subagents | out-of-scope | Codex subagent/current-time feature. |
| 361 | ca83f7908ca3 | Add running-task exit choices to local daemon sessions | out-of-scope | Codex TUI/daemon exit UI. |
| 362 | 1da59ad25711 | Support per-server MCP OAuth callback ports | evaluate | Nanocodex OAuth currently binds an ephemeral loopback callback in `crates/nanocodex-tools/src/mcp/oauth.rs`; no per-server callback setting exists. |
| 363 | 5cc65ecb9831 | Expose model upgrade retirement times | out-of-scope | App-server model-list metadata. |
| 364 | 813dc5f08d77 | Embed the Windows sandbox setup manifest in Bazel builds | out-of-scope | Windows/Bazel packaging. |
| 365 | 1b4ea8b3bef3 | Add structured telemetry for response retries | port | Typed retry events/counters are implemented in `crates/nanocodex-oai-api/src/events` and `crates/nanocodex-agent/src/model/telemetry.rs`, with projection/tracing regressions in `crates/nanocodex-oai-api/tests/event_projections.rs` and `crates/nanocodex-agent/tests/tracing.rs`. |
| 366 | 4d9f3021c828 | Include node_repl images in Guardian review evidence | out-of-scope | Guardian review evidence. |
| 367 | 9341b38310c7 | Add experimental thread queue APIs to app server | out-of-scope | App-server experimental queue protocol. |
| 368 | 18bbb585e767 | Add an `AbsolutePathBuf` conversion for `FileSystemPath` | out-of-scope | Codex filesystem/sandbox type conversion. |
| 369 | 535795f7d124 | Centralize turn environment selection state | out-of-scope | Codex turn/environment state is tied to its app-server/session model. |
| 370 | c6dee5f49f9d | Preserve thread subscriptions across revert reloads | out-of-scope | Persisted-thread subscriptions. |
| 371 | 3711943d11a1 | Parse model annotations from skill frontmatter | out-of-scope | Codex skill loader metadata. |
| 372 | d5e256ceb210 | Add an Amazon Bedrock Runtime provider | out-of-scope | Provider portability is explicitly outside Nanocodex's one-model boundary. |
| 373 | 5c6f498b0e35 | Stop generating accepted-line fingerprints | out-of-scope | Codex analytics privacy/telemetry. |
| 374 | 5620bab61cf3 | Add bounded skill model delegation instructions | out-of-scope | Codex skill-driven model delegation. |
| 375 | 9d012ca4f54c | Include agent names in turn metadata | out-of-scope | Codex subagent/app-server turn metadata; Nanocodex keeps its owned lifecycle identity separately. |
| 376 | cbe85e117b1d | Search selected plugin apps before falling back | out-of-scope | Codex plugin app discovery. |
| 377 | 4e5a08feb63f | Enforce strict auto-review for MCP tool calls | out-of-scope | Codex Guardian/approval policy for MCP calls. |
| 378 | 45c9c74e299a | Reuse pending MCP startups during reconciliation | out-of-scope | Codex mutable MCP reconciliation (`O11`); Nanocodex builds an explicit immutable MCP catalog/runtime. |
| 379 | 636e505c5cd8 | Verify bundled bwrap in Bazel builds | out-of-scope | Linux sandbox/Bazel packaging. |
| 380 | 86b1123ff6b5 | Enable parallel tool calls for all model prompts | evaluate | Upstream removes model metadata gating while preserving Lite's false wire bit; Nanocodex intentionally sends `parallel_tool_calls: false` in `crates/nanocodex-oai-api/src/responses/request.rs` while client-side parallel execution is tested. |
| 381 | fdbab67c669a | Carry environment config in turn selections | out-of-scope | Codex app-server turn/environment selection protocol. |
| 382 | 4eff3b788ba6 | Configure Guardian sampling for responses lite | out-of-scope | Guardian sampler configuration. |
| 383 | 8630bb3caeca | Record Guardian V2 risk scores on threads | out-of-scope | Guardian thread risk persistence. |
| 384 | a44f266a4a23 | Initialize Guardian V2 samplers per thread | out-of-scope | Guardian sampler lifecycle. |
| 385 | db5b4a4cfb26 | Preserve Guardian transcript boundaries in sampling input | out-of-scope | Guardian transcript sampling. |
| 386 | 486df09a0039 | Improve Guardian transcript context selection | out-of-scope | Guardian transcript selection. |
| 387 | 3134ab65725d | Restrict filesystem helper sandbox access | out-of-scope | Codex exec-server sandbox policy. |
| 388 | 08c48e370076 | Reuse compatible parent compactions in Guardian V2 | out-of-scope | Guardian review compaction. |
| 389 | aa905bb9625d | Store security risk scores as a snapshot | out-of-scope | Guardian risk snapshots and persisted thread history. |
| 390 | d40dfcc3c727 | Run tool start callbacks after pre-tool hooks | out-of-scope | Codex hooks/extension lifecycle; Nanocodex has no hook pipeline. |
| 391 | 1c4f42863c1f | Require automatic review for high-risk Guardian v2 actions | out-of-scope | Guardian automatic-review policy. |
| 392 | 42d842a91a9d | Report thread storage changes after rollout migration | out-of-scope | Codex rollout migration CLI. |
| 393 | 2a452d7dc1f9 | Keep the latest Guardian risk score during concurrent sampling | out-of-scope | Guardian sampling state. |
| 394 | 7c194ff24b3a | Honor cloud-managed requirements in feature listings | out-of-scope | Codex cloud feature/config listing. |
| 395 | 5bc8da6d78fe | Bound Guardian V2 tool actions before risk classification | out-of-scope | Guardian action classification. |
| 396 | 23094236acac | Let extensions resolve approval reviews before Guardian | out-of-scope | Codex extension/Guardian approval ordering. |
| 397 | 742edd6c1693 | Prioritize new Guardian classifications under load | out-of-scope | Guardian sampler scheduling. |
| 398 | 3360f4a909a9 | Install Guardian V2 in the app server | out-of-scope | App-server Guardian integration. |
| 399 | da898490fcc7 | Make unbounded connection retries configurable | defer | Nanocodex deliberately keeps a bounded default retry budget; unbounded mode is not supported. |
| 400 | 588ee893241d | Isolate Guardian reviewer sessions from parent extensions | out-of-scope | Guardian reviewer session isolation. |

## Classification totals

| Classification | Count |
|---|---:|
| `port` | 3 |
| `evaluate` | 9 |
| `defer` | 1 |
| `out-of-scope` | 87 |
| Total | 100 |

## Non-out-of-scope commits needing parent review

`303`, `305`, `317`, `321`, `322`, `328`, `345`, `347`, `359`, `362`, `365`,
`380`, and `399`.
