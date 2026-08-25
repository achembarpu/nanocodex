# Production performance review

Date: 2026-08-25

Production URL: `https://nanocodex.gakonst.workers.dev/`

Web deployment: `15242374-9513-4dac-ac06-c9103cc5bdc2`

Managed deployment: `718abf2c-7927-4e19-8d55-1d75434428e2`

## Outcome

The interactive path is fast and managed mode is now close to local browser
mode. Managed list and history hydration are off the terminal-ready path, and
model latency dominates time to first token.

The normal live prompt-cache path is also structurally sound: one agent keeps a
stable cache lineage and uses `previous_response_id` for compatible incremental
requests. Portable durability now defaults the cache key to the stable journal
ID. Cold reopen retains that key but deliberately omits the remote response ID,
so the first request replays complete client-owned typed history. Durable model
steps bind that key, instructions, tools, model, request controls, immutable
prefix, and history into their semantic identity; configuration drift rejects
replay instead of applying an old result under a new profile.

This production pass did not measure provider cached or cache-write tokens, so
it still does not establish a live cache-hit rate or cold durable-restart
performance. The review baseline and remaining benchmark are in
[`PROMPT_CACHE_REVIEW.md`](PROMPT_CACHE_REVIEW.md).

The pathological failed-prewarm alarm loop and the durability ownership races
found by that deployment are fixed. The deployed durability implementation is
revision `536345ad97cecf6a9af52bd100c6d475f15f9b70`: startup rollback spans the
real host lifecycle, persisted owner fences exclude stale writers, structural
authority failures require a fresh authoritative reopen, and managed creation
replay is crash-safe through commit, deletion, and watchdog recovery. The load
harness cleanup verifier was subsequently tightened on master at `01e52a51`;
that harness-only change did not require a Worker deployment.

The scale pass also removed both account-sized coordination structures. Subject
ownership routes directly to one named Durable Object per subject, and each
account/agent membership is one SQLite row rather than an aggregate JSON array.
Every idempotent public create stage now has bounded replay on an ambiguous
transport result or transient HTTP status, and a caller `Idempotency-Key`
derives one account-scoped agent identity for safe outer retry. The production
browser created a new managed conversation, completed
`CREATE_REPLAY_FINAL_OK`, and recovered the exact turn after reload with zero
page errors. The final hosted control run then completed 100,000 creates,
isolated state reads, terminal deletions, and run-scoped leak checks through one
real account at concurrency 128.

## Measurement scope and caveats

Measurements used the host-managed browser against the production deployment,
plus live Wrangler tails for the website, managed, and egress Workers.

The browser retained an authenticated account, conversations, and some cached
assets. Document navigations were fresh, but these are not incognito
cold-cache or first-ever account measurements. Local-agent measurements used a
retained thread; a completely new Worker/WASM/OPFS thread remains a separate
benchmark.

No sample cold-restarted an agent process and then measured its first provider
request. Portable recovery retains the prompt-cache key but deliberately omits
provider response IDs, so its first post-restart request replays complete typed
history rather than continuing from a stored provider checkpoint. A warm
provider cache may still price much of that input as cached, but the current
measurements cannot prove it.

The final post-deployment replay check used a newly created managed conversation
on the canonical production agent URL. Its full reload measured 33.4 ms TTFB,
224 ms FCP, 616 ms LCP, 4 ms TBT, 0.00083 CLS, and 13,808 transferred bytes.
The prompt and exact `CREATE_REPLAY_FINAL_OK` response remained visible after
reload. There were zero page errors; the only aborted request was the prior SSE
stream being replaced by the reload.

## Document and terminal readiness

| Metric | Desktop | Mobile |
| --- | ---: | ---: |
| TTFB | 38 ms | 42-44 ms |
| FCP | 148 ms | 120-132 ms |
| LCP | 564 ms | 236-828 ms |
| Terminal ready | 262 ms | 262-902 ms |
| TBT | 38 ms | 0 ms |
| CLS | 0.00018 | 0-0.00117 |

No authentication/connect flash, uncaught page error, horizontal overflow, or
material forced-layout cost was observed. The first complete sampled account
UI said `Account agent ready`.

The desktop startup trace contained one 89.5 ms long task. Total trace work was
173 ms scripting, 36 ms rendering, and 8 ms painting.

## Local and managed turn latency

