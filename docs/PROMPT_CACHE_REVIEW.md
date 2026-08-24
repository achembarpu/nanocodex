# Prompt cache and durable recovery review

Status: reviewed, corrected, and dynamically verified, 2026-08-24.

Nanocodex's normal prompt-cache path is sound and closely matches the current
local Codex behavior. One agent retains a stable cache lineage, uses
`previous_response_id` for healthy incremental calls, and falls back to
authoritative full-history replay after retry, reconnect, checkpoint eviction,
or compaction.

Cold durable recovery preserves provider prompt-cache eligibility, but it does
not preserve provider checkpoint continuation. The review originally found
four durability/cache correctness defects, and the later hostile pass found an
unjournaled automatic-compaction boundary plus a durable developer-message
delta regression. The request-profile, model-owner, cancellation,
standalone/automatic-compaction, developer-context, and cold model-step replay
defects are now closed. Codex-rollout cache-key reconstruction and bounded
warmup suppression remain follow-up performance work.

## Current behavior

| Boundary | Retained behavior |
| --- | --- |
| Live agent | Stable cache key, persistent WebSocket, typed history, and healthy `previous_response_id` continuation |
| `store(true)` | Provider checkpoint may cross socket replacement and enables delta-sized in-memory forks |
| Portable `SessionSnapshot` | Model, lineage, cache key, completed request prefix, context, and complete typed history; a new runtime rebinds its current prefix |
| Cold process recovery | Full-history replay with the retained cache key; no `previous_response_id` |
| Codex rollout reconstruction | History survives, but an explicit cache key is currently replaced by the thread ID |

Roots default their prompt-cache key to their stable lineage/session ID.
Explicit keys are serialized on warmup, generation, compaction, retry, and
replay requests. Forks and descendants retain the root cache lineage while
using distinct session IDs.

Healthy calls send only their delta with `previous_response_id`. Physical
retry, a non-durable replacement socket, checkpoint eviction, and installed
compaction history switch to complete client-owned history while retaining the
same cache key.

Provider response IDs are deliberately excluded from `SessionSnapshot`.
Consequently, even with `store(true)`, the first request after a cold durable
restart is a full replay. It can receive cached-input pricing while the provider
prompt cache remains warm, but it does not get the smaller stored-checkpoint
request. Today `store(true)` improves live socket replacement and in-memory
forks, not process restart.

A completed snapshot does not freeze application policy forever. On cold
resume, the retained typed history and prompt-cache lineage remain
authoritative, while the newly deployed runtime rebuilds the request prefix
from its current instructions, tool definitions, and handlers. If that prefix
changed, the provider may miss the old cached prefix even though the stable key
is retained. An unfinished recorded model step is stricter: its exact old
request profile remains part of the durable step definition and cannot replay
under changed semantics.

## Findings

### PC-01 — Closed high: pending model replay was not bound to the request profile

The original durable model-step identity recorded the model, reasoning mode,
effort, fast mode, and conversation history, but omitted the prompt-cache key,
immutable request prefix, base instructions, and tool definitions.

If the first durable operation crashes after its model result is journaled but
before a terminal snapshot exists, recovery has no prior `SessionSnapshot` to
validate. A newly configured agent can therefore replay a result produced under
old instructions or tools, then commit it under a new request prefix and cache
identity. The journal considers the model step unchanged because those inputs
were not part of its recorded definition.

Evidence:

- `crates/nanocodex-agent/src/model/run/responses.rs:3-10,75-101`
- `crates/nanocodex-durability/src/session.rs:385-425`
- `crates/nanocodex-agent/src/agent/spawn.rs:21-24,68-73`

Implemented fix: each recorded model step is bound to a stable request-profile
fingerprint covering the exact immutable prefix, prompt-cache key, model, and
every non-input request control that affects continuation compatibility.
Recovery must reject configuration drift rather than replaying an output under
a different profile.

Regression: complete the first operation's model step, fail its terminal
append, restart with changed instructions, tools, and cache key, and assert that
the old model result cannot replay.

### PC-02 — Closed high: multiple live agents could regress history and cache lineage

The original attachment path read the latest checkpoint once while building an
agent and had no persisted authority for the model owner. Two agents attached
to the same journal could therefore retain different in-memory histories.

