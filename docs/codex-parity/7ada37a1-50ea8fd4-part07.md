# Codex parity review: ordinals 601–700

This appendix classifies ordinals 601–700 from the exact ordered range
`openai/codex@7ada37a15e1f6aa84f83b4b9410f9d29e66fefe4..50ea8fd411422b3f7bc906bcde6c1c4432019a2e`.
The rows use `git rev-list --reverse --topo-order` and cover every one of the
100 commits returned by `sed -n '601,700p'`.

## Ordered classifications

| Ordinal | SHA | Subject | Classification | Decision / evidence |
| ---: | --- | --- | --- | --- |
| 601 | `997a80020f5b` | Report diagnostic upload failures (#39287) | out-of-scope | App-server feedback/diagnostic upload surface; Nanocodex has no feedback service. |
| 602 | `ccf419158252` | Register the async message feature flag (#39288) | out-of-scope | Codex feature/config flag for its app-server message path; no corresponding Nanocodex policy. |
| 603 | `633bd4abf7b2` | Add Windows sandbox diagnostics to `codex doctor` (#39290) | out-of-scope | CLI doctor and Windows sandbox diagnostics are outside the SDK/managed-agent contract. |
| 604 | `17de14558b2b` | Remove app-server's direct reqwest dependency (#39293) | out-of-scope | App-server dependency and transport refactor; Nanocodex owns its Responses transport. |
| 605 | `701db965e583` | Increase SQLite log sink batching (#39294) | out-of-scope | Codex SQLite logging implementation; Nanocodex does not own that database sink. |
| 606 | `87070a77925c` | Enable MCP tool hooks in Codex sessions (#39296) | out-of-scope | Hook dispatch, managed policy, telemetry, and recursive-hook controls are Codex hook surfaces, deliberately absent from Nanocodex MCP. |
| 607 | `45528c51320e` | Allow overriding Codex package versions (#39298) | out-of-scope | Release/package assembly policy, not runtime SDK behavior. |
| 608 | `1a6e07a4febc` | Restrict agent roles to bounded configuration overrides (#39299) | out-of-scope | Generic Codex multi-agent role/configuration scheduler; Nanocodex's optional task tree has caller-defined tools and no role catalog. |
| 609 | `fe50b616899e` | Prevent Node REPL auth tokens from reaching child processes (#39301) | evaluate | Relevant subprocess secret boundary: `crates/nanocodex-tools/src/shell/process.rs` classifies `TOKEN` names, but explicit sensitive overrides are intentionally retained and no `NODE_REPL_AUTH_TOKEN` regression exists. |
| 610 | `b473c4e6abd3` | Record Guardian v2 classification token usage (#39303) | out-of-scope | Guardian-specific risk/usage accounting is not a Nanocodex lifecycle surface. |
| 611 | `e51a91b2f4a1` | Keep Guardian v2 risk scores in memory (#39304) | out-of-scope | Guardian extension state and app-server projections are outside product scope. |
| 612 | `6ec012668b0d` | Honor managed config during project discovery (#39306) | out-of-scope | Codex managed-config/project-discovery policy; Nanocodex receives caller-owned workspace context. |
| 613 | `c97bd2dcb52a` | Fail closed on Guardian V2 risk scoring errors (#39307) | out-of-scope | Guardian fail-closed policy is not implemented or owned by Nanocodex. |
| 614 | `280d56b1d823` | Attribute executor skill invocations to plugins (#39309) | out-of-scope | Skills/plugins and executor attribution are explicit Codex extension surfaces. |
| 615 | `7d9990fa30ab` | Bind unified exec approvals to shell executables (#39311) | out-of-scope | Approval/exec-policy subsystem is deliberately not part of Nanocodex. |
| 616 | `fb356f3d2c9f` | Add async delivery metadata to agent messages (#39312) | out-of-scope | App-server agent-message schema, persistence, and notification delivery; Nanocodex events/results have a separate typed contract. |
| 617 | `4d8c664a4976` | Run hooks with the captured session environment (#39314) | out-of-scope | Codex hook engine environment capture; Nanocodex has no model hook engine. |
| 618 | `8ae72a9314dd` | Evict guardian transcript entries in cacheable chunks (#39315) | out-of-scope | Guardian transcript cache implementation is outside Nanocodex. |
| 619 | `657bd889ae28` | Support Edu Plus and Edu Pro account plans (#39316) | out-of-scope | Provider account-plan entitlements and app-server account schemas are not SDK behavior. |
| 620 | `71dbf72b0576` | Add the async user message tool (#39319) | out-of-scope | Codex internal user-message tool and app-server delivery path; Nanocodex subagent messages are a separate extension. |
| 621 | `f1087ff151b0` | Expand OAuth metadata redirect test coverage (#39320) | out-of-scope | Test-only coverage for Codex RMCP discovery; no changed Nanocodex runtime invariant. |
| 622 | `b537d5a0970f` | Enforce workspace restrictions for header authentication (#39322) | out-of-scope | Codex login/header-auth and workspace policy, not Nanocodex provider authentication. |
| 623 | `67ed4e717acf` | Stop migrating Cursor sandbox settings (#39325) | out-of-scope | External-agent migration and sandbox compatibility cleanup. |
| 624 | `d35e5495f991` | Route hook MCP calls through current connections (#39331) | out-of-scope | Hook-only MCP execution and Codex connection-manager policy; Nanocodex MCP calls are caller/model tool calls. |
| 625 | `fde2156057c3` | Enforce environment MCP policies (#39335) | out-of-scope | Managed environment/MCP policy projection and Codex extension plumbing are outside the narrow MCP provider. |
| 626 | `8843960ba06b` | Scope TUI approval requests to their threads (#39372) | out-of-scope | TUI approval routing is not a Nanocodex surface. |
| 627 | `14a8ac89af0a` | Prefer the most recent session when queueing by name (#39385) | out-of-scope | Persisted Codex TUI session queue/name lookup. |
| 628 | `956f590ad549` | Remove npm package staging from repo checks (#39402) | out-of-scope | Repository CI/package-check maintenance. |
| 629 | `6cc2ba8a9567` | Support FD mounts with older system Bubblewrap versions (#39404) | out-of-scope | Linux Bubblewrap sandbox implementation; VM/egress isolation owns its own boundary. |
| 630 | `3929c99a97d1` | Refresh expired AWS credentials for Bedrock (#39410) | out-of-scope | Alternate Bedrock provider credentials; Nanocodex supports one OpenAI model family. |
| 631 | `f5a3dc55404d` | Remove the feature gate for async user messages (#39452) | out-of-scope | Codex app-server async-message feature toggle, not Nanocodex turn semantics. |
| 632 | `e741cd9ace02` | Consolidate Guardian extensions into `codex-guardian-v2` (#39474) | out-of-scope | Guardian extension packaging and policy. |
| 633 | `d1d51f6315f8` | Move shell snapshot tests into shell-command (#39480) | out-of-scope | Codex test organization with no portable Nanocodex runtime change. |
| 634 | `fcdf2b501412` | Make head-tail buffer capacity const generic (#39493) | out-of-scope | Codex unified-exec buffer refactor; Nanocodex's shell capture has a separate implementation and this is an internal cleanup. |
| 635 | `94a831d9dd33` | Test panoramic Guardian transcript image resizing (#39494) | out-of-scope | Guardian-only test coverage. |
| 636 | `af700180808c` | Use default timeouts in cyber exec policy tests (#39496) | out-of-scope | Test-only adjustment for Codex cyber exec policy. |
| 637 | `83915c7ca1c2` | Correct normalized dynamic tool coverage across response modes (#39497) | out-of-scope | Test-only Codex dynamic-tool/response-mode coverage; no Nanocodex behavior change. |
| 638 | `36268f177f55` | Use a narrow fixture for the unified image resize test (#39501) | out-of-scope | Test fixture maintenance. |
| 639 | `b0cdcce6169d` | Test text stringify errors in the code mode runtime (#39505) | out-of-scope | Codex test-only coverage; Nanocodex's embedded runtime has independent stringify tests. |
| 640 | `eb5a25aaa228` | Test code mode notifications without a sync tool call (#39506) | out-of-scope | Codex test-only notification coverage. |
| 641 | `6972c57c78ae` | Test disabled enhanced Node REPL transcript images separately (#39509) | out-of-scope | Node REPL/Guardian transcript test separation, not the supported Nanocodex Code Mode runtime. |
| 642 | `992f5c681f0d` | Track built-in control tool calls in analytics (#39510) | out-of-scope | Codex analytics and app-server control-tool attribution. |
| 643 | `db675cc005db` | Use stored item types when materializing turn summaries (#39514) | out-of-scope | Persisted Codex thread-summary materialization, not Nanocodex typed turn results. |
| 644 | `18937b226524` | Use `mem::take` to drain unified exec output buffers (#39515) | out-of-scope | Codex unified-exec allocation cleanup with no Nanocodex invariant. |
| 645 | `ffad92234000` | Isolate automatic plugin Git operations (#39520) | out-of-scope | Plugin marketplace Git operations. |
| 646 | `1b450c79126c` | Persist thread section moves before the first turn (#39523) | out-of-scope | Persisted app-server thread sections and SQLite migration. |
| 647 | `3b45c29062ff` | Stop treating Git commands as inherently safe (#39524) | out-of-scope | Codex approval policy and exec-policy classification, deliberately absent from Nanocodex. |
| 648 | `8e2265196ecc` | Add a just recipe for assembling Codex packages (#39584) | out-of-scope | Release packaging automation. |
| 649 | `6141747444de` | Test plugin sync isolation from repository Git config (#39585) | out-of-scope | Plugin test-only isolation. |
| 650 | `3bebaea8f209` | Isolate IPC in Bubblewrap sandboxes (#39586) | out-of-scope | Linux sandbox/IPC isolation implementation. |
| 651 | `4b450d2f1b21` | Preserve unparsed shell wrappers in exec policy (#39588) | out-of-scope | Exec-policy approval parsing, not Nanocodex shell execution. |
| 652 | `e7c0e8eb9f38` | Harden plugin manifest handling during installation (#39590) | out-of-scope | Plugin installation/manifest surface. |
| 653 | `493e0efb7b88` | Prevent SQLx warnings from feeding back into SQLite logs (#39592) | out-of-scope | Codex SQLite logging implementation. |
| 654 | `1bfabb21fe56` | Raise the MCP tool name limit to 128 bytes (#39594) | port | `crates/nanocodex-tools/src/mcp/catalog.rs` uses `MAX_MODEL_TOOL_NAME_BYTES: usize = 128`; `model_names_preserve_the_128_byte_boundary_and_hash_longer_names` covers the boundary and hashing. |
| 655 | `8f4a48a6adc6` | Keep marketplace upgrade state out of config (#39595) | out-of-scope | Marketplace/plugin configuration state. |
| 656 | `d75c85f65139` | Separate thread settings from environment configuration (#39597) | out-of-scope | Codex thread/app-server settings and environment projection. |
| 657 | `f6950546e5ea` | Protect macOS Seatbelt writable root anchors (#39599) | out-of-scope | Seatbelt sandbox policy. |
| 658 | `198f42067aff` | Keep async user messages on the direct tool surface (#39601) | out-of-scope | Codex internal async-message surface and tool exposure policy. |
| 659 | `8e7f64697456` | Use in-process parsing for PowerShell command classification (#39602) | out-of-scope | Codex shell safety/approval classification; Nanocodex does not implement approval policy. |
| 660 | `3434c2545b16` | Preserve queued TUI input semantics (#39604) | out-of-scope | Codex TUI composer queue behavior. |
| 661 | `430bc36fb235` | Hide approved automatic review warnings in the TUI (#39605) | out-of-scope | TUI review-warning presentation. |
| 662 | `6869d17cc24f` | Enable user namespaces in shared CI setup (#39606) | out-of-scope | CI environment setup. |
| 663 | `186b449bc218` | Resolve model-provided shells by type (#39607) | out-of-scope | Codex model-provided shell selection and environment policy. |
| 664 | `5c305eb50b3e` | Harden skill installation against unsafe symlinks (#39608) | out-of-scope | Skills installer security, not Nanocodex tool registration. |
| 665 | `c19482a7687a` | Limit Bazel integration test threads on macOS (#39609) | out-of-scope | Test/build configuration. |
| 666 | `929e2b9c1d8a` | Harden MCP OAuth fallback credential writes (#39611) | out-of-scope | Codex fallback credential file/keychain implementation; Nanocodex OAuth credentials are supplied through `McpOAuthStore`, with no equivalent fallback file. |
| 667 | `530c1aed58b8` | Prevent `apply_patch` from widening write permissions (#39614) | out-of-scope | Depends on Codex filesystem sandbox/permission profiles, which Nanocodex deliberately does not own. |
| 668 | `250b5ea2bff8` | Bind MCP OAuth refresh tokens to their issuer (#39615) | port | `crates/nanocodex-tools/src/mcp/oauth.rs` stores/validates `issuer`; `refresh_tokens_require_the_pinned_authorization_issuer` and `refresh_preserves_omitted_refresh_token_and_scopes` cover issuer pinning and refresh persistence. |
| 669 | `bc3545b805de` | Validate linked worktrees before inheriting project trust (#39616) | out-of-scope | Codex project-trust/approval policy. |
| 670 | `4bb7804a23be` | Apply composer editing preferences to TUI text prompts (#39618) | out-of-scope | TUI composer preferences. |
| 671 | `da6e68951b98` | Preserve inline TUI scrollback in Windows Terminal (#39619) | out-of-scope | Windows Terminal/TUI scrollback rendering. |
| 672 | `f1e06b386510` | Stream executor capability and skill file reads (#39620) | out-of-scope | Codex remote executor and skills metadata. |
| 673 | `52e387dacaf5` | Prevent protected-path rename bypasses in macOS Seatbelt (#39623) | out-of-scope | Seatbelt protected-path policy. |
| 674 | `e396ef3fc1bc` | Add cwd-relative turn diff paths (#39625) | out-of-scope | Codex `TurnDiff` app event and feature flag; Nanocodex has no equivalent turn-diff event contract. |
| 675 | `9ca99b517130` | Preserve parent repository discovery through sandbox metadata mounts (#39629) | out-of-scope | Codex repository discovery and sandbox metadata mounts. |
| 676 | `942af8447b1d` | Retire the untrusted approval policy (#39630) | out-of-scope | Approval-policy removal in Codex configuration. |
| 677 | `910ecccf30ba` | Skip sandboxed shell commands in Guardian v2 by default (#39631) | out-of-scope | Guardian plus sandbox policy. |
| 678 | `7ea7b2936964` | Expose permission profile resolution in the core API (#39632) | out-of-scope | Codex permission-profile/approval API, not Nanocodex's caller-owned tool policy. |
| 679 | `7edd0a4c9dc6` | Show strict review warnings in the TUI (#39635) | out-of-scope | TUI review presentation. |
| 680 | `fdc23b93b895` | Treat `invalid_grant` refresh failures as permanent (#39637) | out-of-scope | Codex login refresh state; Nanocodex MCP OAuth has its own typed provider boundary. |
| 681 | `d944ce83a230` | Prompt to unarchive sessions before resuming or forking (#39640) | out-of-scope | Persisted Codex session archive and TUI resume/fork UX. |
| 682 | `663da53823df` | Sanitize developer context in full-history agent forks (#39641) | out-of-scope | Codex generic multi-agent mode instructions and app-server fork history; Nanocodex forks retain its own typed context snapshots. |
| 683 | `af0e82c562a0` | Enforce managed residency for model providers (#39645) | out-of-scope | Codex managed provider residency/account configuration. |
| 684 | `8aaf839774b9` | Exercise restricted-token sandboxing in cyber policy tests (#39646) | out-of-scope | Sandbox/cyber policy test coverage. |
| 685 | `ab82cddd049a` | Resolve bundled Windows helpers through bin junctions (#39649) | out-of-scope | Codex Windows packaging/helper materialization. |
| 686 | `7ece061767a8` | Enforce filesystem permissions when loading AGENTS.md (#39653) | out-of-scope | Requires Codex permission-profile sandboxing; Nanocodex's context source has caller-owned filesystem access and no equivalent profile. |
| 687 | `1802a65571e0` | Make core integration test permissions explicit (#39655) | out-of-scope | Test-only Codex permission setup. |
| 688 | `4a432d180dcd` | Advertise the Desktop app in graphical Linux sessions (#39656) | out-of-scope | CLI desktop-app discovery/marketing. |
| 689 | `5e3a6fe4eee7` | Warn when launching the deprecated MCP server (#39657) | out-of-scope | Deprecated Codex MCP server CLI warning. |
| 690 | `4e1a772a7dab` | Let Guardian V2 satisfy required model reviews (#39658) | out-of-scope | Guardian/review entitlement policy. |
| 691 | `e3e5ad28470f` | Harden unsandboxed patch filesystem access (#39659) | evaluate | Relevant `apply_patch` race/symlink boundary, but `crates/nanocodex-tools/src/apply_patch/mod.rs` still uses `std::fs::write`, `create_dir_all`, and `remove_file` without no-follow options; current tests cover basic/lexical aliasing, not symlink swaps. |
| 692 | `631d5a8b02d4` | Expand Vim change commands and add character replacement (#39661) | out-of-scope | Codex TUI Vim editing. |
| 693 | `240bbfc14ac4` | Add max and ultra reasoning efforts to the SDKs (#39662) | out-of-scope | Changes Codex Python/TypeScript app-server SDK artifacts; Nanocodex's Rust `Thinking` contract already has its own supported values and is not those bindings. |
| 694 | `97c82c0900d2` | Restrict plugin migration to home scope (#39663) | out-of-scope | External-agent/plugin migration policy. |
| 695 | `fec2dccfcfe1` | Add macOS Seatbelt filesystem integration tests (#39665) | out-of-scope | Sandbox integration tests. |
| 696 | `2584e88cadc1` | Improve no-follow filesystem behavior across platforms (#39666) | out-of-scope | Codex exec-server filesystem protocol; Nanocodex has no equivalent remote exec-server API. |
| 697 | `312b62ac9533` | Trace MCP runtime refresh coordination (#39667) | evaluate | Relevant MCP observability, but current `McpHandle::reload` tracing (`crates/nanocodex-tools/src/mcp/mod.rs`) has no semaphore/wait span or regression asserting refresh-coordination traces. |
| 698 | `478dbe9df0a3` | Make Guardian v2 parent compaction reuse configurable (#39691) | out-of-scope | Guardian compaction configuration. |
| 699 | `f277e313f1ce` | Fail closed on unsafe config and sed parsing (#39700) | out-of-scope | Mixes Codex app-server config fallback with approval-oriented shell safety parsing; neither surface is owned by Nanocodex. |
| 700 | `585b97d394aa` | Wait for turn completion events in multi-agent resume tests (#39702) | out-of-scope | Codex app-server multi-agent resume test synchronization. |

## Classification totals

| Classification | Count |
| --- | ---: |
| `port` | 2 |
| `evaluate` | 3 |
| `defer` | 0 |
| `out-of-scope` | 95 |
| Total | 100 |

## Parent-review queue

Non-out-of-scope commits needing parent review are:

- `fe50b616899e` (609) — evaluate explicit `NODE_REPL_AUTH_TOKEN` scrubbing in configured child environments.
- `e3e5ad28470f` (691) — evaluate no-follow/symlink-safe `apply_patch` writes and path swaps.
- `312b62ac9533` (697) — evaluate MCP refresh coordination tracing and a focused span regression.

The two `port` rows are backed by the concrete Nanocodex code/tests cited in
their table entries; no commit in this slice is intentionally deferred.