| Runtime | Submit to first token | Run-start to first token | Pre-run overhead |
| --- | ---: | ---: | ---: |
| Local first sample | 3.131 s | 3.124 s | 7 ms |
| Local warm | 1.294 s | 1.286 s | 8 ms |
| Managed samples | 1.149-3.112 s | 1.029-3.001 s | 98-125 ms |
| Managed median | 1.633 s | 1.508 s | 111 ms |

Model time accounts for nearly all variance. The stable managed penalty is
about 100 ms, corresponding to one browser/Worker/Durable Object round trip:

- Managed turn POST/202 took 114-151 ms.
- Managed pre-run overhead stayed between 98 and 125 ms.
- Local browser admission overhead stayed near 8 ms.

Managed is therefore practically comparable to local, though not identical at
the transport/admission boundary.

## Prompt-cache interpretation

The implementation review supports the following interpretation of these
latency samples:

- Live roots and descendants retain one stable cache lineage even though they
  have distinct session IDs.
- Healthy sequential turns use delta-sized requests with
  `previous_response_id`.
- Retry, reconnect, checkpoint eviction, and compaction replacement replay
  complete authoritative history while retaining the cache key.
- `store(true)` improves live replacement-socket continuation and in-memory
  historical forks. It does not currently make a cold durable restart send a
  delta-sized stored-checkpoint request.
- Codex-rollout reconstruction currently replaces a caller-defined cache key
  with the thread ID, so it is not cache-lineage-equivalent to direct
  `SessionSnapshot` recovery.

These are source-backed behavior claims, not production cache-effectiveness
measurements. The next cache pass must record request bytes plus total, cached,
and cache-write input tokens, with retained-key and changed-key controls.

## Managed startup waterfall

The atomic latest-tail change and parallel history hydration are working:

- `/v1/agents` took 95-327 ms across samples.
- `events?cursor=latest` opened concurrently with history.
- Initial 128-event history took 423-484 ms and transferred about 15.6 KB.
- Desktop terminal readiness occurred at 262 ms, before history completed.
- With a retained agent ID, managed terminal readiness was about 26 ms after
  the managed chunk began loading.

Agent listing and retained history do not warrant more hot-path work before the
server lifecycle issue below is fixed.

SSE restarts observed around turn submission were immediate cursor-preserving
restarts, not one-second reconnect delays. POST acceptance and the replacement
SSE typically reached response headers in roughly 90-150 ms.

## Browser CPU, layout, and memory

A representative managed turn trace reported:

- 226 ms scripting over a 5.7 second trace.
- 6.4 ms rendering and 4.8 ms painting.
- One 62.5 ms long task.
- Forced reflows below 0.2 ms each.
- 233 DOM nodes.
- 46.5 MB used JavaScript heap.

The terminal is not currently rendering-bound. The repeatable 60-90 ms long
task around startup/interaction is a secondary xterm/full-frame investigation,
not the present release blocker.

## Localhost whole-application pass

The final localhost pass cold-opened every public application route through
the real running stack: `/`, `/agent`, `/multiplayer`, `/world`, `/changelog`,
`/commits`, `/docs`, `/evals`, `/code`, and `/requests`. It also exercised
runtime switching, local and managed prompts, reload recovery, two independent
local-owner tabs, two multiplayer tabs, commit navigation and patch expansion,
documentation/source navigation, eval failure UI, desktop layout, and a
representative touch viewport. No route produced an uncaught page error or a
deadlock.

The material costs and fixes were:

- Direct cold `/commits` reached DOM content loaded at 205 ms, FCP at 352 ms,
  LCP at 536 ms, and zero blocking time with about 124 KB transferred. Patch
  publication began at 482 ms and the complete patch was ready around 3.23 s.
  Before streaming/adopted-preload ownership, the same development path moved
  about 2.08 MB, reached FCP/LCP around 464/672 ms, and retained about 105 MB of
  heap.
- A missing eval workset formerly repeated three retry cycles for six requests.
  Permanent 4xx responses now make one overview and one cluster request, show
  the actionable error around 564 ms, and do no blocking work. 408, 425, and
  429 remain retryable.
- The first transcript-retention migration performed repeated array sorting and
  took 22.6 s for 5,000 fake-IndexedDB rows. The bounded object-store rebuild
  takes roughly 475-563 ms in that harness and 166.6 ms in the browser while
  retaining the newest 100 terminals per thread. If any row cannot participate
  in ordered recovery, the version-change transaction aborts and preserves the
  old database instead of clearing it.
