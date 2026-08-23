# Nanocodex plan

## Objective

Build high-quality reusable Rust building blocks for frontier OpenAI agents.
Nanocodex makes a small number of deliberate choices about models, transport,
ownership, tools, performance, and observability. The embeddable APIs are the
product; the CLI, Ratatui application, hosted WASM deployments, managed-agent
service, and evaluation harnesses are concrete consumers that prove those APIs.

The active product mode is fully embedded: the website and managed-agent
platform are the primary end-to-end proving ground for browser-local agents,
account-owned durable agents, identity, retained conversations, tools, and the
public JavaScript bindings. They consume the same owned SDK lifecycle rather
than introducing a parallel app-server agent contract.

Every stable crate must remain useful independently, documented from its own
README, tested through its public paths, benchmarked at the boundaries it can
affect, and observable without adopting the Nanocodex CLI. Experimental crates
may move faster, but they must preserve the same ownership discipline and may
not leak application policy into the stable graph.

## Current baseline

The PR #50 refactor and the `0.3.0` release are complete. The repository has
since moved beyond that delivery boundary:

- the stable crates own the OpenAI, tool, agent, observability, and facade
  boundaries described in the workspace instructions;
- retained VM-backed workspace tools, composable egress, and host-side secret
  routing are available as experimental application infrastructure;
- deterministic browser automation, a dedicated headed browser VM, and the
  normal CLI browser provider are implemented;
- reusable GPT Realtime voice sessions and the Ratatui voice consumer are
  implemented with current Codex transport behavior;
- native, Python, Node, browser WASM, Cloudflare Durable Object, and Rivet Actor
  consumers exercise the same owned session API; and
- nightly and stable release automation, differential workloads, retained
  traces, and performance gates exist and must continue to protect the public
  contracts.

Do not reopen completed refactor work unless a regression, current consumer, or
measured boundary demonstrates a concrete problem.

## Delivery model

There is no longer one repository-wide pull request boundary. Work advances as
small, independently mergeable vertical slices. Each slice must have a real
consumer, preserve unrelated behavior, and leave `master` releasable.

For each slice:

1. establish the public or application-owned contract and its owner;
2. implement the complete lifecycle, including cancellation and cleanup;
3. add focused deterministic regressions and representative measurements;
4. validate affected native, WASM, language-binding, example, and crate-boundary
   consumers; and
5. merge only with required checks green and no known migration ambiguity.

Codex remains behavioral evidence rather than an API specification. Before a
new parity claim, reconcile the authoritative checkpoint in the workspace
instructions with the classifications already recorded in
[`docs/CODEX_PARITY.md`](docs/CODEX_PARITY.md), update the local Codex checkout,
and classify every intervening commit as port/evaluate/defer/out-of-scope. Do
not let an unreviewed upstream change silently redefine Nanocodex behavior.

## Immediate working slice: embedded web and authenticated managed agents

The managed-agent product is the active vertical slice. The evaluation
controller continues as an isolated side track and must not shape this
service's tenancy, authentication, credential, or JavaScript APIs.

Outcome: a passkey-authenticated Nanocodex user can connect a personal ChatGPT
subscription or OpenAI API key, issue a Nanocodex API key, create a durable
agent through the same HTTP contract from the website, curl, or JavaScript,
disconnect the client, and resume the accepted turn and ordered event stream.
Provider credentials remain exclusively inside the private egress broker.

- [ ] Promote the managed-agent and egress Workers from examples into
  first-party `services/` applications without moving hosted-product policy
  into the stable Rust crates.
- [ ] Use the direct Accounts WebAuthn adapter for the passkey ceremony and
  Provider-level SIWE server authentication for the sole Nanocodex account
  session. Keep multi-passkey enrollment and recovery out of this slice.
- [ ] Persist one account record per verified Tempo address and let only a
  logged-in browser session issue, list, and revoke that account's Nanocodex
  API keys. Store no recoverable API-key value.
