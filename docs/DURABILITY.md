# Durability model and correctness review

Status: implemented and verified, 2026-08-24.

This document records the end-to-end durability contract after closing findings
D-01 through D-98. The central rule is:

> An accepted operation is not finished until its authoritative Rust journal
> transition and checkpoint are committed. Everything outside that journal is
> an ingress ledger or projection recoverable from the same operation identity.

## 1. Boundaries and sources of truth

| State | Owner | Purpose | Authority |
| --- | --- | --- | --- |
| Rust execution journal | `nanocodex-durability` | Admission, FIFO execution, effect replay, terminals, and resumable checkpoints | Authoritative for whether model/tool work may execute |
| `SessionSnapshot` | `nanocodex-agent` | Typed history, model configuration, response chain, and completed tool progress | Authoritative model state only after the journal commits it |
| Managed/local ingress and transcript rows | Application | Retain exact external IDs and inputs before Agent admission; present history | Authoritative for application delivery, never proof of a Rust terminal |

The host store owns atomic storage but treats Rust journal batches as opaque,
byte-preserved JSON. The Rust reducer alone interprets operations, steps,
checkpoints, and recovery policy.

The browser has two separate origin-local databases: the Worker-owned Rust
journal and the UI transcript. The transcript is an ingress ledger and
projection; it is not a second execution authority. Likewise, managed
`managed_turns` rows instruct recovery of the Cloudflare Agent's Rust journal
and do not replace it.

## 2. Fenced host-store contract

`JournalStore` has two operations:

1. `acquire_owner(journal_id, owner_id)` atomically increments the persisted
   monotonic fence, installs the proposed owner identity, and returns an
   `OwnedJournal { owner: OwnerToken, journal }` read from that same snapshot.
2. `append(journal_id, owner, expected_revision, payload)` atomically checks
   the complete `OwnerToken` **before** checking the revision, appends one
   byte-preserved payload, and advances the revision by one.

Owner authority and journal revision are separate. Authority is not a lease:
it has no TTL, heartbeat, or expiry. Every successful acquisition immediately
replaces the prior authority by increasing its persisted fence. Consequently,
the last opener wins and every prior opener becomes stale, even if its expected
revision happens to match.

The contract is implemented by Memory, native SQLite, Postgres, browser
IndexedDB, and Cloudflare Durable Object SQLite. Native SQL acquisition also
fixes the former mixed-snapshot load race by acquiring authority and reading
the revision/batches inside one transaction.

Owner fences use the complete `u64` domain in every backend. Journal revisions
use `u64` in the Rust contract, Memory, IndexedDB, Cloudflare SQLite text
adapters, and the JavaScript Postgres adapter. Native Rust SQLite/Postgres
journal revisions deliberately stop at signed SQL `INTEGER`/`BIGINT`
`i64::MAX`; an attempted successor returns definite `NotCommitted` without a
write. This backend limit is explicit rather than an accidental conversion.

| Store outcome | Commit knowledge | Required action |
| --- | --- | --- |
| appended | Batch committed exactly once | Apply it to the live reducer |
| `NotCommitted` | Store guarantees no durable mutation | The same owner may retry |
| `Fenced` | A newer owner replaced this owner | Stop and reopen |
| `Conflict` | Authoritative revision differs | Stop and reopen |
| `Backend` | Mutation outcome may be unknown | Stop and reopen |

Only `NotCommitted` permits an in-place retry. `Fenced`, `Conflict`, and
`Backend` poison the live durability driver; a fresh acquisition and complete
journal reduction are required before deciding what happened.

Evidence:

- `crates/nanocodex-durability/src/store.rs`
- `crates/nanocodex-durability/src/{memory,sqlite,postgres}.rs`
- `js/bindings/browser/indexeddb-durability-store.mjs`
- `js/bindings/cloudflare/Agent.mjs`
- store regressions
  `acquisition_fences_stale_writer_before_revision_check`,
  `IndexedDB durability atomically increments concurrent owner acquisitions`,
  `PostgreSQL retains owner fences separately and checks them before revisions`,
  and `Cloudflare durability owns schema setup and atomic SQLite adaptation`

## 3. Journal and execution authorization

The journal records:

```text
OperationAccepted(id, input)
AttemptStarted(id)
StepStarted(id, step_id, kind, input, retry_policy)
StepCompleted(id, step_id, output)
AttemptFailed(id, error)
OperationCompleted(id, checkpoint, output)
OperationFailed(id, checkpoint, error)
OperationCancelled(id, optional_checkpoint)
CheckpointCommitted(checkpoint)
```

Admission is idempotent by exact operation ID and encoded input. Pending work
is recovered in acceptance order; completed, failed, and cancelled submissions
replay their retained terminal without repeating model or tool work.

Many operations may be admitted, but an execution step is authorized only when
all of these are true:

- the caller still owns that operation's process-local claim;
- the operation is the oldest pending operation;
- an attempt has started; and
- the recorded step definition is byte-identical.

Every `DurableSession` clone receives a distinct caller identity. An Agent
receives a generation-scoped `DurableOwner`; acquiring a new Agent generation
invalidates the older generation and its claims. These process-local checks
close clone/caller ABA and accidental cross-claim mutation. They complement,
but do not replace, the persisted host-store fence that excludes stale
processes, Workers, tabs, and Durable Object incarnations.

Admission result delivery uses an acknowledgement handoff. If the receiver is
cancelled before acknowledging ownership, the driver releases exactly the
claim it granted, so an ownerless live claim cannot strand FIFO recovery.
Each clone tracks only claims that it can actually own. Dropping a clone with
no claim emits no release traffic; dropping a claimant uses an unbounded
release lane, and the driver drains that lane in bounded batches so reclamation
cannot be lost or starve normal commands.