- Local transcript initialization no longer starts during React render. It
  begins at the first history subscription or prompt, surfaces initialization
  failures into the terminal, caps unfinished admission at 32 rows, and removes
  both live and retained-history listeners on disposal.
- The local relay now installs parent-disconnect handling before readiness and
  owns socket cleanup. Setup, publisher, website, Vite, and relay process groups
  are tracked from before setup begins; repeated signals escalate and Vite has
  a parent-IPC watchdog. Completed one-shot groups surrender their capabilities
  immediately. The local stack requires Unix process-group semantics and fails
  closed on Windows rather than claiming descendant cleanup it cannot prove
  without Job Objects. Seven live relays and one live Vite orphan from earlier
  development stacks were identified by their exact child command and
  terminated. A real stop after the fix left no owned child and released the
  canonical port.
- A Worker crash formerly rejected pending RPCs but retained the page-side
  stable-session reservation. The full bindings suite then stalled for the
  heartbeat window and same-session recovery falsely failed as already active.
  Worker close now invalidates every root/child wrapper and releases authority;
  the 36-case Worker suite completes in about 116-155 ms and a crash followed by
  immediate same-session construction is a regression.
- Browser compiler runs now remove their temporary memfs tree on both success
  and failure while preserving declared outputs. Repeating 24 runs with 2 MiB
  inputs stabilized retained memfs near 2.56 MB instead of accumulating run
  directories. CONNECTING sockets are likewise closed before any late open.
- Retained local recovery now has a bounded deadline. A hung exact-ID recovery
  becomes an actionable nonterminal reopen barrier and continues to block newer
  model effects instead of hanging the interface indefinitely. The deadline
  relinquishes only the observer: it never cancels or disposes a Turn whose
  durable outcome is unknown, and late settlement is still observed.

The remaining visible web-performance opportunities are the measured 60-90 ms
xterm task, deferred MCP negotiation/teardown churn, and explicit
runtime-labelled end-to-end marks. None blocked interaction or durability in
this pass.

### Final localhost brutalism and measurements

The last browser-shaped pass found and fixed three lifecycle/UI defects that
the lower-level suites did not expose:

- a terminal attachment could detach, miss a cross-tab commit, and reattach to
  the same local wrapper's stale one-shot history promise; each subscription
  now performs a fresh authoritative transcript read, with visible/focus/page
  refresh as a lost-broadcast fallback;
- the mobile conversation header was a sibling of `.conversation-main`, but
  the main grid reserved a second 44-pixel header row internally. The sole
  terminal child landed in that row and collapsed xterm to zero height after a
  mobile reload. Main content now owns the viewport remaining below its actual
  sibling header; iPhone SE reload retained 313 pixels of xterm height; and
- managed offline fetch failures exposed `Failed to fetch`. They now render
  the same actionable reconnect message as WebSocket handshake failures.

The compact mobile account trigger also received an explicit accessible name,
and the decorative conversation backdrop is no longer an aria-hidden button.
Both the embedded audit and axe reported zero violations afterward.

A warm localhost managed reload on the iPhone-SE profile measured 5.7 ms TTFB,
274 ms DOM content loaded, 324 ms FCP, 632 ms LCP, 0.00194 CLS, 39 ms TBT, 173
resources, and 592 KB transferred. The trace recorded 614 ms scripting, 81 ms
rendering, 12 ms painting, four long tasks, and a 122 ms maximum. It also
identified the largest remaining transfer: the four-turn managed history page
was 338,676 JSON bytes (338,874 transferred), of which 310,159 bytes were 68
raw `api.event` envelopes that the terminal does not visibly project. A
terminal-specific server projection or filtered history view is the highest
confidence transfer reduction; changing the authoritative event log is not.

Repeated visible local/managed switching remained correct with no page or
console errors. Browser marks put terminal readiness at 152 ms for local and
58 ms for managed in the sampled switch. The automation action itself returned
after about 5.18 seconds because it waited on the intentionally persistent
event transport; that wall time is harness/network-idle behavior, not UI
readiness. A garbage-collected development heap snapshot retained 94.4 MB,
including 50.1 MB of external source strings. Development coverage confirms
that the conventional static Vite graph loads route-heavy modules; final-build
evidence, not source-server byte counts, remains authoritative for a
route-splitting decision. After rebasing the connector UI from current master,
the release build emits an approximately 3,679.23 kB main client chunk
(947.48 kB gzip) and a 3,661.03 kB WASM module; managed code is now folded into
the main graph rather than emitted as its prior 16.01 kB route chunk. Current
FCP/LCP remain acceptable, but a future split must use the router's canonical
declarative route boundary and prove both cold start and warm navigation in the
browser rather than introducing another loader layer.