- [ ] Associate ChatGPT and OpenAI credentials with the authenticated account,
  encrypt them at rest, and resolve them only inside the private egress
  service. Agent and room actors retain only an opaque broker subject.
- [ ] Authorize every managed-agent mutation and replay read by account cookie
  or account-issued Nanocodex API key. Preserve durable acceptance,
  idempotency, cursor replay, cancellation, and deletion.
- [ ] Expose the hosted contract through curl and a typed JavaScript client
  without treating the remote control plane as a model transport.
- [ ] Make the Agent and Multiplayer website surfaces use the same account and
  credential path. Any room member may invoke the host-owned shared agent.
- [ ] Browser-test passkey registration/login, ChatGPT connection, API-key
  issuance/revocation, durable reconnect, and a two-browser Multiplayer room
  locally and on the deployed Cloudflare stack.

Exit gate: no deployment-global provider credential or admin bearer remains in
the product path; the browser, agent Durable Object, room guests, and managed
JavaScript client never receive a provider credential; accepted inference
survives client death; focused service/binding tests and browser flows pass;
and the old example-owned deployment path is deleted.

## Parallel side track: durable evaluation throughput

Outcome: drive a closed, pre-materialized benchmark continuously at maximum
productive host occupancy with only three actors:

```text
Controller   observes the host and chooses desired occupancy
Coordinator  atomically hands out tasks and records outcomes in SQLite
Worker       runs exactly one `nanocodex eval run`, reports, and exits
```

The controller is neural and disposable. It owns no worker process and keeps
no durable state. SQLite is the sole task authority; systemd is the sole
process authority. The one-task command delegates benchmark execution to an
adapter selected by the binary. Harbor owns its task containers, verification,
and retained eval record; Nanocodex supplies the Rust agent process. There is
no PID-marker store, worker pool, queue, lease, heartbeat, release manager,
reconciliation database, wave scheduler, binary search, or generic durability
framework.

- [x] Store every task/treatment/repetition as one immutable SQLite row with
  exactly `unclaimed`, `running`, `success`, or `failed` state.
- [x] Claim one row atomically. A verifier result becomes `success` or `failed`;
  infrastructure failure or worker death returns the row to `unclaimed`.
- [x] Recover SQLite running claims across coordinator restart and make worker
  exit reporting idempotent.
- [ ] Define the one-task runner contract in `nanocodex-eval`, implement it in
  `nanocodex-eval-adapters`, and have the binary wire the selected adapter into
  `nanocodex eval run`. Do not retain a second Harbor-like VM/verifier runtime
  in the durable worker path.
- [ ] Expose the names attached to running SQLite rows, delete the compiled
  supervisor and PID markers, and have the neural controller reconcile those
  names directly against live systemd units.
- [ ] On every control cycle, observe SQLite, live and starting units, recent
  completions, memory, swap, load, and pressure; reason about an absolute
  desired occupancy; and launch the missing workers as one immediate batch.
- [ ] With backlog and no measured overload or throughput stall, increase
  occupancy aggressively. OOMs and retries are acceptable calibration signals;
  chronic unused capacity or repeated unadapted thrashing is failure.
- [ ] Never stop or shed a live worker. Controller death leaves workers alone;
  controller restart reconstructs the entire situation from SQLite and
  systemd before another admission.
- [ ] Exercise the actual CLI processes end to end: one successful worker, one
  verifier-failed worker, worker death, coordinator death, and controller death.
  Do not add scheduler-policy or prompt-wording unit tests.
- [ ] Deploy the reduced implementation to `dev-georgios`, run the retained
  benchmark without changing tasks or verifiers, and record the worker-count
  ramp, task counts, throughput, memory, swap, load, pressure, OOMs, retries,
  and worker/VM/proxy correspondence through terminal completion.