Durable steps retain their definition before the effect. A completed step
replays its output. An unfinished idempotent step may run again; an unfinished
`Never` step remains `AmbiguousStep` and is never repeated automatically.
Model-step identity includes the complete continuation-relevant semantic
profile: model and model prefix, reasoning and effort controls, fast/store and
transport configuration, endpoints, durable prompt-cache key, immutable
request prefix (including instructions and tool definitions), and typed prompt
history. A changed configuration therefore rejects replay instead of applying
an old result under new semantics.

That strict identity belongs to an unfinished effect, not to the lifetime of a
completed thread. A cold reopen from a committed `SessionSnapshot` keeps its
typed conversation, model, workspace, lineage, and prompt-cache key, then
rebuilds the request prefix from the current runtime. This lets deployments
change instructions or tool schemas without stranding the thread. Historical
tool calls and outputs remain inert typed history; only current handlers may
execute on subsequent turns.

The durable model-effect append is the authorization linearization point. A
newer owner can fence the old owner before that append or fence its result
afterward, but cannot retract a provider call that was already authorized and
is in flight. Warmup and ordinary generation both cross this boundary; warmup
is not a durability bypass. Custom `ExecutionPolicy` implementations that omit
model authorization, checkpoint commit, or cancellation support fail closed
with an explicit unsupported-capability error.

## 4. Checkpoints, cancellation, terminals, and shutdown

Completed and failed operations atomically retain their `SessionSnapshot` with
the terminal. Active cancellation now commits its safe interrupted checkpoint;
queued cancellation commits without a new model checkpoint and may terminalize
behind an active predecessor because it never started model work. Successful
standalone compaction commits `CheckpointCommitted`, so a cold reopen restores
the compacted history even if no later prompt ran.

Automatic pre-turn and mid-turn compaction is part of the owning operation,
not an unjournaled provider side effect. It records a stable idempotent step,
authorizes the provider call against the current owner immediately before the
effect, and replays the retained compaction output after a crash. A takeover
before provider entry fences the old owner; a terminal append that is definitely
not committed reclaims the same operation and reuses completed compaction rather
than compacting again or allowing later work to overtake it.

The model run returns terminal data without publishing a contractual terminal
event. The Agent driver first commits the journal transition and only then
emits `completed`, `failed`, or `cancelled`. Replayed completed, failed, and
cancelled admissions emit the corresponding terminal without executing the
model, but only after the caller receives prompt acceptance. Dropping
acceptance cannot create an orphan contractual terminal. A failed append emits
no false terminal.

Shutdown drains accepted work and reports settlement/terminalization failures
instead of returning success while an accepted cancellation or terminal failed
to commit.

The crash rules are therefore:

| Boundary | Recovered state and action |
| --- | --- |
| Before acceptance commit | No operation; submit stable ID/input |
| After acceptance, before attempt | Pending; reclaim exact ID/input |
| After attempt, before a step | Pending; start another attempt |
| After idempotent step start | Pending; repeat the same step identity |
| After unsafe step start | Pending and ambiguous; reconcile manually |
| After step completion | Replay retained output without repeating effect |
| Terminal append returns `NotCommitted` | Pending; same owner may retry |
| Terminal append returns `Fenced`, `Conflict`, or `Backend` | Live owner stops; reopen before deciding |
| Terminal committed but projection missed | Replay terminal and repair projection |
| Active cancellation committed | Restore exact safe interrupted checkpoint |
| Standalone compaction committed | Restore the compacted checkpoint |

## 5. Public recovery dispositions and consumers

`ExecutionPolicyDisposition` preserves action, not wording:

| Disposition | Examples | Caller action |
| --- | --- | --- |
| `Retry` | `NotCommitted`, retryable transport, predecessor/active-owner wait | Retry only on the still-valid owner when allowed |
| `Blocked` | `AmbiguousStep` | Keep nonterminal and require reconciliation |
| `Reopen` | `Fenced`, `Conflict`, `Backend`, poisoned/stopped owner | Dispose the stale Agent, acquire the journal again, and resubmit exact ID/input |
| `Fatal` | Invalid journal, changed step definition, invalid request | Fail closed; do not loop or reinterpret retained state |

WASM exposes stale-authority failures as `reopen_required`. The managed
controller rebuilds its Agent; the local controller retains an actionable
reload state for a fresh wrapper. Both keep the exact operation pending for
recovery and never retry a poisoned handle.

The local transcript allocates an atomic per-thread monotonic sequence, stores
the exact Rust operation ID and prompt before admission, and recovers rows in
that order. It no longer infers completion by matching prompt text against
compactable model context. Duplicate prompt text cannot alias an older turn.
Later recovery publishes its updated history before admitting newer work, and
blocked/reopen states are actionable. If transcript ingress persistence fails,
Rust admission is not attempted.

Transcript persistence does not serialize remote execution. Each local runtime
has a process-local FIFO only; no browser Web Lock is held across model I/O.
Independent tabs may race to recover the same ingress row, and the persisted
Rust owner fence decides which Agent can execute. A retained-recovery display
deadline relinquishes only the UI observer. It never cancels or disposes a Turn
whose durable outcome is unknown; late settlement remains observed and newer
model effects stay behind the retained barrier.

Terminal transcript transitions are absorbing. A stale tab cannot replace a
winner's `completed` or `failed` row with `reopen_required`, and live/recovery
callers consume the authoritative transition returned by IndexedDB. Storage
retains every unfinished row plus the newest 100 terminal rows and physically
deletes older terminals in the same write transaction. Malformed retained rows
fail closed instead of disappearing from recovery, and observer callbacks are
isolated from admission.

