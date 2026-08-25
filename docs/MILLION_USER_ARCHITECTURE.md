# Million-user managed architecture

Status: implemented and production-tested. This document describes the current
no-global-coordinator topology, the remaining signed-capability target, and the
split between live coordination state and retained history.

## Measured and implemented first slice

The initial instrumented Worker test proved four things:

- one ordinary completed managed turn populated the append-only Rust durability
  journal, the managed cursor log, and the managed turn receipt;
- the same raw model/tool event content was retained in both the Cloudflare SDK
  event table and the managed cursor table;
- the runtime journal ID is derived from the adapter's retained
  `nanocodex_cloudflare_agent.session_id`, not the public managed agent ID; and
- SQLite database size materially exceeds known JSON payload bytes, so indexes,
  workspace state, and page overhead must stay visible as an unattributed
  remainder rather than being guessed away.

The current implementation:

- emits structured per-agent capacity snapshots after construction, at
  power-of-two terminal milestones, and before idle shutdown;
- exposes the same accounting through an internal-only AgentDO route for load
  and regression probes;
- enables automatic Worker traces across the web, managed, and egress Workers;
- lets an embedding Durable Object explicitly own event persistence; managed
  agents use that mode, clear the old raw event projection on reopen, and retain
  only `managed_events`; and
- fixes `Agent.extend()` so nested adapter actions such as `events.connect` and
  `turn.route` are actually merged at runtime instead of existing only in the
  type declarations;
- compacts 64 or more terminal Rust journal batches into one fenced checkpoint
  batch without rewinding the revision, while retaining exact completed-ID
  replay receipts and every unresolved operation; and
- prevents a cold alarm from taking the idle-shutdown path while SQLite still
  owns accepted, cancelling, or retryable work. A real browser detach/reconnect
  run exposed this race: the outer turn remained accepted while repeated idle
  shutdowns fenced admission before the first journal revision. The corrected
  run recovered that same accepted turn and committed its terminal after the
  browser re-authorized the reconnect.
- seals old managed cursor events into immutable, checksum-verified R2
  segments while retaining a bounded SQLite tail. Sixteen recent segment
  descriptors stay hot; older descriptors move into immutable ordinal R2
  index pages behind one SQLite root. History and SSE use one logical cursor
  space across both tiers, binary-search old pages, and retry a read if the
  SQLite ownership fence moves;
- archives old terminal turn/idempotency receipts under deterministic per-agent
  R2 keys while keeping unresolved work and 512 recent terminals in SQLite.
  Exact old-ID replay and request-key conflict detection read those immutable
  receipts before admitting any new model work;
- removes the unused `completed_operations` mirror and retains lifetime
  accepted/completed counts plus the original title prompt as bounded session
  metadata; and
- archives completed realtime operation receipts under one deterministic
  compound-identity key while keeping pending operations and 512 recent exact
  replays in SQLite; and
- lets an embedding select a bounded Rust terminal-receipt checkpoint policy.
  Managed selects 512 only because its outer receipt archive preserves older
  exact results first. Successful compaction prunes both the stored checkpoint
  and the live Rust state; all other SDK consumers keep indefinite replay by
  default;
- routes every credential subject directly to the existing
  `agent-subject-v1:<subject>` Durable Object. The old `agent-subjects-v1`
  singleton is unreachable from production requests and retained only as
  forensic cutover evidence;
- stores each account/agent membership and deletion tombstone as its own
  `UserAccount` SQLite row. Create, activity, detach, and deletion no longer
  rewrite an account-sized JSON array or summary object; and
- replays every idempotent public agent-creation stage with bounded
  exponential jitter for transport failure, HTTP 408/429, or 5xx. Preparation
  absorbs four consecutive transient responses; later stages replay once. A
  caller `Idempotency-Key` derives one account-scoped agent UUID, so an outer
  lost response also retries the same identity and byte-identical request. A
  definitive 4xx enters the existing durable cleanup path immediately.

The hot durability head is now bounded by explicit policy. Model checkpoints,
unresolved operations, ambiguous steps, recent exact receipts, recent managed
events, and the small manifest head remain in SQLite. Closed cursor history and
old exact receipts are immutable R2 data. The durable workspace remains a
separate caller-visible storage budget; it is not journal history and is never
silently moved or expired.