Agent A may commit operation 1, after which stale Agent B begins operation 2
and commits a later snapshot built without operation 1. The journal remains
internally ordered, but its newest model checkpoint regresses conversation
history and may replace the prompt-cache key selected by Agent A. Replaying a
completed admission returns its snapshot in `TurnResult`; it does not install
that snapshot into the stale live agent.

Evidence:

- `crates/nanocodex-durability/src/agent.rs:23-41`
- `crates/nanocodex-durability/src/session.rs:522-530`
- `crates/nanocodex-agent/src/agent/driver/mod.rs:1060-1068`

Implemented fix: every store persists a monotonic owner fence. Acquisition
installs a fresh owner and reads one journal snapshot atomically; every append
checks the complete owner token before revision. A newer Agent therefore fences
every stale Agent before model work or checkpoint mutation. Generation-scoped
Agent capabilities and caller-scoped claims enforce the same rule inside one
process.

Regression: build Agents A and B from one empty journal, complete operation 1
on A and operation 2 on B, reopen, and assert that the latest snapshot contains
both turns and one stable cache lineage.

### PC-03 — Medium: rollout resume replaces explicit cache keys

A normal committed snapshot copies the active prompt-cache key. Codex rollout
reconstruction instead assigns `prompt_cache_key = thread_id`. An agent that
originally used a caller-defined shared cache key therefore resumes under its
thread UUID, and configuring the original key during resume is rejected as a
mismatch.

Evidence:

- `crates/nanocodex-agent/src/session.rs:66-76,137-142`
- `crates/nanocodex-agent/src/rollout/load.rs:75-84`
- `crates/nanocodex-agent/tests/it/model/persistence.rs:154-168`

Required fix: persist the prompt-cache key in the rollout session metadata and
restore it directly. Do not infer it from thread identity.

### PC-04 — Closed medium: portable durability did not retain standalone compaction

Compaction installs replacement history into the live agent, but the attached
portable execution policy is disabled for standalone compaction. Only the
Codex rollout projection records that boundary. A crash before the next
terminal prompt restores the older un-compacted history and loses the reduced
request shape.

This is primarily a durability and performance gap: authoritative older
history remains available, but cold recovery can regain a much larger prompt
and different cache prefix than the live agent had already installed.

Evidence:

- `crates/nanocodex-agent/src/agent/driver/mod.rs:446-462`
- `crates/nanocodex-agent/src/agent/execution/mod.rs:351-384`

Implemented fix: successful standalone compaction commits a model-only
`CheckpointCommitted` entry in the portable journal. Cold reopen selects that
checkpoint without fabricating a user operation. Failed or cancelled
compaction never publishes an uncommitted replacement snapshot.

### PC-06 — Closed high: cold step replay reused a dead transport response ID

A model step can commit before its containing operation terminal commits. On a
new owner, replaying that step used to reinstall its provider response ID even
though the WebSocket that created it was gone. The next model call could send a
delta against a socket-local or unretained checkpoint.

Implemented fix: a journal-replayed model result remains authoritative typed
history but explicitly carries no valid transport continuation. The response
chain is cleared and the next generation or compaction sends full typed history
with the retained cache key, for both `store(false)` and `store(true)`.

Regression: `cold_model_step_replay_never_reuses_the_replaced_transport_chain`
crashes after a tool-calling model step, reopens under a new owner, and asserts
that model call two has no `previous_response_id`, is a full replay, and
contains the prompt, model output, and tool result.

### PC-07 — Closed high: automatic compaction was outside operation replay

Pre-turn and mid-turn compaction could call the provider without a durable step
owned by the accepted operation. A crash after compaction or an owner takeover
around provider entry could therefore repeat paid work, allow a later operation
to overtake the unfinished one, or use authority checked too early.

Implemented fix: automatic compaction records stable semantic input as an
idempotent step inside the operation journal, authorizes the model effect again
immediately before provider entry, and retains the replacement output for exact
replay. A definitely uncommitted terminal append reclaims that same operation
and reuses the completed compaction.

Regressions:
`automatic_compaction_replays_a_after_terminal_not_committed_instead_of_running_b`
and
`takeover_during_automatic_compaction_authorization_fences_before_provider_entry`.

### PC-08 — Closed high: durable developer context could miss the next request

Acknowledging an adapter developer message correctly persisted its checkpoint,
but checkpoint publication could clear the model delta even though no provider
had observed the message. Recovery retained the text while the next paid
request omitted it.