Managed creation uses a durable credential-binding saga. The session Durable
Object records binding ownership before external bind/initialize work, commits
the binding active only after account attachment, and retains deletion markers
until unbind, detach, workspace cleanup, and local-state deletion all finish.
Every ownership RPC has a hard caller deadline independent of abort cooperation;
deletion therefore cannot wait forever on a nonsettling service binding.
Cleanup first retires the one-shot agent and subject identities in their
authoritative account/directory rows. A delayed attach or bind that arrives
after its caller timed out is rejected by that permanent tombstone instead of
resurrecting ownership. Cleanup retries use persisted capped exponential
backoff with jitter. Subject mappings are sharded one Durable Object per
subject; a retained pre-sharding session installs an active ownership marker
from authoritative `session_state` and idempotently rebinds the current shard
before constructing any model transport. Retryable keyed creation stages retain
and refresh the same preparation lease; keyless legacy creates compensate
immediately, while the durable watchdog owns abandoned keyed preparations.
Deletion commits that durable marker and alarm before the irreversible local
tombstone, so reconstruction always owns unfinished external cleanup.

Managed turn cancellation is itself durable work. One `turn_cancelling` intent
is committed before acknowledgement. Control or reconstruction failure updates
that row's attempt count, error, and absolute `retry_at`; duplicate requests,
reconstruction, and alarms cannot run cancellation before that deadline. A due
cancellation can target a still-live Turn, and alarm selection takes the
minimum cancellation deadline rather than replacing it with idle shutdown.

## 6. Closed findings

All review findings D-01 through D-98 are closed in the current implementation.