## Production scale evidence

Production currently runs the durability implementation from
`536345ad97cecf6a9af52bd100c6d475f15f9b70` as managed deployment
`718abf2c-7927-4e19-8d55-1d75434428e2`. The website deployment
`15242374-9513-4dac-ac06-c9103cc5bdc2` attests the same source revision. A real
authenticated browser created a fresh managed agent, completed
`CREATE_REPLAY_FINAL_OK`, reloaded the document, and recovered the exact prompt
and answer with zero page errors.

The final public-API control wave concentrated 100,000 agent creates, state
reads, and terminal deletions through one account at concurrency 128. It
completed in 35 minutes 58 seconds. Create throughput was 87.15/s with 1.392 s
p50 and 2.410 s p99; isolated state reads were 359.49/s; deletion was 136.64/s
with 873 ms p50 and a 34.755 s maximum. All 38 initially pending deletions
settled, exact run-ID verification took 194 ms, and the account returned from
28 ordinary agents to the same 28.

Provider-backed waves also completed at 10 agents/concurrency 10 and 100
agents/concurrency 32. Turn acceptance remained 182 ms p50 and 217 ms p95 in
the larger wave, but acceptance-to-terminal latency rose to 10.555 s p50 and
71.856 s p95. The edge coordination path remained responsive; the shared
provider/broker path was the observed active-generation bottleneck.

This validates 100,000 independent AgentDO control-plane lifecycles and, more
stringently, 100,000 membership mutations through one UserAccountDO. It does
not measure one million simultaneous model generations. One million registered
users remains a topology claim based on deterministic per-user and per-agent
sharding, with provider capacity sized independently.

## Scale target

The design target is one million registered users and agents, at least one
hundred thousand mostly idle connected clients, and ten thousand concurrently
active agents without a deployment-global mutable owner.

The governing rule is simple:

> Every independently operating identity routes directly to its own atom of
> coordination. No product request consults a global directory, allocator,
> quota actor, journal owner, or deployment owner.

## Current topology

```text
 Browser / API client
          |
          | cookie or Nanocodex API key
          v
 +----------------------+        service binding
 | Website Worker       |-------------------------------+
 | managed API proxy    |                               |
 +----------------------+                               v
                                              +----------------------+
                                              | Managed Worker       |
                                              | public route/auth    |
                                              +----------+-----------+
                                                         |
                  +--------------------------------------+-------------------+
                  |                                      |                   |
                  v                                      v                   v
       +----------------------+              +------------------+   +------------------+
       | Fixed-name auth DOs  |              | UserAccountDO    |   | NanocodexSession |
       | account / webauthn / |              | keyed by user    |   | keyed by agent   |
       | account-link state   |              +------------------+   +---------+--------+
       +----------------------+              | one SQL row per  |             |
                                             | agent + tombstone|             |
                                             +------------------+             |
                                                                                |
                           one agent's SQLite storage                      |
                 +--------------------------------------------------------+
                 |                                                        |
                 |  session_state                                         |
                 |  managed_turns              unresolved + recent exact  |
                 |  managed_events             bounded managed tail       |
                 |  managed_realtime_operations pending + recent exact    |
                 |  archive manifests          bounded R2 ownership heads |
                 |  nanocodex_cloudflare_events disabled for managed mode |
                 |  nanocodex_journal_owners   current fence              |
                 |  nanocodex_journals         current revision           |
                 |  nanocodex_journal_batches  checkpoint + recent tail   |
                 |  workspace / Computer state                            |
                 +--------------------------------------------------------+
                                                                          |
                                                                          v
                                                              +----------------------+
                                                              | Egress Worker        |
                                                              +----------+-----------+
                                                                         |
                     +---------------------------------------------------+
                     | deterministic name                                |
                     v                                                   v
       +----------------------------------+                       +------------------+
       | AgentSubjectDirectory(subject)   |---------------------->| User credential  |
       | agent-subject-v1:<subject>       | resolved user ID      | DO(user ID)      |
       | bound | permanent tombstone      |                       +--------+---------+
       +----------------------------------+                                |
                                                                           v
                                                                      Provider
```

