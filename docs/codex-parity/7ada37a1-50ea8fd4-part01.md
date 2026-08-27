# Codex parity review: `7ada37a1..50ea8fd4`, ordinals 1–100

The rows below use `git rev-list --reverse --topo-order` at the exact upstream
checkout `openai/codex@50ea8fd411422b3f7bc906bcde6c1c4432019a2e`. `port` is
reserved for behavior already implemented and regression-tested in Nanocodex;
`evaluate` identifies a relevant gap requiring a focused decision/test;
`defer` is an intentional product-boundary postponement; and `out-of-scope`
covers Codex-only surfaces.

## Counts

| classification | count |
| --- | ---: |
| port | 1 |
| evaluate | 13 |
| defer | 1 |
| out-of-scope | 85 |
| total | 100 |

## Ordered classifications

| ordinal | SHA | subject | classification | decision / evidence |
| ---: | --- | --- | --- | --- |
| 1 | `90314a920732` | Read turn permissions from the current configuration (#36930) | out-of-scope | Guardian approval-policy plumbing; Nanocodex has no Guardian surface. |
| 2 | `1e59dc5bdaa3` | Trust undecided local projects automatically (#36935) | out-of-scope | Local-project trust and approval policy, outside the headless SDK contract. |
| 3 | `3ca9f375aa23` | Enable cached web search for Amazon Bedrock (#36938) | out-of-scope | Amazon Bedrock alternate-provider/configuration behavior; product boundary supports one OpenAI model family. |
| 4 | `2b1357c27cc4` | Include policy approval reasons in Guardian reviews (#36939) | out-of-scope | Guardian review prompts and approval policy are not Nanocodex-owned. |
| 5 | `d1fb77d69274` | Use current session settings for review threads (#36941) | out-of-scope | Review-thread/app-server behavior, not the owned agent lifecycle. |
| 6 | `1a7519fa070d` | Move host skill root resolution into the skills extension (#36943) | out-of-scope | Codex skills-extension loader; Nanocodex deliberately has no plugin/skills subsystem. |
| 7 | `ceaa81889882` | Grant the blob size policy job read access to contents (#36945) | out-of-scope | Repository CI workflow only. |
| 8 | `989a0b053e25` | Accept user input when starting idle turns (#36947) | evaluate | Relevant idle-input semantics; `Nanocodex::route_prompt` starts/steers prompts (`crates/nanocodex-agent/src/agent/handle.rs`), but no equivalent exported `TurnInput`/idle-extension regression covers Codex's Plan-mode and mailbox cases. |
| 9 | `8bfa49e350ed` | Paginate transcript history in the TUI (#36948) | out-of-scope | App-server persisted transcript pagination and TUI integration. |
| 10 | `3b8d22ec2c75` | Improve paginated TUI history loading (#36949) | out-of-scope | TUI history rendering/loading surface. |
| 11 | `dbcd837c20cd` | Paginate TUI transcript history (#36950) | out-of-scope | TUI transcript pagination, not a library lifecycle invariant. |
| 12 | `449f099f1cad` | Harden paginated history handling in the TUI (#36951) | out-of-scope | TUI/app-server history handling. |
| 13 | `b87981a51024` | Add durable per-thread user submission queues (#36952) | out-of-scope | SQLite thread-store queue persistence; Nanocodex's queue is owned by the agent/managed runtime, not Codex's persisted app-server thread store. |
| 14 | `9952933c1d75` | Add tool registry collision policy configuration (#36954) | out-of-scope | Codex config schema/feature-toggle plumbing; the independently owned strict collision behavior is covered by ordinal 37. |
| 15 | `4bd5b9fd0933` | Keep image resize notices attached during remote compaction (#36956) | evaluate | Nanocodex compaction retains/re-writes tool outputs (`crates/nanocodex-oai-api/src/session/compaction.rs`) but has no adjacent image-resize notice grouping regression. |
| 16 | `92689b6b7bd9` | Track connectors detected in external agent sessions (#36959) | out-of-scope | External-agent migration and connector detection/import. |
| 17 | `17801b42062f` | Prompt before trusting local project directories (#36960) | out-of-scope | Trust/approval policy, outside Nanocodex. |
| 18 | `40d226e39821` | Link Codex attribution in pull request bodies (#36963) | out-of-scope | Codex Git attribution extension and app-server tests. |
| 19 | `e9a692d53ba5` | Preserve working directories when importing external sessions (#36964) | out-of-scope | External-session migration/import behavior. |
| 20 | `78f00743f92c` | Allow disabling the built-in image viewer (#36966) | out-of-scope | Codex app-server/TUI image-viewer configuration. |
| 21 | `720c9d68e121` | Skip symlinks when installing plugins (#36967) | out-of-scope | Plugin installation policy. |
| 22 | `c607da9f371b` | Make token budget context identity configurable (#36970) | out-of-scope | Codex token-budget configuration and context-message policy; Nanocodex deliberately does not own Codex config surfaces. |
| 23 | `1b90b1d16bad` | Honor explicit-only orchestrator skills (#36976) | out-of-scope | Orchestrator skills extension. |
| 24 | `1a5e15218990` | Improve connector detection for migrated sessions (#36977) | out-of-scope | Connector detection in external-session migration. |
| 25 | `e1f39b5f5be9` | Add Fence auditing to the blob size workflow (#36979) | out-of-scope | Repository CI workflow only. |
| 26 | `b9ba969f3996` | Enable remote compaction for Amazon Bedrock (#36981) | out-of-scope | Alternate-provider compaction behavior. |
| 27 | `bf05737da401` | Preserve ChatGPT auth for trusted staging MCP servers (#36983) | out-of-scope | Provider credential/auth routing and trusted staging policy. |
| 28 | `411f3f068060` | Support configured ChatGPT cookies in HTTP clients (#36984) | out-of-scope | ChatGPT credential and shared HTTP-client plumbing; provider credentials stay behind Nanocodex's broker. |
| 29 | `1d952f027e22` | Add process-scoped PSP routing for ChatGPT requests (#36986) | out-of-scope | ChatGPT/app-server provider routing. |
| 30 | `eeae88d8a65e` | Add opt-in concurrent exec-server request dispatch (#36987) | out-of-scope | Remote exec-server protocol/concurrency, outside embedded Code Mode. |
| 31 | `bae8d8f5b669` | Preserve shared bundled skill caches (#36989) | out-of-scope | Skills/plugin cache behavior. |
| 32 | `11e390bb10bb` | Remove legacy collaboration mode variants (#36990) | out-of-scope | Codex collaboration-mode templates and scheduler policy. |
| 33 | `44cb66e4edc0` | Allow injecting model catalog caches (#36992) | out-of-scope | Provider model-catalog injection; no provider-portability contract. |
| 34 | `e87e2b495bcf` | Support `includeTurns` reads for paginated threads (#36993) | out-of-scope | App-server paginated-thread read API. |
| 35 | `431c78eb9c99` | Support deferred custom tools in tool search (#36998) | evaluate | Nanocodex supports the deferred custom-tool wire shape and the custom/tool-search paths separately, but it lacks one regression that discovers a deferred custom tool and routes the follow-up custom call. |
| 36 | `5d89ab65dc9d` | Keep shared skill caches fresh across plugin loads (#37000) | out-of-scope | Skills/plugin cache lifecycle. |
| 37 | `1e489adad023` | Enforce strict tool name collision errors (#37020) | port | Nanocodex rejects exact and normalized collisions during tool build (`crates/nanocodex-tools/src/runtime/selection.rs:612-735`); regression coverage is `crates/nanocodex-tools/src/runtime/tests.rs:419-450,667-704`. |
| 38 | `f21dc4638803` | Canonicalize default tools under the `functions` namespace (#37022) | evaluate | Responses Lite metadata supports plain/MCP names (`crates/nanocodex-oai-api/src/responses/request.rs:743-783`), but no `functions` default-namespace canonicalization is implemented/tested. |
| 39 | `56b82e676cc5` | Enforce Agent Plugin runtime boundaries (#37027) | out-of-scope | Agent Plugin runtime boundary and app-server MCP contributor. |
| 40 | `30d99232f485` | Apply permission profile updates to future turn environments (#37031) | out-of-scope | Codex managed permission profiles and remote environment selection. |
| 41 | `1fe6be9719ac` | Align registry tests with canonical tool names (#37035) | out-of-scope | Test-only Codex registry maintenance. |
| 42 | `bac3ef1d8e0c` | Use turn environment permissions for tool execution (#37038) | out-of-scope | Sandbox/Guardian permission policy, outside caller-defined tools. |
| 43 | `ed2f985a26ee` | Use turn environment permissions for context and discovery (#37040) | out-of-scope | Managed environment permission projection. |
| 44 | `3171166881a7` | Reject conflicting namespace descriptions in strict tool mode (#37053) | evaluate | Namespace descriptions are emitted by MCP catalog (`crates/nanocodex-tools/src/mcp/catalog.rs:703-719`), but Nanocodex has no strict configurable conflicting-description rejection regression. |
| 45 | `757c151a0e92` | Add safer TUI defaults for cyber models (#37055) | out-of-scope | Cyber-model/TUI model policy. |
| 46 | `fcc4ca552f77` | Preserve longer MCP source descriptions in tool search (#37066) | evaluate | MCP search currently bounds names and returns per-tool/namespace descriptions (`crates/nanocodex-tools/src/mcp/catalog.rs:549-575,703-719`); upstream's aggregate source-description budget has no matching Nanocodex evidence. |
| 47 | `f2d825533c94` | Fall back to per-process MCP cleanup on macOS (#37068) | evaluate | Nanocodex uses process-group cleanup for stdio MCP (`crates/nanocodex-tools/src/mcp/stdio.rs:30-75` and `shell/process.rs:258-337`), but lacks the upstream macOS member fallback and platform regression. |
| 48 | `5c44f110649f` | Consolidate unified exec output state (#37083) | out-of-scope | Codex unified-exec internal state refactor with no Nanocodex API invariant. |
| 49 | `952e87d3f29e` | Reuse stable MCP bindings across sampling steps (#37101) | evaluate | `ToolRuntime` retains one registry/provider runtime across calls (`crates/nanocodex-tools/src/runtime/execution.rs:1-16,80-153`), but no stable catalog-revision/binding regression proves the upstream mutable-MCP reuse semantics. |
| 50 | `c4f42d161ae4` | Use Luna for API-key Guardian reviews (#37103) | out-of-scope | Guardian provider-selection policy. |
| 51 | `2707dfc219b9` | Bound interactive telemetry shutdown (#37109) | out-of-scope | Codex interactive telemetry/TUI shutdown. |
| 52 | `9d00bb01c0a7` | Add per-session code-mode execution limits (#37114) | defer | Standalone V8/code-mode-host resource negotiation is explicitly deferred; Nanocodex retains embedded QuickJS (`PLAN.md`, Phase 1 boundary). |
| 53 | `778b86982997` | Centralize tool approval handling in `Session` (#37128) | out-of-scope | Approval/Guardian handling is outside the SDK tool contract. |
| 54 | `4cb8676d3a41` | Make Windows path URI comparisons ASCII-case-insensitive (#37129) | out-of-scope | Codex path-URI utility maintenance, not a Nanocodex-owned invariant. |
| 55 | `2994f545a7eb` | Enforce managed authentication requirements locally (#37132) | out-of-scope | Codex app-server managed-auth configuration. |
| 56 | `fa5d5ae047d1` | Report prompt image resizing to the model (#37134) | evaluate | Nanocodex resizes/validates prompt images (`crates/nanocodex-tools/src/image/mod.rs:189-297`) and tests resizing, but does not append model-visible resize notices. |
| 57 | `72d937ed4d10` | Preserve discovery paths for symlinked skills (#37144) | out-of-scope | Skills discovery and symlink policy. |
| 58 | `2b915a2eed8c` | Gate Apps usage instructions by model capability (#37145) | out-of-scope | Codex Apps/connectors capability policy. |
| 59 | `f5345f1ee858` | Track provisioned environment state across registration (#37147) | out-of-scope | Remote exec-server environment registration. |
| 60 | `a1890b69988f` | Project orchestrator skills through world state (#37149) | out-of-scope | World-state/skills orchestration. |
| 61 | `b6c3b5153393` | Coalesce concurrent Git status scans (#37151) | out-of-scope | Codex Git-status utility optimization. |
| 62 | `0c07c7ee4761` | Use Azure Key Vault for macOS notarization (#37154) | out-of-scope | Release signing/notarization workflow. |
| 63 | `b6cddbf6d579` | Test remote environments reported ready before selection (#37156) | out-of-scope | Remote environment/app-server tests. |
| 64 | `c38a60ded2ff` | Harden named session lookup in the TUI (#37157) | out-of-scope | TUI named-session lookup. |
| 65 | `bd36d69aaee5` | Load host skill roots through the skills extension (#37162) | out-of-scope | Skills-extension host loader. |
| 66 | `ad6e48ddd35a` | Keep textarea cursors and rendering inside the viewport (#37166) | out-of-scope | TUI rendering behavior. |
| 67 | `15ea598c6e7e` | Expose session sources to MCP contributors (#37167) | out-of-scope | Codex extension/contributor session-source metadata, not Nanocodex's MCP tool contract. |
| 68 | `e244a9d94e2e` | Bound remote MCP handshake HTTP requests (#37168) | evaluate | Nanocodex bounds awaited MCP initialize/tools-list (`crates/nanocodex-tools/src/mcp/client.rs:424-436,520-526`), but has no transport-level deadline propagation or timeout-cleanup regression for the underlying HTTP request. |
| 69 | `f380b4873367` | Move plugin skill snapshot integration tests into core (#37169) | out-of-scope | Plugin/skills test relocation. |
| 70 | `e3465b48ad49` | Centralize skill invocation helpers in `codex-skills` (#37174) | out-of-scope | Skills crate refactor. |
| 71 | `6bb6e9045f72` | Add legacy rollout migration to paginated history (#37175) | out-of-scope | Codex rollout/thread-store migration. |
| 72 | `a3ebd19fa40d` | Move explicit skill selection into the skills crate (#37177) | out-of-scope | Skills selection. |
| 73 | `928bda82cf54` | Preserve image transparency metadata in app-server items (#37178) | out-of-scope | App-server protocol schema metadata. |
| 74 | `98da2c4499dc` | Reserve the `tool_search` namespace for the search tool (#37188) | evaluate | Nanocodex reserves exact `exec`, `wait`, and `tool_search` names (`crates/nanocodex-tools/src/runtime/selection.rs:663-715`, regression `runtime/tests.rs:723-756`), but does not reject the `tool_search__*` namespace collision covered upstream. |
| 75 | `92b83e226df5` | Track multi-agent usage hints in world state (#37189) | out-of-scope | Codex world-state/multi-agent policy. |
| 76 | `f141dc77f05b` | Interrupt cyber model turns after one Guardian denial (#37190) | out-of-scope | Guardian denial and cyber-model policy. |
| 77 | `aac9f842473a` | Preserve legacy semantics during rollout migration (#37191) | out-of-scope | Legacy rollout migration. |
| 78 | `547080e4d690` | Prefer persisted cwd when reading local threads (#37198) | out-of-scope | Persisted Codex thread-store cwd behavior. |
| 79 | `70b465323282` | Track thread archive analytics (#37199) | out-of-scope | Codex analytics event/reducer maintenance. |
| 80 | `bc8b25ea0219` | Add durable user-message queue dispatch (#37204) | out-of-scope | App-server durable queue dispatch; Nanocodex's typed driver queue is not a Codex SQLite thread projection. |
| 81 | `0a0ebb853551` | Add a unified image budget (#37206) | evaluate | Nanocodex has detail-based image limits/cache (`crates/nanocodex-tools/src/image/mod.rs:30-104,287-327`), but no unified-budget mode or model-capability regression. |
| 82 | `1ae82ce6a58d` | Fetch remote installed plugins across all scopes (#37210) | out-of-scope | Remote plugin catalog/discovery. |
| 83 | `7a0e974e08c7` | Harden network proxy MITM authorization (#37211) | out-of-scope | Managed network-proxy authorization, outside caller-defined tools. |
| 84 | `74b8f8db93e7` | Cover remote MCP discovery timeout cleanup (#37248) | out-of-scope | Upstream diff is test-only remote exec-server coverage; no Nanocodex code change is represented. |
| 85 | `82b17bc724aa` | Allow agent roles on full-history forks (#37252) | out-of-scope | Codex multi-agent roles/fork scheduler. |
| 86 | `a17da5e6e4a5` | Fix first-turn model switching and rollback (#37260) | out-of-scope | Multi-model switching/rollback policy conflicts with the one-model contract. |
| 87 | `1151b23f01ac` | Start cached MCP servers lazily for subagents (#37261) | out-of-scope | Codex subagent scheduler and mutable MCP startup cache. |
| 88 | `bfb6a6ea226b` | Support plugin roots in the host skill loader (#37267) | out-of-scope | Plugin/skills host loader. |
| 89 | `e1831db7c31e` | Reuse MCP handlers across sampling steps (#37273) | out-of-scope | Codex MCP handler cache tied to its mutable app-server runtime; Nanocodex intentionally owns one fixed per-driver provider runtime. |
| 90 | `57f42a81131c` | Avoid cloning immutable metadata on tool search cache hits (#37279) | out-of-scope | Internal Codex tool-search allocation optimization without a changed Nanocodex contract. |
| 91 | `303a29258176` | Fully repaint inline viewports after history overlap (#37335) | out-of-scope | TUI viewport rendering. |
| 92 | `7257826ab228` | Use step environments for extension turn input (#37336) | out-of-scope | Codex extension/environment selection. |
| 93 | `b3ffe3d00177` | Recover MCP servers after OAuth reauthentication (#37337) | evaluate | Nanocodex supports OAuth refresh/login/reload (`crates/nanocodex-tools/src/mcp/mod.rs:96-134,319-470`) and refresh persistence tests, but lacks the upstream auth-failure detection/reconnect regression. |
| 94 | `842547640ee3` | Honor the configured ChatGPT origin in connector install URLs (#37338) | out-of-scope | ChatGPT connector-specific install routing. |
| 95 | `d9eac1040617` | Reload app-server telemetry after account changes (#37339) | out-of-scope | App-server account/telemetry lifecycle. |
| 96 | `f8ac8fa6c6ac` | Consolidate deferred environment provisioning APIs (#37340) | out-of-scope | Remote exec-server environment API refactor. |
| 97 | `29dce2db4371` | Support content references for inline visualizations (#37341) | out-of-scope | TUI inline visualization renderer. |
| 98 | `bcea6447ee9f` | Preserve foreign cwd URIs for turn-input contributors (#37342) | out-of-scope | Codex extension contributor metadata and cwd URI handling. |
| 99 | `a9da0bdbac5c` | Stage Bazel app-server test binaries in `TEST_TMPDIR` (#37343) | out-of-scope | Test-infrastructure staging only. |
| 100 | `4ffeddcbcc0d` | Fix subagent MCP startup status settling (#37344) | out-of-scope | TUI/app-server subagent startup status presentation. |

## Non-out-of-scope commits needing parent review

`8:989a0b053e25 (evaluate)`, `15:4bd5b9fd0933 (evaluate)`,
`35:431c78eb9c99 (port)`, `37:1e489adad023 (port)`,
`38:f21dc4638803 (evaluate)`, `44:3171166881a7 (evaluate)`,
`46:fcc4ca552f77 (evaluate)`, `47:f2d825533c94 (evaluate)`,
`49:952e87d3f29e (evaluate)`, `52:9d00bb01c0a7 (defer)`,
`56:fa5d5ae047d1 (evaluate)`, `68:e244a9d94e2e (evaluate)`,
`74:98da2c4499dc (evaluate)`, `81:0a0ebb853551 (evaluate)`,
`93:b3ffe3d00177 (evaluate)`.