| Finding | Implemented closure | Regression evidence |
| --- | --- | --- |
| D-01 stale model-owner checkpoint | Persisted monotonic owner fences plus one generation-scoped Agent owner prevent stale model execution and checkpoint regression | `newer_agent_acquisition_fences_an_older_live_model_before_execution`; `sequential_model_owners_preserve_history_and_cache_lineage` |
| D-02 cancellation lost checkpoint | Active cancellation journals the safe interrupted snapshot and checkpoint selection includes it | `ExecutionOutcome::Interrupted` passes `Some(checkpoint.snapshot())`; cancellation/reopen lifecycle coverage |
| D-03 terminal preceded commit | Driver commits execution policy before emitting contractual terminal; failed terminal append emits none | `portable_journal_replays_a_completed_model_step_after_terminal_commit_failure` |
| D-04 native load mixed snapshots | `acquire_owner` installs authority and reads the journal in one SQLite/Postgres transaction | store acquisition implementations and owner-fence store regressions |
| D-05 stale JS owner retried forever | WASM maps fenced/conflict/backend/stopped owner to `reopen_required`; managed/local replace the Agent | `a fenced durability owner requires reopening instead of retrying the stale Agent`; managed/local reopen tests; two-tab browser gate below |
| D-06 queued cancellation/shutdown contradiction | Never-started queued work can cancel out of order; shutdown accumulates uncommitted settlement failures | `queued_unstarted_operation_can_cancel_behind_a_pending_predecessor`; `shutdown_reports_a_queued_terminalization_that_did_not_commit` |
| D-07 policy disposition collapsed | Typed `ExecutionPolicyDisposition` drives retry, blocked, reopen, and fatal behavior end to end | `durability_errors_preserve_their_required_recovery_action`; binding and controller disposition tables |
| D-08 prompt-text reconciliation alias | Local recovery uses exact retained operation IDs and does not infer terminality from prompt text | `recovers a newer identical pending prompt by exact durable ID` |
| D-09 replay emitted no terminal | Durable terminal replay emits one typed terminal without model execution | `durable_terminal_replays_emit_one_terminal_without_model_execution` |
| D-10 claims were advisory | Distinct caller identities and Agent generations authorize every mutation and release | `cloned_handle_cannot_mutate_another_handles_claim` |
| D-11 transcript ordering/status gaps | Atomic per-thread sequence, post-recovery history projection, and actionable reopen state | `orders same-millisecond prompts by the durable per-thread sequence`; `later recovery publishes the recovered answer before admitting newer work`; `projects reopen-required recovery as actionable history and blocks newer admission` |
| D-12 steps bypassed FIFO/attempt/claim | Driver and reducer require claimed oldest operation and a started attempt before step authorization | direct-session transition/FIFO tests, including `queues_admission_but_serializes_attempts` and pre-append invalid-transition coverage |
| D-13 cancelled admission leaked a claim | Two-phase acknowledgement releases unaccepted claims for direct and automatic admission | acknowledgement handoff in `session.rs` and cancellation-safe admission coverage |
| D-14 local ingress failed open | Transcript ID/input commit is mandatory before Rust prompt admission | `prompt ingress fails closed and a later persisted prompt is not blocked` |
| D-15 routed prompt bypassed durability | Idle `route_prompt` performs the same automatic journal admission as `prompt`; active routing remains steering | routed prompt completion, cold-reopen, and active-steering regressions |
| D-16 stale transcript downgrade | IndexedDB terminal transitions are conditional and absorbing; callers use the authoritative returned row | two-runtime winner-before-stale-fence barriers, including a live turn |
| D-17 JavaScript numeric precision | Numeric revisions/fences are accepted only when nonnegative safe integers; exact decimal strings preserve the complete `u64` domain | unsafe-number rejection and exact-string binding tests |
| D-18 cold step replay reused dead response ID | Journal-replayed model output remains typed history but invalidates transport continuation and forces full replay | `cold_model_step_replay_never_reuses_the_replaced_transport_chain`, with store off/on |
| D-19 replay terminal preceded acceptance | Replayed terminals publish only after acceptance delivery succeeds for both queued prompts and idle routed prompts | `abandoned_terminal_replay_acceptance_emits_no_terminal_event` and `abandoned_routed_terminal_replay_emits_no_terminal_event` |
| D-20 managed transient became terminal/unscheduled | Disposed/startup/HTTP 5xx failures stay retryable; alarm scheduling occurs after admission-task removal | real HTTP 503 → retryable → alarm/resubmission → one completion Worker test |
| D-21 persistent backend races/schema ambiguity | Real SQLite multi-connection lock-order tests prove fencing/CAS; SQLite and Postgres reject malformed owner schemas at initialization | SQLite backend race tests and configured PostgreSQL 18 test |
| D-22 transcript retention/corruption | Older terminal rows are deleted, all unfinished rows remain recoverable, malformed rows and session sequence metadata block admission, v1 sessions migrate to exact sequencing, and the oldest barrier remains visible | real fake-IndexedDB retention/corruption/migration tests and history projection regression |
| D-23 definitely-uncommitted terminal retained claim | Exact-ID terminal retry releases and then reclaims the same operation; a committed model step replays once instead of repeating the effect | `exact_id_retry_reclaims_a_definitely_uncommitted_terminal_append`; direct-session definite-`NotCommitted` regressions |
| D-24 developer checkpoint overtook pending retry | Developer context remains unacknowledged and uncommitted until the preceding pending operation terminalizes | `queued_developer_context_waits_for_an_exact_id_retry_to_terminalize`; active developer checkpoint regression |
| D-25 compaction failure escaped or exposed uncommitted state | Standalone compaction failures stay inside the driver; failed checkpoint persistence restores the previously committed model state | `failed_completed_compaction_persistence_restores_the_committed_live_boundary` |
| D-26 warmup bypassed model authorization | Warmup crosses the same durable model-effect authorization boundary as generation; takeover can fence its result | `takeover_after_warmup_authorization_fences_the_result_not_the_in_flight_call` |
| D-27 shutdown/release was cancellation-unsafe | Owner shutdown has explicit active/releasing/released state and a shared completion; Drop keeps the release lane armed | `cancelled_shutdown_keeps_the_drop_release_lane_armed`; concurrent graceful-shutdown binding regression |
| D-28 policy defaults and clone release traffic failed open/liveness | Authority-bearing `ExecutionPolicy` defaults fail closed; only claim-owning clones release and bounded fair draining prevents command starvation | `execution_policy_authority_defaults_fail_closed`; `clone_drop_churn_and_claim_release_bursts_do_not_starve_commands` |
| D-29 transcript migration could lose unindexed rows or block startup | Upgrade scans the object store, bounds retained terminals per thread, and aborts the whole version change on an unorderable row; initialization is lazy and surfaces an actionable storage error | fake-IndexedDB 5,000-row bounded migration and unindexed-row preservation regressions |
| D-30 managed create/delete lifecycle races | Durable binding ownership, tracked bind/attach work, shutdown-before-admission drain, and persisted cleanup backoff make create/delete compensating and restartable | managed watchdog, stalled admission, cleanup retry, and retained pre-marker rebind Worker tests |
| D-31 provider throttling caused retry storms or rejected usable credentials | `Retry-After` or capped exponential jitter is persisted before body disposal; ordinary acquisition keeps an unexpired token while recovery and expiry fail closed | real broker Durable Object alarm/cancellation/backoff tests |
| D-32 active cancel acknowledged an uncommitted terminal | Active cancellation returns success only after `OperationCancelled` commits; a definite `NotCommitted` remains recoverable and any ambiguous store outcome requires reopen | `active_cancel_acknowledges_only_a_committed_operation_cancelled_entry` |
| D-33 automatic compaction was neither replayable nor freshly authorized | Pre/mid-turn compaction is an operation-owned idempotent durable step with stable input, retained output, and a fresh owner authorization immediately before provider entry | `automatic_compaction_replays_a_after_terminal_not_committed_instead_of_running_b`; `takeover_during_automatic_compaction_authorization_fences_before_provider_entry` |
| D-34 duplicate JavaScript construction fenced the live owner before failing | Stable session IDs are atomically reserved before raw Agent construction; failed construction releases, successful construction adopts, and duplicate/concurrent construction never touches durability authority | duplicate stable-session and concurrent-creation binding regressions |
| D-35 managed terminals and history had projection/cursor gaps | Outer terminal events survive retained history and reload without duplicating raw assistant output; history snapshot completion establishes the exact cursor before the live watcher attaches | managed outer-terminal projection and delayed-page-snapshot attachment regressions |
| D-36 retained managed lifecycle could lose cleanup or accepted siblings | Legacy deletion derives binding ownership from authoritative session state; deletion supersedes cold construction; controller-driven reopen keeps accepted siblings retryable; replay-only raw terminals are attributed before following work; infrastructure retry has no arbitrary terminal attempt count | direct legacy delete, deletion-versus-construction, accepted-sibling reopen, replay-only terminal, and former-eight-attempt Worker regressions |
| D-37 hung local recovery blocked the UI forever | Retained exact-ID recovery has a bounded observer deadline and an actionable nonterminal `reopen_required` barrier; it does not cancel an ambiguously live Turn, newer model effects remain blocked, and late settlement is observed and disposed | `bounds hung retained recovery without admitting newer model work` |
| D-38 browser sockets and compiler runs leaked after disposal | CONNECTING sockets are owned immediately and closed on disposal; compiler run trees and directory metadata are removed in `finally` while declared outputs survive | CONNECTING-socket and successful/failed compiler run-tree regressions; repeated large-memfs measurement |
| D-39 localhost shutdown orphaned relays, Vite, and setup children | Signal ownership is installed before setup, every detached process group is tracked, repeated signals escalate, and the Vite child exits when parent IPC disappears | dev-local parent-disconnect, descendant, repeated-signal, publisher, and abrupt-orchestrator regressions |
| D-40 response-body disposal could overwrite egress protocol outcomes | Best-effort cancellation cannot replace 401 recovery or 429 classification; device-login start/poll/exchange disposes every pending and non-success body | rejecting-body 401/429 and device-login body-lifecycle regressions |
| D-41 Worker failure leaked the page-side session reservation | Worker close invalidates every page-side root/child wrapper, releases its reservation, rejects pending work once, and permits immediate same-session reconstruction | Worker pending-RPC crash followed by same-session replacement; complete Worker Agent suite |
| D-42 durable developer context was retained but could be omitted from the next model delta | Acknowledged developer messages commit their checkpoint while preserving the unsent model delta across live and cold reconstruction; only a completed provider response advances that boundary | adapter developer-context model-input regression; `acknowledged_developer_context_survives_a_cold_reopen` |
| D-43 cloned builders could construct two owners from one durability route | Durable attachment is consumed atomically across every builder clone; the loser fails before host acquisition and cannot fence the live Agent | `durability_attached_builder_is_safe_single_use_across_clones`; duplicate/concurrent JavaScript stable-session construction suites |
| D-44 persistent host schemas could look compatible while changing authority semantics | Native and JavaScript Postgres validation now pins schema, column types/defaults/nullability, exact CHECK constraints, primary keys, immediate same-schema foreign keys, and the absence of extra constraints before any mutation | PGlite/native schema suites covering cross-schema and deferred FKs, missing/extra CHECK constraints, mixed legacy counters, and counter exhaustion |
| D-45 browser-host cleanup could lose not-yet-registered sockets or run twice | The host owns socket factories and preconnects from invocation through registration, aborts never-resolving construction, closes late CONNECTING sockets, isolates cleanup failures, and returns one promise for reentrant disposal | complete browser-host lifecycle suite, including direct/MPP late-open and reentrant cleanup |
| D-46 a stopped fenced Agent lost its recovery disposition | Driver shutdown records whether it owned an execution policy; every stopped command path returns typed `ExecutionPolicyOwnerStopped`, which WASM/controller policy maps to `reopen_required` rather than an ordinary stopped failure | core stopped-error distinction and stale-owner subsequent-prompt reopen regressions |
| D-47 a remounted local terminal could replay a stale one-shot history cache | Every new history subscription reloads the authoritative IndexedDB transcript after initialization; visible/focus/pageshow refresh is a fallback when a suspended tab misses its best-effort broadcast | continuously attached cross-tab propagation, missed-broadcast foreground recovery, and dispose/commit/reattach same-wrapper regressions |
| D-48 Windows local shutdown could only kill process leaders, not prove descendant cleanup | Local development fails closed on Windows until it has a Job Object owner; supported Unix hosts retain verified process-group shutdown | platform-contract and process-group lifecycle regressions |
| D-49 local optimistic prompt IDs differed from authoritative transcript IDs | Every local Turn exposes its durable transcript-row identity, including prompts queued behind a running turn, so history reconciliation replaces rather than duplicates the optimistic row | immediate and queued prompt projection regressions; real two-tab browser pass |
| D-50 Cloudflare public disposal retained stale lifecycle authority | Lifecycle authority follows the exposed Agent's actual release observer; public disposal permits a fenced replacement while joined shutdown remains exclusive until completion | dispose/recreate/destroy and in-flight shutdown regressions |
| D-51 throwing Worker cleanup could strand construction and its session reservation | Prewarm rejection settles before best-effort cleanup, cleanup failures are isolated and reported, and failed construction always releases the stable-session reservation | throwing-terminator followed by same-session replacement regression |
| D-52 JavaScript PostgreSQL schema probes admitted sampled values outside `u64` | Validation probes negative, zero where forbidden, adjacent overflow, and farther overflow boundaries for every authority/revision counter before accepting retained schemas | mock predicates and real PGlite malformed-CHECK regressions |
| D-53 same-isolate restore could reuse an ambiguously consumed refresh token | Every decrypted durable credential passes one restoration installer that quarantines `in_flight` refresh state, including restoration after persistence failure | post-provider persistence-failure and second-request regression |
| D-54 one slow subject shard blocked every tenant behind a singleton queue | Directory ordering is keyed per subject; shard I/O no longer owns a cross-tenant tail, and unbind reconciles the shard before deleting authoritative legacy metadata | stalled-subject concurrency, rollback unbind, reconciliation-failure, and malformed throttle regressions |
| D-55 retained local history duplicated the matching live assistant result | History reconciliation pairs the authoritative assistant with its exact durable user row and removes the matching live projection before result settlement | reducer regression and real completed local browser turn |
| D-56 browser network restoration left managed SSE half open after durable completion | A browser `online` transition replaces the shared connection from every subscriber's exact cursor, and response-reader failures reconnect instead of terminally ending subscribers | controlled half-open/reader-failure regressions and real offline-complete-reconnect browser turn |
| D-57 a prompt rejected before `run.started` remained at the head of the transcript queue and consumed the next run admission | Turn completion removes its exact optimistic prompt identity whether or not admission was observed; later runs cannot inherit failed projection state | reducer regression plus consecutive offline-failure/online-success browser turn |
| D-58 repeated localhost shutdown could mistake an inaccessible reused process-group ID for an owned live descendant and report a fatal `EPERM` after cleanup succeeded | Local groups run under the orchestrator uid; `EPERM` therefore proves that the numeric group is no longer the owned group and must never be targeted | injected reused-group regression plus real stack shutdown and port-release check |
| D-59 a browser Web Lock serialized cross-tab transcript processing across remote model I/O | Local coordination is process-local only; independent tabs race at the ingress boundary and the persisted Rust owner fence remains the sole cross-tab execution authority | `a stalled tab cannot hold cross-tab transcript processing across model I/O`; real two-tab fence pass |
| D-60 a local recovery display timeout cancelled a Turn whose durable outcome was still unknown | Timeout relinquishes the observer without sending cancellation or disposal; the retained row remains a barrier and late settlement is observed and released | timeout cancellation-count and late-disposal regressions |
| D-61 managed history startup could detach permanently or outlive its page | Initial history keeps retrying after its actionable error, wakes immediately on `online`, and every page request is owned by the subscriber's abort signal | managed initial-history retry, online recovery, and detach-abort regressions |
| D-62 transcript reconciliation used globally colliding presentation IDs and adjacency-derived ownership | User, assistant, reasoning, tool, plan, steer, and error projections carry durable turn identity; history keys are turn-scoped and queued hydration cannot move one turn's answer behind another | local exact-result, queued A/B rebase, same-tab managed, and cross-turn ID-collision regressions |
| D-63 managed cancellation ignored its persisted retry deadline | The cancelling row owns backoff across direct control failure, reconstruction, duplicate requests, active Turns, and alarms; only one intent event is emitted | real Durable Object HTTP-503 reconstruction, premature duplicate/alarm, and due-time retry regression |
| D-64 Evals failures became permanently inert after navigation remount | The shared query client retains normal failed-query remount retry, while explicit retry remains available in the rendered failure state | QueryObserver failure-remount-success regression and Evals route tests |
| D-65 wildcard localhost ownership let two development servers answer one port and cross-connect HMR | The local orchestrator probes both loopback families before setup, defaults to explicit `127.0.0.1`, and fails actionably if either family already owns the selected port | dual-family occupied-port regressions; canonical stack cold-start on explicit port 5183 |
| D-66 duplicate managed submissions bypassed an admission retry deadline | The authoritative admission boundary reloads the row and refuses `retryable` work before its persisted absolute `retry_at`; it preserves the same alarm | real Durable Object fake-clock duplicate-POST, premature-alarm, and exact-deadline regression |
| D-67 raw local Rust events could associate an older recovered run with the newest optimistic prompt | The local wrapper tags every live event with the exact durable turn active at admission, and the reducer removes only the queued row matching that ID; FIFO remains only for non-durable events | wrapper exact-ID event regression, unmatched-old-run reducer regression, and two-tab A/B browser pass |
| D-68 a managed history fetch could ignore abort and blackhole startup forever | Each initial and older-page attempt owns an online wakeup and hard deadline raced independently of fetch cooperation; subscriber detachment aborts the same attempt | never-settling loader deadline, online recovery, and detach regressions |
| D-69 terminal detachment left managed result subscribers and online listeners live | Every active terminal turn observer is disposed on detach; managed disposal aborts its local request/SSE signal without cancelling the authoritative server turn | active-turn terminal-detach and managed-observer-abort regressions |
| D-70 history prepend renumbered live reasoning/tool identities and could place tool work after its retained answer | Managed raw projections derive presentation identity from the durable event cursor, and reconciliation inserts live turn activity before that turn's retained final assistant | cursor-renumber reasoning regression, live-tool ordering regression, and exact browser row-order check |
| D-71 non-contiguous retained/live groups for one turn dropped late activity | Transcript reconciliation globally coalesces groups by durable turn ID while preserving each turn's first-seen order | non-contiguous same-turn merge and retained/live prepend regressions |
| D-72 a retained terminal error and its buffered live terminal rendered twice | Failure projection detects an existing error for the terminal event's durable turn even after active state has detached | retained-plus-buffered terminal error deduplication regression |
| D-73 presentation abort cancelled managed prompt/cancel mutations | Mutation submission owns its own lifetime; `Turn.result({ signal })` aborts only that observer and leaves the authoritative request running | held prompt, cancel-signal, and observer-detach binding/runtime regressions |
| D-74 a half-open managed SSE could retain subscribers forever without throwing | Each reader wait has a 45-second inactivity deadline, safely above the server's 15-second keepalive, and reconnects from the exact adopted cursor | fake-clock inactive-reader reconnect regression |
| D-75 route detachment shut down a browser Agent with accepted durable work | Config tracks accepted Turns independently of presentation subscribers and retires the Agent only after the result settles | active-turn unsubscribe/shutdown regression and route-switch browser gate |
| D-76 credential ownership RPCs and deletion drain could never settle | Bind, rebind, unbind, attach, detach, create phases, compensation, and drain all use real raced deadlines even when a callee ignores `AbortSignal` | nonsettling create-bind, cold-rebind, account-attach, and cleanup regressions |
| D-77 a lost outer create-commit response could leave an attached orphan | Any non-confirmed commit response enters authoritative session cleanup; account and subject tombstones reject every late one-shot generation | post-inner-commit response-loss, late attach, failed shard reconciliation, and rollback-broker regressions |
| D-78 the route-lifetime presentation wrapper hid later Worker failure callbacks | Runtime Agents are mapped to their presented wrappers solely for identity comparison while failure cleanup still disposes the real Worker Agent | silent Worker heartbeat failure/replacement regression, repeated 20 times, plus complete binding gate |
| D-79 recovery snapshot and buffered live events duplicated a terminal | History establishes the authoritative snapshot before recovery can flush live events, and retained/live terminal reconciliation is by durable turn identity | local recovery snapshot/buffer exact-once regression and route-detach browser pass |
| D-80 raw policy diagnostics escaped through old retained assistants | Live Rust policy diagnostics are tracing-only; retained errors and legacy assistant-shaped diagnostics are normalized on every read to one actionable disposition without operation or step IDs | `normalizes legacy raw durability assistants from context and initialized transcripts`; ambiguous-tool regression; retained browser replay |
| D-81 World collision lookup dominated cold main-thread work | Static blocked tiles are precomputed once instead of rescanned for every query | browser CPU profile: `townBlocked` about 95.72 ms self before and 1.53 ms after; World TBT 0 ms |
| D-82 legacy replay rejected repeated attempt markers or attemptless work | Replay accepts the historical shapes already emitted, while live mutation still requires one claimed oldest operation and one current attempt | repeated-`AttemptStarted` and prior-attemptless replay regressions |
| D-83 definitely-uncommitted cancellation stranded its claim | A noncommitted terminal releases exact ownership and permits deterministic reclaim; committed cancellation remains absorbing | Rust `NotCommitted` cancellation and exact-ID reclaim regressions |
| D-84 latest-event reconnect lost control cursor state | SSE adopts and reconnects from the exact latest cursor, with the first canonical terminal absorbing later duplicates and rejecting contradictions | managed latest-cursor, conflicting-terminal, and reconnect regressions |
| D-85 cancellation inherited an already-aborted prompt observer | Prompt, cancel, and control mutations own independent lifetimes; aborting a result observer never aborts the authoritative mutation | held prompt and cancel-signal regressions |
| D-86 Config refresh or subscriber loss destroyed live browser work | Config queues/coalesces replacement until every accepted Turn lease settles; explicit destruction remains the force boundary | active-turn refresh/unsubscribe and replacement regressions |
| D-87 `Turn.agent` escaped the presented lease owner | Presented Turns recursively point at the presented Agent, so prompts reached through `Turn.agent` acquire the same generation lease | recursive `Turn.agent` binding regressions and complete binding gate |
| D-88 a non-cooperative stream could wedge or grow without bound | Fetch, reader cancellation, SSE frames, paused queues, and terminal caches have independent hard deadlines and byte/count caps | nonsettling reader/cancel, oversized frame, paused queue, and terminal-cache regressions |
| D-89 local steering could execute before durable reservation or disappear on crash | Steering is reserved first, transitions to accepted/rejected after dispatch, is capped, and a retained unproved dispatch blocks prompt recovery rather than replaying either input | steer persistence/cap/failure and unresolved-steer recovery regressions |
| D-90 pre-admission local cancellation was ephemeral | Cancellation intent is committed before Rust admission and then absorbed or forwarded exactly once in FIFO order | pre-admission cancel, reload, and cancellation-status regressions |
| D-91 managed retention split turns or orphaned suffixes | Retention groups complete turns by durable identity and compactly retains prompt plus terminal for oversized groups | grouped-retention, oversized-turn, and orphan-suffix regressions |
| D-92 non-cooperative initial history blocked startup forever | One bounded history generation owns each request; timeout returns control while the still-settling request prevents overlap, and retry starts only after it is safe | bounded noncooperative history and retry regressions |
| D-93 shard I/O and response-body cancellation had no hard boundary | Every ownership/shard call and response-body cancel is raced against a real deadline and stale post-I/O authority is revalidated | nonsettling shard, body-cancel, and late-result regressions |
| D-94 two shards or a late bind could disagree about ownership | One revision-fenced shard CAS is authoritative; tombstones win, disagreement is repaired, and legacy authority is checked again after I/O | subject-sharding CAS, tombstone repair, and stale-generation regressions |
| D-95 room initialization and receipt/quota calls could hang | Multiplayer initialization, allocation receipts, and quota ownership have one-shot deadlines and cannot publish after their generation retires | nonsettling room initialize/receipt/quota regressions and two-tab room browser flow |
| D-96 deletion could time out and later resurrect a managed Agent | Deletion is phase-bounded, persists attempt generation/retry state, and fences every post-await runtime/event-watcher publication; stale constructed Agents shut down directly | deletion-runtime generation and late-construction regressions |
| D-97 released PostgreSQL authority schemas could not open safely | Serialized advisory-lock initialization converts released `BIGINT` journal/batch counters to `NUMERIC` in place, preserves rows, and accepts only an exact empty current owner table residue | three ignored real-PostgreSQL-16 upgrade/residue/schema tests plus all-feature gate |
| D-98 browser bootstrap could replay historical diagnostic text as a completed answer | Known policy-text assistants override even an explicit legacy completed status to a safe blocked projection; raw text is never treated as model output or repeated | legacy context and initialized-transcript projection regression plus real retained browser state |