The normal session actor is the atom for turn ordering, durability, client
fanout, and model ownership. Subject ownership is also sharded one object per
subject, and account indexing is row-wise. No request crosses a mutable
deployment-global subject or account registry. The remaining scale variable is
per-agent historical data retained in the hot SQLite database.

Current source anchors:

- `services/managed/src/index.ts` owns the session, managed turns, managed
  event projection, and idempotent create/cleanup state machine;
- `services/managed/src/account-auth.ts` owns the row-wise account agent index;
- `services/managed/src/durable-events.ts` owns managed cursor replay;
- `js/bindings/cloudflare/Agent.mjs` installs the raw AgentEvent projection;
- `js/bindings/cloudflare/event-socket.mjs` retains raw AgentEvents;
- `js/bindings/runtime/durability-store.mjs` retains and reloads journal
  batches; and
- `services/egress/src/egress.ts` and `services/egress/src/broker.ts` route to
  and own the direct one-subject state machines.

## What currently grows

There are two independent lifetime axes: a user's account index grows with
agent-ID churn, while each agent's hot and archived state grows with its own
conversation. Neither is deployment-global.

### Account membership tombstones

`UserAccount.user_agents` stores one active row or permanent deletion tombstone
per agent ID. The tombstone prevents a delayed attach or replayed create from
resurrecting deleted ownership. The 100,000-agent wave showed that one
concentrated account remains functional at that size, but repeated lifetime
churn is unbounded today. Deleting tombstones without another permanent
anti-resurrection proof would reintroduce the race, so any compaction must first
replace their semantic role rather than merely expire rows.

### Durability journal

`nanocodex_journal_batches` stores one payload for every journal revision.
Acquisition loads every retained batch in revision order and reduces the whole
journal in memory. Terminal entries carry safe resumable checkpoints and
results, so retained bytes can grow faster than the number of turns when those
checkpoints are large.

The managed policy now compacts a terminal prefix after 64 retained batches
and keeps only unresolved operations plus the 512 newest exact receipts in the
live and stored Rust state. The outer managed receipt archive preserves older
API replay identities. The latest checkpoint itself can still grow with the
model's retained conversation and remains an explicit hot-head budget.

### Managed turns and idempotency

`managed_turns` retains every unresolved turn and the newest 512 terminal
receipts. Older terminal and idempotency receipts move to direct-lookup R2
objects. Once an agent has archived receipts, a genuinely new ID pays an R2
miss because indefinite exact-ID conflict detection cannot safely infer
absence from a bounded local filter.

### Two event histories (inherited topology)

The Cloudflare adapter stores every raw `AgentEvent` in
`nanocodex_cloudflare_events`, capped at 64 MiB. The managed application watches
that stream, wraps it as a managed stream message, and stores it again in
`managed_events`, also capped at 64 MiB. Managed acceptance, cancellation, and
terminal messages are added to the second log as well.

This is intentional layering today, but it means much of the largest streaming
content is retained twice. When `managed_events` reaches its admission ceiling,
the agent rejects new work until it is deleted or replaced.

The first implementation slice removes this duplication for the managed
application. The Cloudflare SDK keeps durable event persistence as its default,
while the managed AgentDO selects caller-owned persistence and uses its managed
cursor log as the canonical retained stream. This preserves SDK behavior for
other embedders and removes stale raw rows when an existing managed agent next
opens.

### Workspace

The retained Computer filesystem shares the session's Durable Object storage.
It is not loaded as part of journal recovery, but it contributes independently
to the per-agent SQLite size and requires its own retention policy.

## Remaining target topology