Implemented fix: the durable checkpoint seals storage structure without
advancing provider continuation state and explicitly preserves the inherited
delta across live and cold reconstruction. Only a completed provider response
may move the continuation boundary past the developer message.

Regressions: the adapter developer-context model-input test and
`acknowledged_developer_context_survives_a_cold_reopen`.

### PC-05 — Low: shared warmup suppression never expires

`SharedPromptCache` stores completed `OnceCell`s without TTL, capacity, or
eviction. A long-lived cloned builder permanently skips later warmups for a
fingerprint even after provider cache expiry. Varying fingerprints also grow
the map without bound.

This does not corrupt history. It can move connection and cache-write work back
onto a later first generation and retain unnecessary process memory.

Evidence:

- `crates/nanocodex-agent/src/prompt_cache.rs:9-49`
- `crates/nanocodex-agent/src/model/run/lifecycle.rs:113-156`
- `crates/nanocodex-agent/tests/it/model/branching/spawn.rs:241-304`

Required fix: either scope the singleflight object to a bounded startup wave or
give completed entries an explicit expiry/eviction policy based on measured
provider behavior.

## Related durable-state closure

Active cancellation originally installed a safe interrupted checkpoint only in
the live driver. It now commits that checkpoint atomically with
`OperationCancelled`; queued cancellation remains checkpoint-free because it
never started model work. Cold recovery therefore retains the cancelled prompt
and safe completed tool progress without exposing partial assistant output.

Evidence:

- `crates/nanocodex-agent/src/model/run/turn.rs:216-242`
- `crates/nanocodex-agent/src/agent/execution/mod.rs:541-563`
- `crates/nanocodex-durability/src/journal.rs:118-122,246-261`

## Codex comparison

The local Codex checkout at
`openai/codex@50ea8fd411422b3f7bc906bcde6c1c4432019a2e` uses stable session
identity as the normal prompt-cache key. Descendants share the root session
identity. `previous_response_id` is opportunistic WebSocket state: Codex keeps
it only after a completed response and only while the next request is a strict
compatible extension on the usable socket.

Cold restore, socket replacement, changed non-input request fields, and
post-compaction replacement history send complete client-owned history without
`previous_response_id`, retaining the same prompt-cache key. Codex currently
uses `store: false`; Nanocodex's `store(true)` continuation across replacement
sockets is an intentional extension.

Relevant local Codex evidence:

- `~/github/openai/codex/codex-rs/core/src/client.rs:306-362,477-497`
- `~/github/openai/codex/codex-rs/core/src/client.rs:944-963`
- `~/github/openai/codex/codex-rs/core/src/client.rs:1240-1319`
- `~/github/openai/codex/codex-rs/core/src/client.rs:1389-1424`

This comparison records current behavior only. It does not advance
Nanocodex's reviewed Codex parity checkpoint.

## Validation gaps and release evidence

Executable coverage proves request-key serialization, fork inheritance, shared
warmup singleflight, full replay after reconnect/checkpoint miss/compaction,
semantic-drift rejection, sequential fenced owners, cancellation and
standalone-compaction checkpoints, and cold model-step replay without a stale
response ID. Durable builder attachment is now single-use across clones, so a
losing construction cannot acquire authority or change the winning Agent's
cache lineage. A stopped policy-owning driver also preserves
`reopen_required`, ensuring its consumer constructs a fresh owner that keeps
the journal-derived cache key while dropping the dead response ID. The Node
binding also proves that direct cold snapshot resume
keeps `prompt_cache_key`, omits `previous_response_id`, and replays complete
history.

There is no live cold-restart prompt-cache benchmark. The stored-fork benchmark
measures in-memory historical forks, not portable journal recovery. Before
making a durable cache-performance claim, run paired live trials that record:

- first post-restart request bytes;
- total, cached, and cache-write input tokens;
- time to first event/output and terminal latency;
- `store(false)` versus `store(true)`;
- retained key versus a deliberately changed-key control;
- direct `SessionSnapshot`, portable journal, and Codex rollout recovery; and
- warm-cache restart versus restart after the provider cache is expected to
  have expired.

The remaining evidence gap is live provider cache effectiveness, not durability
correctness: record cached/cache-write token accounting and request bytes under
the paired trial above before making a post-restart performance claim.