Additional recovery coverage proves completed model-step replay after a failed
terminal commit, ambiguous tool refusal, changed tool-profile rejection, and
exact history/cache lineage across sequential owners.

The adversarial gate repeatedly ran the complete 25-case Rust durable-Agent
suite 100 times, the local runtime race suite 100 times, and the
IndexedDB/Cloudflare store suites 100 times. Managed Miniflare tests exercise
concurrent duplicates, alarm/admission overlap, concrete cursor reconnect, and
HTTP 503 recovery against real Durable Object SQLite semantics.

## 7. Browser verification

On 2026-08-24 the real local application was exercised in two independent tabs
at:

`http://127.0.0.1:5183/agent?thread=11111111-2222-4333-8444-555555555555`

The newer tab fenced the older owner. The stale tab submitted
`Reply with exactly FINAL_STALE_RECOVERY_OK`; the prompt was retained as
`reopen_required` with actionable reload text and made no model call. Reloading
acquired fresh authority, recovered the exact retained prompt, and rendered
`FINAL_STALE_RECOVERY_OK` exactly once. The authoritative IndexedDB row changed
to `completed`. The replacement
WebSocket contained exactly the recovered generation and a later mobile turn;
there was no generation for the fenced submission before reload.

The same integrated build also performed a real curl-style GET to
`https://api.github.com` through the browser agent and observed `200 OK`, sent
and completed a turn through native touch controls under an iPhone 15 Pro
profile, and completed a managed-durable turn followed by a page reload. Local
and managed outputs survived their respective reloads. The complete pass had
zero uncaught page errors and zero error/warning console entries. Expected MCP
transport negotiation and runtime-switch aborts remained visible as canceled
requests; they did not become durability failures or user-visible errors.
The transcript v4 upgrade is separately exercised with real IndexedDB-shaped
data: a 5,000-row migration retains the newest 100 terminals per thread and all
unfinished work, while a row that cannot participate in ordered recovery aborts
the version change and preserves the old database rather than deleting evidence.