```text
 Browser / SDK
      |
      v
 +---------------------------+
 | Stateless edge router     |
 | authenticate + route only |
 +----+------------------+---+
      |                  |
      |                  +---------------- deterministic identity ----------------+
      |                                                                        |
      v                                                                        v
 +--------------------------+                                    +--------------------------+
 | Identity actors          |                                    | User index shards        |
 | SessionDO(token hash)    |                                    | AgentIndexDO(user,bucket)|
 | PasskeyDO(credential ID) |                                    +--------------------------+
 | ApiKeyDO(key hash)       |
 | LoginDO(challenge hash)  |
 +--------------------------+
      |
      | authorized agent ID
      v
 +----------------------------------------------------------------------------------+
 | AgentDO(agent ID) -- sole authoritative owner                                    |
 |                                                                                  |
 | SQLite coordination head                                                         |
 |   owner epoch + journal fence                                                     |
 |   latest resumable model checkpoint                                               |
 |   unresolved operations and tool steps                                            |
 |   bounded recent idempotency/terminal receipts                                    |
 |   recent event tail + monotonic cursor                                             |
 |   immutable-segment manifest                                                      |
 |                                                                                  |
 | In memory                                                                         |
 |   owned Agent runtime + upstream socket                                            |
 |   hibernatable client WebSockets                                                  |
 +-----------+-----------------------------------------------------------+----------+
             |                                                           |
             | signed (agent, user, epoch) capability                    | sealed immutable data
             v                                                           v
 +--------------------------+                                +---------------------------+
 | CredentialDO(user ID)    |                                | R2 agent history          |
 | credential mutations     |                                | event segments            |
 | short-lived leases       |                                | old operation receipts    |
 +------------+-------------+                                | optional checkpoint backup|
              |                                              +---------------------------+
              v
          Provider
```

There is no subject directory. `AgentDO` durably stores its owner and presents
a private signed capability containing the agent ID, owner user ID, and current
owner epoch. Egress verifies the capability statelessly and routes directly to
`CredentialDO(user ID)`.

## SQLite and R2 boundary

R2 should not become the live journal.

The live journal needs atomic revision comparison, current-owner fencing,
ordered admission, exact unresolved-operation state, and a checkpoint commit
that agrees with the accepted terminal. Agent-local SQLite already owns those
properties with the lowest coordination cost.

R2 is a good fit for immutable closed prefixes because it supplies strongly
consistent reads, writes, listings, and deletes through Worker bindings, large
objects, checksums, and conditional writes. It is not transactionally coupled
to AgentDO SQLite, so the cut protocol must make partial progress harmless.

### Hot coordination head in SQLite

Keep only what is required to execute or recover the next operation:

- current owner ID, epoch, and fence;
- latest complete resumable model checkpoint;
- unresolved operations and ambiguous tool steps;
- a bounded recent idempotency and terminal-replay window;
- recent events needed for reconnect-to-live delivery;
- the next journal revision and event cursor;
- a bounded recent segment window and immutable archive-index root; and
- workspace metadata and actively retained files.

Cold Agent construction reads this bounded head only. It never scans R2 and
never replays the complete lifetime journal.

### Immutable history body in R2

Implemented deterministic keys:

```text
agents/<storage-id>/managed-events/segments/<first>-<last>-<sha256>.json
agents/<storage-id>/managed-events/indexes/<zero-padded-ordinal>.json
agents/<storage-id>/managed-turns/by-id/<sha256(turn-id)>.json
agents/<storage-id>/managed-turns/by-request/<sha256(request-key)>.json
agents/<storage-id>/managed-realtime/by-id/<sha256(voice-session + operation)>.json
```

Objects are immutable. The AgentDO's SQLite manifest is authoritative; bucket
listing is never part of correctness or normal restoration.

The manifest must also remain bounded. Recent segment descriptors can remain in
SQLite, but older descriptors are packed into immutable R2 index nodes. SQLite
retains the newest ordinal key, page count, and a small recent window rather
than one row for every lifetime segment. History pagination binary-searches
immutable per-agent pages; it never lists the bucket or consults a global
catalog.

The archive body serves full transcript/history pagination, old exact-ID result
lookup, audit/debug export, and recovery evidence. R2 is absent from cold Agent
construction. After the first receipt is archived, new turn admission performs
a direct R2 absence lookup before provider execution to preserve indefinite
exact-ID and idempotency semantics.

### Sealing protocol

