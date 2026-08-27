# Codex parity review: ordinals 101–200 (`7ada37a1..50ea8fd4`)

This appendix classifies the exact ordered slice produced by
`git rev-list --reverse --topo-order 7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4..50ea8fd411422b3f7bc906bcde6c1c4432019a2e | sed -n '101,200p'`.
Every row below is one upstream commit; subjects are taken from the upstream
commit itself.

| Classification | Count |
| --- | ---: |
| `port` | 5 |
| `evaluate` | 21 |
| `defer` | 7 |
| `out-of-scope` | 67 |
| Total | 100 |

## Ordered classifications

| Ordinal | Codex commit | Subject | Classification | Decision/evidence |
| ---: | --- | --- | --- | --- |
| 101 | `270d93268ce9` | Send model routing hints to the Codex backend (#37345) | `evaluate` | Backend model-routing hints are absent from Nanocodex's provider contract; assess only if model routing becomes an owned API. |
| 102 | `69b6152c1794` | Track context windows per agent (#37347) | `evaluate` | Per-agent context-window/reset accounting is relevant, but current `ContextManager` has no equivalent per-agent window regression. |
| 103 | `4bb7ee347283` | Add rollout migration tooling and background migration (#37348) | `out-of-scope` | Codex CLI/app-server rollout migration and background state machinery; not the Nanocodex SDK lifecycle. |
| 104 | `912524d6feec` | Mount a minimal `/dev` in full-filesystem Bubblewrap sandboxes (#37349) | `out-of-scope` | Codex Bubblewrap sandbox internals; Nanocodex's experimental VM owns its isolation boundary. |
| 105 | `9457f8f73412` | Allow `ThreadManager` to customize thread ID generation (#37350) | `evaluate` | Custom persisted-thread ID factories are relevant to branching identity, but current agent IDs have no equivalent configurable manager boundary. |
| 106 | `d0c8f422eaaa` | Configure the default code-mode exec yield timeout (#37352) | `evaluate` | Configurable Code Mode defaults are relevant, but Nanocodex currently has a fixed ten-second contract and no config/regression for this option. |
| 107 | `9afb96faffc2` | Retry busy app-server test executable spawns (#37354) | `out-of-scope` | App-server test-harness-only spawn retry. |
| 108 | `b94343ab9f3f` | Support agent identity endpoint overrides (#37356) | `out-of-scope` | Codex provider/login Agent Identity endpoint configuration. |
| 109 | `4d7e3e90d978` | Clamp short wait_agent timeouts to the configured minimum (#37357) | `evaluate` | A bounded wait primitive is relevant to subagent tooling, but no configured minimum clamp/report regression exists in Nanocodex. |
| 110 | `2801d12661be` | Add Markdown conversation export to the TUI (#37358) | `out-of-scope` | Codex TUI transcript-export surface. |
| 111 | `5bdc88970801` | Use consistent TUI input placeholders (#37360) | `out-of-scope` | Codex TUI cosmetic placeholder change. |
| 112 | `81b9bc210926` | Recognize MCP tool hook configurations (#37363) | `out-of-scope` | App-server/config hook schema; Nanocodex has no Codex hook subsystem. |
| 113 | `9daa491f7c27` | Harden local MCP server process tree cleanup (#37366) | `evaluate` | Unix process-group cleanup is tested, but Codex also adds Windows no-breakaway Job Object containment and macOS fallback behavior that Nanocodex does not implement or regress. |
| 114 | `80858a8cce7f` | Add session forking to `codex exec` (#37367) | `port` | The owned SDK already forks retained state via `crates/nanocodex-agent/src/agent/driver/branch.rs`; `crates/nanocodex-agent/tests/it/model/branching/forks.rs` covers latest/historical branches. Codex's `exec` CLI flag is excluded. |
| 115 | `66225461695f` | Restore approval policy when resuming threads (#37368) | `out-of-scope` | Codex app-server approval-policy resume plumbing; approval is not a Nanocodex runtime owner. |
| 116 | `1efd8fcb2697` | Add session archiving to the resume picker (#37369) | `defer` | Track-B session finding/retention UX is relevant but intentionally postponed; Codex's picker implementation is not imported. |
| 117 | `0bdce9f424eb` | Restore archived sessions from the resume picker (#37371) | `defer` | Track-B archive restoration UX remains deferred with row 116. |
| 118 | `4ee41929eaf4` | Add tool namespace metadata configuration (#37389) | `evaluate` | Tool metadata configuration is relevant, but current registry metadata is not caller-configurable and lacks this setting's regression. |
| 119 | `c87a218bd3e7` | Rename the tool registry metadata setting (#37400) | `out-of-scope` | Codex config-only rename with no Nanocodex setting. |
| 120 | `957f8eedee0d` | Add a loader for executor-local config layers (#37406) | `out-of-scope` | Codex executor/config-layer pipeline. |
| 121 | `95c7265e849e` | Add executor-local config reads to the exec server (#37408) | `out-of-scope` | Codex exec-server environment-config protocol. |
| 122 | `85e0661c3baa` | Cap project instructions across environments (#37424) | `out-of-scope` | The diff changes Codex's multi-environment aggregate config budget; Nanocodex has one local hierarchy and its own 32-KiB loader policy. |
| 123 | `51e36d2ec23c` | Expose multi-agent versions in model/list (#37433) | `out-of-scope` | App-server `model/list` schema and multi-agent version advertisement. |
| 124 | `a7dcd20d3895` | Add process diagnostics snapshots (#37434) | `evaluate` | Process diagnostics are relevant to observability, but no equivalent Nanocodex process snapshot/gauge evidence exists. |
| 125 | `a4b129eb3e1a` | Add shared skill root loading interfaces (#37439) | `out-of-scope` | Codex skills loader API; skills are not a Nanocodex-owned surface. |
| 126 | `e75a1888d7e9` | Load plugin skill roots through the host skills service (#37440) | `out-of-scope` | Codex plugin/skills host service. |
| 127 | `e58d9ef44778` | Unify plugin skill loading with the host skill service (#37444) | `out-of-scope` | Codex plugin and skills loader architecture. |
| 128 | `964a227d8cda` | Preserve base instruction provenance across sessions (#37446) | `out-of-scope` | Codex config-lock/session role provenance and app-server persistence; Nanocodex's explicit context snapshots are a separate contract. |
| 129 | `a9d59d8b8e4b` | Respect plugin skill availability in tool suggestions (#37447) | `out-of-scope` | Codex plugin skill suggestions. |
| 130 | `c5d94319715d` | Unify plugin skill loading through the shared loader (#37452) | `out-of-scope` | Codex plugin/skills loader refactor. |
| 131 | `33e365b19e4a` | Remove the legacy core skill loader (#37457) | `out-of-scope` | Codex legacy skills cleanup. |
| 132 | `3b366654f1de` | Remove the unused remote skills client (#37461) | `out-of-scope` | Codex remote-skills cleanup. |
| 133 | `b3278e96cb6d` | Move skill config rule resolution into `codex-config` (#37466) | `out-of-scope` | Codex skills/config layering. |
| 134 | `572954683910` | Expose app-server diagnostics through the experimental API (#37470) | `out-of-scope` | App-server diagnostics API/schema. |
| 135 | `248d8c0e2297` | Include call IDs in MCP requests and clarify metadata config (#37477) | `evaluate` | MCP call-ID request metadata is relevant, but `crates/nanocodex-tools/src/mcp/mod.rs` has no `_meta.callId` emission or focused regression. |
| 136 | `204389afcc09` | Shard state unit tests under Bazel (#37478) | `out-of-scope` | Codex build/test sharding only. |
| 137 | `92fb33b7583a` | Report temporary directories in exec-server environment info (#37479) | `out-of-scope` | Codex exec-server environment-info reporting. |
| 138 | `511262b98445` | Delegate remote process sandboxing to the executor (#37480) | `out-of-scope` | Codex remote executor sandbox delegation; local tools/VM own Nanocodex isolation. |
| 139 | `509565820f90` | Interrupt active code-mode cells with their turn (#37483) | `evaluate` | Nanocodex terminates cells owned by the cancelled turn. Codex additionally interrupts prior yielded background cells and an in-flight nested tool while preserving reusable host state; that combined lifecycle is not implemented or tested. |
| 140 | `5a0d0929e20c` | Keep response streams alive through connection failures (#37485) | `evaluate` | Responses retry/reconnect state exists in `crates/nanocodex-oai-api/src/tower`, but no budget-independent network-failure wait/recovery regression establishes this exact behavior. |
| 141 | `27e4a05cd34f` | Expose runtime activity in server diagnostics (#37486) | `out-of-scope` | Codex app-server diagnostics metadata. |
| 142 | `ce22ea9712ae` | Generalize skill locator aliases across providers (#37488) | `out-of-scope` | Codex provider skill locator behavior. |
| 143 | `ba94150c2a63` | Alias resource-backed skill locators under context pressure (#37489) | `out-of-scope` | Codex skill locator/context-pressure behavior. |
| 144 | `2b1811e56201` | Include tool namespace inventory in turn metadata (#37492) | `evaluate` | Namespace inventory is relevant to Responses metadata, but current metadata only asserts `code_mode_tool_names` in `crates/nanocodex-agent/tests/it/model/mod.rs`. |
| 145 | `41014b11bd0c` | Add MCP event discovery and subscriptions (#37494) | `defer` | Relevant to PLAN Track-B event-driven agents, but Nanocodex currently has no MCP event stream/subscription boundary. |
| 146 | `62b7386b07e4` | Limit payload traces in diagnostic logs (#37497) | `out-of-scope` | Conflicts with Nanocodex's intentional full-fidelity tracing policy; Codex diagnostic payload truncation is not adopted. |
| 147 | `6db53df37f4e` | Preserve child waiters during process termination (#37498) | `port` | `ShellSession::terminate` in `crates/nanocodex-tools/src/shell/mod.rs` terminates then awaits the child; `assert_direct_cancellation_finishes`, `concurrent_full_cancellations_wait_for_the_same_process_cleanup`, and `direct_pty_cancellation_reuses_the_completed_wait_result` cover waiter draining. |
| 148 | `8e4b10446eed` | Remove the legacy code-mode tool metadata inventory (#37500) | `out-of-scope` | Codex legacy metadata inventory cleanup. |
| 149 | `beac16cccd67` | Move host skill prompt injection into the skills extension (#37503) | `out-of-scope` | Codex skills extension prompt injection. |
| 150 | `abc5d0b552a8` | Disable Nagle's algorithm for code-mode WebSockets (#37504) | `defer` | Remote Code Mode WebSocket tuning is deferred with the standalone host; Nanocodex retains embedded QuickJS (D3). |
| 151 | `45f8cafa4e2e` | Remove the codex-core-skills crate (#37505) | `out-of-scope` | Codex packaging/skills crate deletion. |
| 152 | `4ca25a2c4e6d` | Include sandbox mode in response metadata (#37507) | `out-of-scope` | Sandbox/approval response metadata is not a Nanocodex-owned contract. |
| 153 | `8073dbb20bbd` | Define the code-mode host gRPC protocol (#37510) | `defer` | Standalone Code Mode host protocol is intentionally deferred (D3); embedded QuickJS remains supported. |
| 154 | `208f05b23387` | Enforce automatic review for managed models (#37511) | `out-of-scope` | Managed-model Guardian approval/config requirements. |
| 155 | `c2bcb9a26b5b` | Reuse parent compactions in Guardian review sessions (#37513) | `out-of-scope` | Guardian review-session machinery. |
| 156 | `e734a1a5c1c6` | Ignore reusable command approvals for cyber models (#37516) | `out-of-scope` | Codex approval/exec-policy and cyber-model policy. |
| 157 | `2e3a1702c2e7` | Expose auto-review ignore rules in config requirements (#37519) | `out-of-scope` | Guardian auto-review config RPC. |
| 158 | `dd916428cd73` | Terminate timed-out hook process trees (#37527) | `out-of-scope` | Codex hooks engine; Nanocodex has no hook subsystem. |
| 159 | `f65ea998c753` | Keep external agent detection from blocking config requests (#37528) | `out-of-scope` | Codex app-server external-agent config requests. |
| 160 | `61a3dd4387da` | Implement the gRPC code-mode host service (#37530) | `defer` | Standalone gRPC Code Mode host is deferred under D3; current host is embedded QuickJS. |
| 161 | `6f647caa9bd6` | Support asynchronous command hooks (#37533) | `out-of-scope` | Codex hooks engine and approval events. |
| 162 | `3aae5d885bac` | Expose execution mode in hook listings (#37538) | `out-of-scope` | Codex hook listing/app-server/UI metadata. |
| 163 | `c4513cb982e9` | Prevent launch context from reaching child processes (#37607) | `evaluate` | Child environment scrubbing is security-relevant, but distinct workload/launch-context variables and a focused Nanocodex regression are absent. |
| 164 | `936f5eb3ee22` | Add workload identity token exchange support (#37610) | `out-of-scope` | Provider/workload-identity authentication exchange. |
| 165 | `dd43a9967ff1` | Use step environments for Guardian approval reviews (#37618) | `out-of-scope` | Guardian approval review environment plumbing. |
| 166 | `266c6920d9b8` | Include buffered turns when editing prompts (#37622) | `port` | Historical prompt editing archives the running source and prevents completion misrouting; `bin/nanocodex/src/tui/app.rs` tests `historical_edit_archives_a_running_source_without_misrouting_its_completion` and `bin/nanocodex/src/tui/mod.rs` cover submission. |
| 167 | `420accf199e1` | Use the step context for command approval prefix rules (#37641) | `out-of-scope` | Codex approval-prefix/exec-policy subsystem. |
| 168 | `a875dd6b220b` | Generalize hook handler execution (#37644) | `out-of-scope` | Codex hooks engine/handlers. |
| 169 | `94937de51ba2` | Improve plugin install failure analytics (#37645) | `out-of-scope` | Codex plugin install analytics/app-server protocol. |
| 170 | `646f7c0a91b8` | Advertise environment config read support (#37654) | `out-of-scope` | Codex exec-server environment-config protocol. |
| 171 | `a16863f87048` | Keep wrapped composer whitespace with following text (#37709) | `evaluate` | Composer exists, but current layout hard-wraps characters and has no whitespace-breakpoint parity evidence. |
| 172 | `50ef7395faee` | Report I/O subtypes for session config import failures (#37723) | `out-of-scope` | Codex external-agent session import diagnostics/app-server. |
| 173 | `c0ad3ab014a2` | Add gRPC TCP transport to the code-mode host (#37745) | `out-of-scope` | Codex standalone Code Mode host listener; Nanocodex uses embedded QuickJS/owned attachment transport. |
| 174 | `f344a80a3b4a` | Bound Cursor project path resolution (#37747) | `out-of-scope` | Codex Cursor external-session migration. |
| 175 | `21aa552e8727` | Add a line-ending preservation mode to `apply_patch` (#37757) | `evaluate` | Nanocodex apply_patch currently normalizes LF; no preserved-CRLF mode or regression exists. |
| 176 | `c9c6c0daa994` | Add a feature flag to preserve apply_patch line endings (#37758) | `evaluate` | Feature propagation for line-ending preservation is absent; evaluate with the row-175 tool behavior. |
| 177 | `89a335ed5025` | Forward install attempt IDs for remote plugins (#37773) | `out-of-scope` | Codex remote-plugin install analytics/app-server protocol. |
| 178 | `8cabf5a6cf10` | Use native transparency in the imagegen skill (#37788) | `out-of-scope` | Codex imagegen skill documentation asset. |
| 179 | `c8e6e8555c42` | Initialize the install attempt ID in the plugin analytics test (#37806) | `out-of-scope` | Plugin analytics test-only change. |
| 180 | `beeba1d2fc49` | Share model-visible tool specs across prompts (#37807) | `port` | `ToolRuntime::model_contract` builds the direct specs/name map together in `crates/nanocodex-tools/src/runtime/execution.rs`; `exposure_controls_direct_visibility_without_removing_code_mode_access` and `per_tool_exposure_selects_direct_and_code_mode_surfaces_independently` in `crates/nanocodex-tools/src/runtime/tests.rs` assert stable specs and names. |
| 181 | `09f47c87857a` | Simplify package-based skill reads (#37808) | `out-of-scope` | Codex package-based skills extension. |
| 182 | `34ecac1f2b44` | Support packaged defaults in config layering (#37810) | `out-of-scope` | Codex packaged config-layer defaults/app-server schema. |
| 183 | `1c042dd4d823` | Keep multi-workspace skill listings consistent (#37812) | `out-of-scope` | Codex multi-workspace skill listings. |
| 184 | `d10939327043` | Track running unified exec processes at turn completion (#37828) | `evaluate` | Code Mode/shell guards bound process lifecycle, but no equivalent running-process metric/evidence exists. |
| 185 | `bfb7790eb3ca` | Remove obsolete plugin skill discovery helpers (#37832) | `out-of-scope` | Codex plugin/skill internals cleanup. |
| 186 | `680934adc4dc` | Encapsulate watchable skill root selection (#37833) | `out-of-scope` | Codex watchable skills roots. |
| 187 | `3b67b03a3f6b` | Run plugin and skill tests on Windows (#37836) | `out-of-scope` | Codex plugin/skill Windows test matrix. |
| 188 | `3c60d4da648b` | Tighten the skills extension API surface (#37838) | `out-of-scope` | Codex skills extension API. |
| 189 | `8b1b06571910` | Speed up MCP OAuth credential reads (#37842) | `evaluate` | OAuth metadata/cache and caller-owned store exist, but no cross-process shared-read optimization benchmark exists. |
| 190 | `92cbfb4d2431` | Use the shared environment scrubber in git-utils (#37843) | `out-of-scope` | Codex git-utils internal scrubber refactor; Nanocodex has no corresponding git-utils boundary. |
| 191 | `4996cf05af6e` | Preserve environments when reloading V2 agents (#37847) | `out-of-scope` | Codex V2 app-server agent residency/reload. |
| 192 | `97729885d470` | Expose the session ID to shell commands (#37848) | `evaluate` | Nanocodex propagates `CODEX_THREAD_ID`/session binding, but distinct `CODEX_SESSION_ID` propagation and regression evidence are absent. |
| 193 | `78d3665d1569` | Expose plugin ownership in MCP server status (#37850) | `out-of-scope` | Plugin ownership in Codex app-server MCP status. |
| 194 | `d06dc7329072` | Route intercepted exec approvals through shared review (#37851) | `out-of-scope` | Guardian/intercepted approval review. |
| 195 | `afcc95b4310b` | Speed up MCP OAuth credential reads (#37860) | `evaluate` | OAuth contention/stale-snapshot behavior is relevant, but no cross-process nonblocking store evidence exists. |
| 196 | `ee7815dad232` | Rename environment config for turn scope (#37862) | `out-of-scope` | Codex internal turn-environment naming refactor. |
| 197 | `4b0e2a0bffcc` | Support MCP form input in full-access user threads (#37864) | `defer` | Standard MCP form elicitation is relevant, but Nanocodex has no elicitation/approval UI path; postpone it. |
| 198 | `dd22460869a9` | Add MCP OAuth credential contention regression tests (#37866) | `evaluate` | OAuth contention is relevant, but no equivalent concurrent external-store regression currently exists. |
| 199 | `a1c88e865dbf` | Reject duplicate resolved paths in apply_patch (#37867) | `port` | `validate_unique_targets` in `crates/nanocodex-tools/src/apply_patch/mod.rs` canonicalizes paths before mutation; `rejects_duplicate_normalized_sources_before_mutation` covers the failure. |
| 200 | `63002bdb26c9` | Extract persisted history types into a dedicated crate (#37871) | `out-of-scope` | Codex persisted-history crate/app-server architecture extraction. |

## Non-out-of-scope commits needing parent review

`101 270d93268ce9 evaluate`, `102 69b6152c1794 evaluate`,
`105 9457f8f73412 evaluate`, `106 d0c8f422eaaa evaluate`,
`109 4d7e3e90d978 evaluate`, `113 9daa491f7c27 port`,
`114 80858a8cce7f port`, `116 1efd8fcb2697 defer`,
`117 0bdce9f424eb defer`, `118 4ee41929eaf4 evaluate`,
`124 a7dcd20d3895 evaluate`, `135 248d8c0e2297 evaluate`,
`139 509565820f90 port`, `140 5a0d0929e20c evaluate`,
`144 2b1811e56201 evaluate`, `145 41014b11bd0c defer`,
`147 6db53df37f4 port`, `150 abc5d0b552a8 defer`,
`153 8073dbb20bbd defer`, `160 61a3dd4387da defer`,
`163 c4513cb982e9 evaluate`, `166 266c6920d9b8 port`,
`171 a16863f87048 evaluate`, `175 21aa552e8727 evaluate`,
`176 c9c6c0daa994 evaluate`, `180 beeba1d2fc49 port`,
`184 d10939327043 evaluate`, `189 8b1b06571910 evaluate`,
`192 97729885d470 evaluate`, `195 afcc95b4310b evaluate`,
`197 4b0e2a0bffcc defer`, `198 dd22460869a9 evaluate`,
`199 a1c88e865dbf port`.