A final lifecycle pass reproduced the former projection gap without involving
the model: the receiving terminal detached, another tab committed while no
journal observer existed, and the same memoized local wrapper reattached. Its
first snapshot now reloads IndexedDB and contains the missed prompt and answer
exactly once. A fresh two-tab browser run then projected each tab's completion
into the other tab without reload. Browser foregrounding also rereads
authoritative history, so suspended tabs do not depend on BroadcastChannel
delivery being durable.

The mobile managed path was reloaded at iPhone SE geometry, retained a
313-pixel transcript viewport, submitted `MOBILE_TOUCH_OK` through native
touch/IME controls, survived an offline failure and reconnect, and retained
the final output after reload. The embedded and axe audits had zero violations
after naming the compact account trigger and making the decorative conversation
backdrop non-interactive.

The final cold-stack pass repeated the ownership paths after D-79 through D-98.
A local tool turn and a managed tool turn each finished while the complete Agent
document was detached, returned exactly once, and remained exactly once after a
full reload. Two independent local tabs converged on `TAB_A_FINAL_OK` and
`TAB_B_FINAL_OK`; the stale tab showed an actionable recovery notice rather
than a policy diagnostic. Cancellation suppressed the requested final output,
and a mid-turn steering input produced `STEERING_ACCEPTED_OK` once before and
after reload. A previously retained raw ambiguous-effect assistant was read as
the safe “outcome could not be proved” disposition without its operation or
step IDs. Managed native touch/IME produced `MOBILE_TOUCH_IME_OK` once.