Exit gate: the implementation is net-negative and reviewable versus `master`;
rustfmt and warnings-denied Clippy are clean; real CLI-process checks preserve
every task across worker, coordinator, and controller death; SQLite integrity
is clean; the neural controller maintains occupancy without a wave tail; and
the terminal host has zero running/unclaimed rows, worker units, VMMs, proxies,
or controller-owned recovery residue.

## Active milestones

### 1. Runtime and Code Mode parity

- Land the focused Code Mode contract alignment from
  [PR #95](https://github.com/gakonst/nanocodex/pull/95) independently of the
  evaluation stack it came from.
- Preserve one model-facing Code Mode tool, deferred runtime discovery, exact
  tool ordering, caller-owned exposure policy, and the current provider-native
  Responses namespace boundary.
- Refresh the Codex parity ledger through a deliberately selected current
  checkpoint. Port only relevant invariants with direct regression evidence;
  keep app-server, approval, provider-portability, and unrelated TUI behavior
  classified out of scope.

### 2. Browser identity, placement, and visibility

- Finish the private-browser desktop profile import in
  [PR #93](https://github.com/gakonst/nanocodex/pull/93). Cookie extraction must
  remain harness-owned, allowlisted, typed, non-mutating, and absent from the
  model-callable schema.
- Replace the single CLI browser boolean with deliberate caller-owned session
  policy while preserving a migration path for bare `--browser`:
  - `private-host`: a Nanocodex-owned host browser;
  - `private-vm`: the existing isolated browser VM; and
  - `user-chrome`: an explicitly enabled bridge to the user's running Chrome.
- Keep presentation independent from placement. `background` and `visible` are
  presentation choices; Chromium running under Xvfb is headed but is not
  visible until a bounded display or screenshot-stream consumer exists.
- Keep tab acquisition explicit and fail closed:
  - private modes create owned tabs;
  - user-Chrome mode creates a tab in a named Nanocodex group by default;
  - taking over an existing tab requires an explicit user selection or exact
    tab mention matched against freshly listed ID, title, URL, browser instance,
    recency, and group metadata; and
  - claimed user tabs remain in their existing group and are released rather
    than closed at cleanup.
- Implement user-Chrome control through a Nanocodex Chrome extension and a
  versioned native-messaging host. Do not attach ordinary remote CDP to a
  personal default profile and do not depend on the proprietary ChatGPT Chrome
  extension or its protocol.
- Lease every controlled tab to one browser session, surface user/debugger
  interruption as cancellation, clean up agent-created tabs deterministically,
  and keep open-tab inventory out of model context unless the caller explicitly
  provides the selected tab.
- Decide whether `private-vm` means the dedicated browser VM or a browser
  co-located with the retained workspace VM before promising guest-localhost
  testing. If the processes remain in different VMs, expose an explicit,
  bounded forwarding path rather than relying on host-network accidents.
- Preserve `BrowserTool` as an ordinary caller-owned provider. Any extension
  backend must either support the declared action contract or expose an honest
  capability-specific contract; unsupported actions must not be discovered as
  usable.

### 3. Application-owned terminals and managed sessions

- Rebase and finish the narrow application-owned terminal contract in
  [PR #79](https://github.com/gakonst/nanocodex/pull/79). Retained process state,
  cancellation, output bounds, and descendant cleanup remain owned by the
  tool runtime rather than the agent driver.
- Review and land [PR #89](https://github.com/gakonst/nanocodex/pull/89) only as
  a concrete experimental managed-session consumer: durable actors may own
  Nanocodex sessions, idempotency, event replay, policy, disposable VMs, and
  service projection, but the stable agent crates must not become an app server
  or generic scheduler.
- Keep payment, tenant, authentication, deployment, and secret-routing policy
  in the consuming application. Lower `nanocodex-*` libraries own typed seams,
  not one hosted product's policy.

### 4. Evaluation as product evidence

- Finish the immediate durable-evaluation-throughput slice above before adding
  another evaluation abstraction or benchmark family.
- Rebase and complete the VM-backed differential evaluation foundation in
  [PR #61](https://github.com/gakonst/nanocodex/pull/61) after its extracted
  Code Mode slice lands.
- Keep [PR #72](https://github.com/gakonst/nanocodex/pull/72) stacked until the
  base evaluation contract is merged, then validate StableBench with exact
  retained artifacts, canonical verifier output, scorer provenance, model
  usage, and cost.
- Keep deterministic task correctness authoritative. Optional model scoring may
  add evidence but must not overwrite verifier rewards or turn scorer failure
  into a false correctness failure.
- Re-evaluate the older recursive task-tooling experiment in
  [PR #32](https://github.com/gakonst/nanocodex/pull/32) only after current
  differential evidence identifies a concrete need. Do not merge a generic
  recursive scheduler because the branch exists.
- Never modify benchmark tasks, verifiers, images, or expected outputs to make
  Nanocodex pass. Inspect exact JSONL, trajectories, retained files, verifier
  logs, and cold-versus-warm timing before making an evaluation claim.

### 5. Next release gate

- Select the next version only after the included milestones and migrations are
  known; do not infer a version number from unreleased workspace metadata.
- Update root and per-crate changelogs, public READMEs, migration notes, and
  release examples from the actual merged graph.
- Run crate-boundary checks, rustfmt, warnings-denied Clippy, workspace and
  all-target tests, rustdoc/doctests/examples, WASM, Node/browser, PyO3,
  CLI/Ratatui, static VM guest, live native smoke, focused browser/VM trials,
  and the relevant differential suites.
- Publish only from a clean, reviewed commit with required checks green; retain
  exact release and evaluation artifacts.

## Current execution order

1. [x] Merge PR #50, ship `0.3.0`, and establish the layered stable SDK.
2. [x] Land retained VM tools, browser/VM automation, Realtime voice, reusable
   hosted transports, composable egress, Cloudflare, and Rivet consumers.
3. [ ] Finish the authenticated managed-agent slice and its deployed browser
   exit gate.
4. [ ] Continue durable-evaluation throughput as an isolated side track without
   changing managed-product boundaries.
5. [ ] Finish and merge the focused Code Mode parity slice in PR #95.
6. [ ] Reconcile and advance the Codex parity checkpoint with a complete commit
   classification and direct evidence for every adopted behavior.
7. [ ] Fix, validate, and merge desktop profile import in PR #93.
8. [ ] Build browser placement and presentation policy for private host and
   private VM sessions, then prove both through the CLI consumer.
9. [ ] Prototype the user-Chrome extension/native-host path; prove exact tab
   claiming, grouping, visible cursor feedback, interruption, leasing, and
   cleanup before exposing it as normal CLI policy.
10. [ ] Rebase and decide PR #79, then review PR #89 against the stable-core and
   application-policy boundaries above.
11. [ ] Rebase and merge PR #61, then complete the stacked StableBench work in
   PR #72 and record retained differential evidence.
12. [ ] Decide whether PR #32 still solves a demonstrated problem or should be
    replaced by a smaller application-owned experiment.
13. [ ] Cut the next release only after all selected milestones pass the full
    release gate.

## Current non-goals

- No provider abstraction, broad model portability layer, generic agent app
  server, compatibility framework, approval subsystem, or stable multi-agent
  scheduler in the core SDK.
- No caller-visible socket tasks, mutable run state, replay bookkeeping,
  browser tab leases, VM internals, or transport response identifiers.
- No model-selected browser placement, ambient takeover of arbitrary personal
  tabs, default-profile remote-debugging escape hatch, or silent fallback from
  an isolated browser to the user's authenticated browser.
- No browser audio-device ownership or generic realtime protocol in the core
  library.
- No provider/payment behavior in public `nanocodex-*` libraries and no generic
  secret manager in the tool runtime.
- No cosmetic CLI/TUI lifecycle rewrite without a demonstrated correctness or
  measured performance reason.
- No benchmark, task, verifier, or retained-artifact modification made solely
  to improve an evaluation result.
