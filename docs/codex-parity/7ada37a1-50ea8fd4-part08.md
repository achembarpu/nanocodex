# Codex parity review: ordinals 701–802

Reviewed against `/Users/gakonst/github/openai/codex@50ea8fd411422b3f7bc906bcde6c1c4432019a2e`, using the exact ordered range `7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4..50ea8fd411422b3f7bc906bcde6c1c4432019a2e` (`git rev-list --reverse --topo-order`). This ledger contains one row for each assigned ordinal.

| Ordinal | SHA | Subject | Classification | Decision / evidence |
|---:|---|---|---|---|
| 701 | `37a9da9901c5` | Move the global scope check into the code-mode runtime (#39703) | evaluate | The embedded QuickJS regression rejects several known Node/host globals, but unlike Codex it does not enumerate `globalThis` and fail on every name outside an exhaustive allowlist. |
| 702 | `02de49f7183d` | Harden Seatbelt writable root path binding (#39706) | out-of-scope | Codex macOS Seatbelt/FileSystemSandboxPolicy; Nanocodex has no Seatbelt policy layer. |
| 703 | `3675fe014b21` | Remove redundant code mode image helper test (#39707) | out-of-scope | Upstream test deletion only; no Nanocodex runtime invariant. |
| 704 | `59f7da58d6ae` | Log TUI app event variants without their payloads (#39709) | out-of-scope | Codex TUI/session-log presentation, absent from the headless SDK. |
| 705 | `4a942885c8b4` | Reduce unified exec output buffer allocations (#39712) | evaluate | Borrowed chunk/storage reuse is relevant to `crates/nanocodex-tools/src/shell/mod.rs` `CapturedOutput`, but a matching benchmark/regression is not yet retained. |
| 706 | `2c74b56fcde8` | Pass CI workflow inputs through environment variables (#39717) | out-of-scope | GitHub Actions/MSVC workflow plumbing only. |
| 707 | `6d020311f0f8` | Stop persisting checkout credentials in V8 workflows (#39719) | out-of-scope | CI checkout credential handling only. |
| 708 | `1674b0a13098` | Expose managed policy for browser settings imports (#39720) | defer | Managed browser-import requirements are a future platform boundary; current browser cookie/profile import has no requirements projection. |
| 709 | `9894a14c81e5` | Track multi-agent v2 spawn calls in analytics (#39722) | evaluate | Nanocodex has `nanocodex-subagents` and tracing but no equivalent analytics event schema/sink. |
| 710 | `9bf673718a46` | Box the WebSocket dial future (#39726) | defer | Proxy dial allocation is not currently actionable in Nanocodex's concrete connector; existing reconnect coverage remains sufficient. |
| 711 | `bf2aee99c583` | Avoid rollout reads for configured TUI sessions (#39731) | out-of-scope | Codex TUI thread-routing startup optimization. |
| 712 | `8c828b18d631` | Remove private executor directory creation (#39736) | out-of-scope | Codex private-executor filesystem RPC, absent from attachment/workspace APIs. |
| 713 | `88da5520d41c` | Honor Guardian runtime settings from model defaults (#39738) | out-of-scope | Guardian-v2 model-default configuration is not Nanocodex-owned. |
| 714 | `4f38432d8709` | Use model-specific auto-review outcome instructions (#39741) | out-of-scope | Guardian approval/review behavior is outside the SDK boundary. |
| 715 | `c3db1804933d` | Skip postprocessing for short composer input (#39744) | evaluate | The CLI composer has analogous layout work, but no retained short-input performance regression. |
| 716 | `2e1f18e0dbb8` | Refresh resumed thread capability roots from executors (#39746) | defer | Remote-executor capability-root refresh is deferred with the broader attached-environment model. |
| 717 | `a26d50852ae6` | Require filesystem backends to implement directory walks (#39749) | port | `WorkspaceBackend` requires bounded recursive listing, implemented and tested in `js/bindings/runtime/workspace.d.mts`, `js/bindings/node/workspace.mjs`, and `services/managed/src/computer-workspace.ts`. |
| 718 | `85a1b0e33db9` | Expose uncompiled permission profile selection (#39752) | out-of-scope | Codex approval/exec-policy permission-profile catalog; Nanocodex context intentionally carries a fixed disabled profile. |
| 719 | `ce950dcf269a` | Add managed developer instructions to requirements (#39755) | evaluate | Managed instruction replacement/removal is relevant, but Nanocodex has no Codex requirements-layer projection; see `crates/nanocodex-agent/src/agent/builder.rs` and managed lifecycle tests. |
| 720 | `d0cc662b8c92` | Cache shell snapshots in the exec server (#39756) | out-of-scope | Exec-server shell snapshots are absent; Nanocodex uses explicit process environments and retained `ShellSessions`. |
| 721 | `8a40095ea31c` | Standardize shell execution on unified exec (#39757) | port | Nanocodex exposes one `exec_command`/`write_stdin` shell path; `shell_contract_matches_codex_unified_exec` and runtime execution tests cover it. |
| 722 | `097825f75a5f` | Add app-server MCP event streaming (#39761) | defer | Event-stream MCP is relevant to the planned event-driven track; current `crates/nanocodex-tools/src/mcp/client.rs` is request/response only. |
| 723 | `39073ca3a758` | Include suggestion IDs in plugin install metadata (#39765) | out-of-scope | Codex plugin-install/app-server metadata; plugins are not a Nanocodex surface. |
| 724 | `5bcd7b0fbcef` | Refresh bundled model definitions (#39770) | out-of-scope | Codex model catalog refresh conflicts with Nanocodex's single supported OpenAI model family. |
| 725 | `bce5f2fcfcc3` | Standardize shell execution on unified exec (#39772) | out-of-scope | Follow-up is Codex zsh-fork/sandbox/approval and feature-registry reorganization, not the Nanocodex shell contract. |
| 726 | `5cada2443458` | Verify Codex app signatures before launch or install (#39776) | out-of-scope | macOS desktop-app signing/launch surface is absent. |
| 727 | `5663754f62ad` | Retry transient registry failures during initial exec connection (#39777) | evaluate | Attachment recovery covers post-ready disconnects, but initial transient handshake retry lacks a Nanocodex regression; see `crates/nanocodex-tools/src/attachment/driver.rs`. |
| 728 | `854cbb2fd43f` | Make tool-result telemetry limits configurable (#39779) | out-of-scope | Codex content-preview telemetry configuration; Nanocodex tracing intentionally preserves full fidelity. |
| 729 | `763787d061de` | Support standalone named function call outputs (#39782) | defer | Standalone external tool outputs belong to the deferred event-driven history track; current Responses history requires paired call IDs. |
| 730 | `90c67e6f3374` | Classify rollout migration failures (#39784) | out-of-scope | Codex SQLite/legacy rollout migration; Nanocodex uses its own JSONL rollout store. |
| 731 | `0cc80b8db54b` | Support turn cost telemetry for custom model providers (#39785) | out-of-scope | Custom-provider portability is explicitly outside Nanocodex's OpenAI-only contract. |
| 732 | `9e680a52e700` | Support host-accepted exec-server WebSockets (#39786) | evaluate | Accepted/replacement sockets could affect attachment placement, but `AttachmentTarget` currently supports URL-based dialing only and has no regression for host-accepted sockets. |
| 733 | `43526b85613e` | Deduplicate zsh fork test setup (#39790) | out-of-scope | Codex-only test cleanup with no portable Nanocodex invariant. |
| 734 | `aead844f64e9` | Handle standalone tool outputs as external context (#39791) | defer | Depends on deferred standalone outputs and external-context history semantics. |
| 735 | `010738a25c9f` | Reject settings updates for parent-owned subagents (#39792) | evaluate | Descendant authorization exists in `crates/nanocodex-subagents/src/task_tree.rs`, but no settings-update API or regression test exists. |
| 736 | `bfb8986f7fe4` | Install build tools in full Rust CI (#39794) | out-of-scope | Upstream CI package installation only. |
| 737 | `d9fd91edab29` | Add hostname to the configurable TUI status line (#39795) | out-of-scope | Codex TUI status-line presentation. |
| 738 | `cc801d70480e` | Enrich thread archive analytics with thread context (#39797) | out-of-scope | Codex archive analytics reducer/events, not Nanocodex OTEL tracing. |
| 739 | `a3bce23f3b29` | Update rmcp to 3.1.3 (#39798) | evaluate | Nanocodex remains on `rmcp` 3.0.0 and does not regress this commit's authentication/retry classification through modern-to-legacy discovery fallback or preservation of pending OAuth state. |
| 740 | `53cec0464657` | Optimize case-insensitive thread history matching (#39802) | out-of-scope | Codex persisted thread-store search, absent from Nanocodex. |
| 741 | `f3cd2994287f` | Use multi-agent V1 for Amazon Bedrock models (#39804) | out-of-scope | Alternate Bedrock provider and generic multi-agent behavior are excluded. |
| 742 | `2790c1389982` | Finalize reserved PDF uploads with creation context (#39807) | out-of-scope | ChatGPT file/PDF upload API, absent from Nanocodex. |
| 743 | `3cde5d4ccdc8` | Preserve WINDIR in core Windows shell environments (#39809) | port | Windows process environment normalization is concrete in `crates/nanocodex-tools/src/shell/process.rs` with environment and shell execution tests. |
| 744 | `21facf227366` | Restrict macOS preference reads to full-disk policies (#39811) | out-of-scope | Codex Seatbelt/macOS sandbox policy files. |
| 745 | `969efa547085` | Avoid materializing writable-root carveouts for presence checks (#39812) | out-of-scope | Codex filesystem permission-policy projection. |
| 746 | `67b2c8c6fb8b` | Defer legacy filesystem policy projection (#39813) | out-of-scope | Codex legacy sandbox/session projection. |
| 747 | `54201093d4b2` | Preserve uncapped Guardian classifier instructions (#39822) | out-of-scope | Guardian classifier extension is not Nanocodex-owned. |
| 748 | `f20b63e85c45` | Use Responses compaction for Amazon Bedrock (#39825) | out-of-scope | Bedrock-specific provider compaction; Nanocodex supports OpenAI Responses only. |
| 749 | `daa48072f4f5` | Add history and notes tools for token-budget sessions (#39827) | defer | History/notes are a possible deeper capability, but no current token-budget backend or history-notes tool exists. |
| 750 | `d8ec270183ff` | Rename the history notes extension config option (#39830) | out-of-scope | Rename within the absent Codex history-notes extension/config. |
| 751 | `bd19459358f5` | Ignore project instructions for untrusted projects (#39837) | evaluate | Nanocodex loads project `AGENTS.md` via `crates/nanocodex-agent/src/agent/context_source/agents_md.rs`, but has no trusted/untrusted gating regression. |
| 752 | `27c05a52e0cd` | Include context window IDs in response metadata (#39847) | evaluate | Retained rollout windows exist, but provider `context_window_id` metadata is not yet exposed or regression-tested at the Responses boundary. |
| 753 | `2151d3a5b78c` | Reset registry retries when refreshing Noise bundles (#39852) | defer | No Nanocodex Noise executor protocol; revisit with the deferred executor boundary. |
| 754 | `9ab176f488f5` | Limit pending input preview wrapping work (#39864) | out-of-scope | Codex TUI pending-input rendering. |
| 755 | `44e95c857f37` | Allow session configuration with `codex agents` (#39870) | out-of-scope | Codex CLI/app-server agent-session configuration. |
| 756 | `2aaefa32b076` | Add keybindings for cycling TUI permission modes (#39873) | out-of-scope | Codex TUI permission-mode controls. |
| 757 | `536f86e5cc9e` | Support attaching to existing realtime calls (#39876) | port | `nanocodex-oai-api/src/realtime.rs` exposes `attach_realtime_call`; tests cover no reconfiguration, reconnect, transcript tail, and ended-call handling. |
| 758 | `ff0e95007cca` | Honor request PATH in exec-server shell snapshots (#39917) | evaluate | PATH handling is relevant to shell execution, but Nanocodex has no snapshot protocol or matching regression. |
| 759 | `93c54bca3899` | Resolve HTTP MCP bearer tokens in executor environments (#39926) | defer | Executor-only credential routing; revisit if the deferred executor environment boundary is adopted. |
| 760 | `9c3da20b3f6d` | Track remote MCP header environment variables (#39930) | defer | Remote executor MCP environment protocol remains deferred. |
| 761 | `7f9832d0d08c` | Enforce issuer binding for MCP OAuth endpoints (#39935) | port | `crates/nanocodex-tools/src/mcp/oauth.rs` validates issuer/endpoint origins and refresh-token issuer binding, with rejection and refresh tests. |
| 762 | `748d8ac83415` | Bound unified exec output delta frames (#39937) | out-of-scope | Codex bounds push-style `ExecCommandOutputDelta` frames while retaining the full transcript separately. Nanocodex exposes pull-based `write_stdin` and terminal tool results, not a shell-output delta event producer; its bounded result capture is a different contract. |
| 763 | `275ef855fac7` | Allow more time for local code-mode host startup (#39940) | evaluate | Code Mode startup exists, but upstream's remote-host timeout differs from the in-process Nanocodex lifecycle and lacks a matching regression. |
| 764 | `00a7b888b237` | Discover HTTP MCP servers from selected executors (#39941) | defer | No selected-executor MCP protocol exists in Nanocodex; revisit with deferred executor placement. |
| 765 | `054588acfe4a` | Honor required MCP servers from selected executors (#39952) | defer | Same absent selected-executor MCP model; intentionally deferred. |
| 766 | `d44696065723` | Support voice-aware configuration and version-skew builds (#39953) | out-of-scope | This changes a Codex-only unused TUI keymap schema field and its exec-server Debian voice version-skew build harness, neither of which Nanocodex owns. |
| 767 | `3882ced09c49` | Add in-memory shell snapshots to unified exec (#39957) | evaluate | Retained `ShellSessions` are concrete, but Nanocodex has no profile snapshot cache or regression for this state model. |
| 768 | `4e6ef3b41819` | Stop advertising shell snapshots from local exec servers (#39958) | out-of-scope | Exec-server capability advertisement only. |
| 769 | `8ce27647fb9f` | Test browser MCP bearer tokens over executor WebSockets (#39961) | out-of-scope | Executor WebSocket MCP credential test. |
| 770 | `e482cc66aeee` | Keep Guardian reviews isolated from executor MCP servers (#39962) | out-of-scope | Guardian/executor isolation policy. |
| 771 | `3432d3f2c9cb` | Upgrade pnpm to 10.34.5 (#39967) | out-of-scope | Dependency/tooling refresh only. |
| 772 | `16e2722c50b7` | Consolidate code mode output helper tests (#39969) | out-of-scope | Upstream test consolidation only. |
| 773 | `41ab01a2eaff` | Fix elevated Windows sandbox setup activation (#39971) | out-of-scope | Codex Windows sandbox activation. |
| 774 | `d12a7f3fd8a3` | Preserve root user authorization in subagent Guardian reviews (#39975) | out-of-scope | Guardian authorization for Codex subagents. |
| 775 | `696b4502dfaa` | Allow semaphore limit queries in the macOS sandbox (#39976) | out-of-scope | Codex macOS Seatbelt policy. |
| 776 | `8edb95f274ae` | Preserve MCP compatibility with older executors (#39979) | defer | No Nanocodex executor protocol; compatibility is deferred with executor placement. |
| 777 | `f580dd886fe5` | Enforce environment network policies for remote execution (#39980) | evaluate | Experimental egress has default-deny `EgressPolicy`, but remote-execution projection is not implemented or regression-tested. |
| 778 | `c517cc6d8436` | Bypass risk scoring for models that require automatic review (#39981) | out-of-scope | Guardian risk scoring/approval. |
| 779 | `51ebf5b1842d` | Truncate Guardian instructions after rendering the policy (#39985) | out-of-scope | Guardian policy rendering. |
| 780 | `f6519a355a30` | Preserve TUI event ordering during active-thread draining (#39991) | out-of-scope | Codex TUI event-loop ordering. |
| 781 | `45a3edc02a59` | Keep keymap action descriptions stable while navigating (#39992) | out-of-scope | Codex TUI keymap presentation. |
| 782 | `79b760680381` | Keep credentials out of app-server logs (#39993) | evaluate | `SecretRef` and egress audit paths redact credentials, but Nanocodex does not have an end-to-end persisted/feedback-log scan covering config, auth, attestation, and error paths; its tracing contract is intentionally full-fidelity. |
| 783 | `56012fafb86d` | Add Guardian internal session support (#39994) | out-of-scope | Guardian internal app-server sessions. |
| 784 | `950dd184a150` | Expand browser and computer use requirements (#39995) | defer | Browser/computer use is experimental and has no shared Nanocodex requirements/app-server layer yet. |
| 785 | `df6a54ee8511` | Add a response target picker to `/copy` (#39997) | out-of-scope | Codex TUI `/copy` interaction. |
| 786 | `9cdc66904fae` | Hide Fast mode status for unsupported models (#39999) | out-of-scope | Codex TUI model-status presentation. |
| 787 | `0f1a30b5c245` | Expose browser and computer-use requirements through app-server (#40000) | defer | No Nanocodex app-server counterpart; defer with the experimental browser configuration boundary. |
| 788 | `ad9e8097fd3d` | Preserve managed deny-read rules across permission updates (#40004) | out-of-scope | Managed approval/sandbox policy. |
| 789 | `dbe9dac1ae00` | Route escalated commands through synchronous Guardian review (#40005) | out-of-scope | Guardian approval path. |
| 790 | `51d8d12236f7` | Synchronize Git enrichment tests explicitly (#40006) | out-of-scope | Codex test synchronization and turn metadata internals. |
| 791 | `e77c2a90af99` | Implement Amazon Bedrock setup in the app server (#40007) | out-of-scope | Alternate-provider app-server setup. |
| 792 | `8b61c50ebe21` | Run allowlisted executor plugin stop hooks (#40009) | out-of-scope | Codex executor plugins/hooks. |
| 793 | `8b5beea5c044` | Synchronize concurrent Git enrichment test explicitly (#40011) | out-of-scope | Codex test synchronization only. |
| 794 | `ab8768306ffd` | Preserve executor context for MCP stop hooks (#40012) | out-of-scope | Executor hook context and stop-hook protocol. |
| 795 | `9949c9eafae0` | Reuse Guardian reviews in async risk scoring (#40013) | out-of-scope | Guardian review/risk-scoring state. |
| 796 | `e6a3877e9578` | Harden remote installed plugin cache reconciliation (#40015) | out-of-scope | Codex remote plugin catalog/cache. |
| 797 | `be6ebb1f6d4c` | Trace turn context creation and realtime state checks (#40017) | out-of-scope | This adds trace-only spans around two Codex-internal call sites (`turn_context.make` and the Realtime manager's running-state lock). Generic Nanocodex lifecycle tracing is not the same invariant. |
| 798 | `95118dff6532` | Add browser and computer use configuration (#40018) | defer | Browser/computer configuration remains experimental with no matching stable schema. |
| 799 | `677cfee0008f` | Add end-to-end tests for executor Stop hooks (#40020) | out-of-scope | Executor stop-hook test suite. |
| 800 | `6143217c6730` | Cancel Guardian reviews with their tool calls (#40021) | out-of-scope | Guardian cancellation/approval lifecycle. |
| 801 | `9445ef227e40` | Honor granular sandbox approvals in unified exec (#40024) | out-of-scope | Codex sandbox approval policy. |
| 802 | `50ea8fd41142` | Log Guardian V2 classification results (#40028) | out-of-scope | Guardian-v2 classification telemetry. |

## Classification totals

| Classification | Count |
|---|---:|
| `port` | 5 |
| `evaluate` | 16 |
| `defer` | 16 |
| `out-of-scope` | 65 |
| **Total** | **102** |

## Non-out-of-scope commits needing parent review

`37a9da9901c5`, `4a942885c8b4`, `1674b0a13098`, `9894a14c81e5`, `9bf673718a46`, `c3db1804933d`, `2e1f18e0dbb8`, `a26d50852ae6`, `ce950dcf269a`, `8a40095ea31c`, `097825f75a5f`, `5663754f62ad`, `763787d061de`, `9e680a52e700`, `aead844f64e9`, `010738a25c9f`, `a3bce23f3b29`, `3cde5d4ccdc8`, `daa48072f4f5`, `bd19459358f5`, `27c05a52e0cd`, `2151d3a5b78c`, `536f86e5cc9e`, `ff0e95007cca`, `93c54bca3899`, `9c3da20b3f6d`, `7f9832d0d08c`, `275ef855fac7`, `00a7b888b237`, `054588acfe4a`, `3882ced09c49`, `8edb95f274ae`, `f580dd886fe5`, `79b760680381`, `950dd184a150`, `0f1a30b5c245`, `95118dff6532`.