The mobile matrix had zero document-level horizontal overflow on iPhone SE,
iPhone 15 Pro, Pixel 8, and Galaxy S24 in portrait and landscape. The harness
reported its host `screen` dimensions rather than the emulated screen; that is
a verifier caveat, not a blank or overflowing document. The 360-pixel product
nav now fits all eight 44-pixel targets without clipping. Native touch/IME
submission completed `MOBILE_TOUCH_OK`, managed output survived reload, and
offline-to-online recovery completed a subsequent turn.

## Deferred MCP behavior

Deferred MCP discovery no longer blocks local terminal readiness. Slow server
catalogs remain behind `tool_search`, as intended.

Off-path network churn remains:

- Four MCP servers perform multiple negotiation requests each.
- Typical individual requests took 20-303 ms.
- One Vocs initialization took 975 ms, with 1.57 seconds to SSE headers.
- Some transports show `POST 202`, aborted `GET`/405, then another POST.
- Viem and Vocs SSE requests often remain open for about ten seconds and abort
  when the runtime is disposed.

This should be cleaned up for network/log efficiency, but it does not currently
affect terminal readiness or time to first token.

## Managed prewarm incident and implemented outcome

Live managed Worker logs repeatedly emitted:

```text
managed agent prewarm failed
Nanocodex durability journal is already active: cloudflare:01a02eba-...
```

Observed behavior:

- Approximately one retry per second.
- 12-16 ms CPU per alarm invocation.
- Commonly 1-2.3 seconds wall time per invocation.
- Continued for many minutes.
- Forced Wrangler tail into sampling mode.

At that rate, one stuck Durable Object produces about 86,400 invocations and
17-23 CPU minutes per day.

Two boundaries interacted to produce the storm in the measured deployment:

1. The deployed SSE-subscriber prewarm path calls `#scheduleAgentWarmup` and,
   after any failure, schedules another alarm at `Date.now() + 1_000` while a
   subscriber remains. The next alarm clears and retries the failed promise.
   This bypasses the bounded exponential turn retry policy.
2. The deployed durability path relied on a process-local strong map keyed by
   journal ID. Explicit shutdown released it, but Durable Object incarnation
   loss had no authoritative cross-incarnation stale-writer boundary.

The stale owner may originate from Durable Object incarnation loss or a
create-time leak. The confirmed leak after HostAgent creation and before
watcher/extension publication was fixed on 2026-08-24 by extending creation's
rollback boundary through final decoration and awaiting session shutdown.

The correctness fix is store-authoritative rather than process-local.
Memory, SQLite, Postgres, IndexedDB, and Cloudflare Durable Object storage now
persist a monotonic fence separately from the journal revision.
`acquire_owner` installs the new authority and reads one journal snapshot in the
same transaction. Every append checks the complete owner token before the
revision. A newer opener therefore fences every older Agent before it can
regress history or cache lineage.

This authority is non-expiring and is not a lease: there is no heartbeat or
TTL. Acquisition is last-opener-wins ownership handoff. `Fenced`, `Conflict`,
and unknown `Backend` outcomes require a fresh Agent and full journal reopen;
only a definite `NotCommitted` result is safe to retry on the same owner.

### Correct fix boundary

1. **Implemented:** make `CloudflareAgent.create` atomic through watcher and
   decoration setup. Every failure before publication awaits
   `agent.session.shutdown()`.
2. **Implemented:** persist a monotonic owner fence in every host store,
   atomically return its same-snapshot `OwnedJournal`, and check authority
   before revision on every append.
3. **Implemented:** remove fixed one-second passive retry. One attempt per
   subscriber transition is sufficient; real turns already own bounded typed
   retry. Structural ownership errors enter actionable `reopen_required` state
   rather than polling.
4. **Implemented:** add a regression that fails after HostAgent setup and
   recreates the same persisted Cloudflare session.
5. **Implemented:** add generation-scoped Agent ownership and caller-bound
   claims inside one `DurableSession`, closing clone ABA in addition to the
   persisted cross-runtime fence.

Primary source boundaries:

- `services/managed/src/index.ts`: subscriber prewarm, alarm, agent creation.
- `crates/nanocodex-durability/src/store.rs`: authoritative owner token and
  host-store contract.