Only the owning AgentDO may seal one of its committed prefixes. `needsSeal` is
the local capacity predicate that decides whether archival work is due; it is
not a lock, lease, consensus vote, or ownership signal. Events need sealing
when local event bytes reach their configured threshold. Turn and realtime
archives need sealing when completed terminal receipts exceed their retained
hot counts. A true result schedules or performs an idempotent cut of older,
already-immutable rows to R2 while preserving the bounded SQLite head. The
AgentDO's existing fence remains the only authority for the cut.

```text
 1. Select a closed event prefix or terminal-receipt set. Unresolved turns are
    never eligible.

 2. Encode the immutable segment with:
      first/last revision or cursor
      payload checksum

 3. PUT an immutable deterministic-key R2 object with a create-only condition.
    Segment bodies are content-addressed; ordinal index and receipt keys bind
    their fenced identity. Await the successful, checksum-validated write.

 4. In one AgentDO SQLite transaction:
      insert the recent sealed descriptor or advance the archive-index root
      advance the local base revision/cursor
      delete the sealed local prefix

 5. Continue normal execution from the bounded local tail.
```

Crash behavior is deliberately one-directional:

- Crash before step 3 completes: SQLite still owns the complete prefix.
- R2 succeeds, crash before step 4: an unreferenced immutable object exists;
  SQLite still owns the complete prefix and sealing may retry safely.
- Step 4 commits: the manifest points to an already durable object and the
  latest checkpoint remains local.
- Crash after step 4: restoration uses the local checkpoint and tail; history
  readers may fetch the sealed segment by its manifest.

No global compactor is introduced. Each AgentDO seals its own history at a safe
terminal boundary or from its own alarm.

## Reduce before exporting

R2 should not preserve accidental duplication forever. The order of work is:

1. **Implemented for owned tables:** measure bytes and rows independently for
   journal batches, managed events, raw AgentEvents, turn receipts, realtime
   receipts, and the SQLite remainder. Computer workspace bytes are still part
   of the visible remainder and need a first-class Computer accounting API.
2. **Implemented:** remove the second full event projection or make the managed
   stream a typed view over one canonical retained event log.
3. **Implemented for capable stores:** teach the durability journal to
   checkpoint and discard a closed prefix while retaining the latest
   checkpoint, unresolved work, and a caller-selected recent replay window.
4. **Implemented:** keep recent reconnect and idempotency data locally and move
   older exact receipts to deterministic immutable R2 objects.
5. **Implemented:** move closed managed-event prefixes into bounded immutable
   R2 segments with a bounded hot manifest and binary-searchable ordinal index.

Deletion is preferable to moving redundant data.

## Measurements required for threshold tuning

Emit these dimensions per agent without requiring a global actor:

- journal batch count and encoded bytes;
- latest checkpoint bytes and checkpoint growth per completed turn;
- managed event rows/bytes;
- raw AgentEvent rows/bytes;
- managed-turn rows, input bytes, and terminal bytes;
- workspace file count and retained bytes;
- cold journal load and reducer time;
- cold Agent construction and restored upstream-connect time;
- history-page latency from local SQLite and R2;
- sealed segment size, upload duration, and compaction duration; and
- local head size after sealing.

The next retained production-shaped sample should determine whether
checkpoints, tool output, assistant deltas, or workspaces dominate. Current
thresholds establish bounded behavior; this evidence is still required to tune
them for cold-start and storage cost rather than guesswork.

## Decisions and open questions

Decisions:

- AgentDO SQLite remains the sole live durability authority.
- R2 stores immutable historical bodies, never the mutable journal head.
- The latest complete resumable checkpoint remains local.
- Every segment is agent-namespaced and content-addressed.
- Every AgentDO compacts itself; there is no global compactor.
- One canonical retained event log should replace the current duplicated logs.
- Cold execution must not depend on reading historical R2 segments.

Resolved product questions:

- Exact-ID terminal replay remains indefinite for managed agents. Recent
  receipts are local; old receipts are direct R2 lookups.
- The complete managed cursor stream remains available through the existing
  history and SSE APIs. R2 is an internal storage tier, not a second API.
- Archived JSON is versioned and checksum-verified but not required to preserve
  incidental source JSON whitespace.

Open questions:

- Which workspace paths are durable product state versus disposable tool
  scratch data?
- What checkpoint and local-tail sizes keep cold restoration within the target
  p99 latency?