The same browser session created a Multiplayer room, synchronized a human
message across two tabs, completed one room-agent turn, reloaded both clients,
and deleted the room. World movement/interact, Changelog-to-commit navigation,
commit search/diff, docs navigation, Evals, and Source file selection completed
with zero uncaught page errors. Every canonical direct route had zero horizontal
overflow. The iPhone SE, iPhone 15 Pro, Pixel 8, and Galaxy S24 layout matrix had
zero application layout findings after the 360-pixel header fix; the harness's
remaining `screen` mismatch is an emulation-provider limitation, while viewport
and document geometry matched. Deterministic and axe audits reported zero
violations (axe retained only an indeterminate xterm contrast check).

## 8. Reference comparison

The pi-mono review informed three invariants but did not supply a complete
execution implementation to copy. Its `dev` runtime2 checkpoint `c77ab55`
commits implemented admission events after state, restores exact open operation
inventory, and its SQLite backend uses a fenced writer lease. Those are
consistent with Nanocodex's commit-before-projection, exact-ID recovery, and
persisted-owner rules.

At that checkpoint pi runtime2 still had no public drive, terminal settlement,
abort/resume, or automatic recovery supervisor. Its JSONL backend also had only
process-local writer exclusion. Nanocodex therefore adopted the useful
invariants, not pi's incomplete lifecycle or weaker JSONL authority model.