- `js/bindings/runtime/durability.mjs`: host binding and process-local guard.
- `js/bindings/cloudflare/Agent.mjs`: Cloudflare Agent construction rollback.
- `js/bindings/browser/InlineAgent.mjs`: durability retain/release ownership.

On 2026-08-24 a two-tab pass against the real local application at
`http://127.0.0.1:5183/agent?thread=6ae69774-3324-4fef-a407-2db0cb887d51`
proved the new boundary: the newer tab fenced the older tab; the stale prompt
was retained as `reopen_required` with actionable reload text and caused no
model call; reload recovered the exact prompt and committed the authoritative
row as `completed`. The replacement WebSocket contained only the recovery
generation and a later mobile turn. The same integrated build completed a real
GitHub API GET with `200 OK`, a native-touch iPhone-profile turn, and a managed
durable turn whose completed output survived reload. The pass had zero page
errors and zero error/warning console entries. This is browser correctness
evidence, not a substitute for the remaining production quiet-log observation.
The retained local transcript database was then upgraded through the current v4
schema; existing history remained ordered, the exact per-thread sequence
advanced, and a new post-migration turn completed cleanly.

## Website and egress Worker findings

The website's local ChatGPT Responses connection is persistent. Switching or
closing tabs causes the long-lived ChatGptEgress/WebSocket invocations to be
recorded as canceled/exceptional `Network connection lost` outcomes despite
only 0-2 ms CPU. These are mostly lifecycle/log-classification noise.

Warm egress primitives were fast:

- Credential lookup: 1 ms.
- Subject bind: 28 ms.
- One cold credential-status lookup: 335 ms.
- Warm turns reused their Responses WebSocket and performed no per-turn broker
  lookup.

The egress Worker separately showed many canceled
`DELETE /subjects/<subject>` operations with 2-107 seconds wall time and nearly
zero CPU. Source ownership limits these deletes to failed agent-create rollback
and explicit agent deletion; passive prewarm does not issue them.

Subject mappings now use one `AgentSubjectDirectory` Durable Object per subject,
removing the global serialization point. Managed session creation first records
durable binding ownership, then binds and initializes, then attaches the account
and commits active ownership. Deletion retains its marker until unbind, detach,
workspace cleanup, and local state deletion finish; late bind/attach work is
tracked and compensated. Cleanup retries persist capped exponential backoff
with jitter instead of waking every second.

The browser pass exposed the required cutover behavior: a retained pre-sharding
session initially received `agent_subject_unavailable` because its mapping
existed only in the obsolete singleton. Cold startup now derives ownership from
authoritative `session_state`, installs the active cleanup marker, and
idempotently binds the current subject shard before any Responses transport.
Repeated cold starts reassert that mapping, and later deletion owns its removal.

ChatGPT refresh throttling is similarly durable. Provider `Retry-After`, or a
capped exponential-jitter fallback, is persisted before response disposal and
drives the broker alarm. An ordinary call may keep using a still-unexpired
access token during proactive-refresh backoff; explicit recovery and expired
credentials remain fail-closed.

## Hosted durability API scale

The control harness reaches the public website Worker with a real account API
key, crosses the private managed service binding, creates independent AgentDOs,
reads every new agent's state, deletes every receipt, and finally proves none of
the run's IDs remain in the account index. It stops new work on the first phase
failure but still deletes all successful receipts. A
`503 session_cleanup_pending` response is not treated as completion: the
harness retries the same deletion until it receives terminal `204` or `404`,
then verifies the exact receipt IDs. Account-wide before/after comparison is
only a fallback for an interrupted create phase whose response receipts may be
ambiguous, so unrelated agents created during a long wave are not mislabeled as
leaks.

The final 100,000-agent control run at concurrency 128 completed in 35 minutes
58 seconds with no errors and no leaked run IDs. Thirty-eight asynchronous
deletions initially returned cleanup-pending and all reached a terminal result.
The account had 28 ordinary agents before and after the wave:

| Phase | Throughput | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Create | 87.15/s | 1.392 s | 2.048 s | 2.410 s | 18.265 s |
| State | 359.49/s | 361 ms | 747 ms | 849 ms | 10.898 s |
| Delete | 136.64/s | 873 ms | 1.652 s | 2.025 s | 34.755 s |

The load generator's maximum resident set was 346,882,048 bytes. The exact
post-wave verification took 194 ms. This deliberately concentrated all
membership writes in one UserAccountDO, making it harsher on the per-user index
than the one-million-user target, where account ownership is distributed. It
does not prove one account can churn indefinitely: permanent deletion
tombstones remain one row per deleted ID and are the next per-account lifetime
growth boundary to measure.

