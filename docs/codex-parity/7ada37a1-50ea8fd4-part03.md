# Codex parity review: ordinals 201–300

This appendix classifies ordinals 201–300 in the ordered range
`7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4..50ea8fd411422b3f7bc906bcde6c1c4432019a2e`.
The upstream changes were inspected at the exact local Codex checkout
`/Users/gakonst/github/openai/codex`.

| Ordinal | SHA | Escaped subject | Classification | Decision / evidence |
| ---: | --- | --- | --- | --- |
| 201 | `46f5d6eba91e` | Keep runtime summary metrics out of Statsig exports (#37874) | out-of-scope | Statsig/OTel export policy is Codex telemetry-provider plumbing, not the SDK's tracing contract. |
| 202 | `a603d7ca5c0f` | Honor the configured Windows sandbox level for managed networking (#37875) | defer | Relevant executor sandbox hardening is intentionally owned by experimental `nanocodex-vm`/egress; no supported Windows VM regression is present. |
| 203 | `a9dee37f9c62` | Add configurable goal token budget limits (#37878) | out-of-scope | Codex goal extension and app-server/config budget surface; goals are not Nanocodex's core lifecycle contract. |
| 204 | `9558d830f632` | Read safety buffering from response metadata (#37882) | out-of-scope | Provider-specific SSE safety-buffering treatment; Nanocodex's supported Responses WebSocket boundary has no such UI/policy surface. |
| 205 | `cc2f26203301` | Extend bundled package discovery and expose its version (#37886) | out-of-scope | Installer/package discovery and release metadata, not a runtime behavior owned by the SDK. |
| 206 | `9742cc8ed5de` | Ignore Unix socket proxy settings on Windows (#37889) | out-of-scope | Codex network-proxy platform configuration; no equivalent Nanocodex proxy setting exists in the stable crates. |
| 207 | `7f928f6ddc43` | Use thread configuration for \`app/read\` (#37891) | out-of-scope | Experimental app-server `app/read` request/schema behavior. |
| 208 | `7a18a5c5285a` | Validate images before returning \`view_image\` output (#37892) | evaluate | Relevant local-image safety behavior, but current `ViewImageHandler` delegates validation to shared preparation and lacks a focused invalid-\`view_image\` regression; inspect before adoption. |
| 209 | `9e301c8c9a38` | Add configurable Responses API request metadata (#37895) | out-of-scope | Product-configured Codex metadata and app-server precedence are provider/config policy outside caller-defined Nanocodex metadata. |
| 210 | `92912d6d84e5` | Add hermetic Windows SDK and MSVC runtime repositories (#37896) | out-of-scope | Bazel/toolchain build infrastructure. |
| 211 | `1549756b7866` | Add appearance metadata to thread sections (#37898) | out-of-scope | Persisted app-server thread-section presentation metadata. |
| 212 | `ab3b4d26d473` | Make submission operations move-only (#37901) | out-of-scope | Codex `Submission`/`Op` and thread-manager test capture; Nanocodex exposes its own queued `PromptRequest`/`Turn` types. |
| 213 | `260261ed8f5c` | Defer \`view_image\` processing to history insertion (#37902) | port | Shared `nanocodex_tools::image::prepare_output_images` owns decode/resize after tool execution, with `failed_images_become_bounded_placeholders` in `crates/nanocodex-tools/src/image/mod.rs`. |
| 214 | `9be95745fb84` | Make gRPC code-mode notifications fire-and-forget (#37906) | out-of-scope | Remote gRPC Code Mode host notification protocol; Nanocodex deliberately owns embedded QuickJS. |
| 215 | `070a26a1f008` | Apply refreshed cloud config bundles to later sessions (#37908) | out-of-scope | Codex cloud-config/session configuration refresh. |
| 216 | `f8821d85eb68` | Extract reusable code-mode host test support (#37922) | out-of-scope | Test-support extraction only, for Codex's remote/in-process host implementations. |
| 217 | `722784e9366a` | Distinguish turn-start thread persistence (#37926) | out-of-scope | App-server paginated-thread persistence timing and store contract; Nanocodex durability has a separate journal protocol. |
| 218 | `2cc9dbb9846b` | Add shared runtime build information (#37929) | out-of-scope | Build/release information crate and Bazel wiring. |
| 219 | `41ece455b7fa` | Validate images before returning \`view_image\` output (#37939) | evaluate | Final Codex behavior rejects invalid \`view_image\` data before output; Nanocodex's shared preparation currently emits a bounded placeholder, so parity needs an explicit policy/test decision. |
| 220 | `0ca439900eb6` | Cache tool catalogs for streamable HTTP MCP servers (#37970) | evaluate | MCP catalog caching is relevant; `nanocodex-tools/src/mcp/catalog.rs` retains an in-memory catalog but `client.rs` still re-lists on reconnect and has no HTTP catalog cache regression. |
| 221 | `7d486ffa9493` | Honor per-directory bundled skill settings in \`skills/list\` (#37979) | out-of-scope | Codex bundled/plugin skills and app-server catalog surface; skills are not Nanocodex's supported tool contract. |
| 222 | `3d4d253f8f4a` | Stop re-exporting skill APIs from \`codex-core\` (#37984) | out-of-scope | Codex crate API cleanup for skills. |
| 223 | `279b93242cfe` | Remove config lockfile support (#38011) | out-of-scope | Codex config-lock and feature/config migration behavior. |
| 224 | `4c5fc230a9f3` | Retry transient exec-server startup failures (#38020) | out-of-scope | Codex exec-server process startup/recovery; Nanocodex's built-in shell runtime has no exec-server dependency. |
| 225 | `edcec133726d` | Expose image generation usage-limit failures (#38024) | out-of-scope | Provider image-generation quota/error notification and app-server schema. |
| 226 | `1dac3d9ca04a` | Fail closed on unsafe Linux unreadable globs (#38026) | defer | Relevant sandbox fail-closed invariant, intentionally deferred to the experimental VM sandbox boundary; no Nanocodex Linux glob-policy API exists. |
| 227 | `8f4a2c99dd56` | Hide approved Guardian assessments from TUI history (#38032) | out-of-scope | Guardian approval state and persisted TUI history presentation. |
| 228 | `4496ba3fd564` | Use session metadata to validate thread history paths (#38033) | out-of-scope | Codex rollout/session path validation for persisted threads. |
| 229 | `ed390a5dc4b5` | Filter live rollout items in place (#38034) | out-of-scope | Codex rollout reconstruction and persisted live-item filtering. |
| 230 | `e20616d2650d` | Propagate MCP elicitation event delivery failures (#38035) | out-of-scope | MCP elicitation/app-server approval event handling; Nanocodex MCP exposes tool calls without this approval surface. |
| 231 | `dad1db87bb5a` | Limit TUI streaming traces in SQLite logs (#38036) | out-of-scope | Codex SQLite rollout/TUI diagnostics. |
| 232 | `b2543af02b2d` | Propagate custom CA settings to local MCP servers (#38040) | evaluate | MCP TLS configuration is relevant, but `nanocodex-tools` has no custom-CA setting or focused local-server CA regression; current OAuth/client trust is fixed by transport setup. |
| 233 | `1e557a554e8f` | Add gRPC-backed code-mode sessions (#38041) | out-of-scope | Remote gRPC Code Mode host architecture, explicitly outside Nanocodex's embedded QuickJS boundary. |
| 234 | `34db7e55638a` | Sandbox remote apply_patch operations (#38043) | defer | Relevant remote filesystem isolation, intentionally owned by experimental VM/host isolation; stable tools currently do not expose Codex executor sandboxes. |
| 235 | `be751dd1dfc5` | Compact code mode tool calls in TUI history (#38044) | out-of-scope | Codex-specific TUI history cell compaction and display policy. |
| 236 | `99915080b6ce` | Store model history in response item envelopes (#38045) | out-of-scope | Codex persisted response-item envelope/rollout schema. |
| 237 | `f2a6f2585c32` | Include auto-review state in turn metadata (#38046) | out-of-scope | Auto-review/Guardian app-server metadata. |
| 238 | `d6ca19d99b81` | Add turn-aware response item injection (#38047) | out-of-scope | Codex session injection and app-server turn metadata, not the caller-owned typed history API. |
| 239 | `eea28321ad67` | Harden network proxy credential brokerage (#38049) | evaluate | Security-relevant to `nanocodex-egress` secret routing, but Codex's provider host bindings/live broker reconfiguration are not covered by current egress regressions. |
| 240 | `965b9f263a63` | Run required CI against pull request merge commits (#38051) | out-of-scope | Repository CI policy only. |
| 241 | `6dc3ac872136` | Add per-login MCP OAuth client registration selection (#38052) | evaluate | MCP OAuth registration strategy is relevant; current `OAuthLoginFlow` in `crates/nanocodex-tools/src/mcp/oauth.rs` has no per-login registration selector or decision test. |
| 242 | `b28aa476f4cf` | Add configuration-backed external authentication (#38054) | out-of-scope | Codex external/provider authentication configuration. |
| 243 | `285abc036895` | Configure PSP routing through the feature system (#38056) | out-of-scope | Codex provider payment routing and feature flags; Nanocodex payment policy is caller/egress-owned. |
| 244 | `44d992c14e0b` | Track artifact operations from trusted plugin markers (#38057) | out-of-scope | Trusted plugin artifact attribution/analytics. |
| 245 | `3a6f747d77d7` | Preserve harness metadata across conversation history (#38058) | out-of-scope | Codex harness metadata in persisted conversation history. |
| 246 | `46c326854212` | Disable storage for Azure Responses requests (#38060) | out-of-scope | Provider-specific Azure Responses request policy. |
| 247 | `853d98b6b078` | Preserve proxy settings for Windows sandbox debug sessions (#38061) | defer | Windows sandbox proxy behavior belongs to the experimental VM/egress boundary and has no supported Nanocodex Windows debug path. |
| 248 | `104e25ac5aec` | Grant Windows sandbox access to the Codex app root (#38064) | defer | Windows VM sandbox filesystem policy is intentionally deferred pending a supported VM consumer/regression. |
| 249 | `c8f673fddcce` | Track resource-backed skill invocations (#38066) | out-of-scope | Codex skills/plugin invocation analytics. |
| 250 | `b43de77679fa` | Scope environment readiness config to thread attachments (#38067) | out-of-scope | Codex executor environment/app-server attachment configuration. |
| 251 | `ba2fb483197a` | Forward gRPC code-mode callbacks to session delegates (#38072) | out-of-scope | Remote gRPC Code Mode callback plumbing. |
| 252 | `a817d9424d8a` | Track implicit executor skill invocations (#38074) | out-of-scope | Codex executor skills attribution. |
| 253 | `33aaf91366b5` | Respect rendered width when adding TUI history (#38075) | evaluate | Nanocodex owns a Ratatui transcript, but no focused width-at-insertion regression establishes whether this Codex TUI layout fix applies to its renderer. |
| 254 | `f317dc8a17d3` | Reduce cloning in world-state patch handling (#38078) | out-of-scope | Codex world-state visualization/patch implementation absent from Nanocodex. |
| 255 | `7c47952f7c2c` | Allow nested Git repositories in the Windows sandbox (#38080) | defer | Windows sandbox filesystem semantics are deferred with the experimental VM boundary. |
| 256 | `67afc7967463` | Use \`ReviewDecision\` for MCP tool approvals (#38081) | out-of-scope | Approval/Guardian policy is explicitly not part of Nanocodex's caller-defined tool lifecycle. |
| 257 | `d7f4324492a8` | Remove standard form input from app-server docs (#38083) | out-of-scope | Documentation-only app-server request surface. |
| 258 | `52d92184240b` | Allow empty input to start a turn (#38084) | defer | Relevant admission policy, but Nanocodex's public `AgentHandle::prompt` and `TurnControl` intentionally reject empty instructions (`crates/nanocodex-agent/src/agent/handle.rs`); changing that contract needs product direction. |
| 259 | `f4936d7aba72` | Support execution-host context when resolving cloud config (#38086) | out-of-scope | Codex cloud-config/environment selection. |
| 260 | `85f331772f54` | Route gRPC code-mode sessions through the shared HTTP client (#38087) | out-of-scope | Remote Code Mode plus Codex shared HTTP client architecture. |
| 261 | `4c89139da96f` | Add CIMD support to MCP OAuth registration (#38089) | evaluate | Relevant extension of the MCP OAuth registration decision in 242; current OAuth code supports dynamic credentials but has no CIMD/DCR selection or conformance regression. |
| 262 | `da2803c73cd3` | Simplify queued user message admission (#38092) | port | Nanocodex admits with `AgentHandle::prompt` and returns an independently awaitable `Turn`; queue ordering/cancellation are covered by `crates/nanocodex-agent/tests/it/model/control/cancellation.rs` and lifecycle shutdown tests. |
| 263 | `ca4d532b2a58` | Test Guardian context for code mode commands (#38094) | out-of-scope | Guardian approval context test only. |
| 264 | `c909d1bc0462` | Attach hosted app context to file uploads (#38101) | out-of-scope | Codex hosted-app/provider file-upload metadata. |
| 265 | `eb9dceba1a2e` | Avoid cloning MCP invocations in TUI history (#38103) | evaluate | Nanocodex has MCP transcript entries, but no allocation profile for its TUI history path proving this ownership optimization. |
| 266 | `2230d6446448` | Route MCP tool calls through shared approval handling (#38108) | out-of-scope | Shared approval action/Guardian routing is deliberately absent from Nanocodex. |
| 267 | `4ef836f883c3` | Distinguish rollout IDs from thread IDs (#38127) | out-of-scope | Codex rollout/app-server identifier schema and persisted indexes. |
| 268 | `3fe19fcd8155` | Resolve subagent analytics connections lazily (#38165) | out-of-scope | Codex analytics connection lifecycle. |
| 269 | `69ae78291dcc` | Read executor skill packages directly (#38167) | out-of-scope | Codex executor skill package implementation. |
| 270 | `16fbfe557446` | Notify running turn watchers only on count changes (#38170) | out-of-scope | Codex app-server thread-status watcher notifications. |
| 271 | `8270a7c74d73` | Update \`lru\` and \`webbrowser\` dependencies (#38172) | out-of-scope | Dependency maintenance only. |
| 272 | `0e82c62a449c` | Embed defaults in the packaged config layer (#38179) | out-of-scope | Codex packaged config layering. |
| 273 | `93beee910d39` | Add conservative restriction helpers for tool policies (#38183) | out-of-scope | Codex approval/tool-policy configuration; Nanocodex tool admission is caller-defined and has no approval policy. |
| 274 | `c4b287cf5791` | Run search tool integration tests on Windows (#38184) | out-of-scope | Test-platform-only change. |
| 275 | `e1b7b1acb3cc` | Stop overriding environments in the skills user-turn test (#38186) | out-of-scope | Test-only Codex skills environment setup. |
| 276 | `96c8be200cf1` | Integrate workload identity with Codex authentication (#38188) | out-of-scope | Codex provider/workload authentication. |
| 277 | `eb752e43d9b7` | Run plugin app-server tests in automatic environments (#38189) | out-of-scope | Test-only plugin/app-server environment change. |
| 278 | `9dd22890f5ff` | Add an LRU baseline to skill shadow selection (#38197) | out-of-scope | Codex skills shadow-selection experiment. |
| 279 | `3d7f9b463795` | Fuse recent and lexical skills in shadow selection (#38204) | out-of-scope | Codex skills ranking/experiment. |
| 280 | `95aada11c415` | Enforce non-interactive approval policy for Codex delegates (#38205) | out-of-scope | Generic delegated Codex approval policy and scheduler. |
| 281 | `91d6f48992ad` | Avoid allocations when sanitizing TUI user text (#38214) | evaluate | Nanocodex has terminal sanitization (`bin/nanocodex/src/tui/resume_picker.rs`) but lacks a comparable user-text allocation benchmark for this TUI path. |
| 282 | `7093e8c48071` | Start required cached MCP servers lazily for subagents (#38217) | evaluate | MCP startup/readiness is relevant to optional subagents; current catalog deferral tests do not prove required-server lazy startup for child agents. |
| 283 | `1ad439782105` | Add a flag to retain client developer messages (#38227) | out-of-scope | Codex app-server/config rollout retention flag. |
| 284 | `9df9ff6ad9ec` | Detect implicit skill invocations from PowerShell reads (#38228) | out-of-scope | Codex skills invocation detection. |
| 285 | `1f4ea798538d` | Track root turns across delegated Codex requests (#38232) | out-of-scope | Codex generic delegation metadata and scheduler; Nanocodex's optional task-tree extension does not import this app-server turn metadata. |
| 286 | `dc8562d67244` | Add manifest-defined metrics for trusted plugin scripts (#38238) | out-of-scope | Trusted plugin metrics/attribution. |
| 287 | `d6eefb26a6d3` | Add bounded plugin measurement analytics (#38239) | out-of-scope | Plugin analytics only. |
| 288 | `74004b5397b2` | Include Node REPL policy in turn metadata (#38241) | out-of-scope | Codex Node REPL and provider turn metadata. |
| 289 | `3d7bb2dd2e83` | Cache stable active-cell layout measurements (#38242) | evaluate | Nanocodex TUI has cached transcript rendering, but no active-cell layout measurement regression or benchmark matching this Codex change. |
| 290 | `0e0ef5d8183c` | Track client-authored developer messages in rollout history (#38243) | out-of-scope | Persisted Codex rollout/history item provenance. |
| 291 | `8d4d57387a90` | Resolve paginated thread history by rollout ID (#38244) | out-of-scope | Codex paginated app-server thread-history lookup. |
| 292 | `379cb6844405` | Add dynamic HTTP header helpers for MCP servers (#38245) | evaluate | Relevant local MCP credential/header feature; current config supports fixed/value/env headers in `crates/nanocodex-tools/src/mcp/config.rs`, not helper execution, origin fencing, or its required regressions. |
| 293 | `8bb8d602345c` | Read model ETags from WebSocket metadata events (#38251) | out-of-scope | Codex model-catalog ETag/provider discovery event; Nanocodex exposes no model-list cache contract. |
| 294 | `9ca0337dbf9b` | Collect metrics from plugin shell commands (#38252) | out-of-scope | Plugin shell analytics. |
| 295 | `6e7daed1e948` | Collect plugin metrics from unified exec commands (#38253) | out-of-scope | Plugin/unified-exec analytics. |
| 296 | `020f6c963e18` | Report the latest rejection from multiple network reviews (#38256) | out-of-scope | Network approval/review aggregation. |
| 297 | `bde723ae7ded` | Reconnect gRPC code-mode sessions after host restarts (#38257) | out-of-scope | Remote gRPC Code Mode reconnection/generation protocol, outside embedded QuickJS. |
| 298 | `18dcc7646f6a` | Unify external authentication provider handling (#38258) | out-of-scope | Codex external provider authentication. |
| 299 | `130c7c93a992` | Resolve skill package aliases in \`skills.read\` (#38261) | out-of-scope | Codex skills package aliasing and app-server skills API. |
| 300 | `631bbb33cc0b` | Use bounded fallback ports for Windows managed proxies (#38265) | out-of-scope | Codex Windows managed-proxy port allocation and network deployment policy; no equivalent Nanocodex surface. |

## Classification totals

| Classification | Count |
| --- | ---: |
| `port` | 2 |
| `evaluate` | 13 |
| `defer` | 7 |
| `out-of-scope` | 78 |
| Total | 100 |

## Non-out-of-scope commits needing parent review

`a603d7ca5c0f` (defer), `7a18a5c5285a` (evaluate), `260261ed8f5c` (port), `41ece455b7fa` (evaluate),
`0ca439900eb6` (evaluate), `1dac3d9ca04a` (defer), `b2543af02b2d` (evaluate),
`34db7e55638a` (defer),
`eea28321ad67` (evaluate), `6dc3ac872136` (evaluate),
`853d98b6b078` (defer), `104e25ac5aec` (defer), `33aaf91366b5` (evaluate),
`7c47952f7c2c` (defer), `52d92184240b` (defer), `4c89139da96f` (evaluate),
`da2803c73cd3` (port), `eb9dceba1a2e` (evaluate), `91d6f48992ad` (evaluate),
`7093e8c48071` (evaluate), `3d7bb2dd2e83` (evaluate),
`379cb6844405` (evaluate).

## Checks

- `git rev-list --count 7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4..50ea8fd411422b3f7bc906bcde6c1c4432019a2e` reports the 802-commit global range.
- `git rev-list --reverse --topo-order ... | sed -n '201,300p'` supplied exactly 100 rows; the table ordinals are contiguous 201–300.
- Every table SHA is the 12-character prefix of the corresponding upstream commit and every assigned ordinal appears once.
- The count table sums to 100 (2 port + 13 evaluate + 7 defer + 78 out-of-scope).