## 9. Remaining limitations and operating risks

- Ownership is deliberate last-opener-wins fencing, not mutual exclusion. A
  second legitimate opener causes an immediate ownership handoff and forces
  the older Agent to reopen on its next mutation.
- There is no lease, TTL, or heartbeat. Authority does not expire; availability
  comes from opening a new owner, which increments the fence.
- Owner fences are `u64`. Journal revisions are `u64` except in the native Rust
  SQLite/Postgres adapters, whose signed SQL counters stop at `i64::MAX`.
  Exhaustion fails without committing; there is no wraparound or automatic
  reset.
- The outer managed/local transcript is an exact ingress ledger and UI
  projection, not execution authority. Application projection repair still
  depends on resubmitting its retained ID/input to the Rust journal.
- Terminal transcript storage is bounded, and admission fails closed at 32
  unfinished rows per local thread. Unfinished rows are never pruned because
  dropping one would lose accepted work; recovery or an explicit replacement
  remains required before admitting more.
- Browser durability is origin-local IndexedDB durability. It survives page and
  Worker replacement in that origin, but it is not remote, cross-browser, or
  cross-device durability.
- Cold reopen retains the durable prompt-cache key (defaulting to journal ID)
  but intentionally omits provider response IDs. Its first model request
  replays complete client-owned typed history and may be larger than a warm
  `previous_response_id` continuation.
- Provider cache-hit rate and first-request cost after cold durable reopen still
  require the paired live benchmark described in `PROMPT_CACHE_REVIEW.md`.
- A malformed retained browser snapshot still fails closed. Instruction and
  tool-definition drift at a completed boundary is deploy-compatible: the new
  runtime rebinds its current request prefix while retaining authoritative
  history. Drift during an unfinished recorded model step remains a semantic
  conflict and must not replay an old result under the new profile.
- Native SQLite/Postgres and JavaScript Postgres validate existing owner-table
  schemas eagerly and exactly. The generic JavaScript SQLite/Cloudflare adapter
  relies on its first acquire/append statement to reject incompatible
  pre-existing owner state. That remains fail-closed for authority but turns a
  bad Cloudflare deployment into a later availability/configuration failure
  rather than an eager startup diagnostic.