Provider-backed tiers separated edge admission from model capacity:

| Active tier | Create p50/p95 | Turn acceptance p50/p95 | Acceptance-to-terminal p50/p95 | Total elapsed |
| --- | ---: | ---: | ---: | ---: |
| 10 agents, concurrency 10 | 1.399/2.003 s | 159/184 ms | 3.345/4.512 s | 7.54 s |
| 100 agents, concurrency 32 | 1.416/2.098 s | 182/217 ms | 10.555/71.856 s | 81.48 s |

Both active tiers completed and returned the account to its exact baseline.
At concurrency 32, edge acceptance remained fast while model completion p95
rose to about 72 seconds. That is provider/broker saturation, not a global
Durable Object coordinator. The production evidence therefore supports 100,000
independent durability actors and the no-global-coordinator path; one million
registered users is an architectural scaling projection, not a measurement of
one million simultaneous generations.

## Instrumentation gaps

Current browser performance marks are useful but incomplete:

- Marks do not identify local versus managed runtime.
- `terminal.ready` measures the first written terminal frame, not complete
  retained-history visibility.
- There are no marks for runtime-switch start, managed HTTP acceptance,
  browser-observed run start, history visible, or turn completion.
- Marks accumulate duplicate names and completion/failure is not timed.
- Managed success logs cover acceptance/admission/creation, but browser,
  managed, and egress timings lack one shared correlation view.
- Provider usage is not split into total, cached, and cache-write input tokens
  in this production comparison.
- There is no retained measurement of first-request bytes after direct
  snapshot, portable-journal, or Codex-rollout recovery.

Add runtime-labelled switch, acceptance, run-start, first-token, history-visible,
and completion timings before the next comparative performance pass. Add a
paired cold-recovery cache trial covering `store(false)` and `store(true)`, a
retained cache key and changed-key control, warm and expired provider-cache
windows, and all three recovery mechanisms.

## Cross-review correctness work

The durability/cache correctness boundaries identified during the production
review are implemented:

1. Durable model-step identity now covers the complete continuation-relevant
   profile: instructions and tool prefix, prompt-cache key, model, reasoning and
   effort controls, fast/store and transport configuration, endpoints, and
   typed history. Any semantic change rejects replay.
2. Active cancellation commits its safe interrupted checkpoint to the portable
   journal, preserving restored history and cache prefix.
3. Successful standalone compaction commits a model-only portable checkpoint,
   preserving the smaller replacement history across a cold reopen.
4. Durable attachment defaults the prompt-cache key to journal ID. Sequential
   owners retain it; cold reopen sends full typed history without a retained
   provider response ID.
5. A journal-replayed model step explicitly invalidates its old transport
   response ID. The next model/compaction request is a full typed-history replay
   under both `store(false)` and `store(true)`.
6. Idle routed prompts now pass through durable admission; terminal replay
   cannot publish before caller acceptance; stale browser projections cannot
   downgrade a winner's terminal row.

The prompt-cache conclusions and the remaining live cache benchmark are
maintained in [`PROMPT_CACHE_REVIEW.md`](PROMPT_CACHE_REVIEW.md). That review is
now incorporated here as the correctness explanation for why a cold durable
reopen is intentionally larger than a healthy warm continuation.

## Adversarial execution evidence

The post-review brutalism pass exercised the boundaries rather than relying on
source inspection:

- 100 consecutive runs of the 25-case Rust durable-Agent suite, including cold
  tool-step replay, owner replacement, routed prompts, terminal commit failure,
  and dropped replay acceptance;
- real multi-connection SQLite lock-order races and a configured PostgreSQL 18
  backend test for malformed schema and counter exhaustion;
- 100 local-runtime race rounds and 100 IndexedDB/Cloudflare-store rounds;
- real fake-IndexedDB retention, corruption, version/open, transaction-abort,
  and stale-terminal transitions;
- Miniflare Durable Object tests for eight concurrent duplicate submissions,
  same-ID/key conflicts, concrete latest-cursor reconnect, idle alarm versus
  admission, and injected WebSocket HTTP 503 recovery through an alarm; and
- a real final-build browser pass covering two-tab ownership takeover, exact
  prompt recovery, a GitHub API GET, native-touch mobile submission, managed
  completion, and local/managed reload.

