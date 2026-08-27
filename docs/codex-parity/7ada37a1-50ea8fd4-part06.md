# Codex parity review: ordinals 501–600

This appendix classifies the 100 commits at ordinals 501–600 in the exact
ordered range `7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4..50ea8fd411422b3f7bc906bcde6c1c4432019a2e`.
The upstream changes were inspected at their actual diffs. A port requires
matching Nanocodex code and regression evidence; evaluate means the surface is
relevant but the implementation or evidence is incomplete; defer means the
surface is intentionally outside the current product phase; out-of-scope means
the Codex-only boundary does not belong to Nanocodex.

| Ordinal | SHA | Subject | Classification | Decision / evidence |
|---:|---|---|---|---|
| 501 | eeb82a156d1b | Dispatch queued messages written by other processes (#39034) | evaluate | Durable cross-process queue watcher in `codex-rs/ext/queue`; Nanocodex has bounded in-process queues in `crates/nanocodex-subagents/src/harness.rs` but no equivalent durable external-message contract. |
| 502 | 71e5e1ec5077 | Add app-server coverage for Guardian V2 approval routing (#39035) | out-of-scope | App-server Guardian approval test only. |
| 503 | 1d928cad2f4e | Allow config reads to join active app-server read batches (#39036) | out-of-scope | App-server config-read batching/protocol surface. |
| 504 | 9dd3d6a13ef1 | Restore Guardian risk scores across thread lifecycles (#39038) | out-of-scope | Guardian state coupled to Codex persisted threads. |
| 505 | d0fd4e830a2f | Preserve foreign paths in managed network approvals (#39040) | out-of-scope | Managed approval and sandbox policy flow, not Nanocodex's fixed execution policy. |
| 506 | 0f21cb3413ea | Enforce managed authentication backend settings (#39043) | out-of-scope | Managed config/auth-backend requirements and app-server schema. |
| 507 | 06418909a035 | Add managed gates for in-app chat and dictation (#39045) | out-of-scope | Codex feature/config gates for desktop chat and dictation. |
| 508 | ff770113ca37 | Restrict MCP HTTP redirects to the configured origin (#39046) | evaluate | Native MCP transport is owned (`crates/nanocodex-tools/src/mcp/client.rs`); current `same_origin_redirect_policy` and OAuth redirect regression exist in `crates/nanocodex-tools/src/mcp/mod.rs` and `oauth.rs`, but the upstream diff adds HTTPS/credential and streamed-hop coverage not yet evidenced. |
| 509 | 0c901fd14187 | Skip plugin hook loading when hooks are disabled (#39047) | out-of-scope | Codex plugin hook loader. |
| 510 | 1a8bac9405a2 | Avoid rendering sub-agent activity twice in the TUI (#39049) | out-of-scope | TUI rendering-only fix. |
| 511 | d7d526b81db9 | Prepare the telemetry shutdown worker during initialization (#39050) | evaluate | Nanocodex has OTLP shutdown and idempotence tests in `crates/nanocodex-observability/src/lib.rs`, but its worker is not pre-started with the upstream failure-safe handoff semantics. |
| 512 | fe5889928c24 | Use installed callable apps for TUI mentions (#39051) | out-of-scope | TUI app/connector mention behavior. |
| 513 | 4a7b51c560aa | Add network policy metadata to environment configuration (#39055) | out-of-scope | Codex generic environment/network-policy configuration; Nanocodex does not expose that executor policy owner. |
| 514 | afb1b3c98435 | Verify the pinned zsh manifest in release builds (#39056) | out-of-scope | Release-build verification script/workflow. |
| 515 | 796325f1e584 | Rate-limit TUI frames from their actual emission time (#39057) | out-of-scope | TUI frame scheduler. |
| 516 | 14973840e0d4 | Tag Codex Apps protocol discovery metrics (#39058) | out-of-scope | Codex Apps protocol metric tagging. |
| 517 | 80e925c28b7f | Add desktop app diagnostics to `codex doctor` (#39060) | out-of-scope | Desktop-only doctor diagnostics. |
| 518 | 386a7b629c4f | Avoid rerendering streamed code fences (#39061) | out-of-scope | TUI streamed rendering optimization. |
| 519 | b6e153c98537 | Render only visible rows in the transcript pager (#39063) | out-of-scope | TUI pager virtualization. |
| 520 | 1aa3a68e7b86 | Restrict queued-message editing to its dedicated binding (#39064) | out-of-scope | TUI composer binding. |
| 521 | d327527a3db3 | Limit terminal hyperlink layout to the visible viewport (#39065) | out-of-scope | TUI terminal layout. |
| 522 | 51a9edc0837a | Add desktop security enforcement diagnostics (#39067) | out-of-scope | Desktop doctor/security diagnostics. |
| 523 | d24507a59b27 | Remove skill model delegation support (#39068) | out-of-scope | Codex skills/model-delegation policy. |
| 524 | 682f57254f8c | Persist generated images through turn executors (#39072) | evaluate | Nanocodex persists configured image results with regression `generation_uses_codex_images_request_and_persists_result` in `crates/nanocodex-tools/src/image_generation/tests.rs`; executor-provided fallback path, size bound, symlink, and hardlink checks from the upstream diff are absent. |
| 525 | 45cf6cbc1946 | Propagate caller metadata to rendezvous connections (#39073) | out-of-scope | Codex exec-server rendezvous transport. |
| 526 | d65d31593926 | Add desktop update diagnostics to `codex doctor` (#39074) | out-of-scope | Desktop update/doctor diagnostics. |
| 527 | 37efa18be293 | Avoid redundant terminal row clears (#39075) | out-of-scope | TUI terminal redraw optimization. |
| 528 | e92627bf7e5f | Build filesystem JSON params only for remote TUI sessions (#39077) | out-of-scope | Remote TUI filesystem request shaping. |
| 529 | 911335eed37a | Preserve tracing context for environment resolution (#39078) | out-of-scope | Generic Codex environment resolution. |
| 530 | 8ef139667f31 | Apply user MCP policy to selected executor plugins (#39079) | out-of-scope | Plugin-selected executor MCP policy. |
| 531 | 9c099e94a2ce | Bound TUI thread replay buffers by delta size (#39081) | out-of-scope | TUI replay/event buffering. |
| 532 | 34e4823a1d9d | Prompt for project trust in remote TUI workspaces (#39082) | out-of-scope | Remote TUI onboarding/trust prompt. |
| 533 | a4f37a5b7f47 | Harden Windows sandbox provisioning against reparse points (#39083) | out-of-scope | Codex Windows sandbox implementation. |
| 534 | 2013e04354b6 | Preserve filesystem permission path conventions (#39084) | out-of-scope | Codex app-server/filesystem permission protocol and platform sandbox paths. |
| 535 | fc6268ad383f | Read plugin authentication state from AuthManager (#39087) | out-of-scope | Plugin marketplace/auth integration. |
| 536 | 0c14c7347100 | Harden TUI subagent navigation (#39088) | out-of-scope | TUI subagent navigation. |
| 537 | 31f23b6022ea | Clarify the external contribution policy (#39089) | out-of-scope | Repository contribution documentation. |
| 538 | 83d015375e57 | Add a command to queue messages for existing sessions (#39092) | out-of-scope | Codex CLI/session queue command. |
| 539 | 4617d4d21d27 | Add an agents overview dashboard to the TUI (#39094) | out-of-scope | TUI agents dashboard. |
| 540 | fd34ad7297d8 | Trace exec-server requests from receipt through completion (#39098) | out-of-scope | Codex exec-server telemetry. |
| 541 | 050aa077b58d | Avoid redundant terminal size queries during history insertion (#39100) | out-of-scope | TUI terminal/history insertion optimization. |
| 542 | 7500ab4c8d0e | Update rmcp to 3.1.2 (#39101) | evaluate | Nanocodex owns native RMCP MCP transport but intentionally pins `rmcp = 3.0.0` in `Cargo.toml`; upgrade compatibility and regressions are unverified. |
| 543 | 2eee483e49f8 | Raise the GPT-5.6 maximum context window (#39102) | out-of-scope | Provider/model configuration limit. |
| 544 | 632420e67af6 | Drop capabilities from Linux sandbox processes (#39103) | defer | Linux sandbox capability isolation belongs to the deferred executor/VM isolation boundary; Nanocodex's current shell policy is explicit full access. |
| 545 | 319b2f72b1d4 | Make the agents overview an interactive task dashboard (#39112) | out-of-scope | TUI agents dashboard interaction. |
| 546 | 13dfaab4469e | Surface interactive requests in realtime conversations (#39113) | out-of-scope | Codex app-server realtime interaction notifications. |
| 547 | fd5018e0445b | Add a dedicated `codex agents` dashboard command (#39114) | out-of-scope | Codex CLI dashboard command. |
| 548 | ca08a58ab477 | Remove the experimental thread config endpoint (#39115) | out-of-scope | App-server endpoint removal. |
| 549 | ede5247893a5 | Reject lossy legacy permission projections (#39117) | out-of-scope | App-server approval/permission compatibility projection. |
| 550 | f97e77569352 | Fail closed on deeply nested command wrappers (#39122) | out-of-scope | Codex shell-command dangerous-command approval classifier; Nanocodex deliberately has no approval-policy owner. |
| 551 | 5ee6baee2fcc | Validate identifiers in plugin creator workflows (#39131) | out-of-scope | Plugin creator workflow validation. |
| 552 | 9a254ba1fa03 | Redact auth tokens from app-server response logs (#39141) | out-of-scope | App-server response logging. |
| 553 | f47f77ada669 | Add configurable shortcuts for the agents dashboard (#39142) | out-of-scope | TUI keybindings. |
| 554 | de7bbb04811a | Hydrate recommended plugin metadata on selection (#39143) | out-of-scope | Plugin marketplace metadata. |
| 555 | 230791fd1f25 | Persist active permission profiles in turn context (#39145) | out-of-scope | Codex approval/permission profile persistence. |
| 556 | bc7a4870398a | Centralize persisted resume settings lookup (#39147) | out-of-scope | Persisted Codex thread resume settings. |
| 557 | 6f95f1910398 | Update PyPI publish action to v1.14.2 (#39152) | out-of-scope | Release workflow only. |
| 558 | 539a09cb28ca | Restore permission profiles when resuming threads (#39153) | out-of-scope | Persisted thread permission restoration. |
| 559 | 3d47dc40be53 | Box the TUI future to bound CLI stack usage (#39154) | out-of-scope | CLI/TUI stack-layout implementation. |
| 560 | f6ba9110fa5a | Prepare Python SDK 0.147.0 stable release (#39155) | out-of-scope | Python SDK release metadata/workflow. |
| 561 | f5e9d66851a2 | Notify clients when Guardian requires strict review (#39157) | out-of-scope | Guardian approval notification protocol. |
| 562 | 4216123b3df5 | Require approval for commands with dynamic shell words (#39159) | out-of-scope | Codex command approval classifier. |
| 563 | e2eea071405a | Refresh collaboration instructions when their content changes (#39163) | out-of-scope | Codex collaboration-mode prompt refresh. |
| 564 | 0acf302db5ff | Prevent marketplace identity spoofing (#39165) | out-of-scope | Plugin marketplace identity policy. |
| 565 | 63b268c81b28 | Skip empty user messages for automatic idle turns (#39174) | evaluate | Upstream changes automatic idle input admission in `codex-rs/core/src/session/turn_input.rs`; Nanocodex has empty-message filtering in `crates/nanocodex-agent/src/model/context.rs` but no automatic-idle submission path or focused parity test. |
| 566 | 711a5f8b3a6e | Drop descendant progress updates after remote compaction (#39176) | out-of-scope | Remote persisted-thread compaction event handling. |
| 567 | 880f1135ea59 | Scope MCP app resource reads to their originating call (#39187) | evaluate | Upstream adds bounded MCP app resource provenance; Nanocodex MCP supports tools/resources in fixtures but has no `resources/read` client API or origin-binding implementation. |
| 568 | a397079287e6 | Preserve MCP resource origins across compaction (#39192) | evaluate | Upstream checkpoints resource origins through rollout compaction; Nanocodex typed history/compaction has no MCP resource-origin checkpoint or regression. |
| 569 | b5ea64a203ce | Add a symlink-safe reader for sensitive files (#39200) | out-of-scope | Codex exec-server sensitive-file reader. |
| 570 | a04940cb12cc | Reject symbolic links in memory workspaces (#39205) | defer | Local memory workspace hardening is relevant to the deeper memory track, but Nanocodex currently uses the managed memory API rather than Codex's local memories workspace. |
| 571 | bb701f1e8c8d | Add a fail-closed Tree-sitter PowerShell lowerer (#39213) | out-of-scope | Codex shell safety/approval parser, outside Nanocodex's fixed full-access command policy. |
| 572 | e13c1d569d95 | Prevent custom providers from inheriting ambient auth (#39214) | out-of-scope | Custom model-provider authentication policy. |
| 573 | 76ceaddb2944 | Reconnect Guardian sampling WebSockets after auth changes (#39220) | out-of-scope | Guardian classifier transport. |
| 574 | 2a30972fcb64 | Skip redirected external-agent migration destinations (#39221) | out-of-scope | Codex external-agent migration. |
| 575 | e7e13c68e224 | Add Guardian v2 approval review metrics (#39224) | out-of-scope | Guardian approval telemetry. |
| 576 | 9b9b614b02ba | Include node_repl screenshots in Guardian v2 reviews (#39227) | out-of-scope | Guardian/node-repl review evidence. |
| 577 | 3df5087f754a | Decouple Noise relay streams from JSON-RPC processing (#39235) | out-of-scope | Codex Noise/exec-server relay architecture. |
| 578 | a998c7a1ce88 | Deduplicate remote plugin bundle syncs with shared semaphores (#39240) | out-of-scope | Remote plugin synchronization. |
| 579 | e683c3118b25 | Record Guardian v2 classification metrics (#39241) | out-of-scope | Guardian classifier metrics. |
| 580 | 19d185fec8e1 | Add safe permission profile intersection (#39242) | out-of-scope | Codex filesystem/network approval profile algebra; Nanocodex exposes no such profile owner. |
| 581 | a1dc95d5afcb | Scope MCP resource reads by connector (#39244) | evaluate | Connector-scoped MCP resources are relevant to the managed catalog boundary, but Nanocodex has no resource-read/connector projection implementation or regression. |
| 582 | 8193c56a595f | Give Guardian classifier connections distinct thread identities (#39246) | out-of-scope | Guardian classifier identity isolation. |
| 583 | 77e688960196 | Add exec-server forwarding mode (#39249) | out-of-scope | Codex exec-server forwarding/Noise transport, distinct from Nanocodex's attachment protocol. |
| 584 | fa9a05f2d25f | Deduplicate rollout moves when archiving threads (#39256) | out-of-scope | Codex persisted rollout archive implementation. |
| 585 | ecb8013dfa82 | Reconnect WebRTC Realtime sideband transports (#39257) | port | `crates/nanocodex-oai-api/src/realtime.rs` retains socket-independent transcript and pending-command state across Frameless sideband replacement, uses Codex's capped/resetting backoff, and treats 404/410 as terminal. Focused reconnect, replay, bounded-transcript, backoff, and terminal-status regressions cover the invariant. |
| 586 | 3006151ad413 | Simplify unified exec output snapshots (#39259) | out-of-scope | Internal Codex unified-exec snapshot cleanup; Nanocodex already owns a separate bounded shell capture implementation. |
| 587 | 785ecd7452f8 | Stop TUI chats on misalignment policy violations (#39261) | out-of-scope | TUI misalignment-policy handling. |
| 588 | 726ec7ecbf2f | Prevent ConPTY DLL loading from the current directory (#39262) | out-of-scope | Windows ConPTY/TUI process loading. |
| 589 | 846a16852f6b | Improve Guardian v2 risk classification (#39264) | out-of-scope | Guardian risk classifier. |
| 590 | d68b85a0978e | Require fresh approval beneath denied permission paths (#39266) | out-of-scope | Approval and sandbox permission enforcement. |
| 591 | 4a3e829c5641 | Inject Node REPL policy into Guardian review sessions (#39267) | out-of-scope | Guardian review prompt policy. |
| 592 | f950a1ba0b12 | Preserve thread names during rollout migration (#39273) | out-of-scope | Persisted Codex rollout migration. |
| 593 | 22b860e80b06 | Add provider-owned authentication recovery (#39274) | out-of-scope | Provider-owned authentication recovery/configuration. |
| 594 | 884a193b78fd | Declare experimental Amazon Bedrock setup APIs (#39277) | out-of-scope | Provider-specific app-server setup API. |
| 595 | 392328ed5d20 | Preserve owner-provided environment configuration (#39278) | out-of-scope | Generic Codex remote-environment ownership/configuration. |
| 596 | 88c39c457891 | Propagate Windows sandbox ACL update failures (#39279) | out-of-scope | Windows sandbox ACL implementation. |
| 597 | 681c82f4979a | Move shell snapshot scripts into `codex-shell-command` (#39281) | out-of-scope | Repository-local Codex shell snapshot refactor. |
| 598 | 2fe4e06cc23b | Document secure devcontainer DNS exfiltration risk (#39283) | out-of-scope | Devcontainer documentation only. |
| 599 | ba37d0c45b46 | Report network disconnects during approval (#39284) | out-of-scope | Managed network approval lifecycle. |
| 600 | e7f9fa9cd9ce | Show file destinations in TUI change approvals (#39285) | out-of-scope | TUI change-approval presentation. |

## Classification totals

| Classification | Count |
|---|---:|
| `port` | 1 |
| `evaluate` | 9 |
| `defer` | 2 |
| `out-of-scope` | 88 |
| Total | 100 |

## Non-out-of-scope commits needing parent review

`eeb82a156d1b`, `ff770113ca37`, `d7d526b81db9`, `682f57254f8c`,
`7500ab4c8d0e`, `632420e67af6`, `63b268c81b28`, `880f1135ea59`,
`a397079287e6`, `a04940cb12cc`, `a1dc95d5afcb`, `ecb8013dfa82`.