This pass found defects hidden by the former green suites: idle routed prompts
bypassed durability; cold step replay reused a dead response ID; replay terminal
events could precede acceptance; stale tabs could downgrade completed
transcripts; JavaScript accepted already-rounded unsafe counters; terminal
retention was read-bounded but not storage-bounded; transient managed startup
failures became terminal; and a retryable managed row could be left without an
alarm. The final independent review additionally found idle routed terminal
replay publishing before acceptance and corrupt local sequence metadata
resetting to zero; both now fail their old behavior under dedicated regressions,
and the complete affected stress suites passed another 100 rounds.

The last hostile pass then found definitely-uncommitted terminal claims that
could not be reclaimed, developer checkpoints overtaking a pending retry,
compaction failures escaping or exposing uncommitted state, warmup bypassing
model authorization, cancellation-unsafe owner release, fail-open public policy
defaults, release-lane command starvation, transcript migration loss, managed
create/delete races, a pre-sharding retained-session cutover failure, synchronized
cleanup alarms, and proactive 429 rejection of a usable token. All now have
focused regressions in the Rust, binding, Worker, or browser-owned layer.

The release-gate pass found four more boundary defects: active cancel could
acknowledge a definitely uncommitted terminal, automatic compaction was outside
operation replay and checked authority too early, duplicate JavaScript Agent
construction could fence the live owner before reporting a duplicate, and an
acknowledged durable developer message could be retained in history yet omitted
from the next model request. It also closed retained managed deletion/construction
races, outer-terminal projection and cursor attachment gaps, hung local
recovery, response-body disposal failures, CONNECTING-socket/compiler cleanup,
localhost child ownership, and Worker-crash reservation leakage. These are
recorded as D-32 through D-42 in [`DURABILITY.md`](DURABILITY.md).

The final release review then closed six additional browser and service
boundaries: optimistic local rows now use their authoritative durable IDs;
Cloudflare disposal and failed Worker prewarm surrender lifecycle/session
capabilities; JavaScript PostgreSQL rejects sampled negative and overflow
counter domains; same-isolate credential restoration quarantines ambiguous
refresh claims; and subject-directory serialization is per subject rather than
held globally across shard I/O. A stalled shard therefore blocks only its own
subject, while unbind remains fail closed until the shard is reconciled.

The last concurrency pass closed six more release boundaries. Browser Web
Locks no longer span remote model I/O; the persisted Rust fence is the only
cross-tab execution arbiter. Managed initial history owns abortable requests
and retries after an actionable startup error or `online` transition. Transcript
projection is keyed by durable turn identity rather than globally colliding
display IDs or adjacency. Managed cancellation now persists control failure and
honors one authoritative `retry_at` across duplicate requests, reconstruction,
active Turns, and alarms. Failed Evals queries retry on remount. The localhost
orchestrator also treats same-uid `EPERM` from a reused process-group number as
proof that the old owned group no longer exists, avoiding a false fatal after
successful cleanup.

The final hostile browser/reviewer pass closed six additional boundaries that
were both correctness and latency risks. Local startup now rejects a port held
on either loopback family before expensive setup, preventing cross-server HMR
and nondeterministic request routing. Managed idempotent replay cannot bypass a
persisted admission deadline. Raw local events carry exact durable turn
identity, so recovery cannot consume a newer optimistic prompt. Managed history
attempts have hard deadlines even when a loader ignores abort, detached
terminals release result observers without cancelling server work, and durable
event cursors keep reasoning/tool identity stable when an older history page is
prepended. The exact two-tab browser transcript retained A, its tool call and
result, its final answer, then B in that order with no durability-policy text.

The release gate closed eight further lifecycle boundaries. Transcript merge
is global by durable turn rather than adjacency, and retained/live failures
deduplicate by that same identity. Managed request mutations outlive detachable
result observers; half-open SSE reads reconnect after a bounded idle interval.
Browser route unmount is presentation-only while an accepted Turn is live.
Managed credential ownership calls have hard deadlines even for non-cooperative
service bindings, while permanent account and subject tombstones prevent timed-
out late requests from resurrecting ownership. An ambiguous keyed create keeps
and refreshes the same preparation lease; keyless legacy creates compensate
immediately, and the durable watchdog owns abandonment. Deletion commits its
durable marker and alarm before the irreversible local tombstone. Finally, the
route-lifetime Agent wrapper preserves later Worker failure identity, so
heartbeat failure still publishes an actionable error and permits a fresh
generation.

Shared warmup suppression still has no expiry or capacity. That is a low-risk
performance/memory issue, not history corruption. Its policy should follow a
measured provider cache window rather than a guessed TTL.

## Final localhost browser measurements

The final release-candidate pass cold-opened every canonical route directly on
the owned localhost stack. Values are browser-observed development transfers,
not production bundle estimates.

| Route | FCP | LCP | TBT | transferred |
| --- | ---: | ---: | ---: | ---: |
| Agent | 292 ms | 416 ms | 9 ms | 351,678 B |
| Multiplayer | 292 ms | 292 ms | 7 ms | 37,359 B |
| World | 252 ms | 252 ms | 0 ms | 49,567 B |
| Changelog | 644 ms | 644 ms | 10 ms | 442,332 B |
| Commits | 292 ms | 524 ms | 9 ms | 125,024 B |
| Docs | 304 ms | 304 ms | 0 ms | 37,659 B |
| Evals | 284 ms | 284 ms | 0 ms | 38,151 B |
| Source | 224 ms | 432 ms | 0 ms | 385,822 B |

World's former `townBlocked` collision scan fell from about 95.72 ms self time
to about 1.53 ms after blocked tiles became one precomputed set; its measured
TBT is now zero. Changelog is the remaining cold outlier. If it is optimized,
the allowed experiment is one conventional router-owned declarative split and
a before/after browser comparison. A manual loader, module registry, preload
fan-out, or bespoke chunk graph is explicitly out of scope.

All eight direct entries had zero uncaught page errors, no raw durability-policy
text, and no horizontal overflow. Local and managed tool turns survived complete
document detachment and returned exactly once after reload. Two local tabs
converged after owner handoff; cancellation suppressed its final response;
steering was retained and changed the terminal answer; legacy raw policy text
was normalized on read. Managed native touch/IME completed once. Multiplayer
created a room, synchronized chat across two tabs, completed a room-agent turn,
survived reload/reconnect, and tore down cleanly. World controls,
Changelog-to-commit navigation, commit search/diff, docs browse, Evals, and
Source selection all passed through visible controls.

The iPhone SE, iPhone 15 Pro, Pixel 8, and Galaxy S24 samples had zero document
overflow and zero application layout findings after the 360-pixel navigation
fix. The embedded accessibility audit and axe reported zero violations; axe's
only incomplete result was indeterminate xterm contrast caused by overlapping
terminal presentation. The emulation provider continued to report its own
`screen`-dimension mismatch even though viewport and document dimensions were
correct, so that harness limitation is not counted as an application pass.

The final rebased production build emitted a 3,679.23 kB main client chunk
(947.48 kB gzip) and a 3,661.03 kB browser WASM asset. The connector UI now on
master folds the managed path into that main graph; no separate managed route
chunk was emitted. The main chunk warning is evidence for measuring a canonical
route split, not permission to add application-owned loading orchestration.

The cache interpretation is the one established in
[`PROMPT_CACHE_REVIEW.md`](PROMPT_CACHE_REVIEW.md): a healthy warm turn sends a
small delta with `previous_response_id`; a replacement transport deliberately
drops that ID and replays complete committed typed history under the same stable
cache key. Byte-stable prefixes, not response-ID persistence, are the durable
cache invariant. The live paired cache-hit benchmark remains required before
claiming a provider-side hit-rate or cold-reopen cost improvement.

## Ranked follow-ups

1. Measure and bound long-lived per-account deletion tombstones. The 100,000-ID
   churn wave did not collapse, but permanent anti-resurrection rows are the
   remaining account-lifetime growth term.
2. Add a terminal-specific managed-history projection that omits raw
   `api.event` envelopes while preserving the authoritative full event log.
3. Measure a conventional router-owned Changelog split of the 947.48 KB-gzip
   main client chunk against the 644 ms cold baseline and warm navigation;
   retain it only if both sides of the tradeoff pass.
4. Add runtime-labelled end-to-end timings and the paired cold-recovery cache
   benchmark described above.
5. Preserve explicit prompt-cache keys through Codex-rollout reconstruction.
6. Add correlated managed/egress cleanup timings, especially for the 35-second
   deletion tail, now that subject sharding and bounded retry are implemented.
7. Remove MCP transport negotiation and teardown churn while preserving fully
   deferred discovery.
8. Bound or expire shared warmup suppression using the cache benchmark's
   measured provider window.
9. Investigate the 60-122 ms terminal long task only after the production
   durability/log observation and cache benchmark are complete.
