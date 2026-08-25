# Million-user managed architecture

Status: active implementation on `codex/million-user-architecture`. This
document describes the inherited managed-agent topology, the intended
no-global-coordinator topology, and the split between live coordination state
and retained history. The measured/implemented section below records what has
already changed on this branch.

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

This branch now:

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
  default.

The hot durability head is now bounded by explicit policy. Model checkpoints,
unresolved operations, ambiguous steps, recent exact receipts, recent managed
events, and the small manifest head remain in SQLite. Closed cursor history and
old exact receipts are immutable R2 data. The durable workspace remains a
separate caller-visible storage budget; it is not journal history and is never
silently moved or expired.

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
       +----------------------+                                           |
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
                     +---------------------------------------------------+------------+
                     |                                                   |            |
                     v                                                   v            v
       +-----------------------------+                    +-------------------+  +----------+
       | AgentSubjectDirectory       |                    | Subject shard     |  | User     |
       | "agent-subjects-v1"         |<------------------>| keyed by subject  |  | credential|
       | deployment-global authority |                    +-------------------+  | broker   |
       +-----------------------------+                                           +----+-----+
                                                                                      |
                                                                                      v
                                                                                 Provider
```

The normal session actor is already the correct atom for turn ordering,
durability, client fanout, and model ownership. The scale problems are the
shared identity paths around it and the amount of historical data retained in
its hot SQLite database.

Current source anchors:

- `services/managed/src/index.ts` owns the session, managed turns, and managed
  event projection;
- `services/managed/src/durable-events.ts` owns managed cursor replay;
- `js/bindings/cloudflare/Agent.mjs` installs the raw AgentEvent projection;
- `js/bindings/cloudflare/event-socket.mjs` retains raw AgentEvents;
- `js/bindings/runtime/durability-store.mjs` retains and reloads journal
  batches; and
- `services/egress/src/egress.ts` and `services/egress/src/broker.ts` own the
  legacy authority and subject shards.

## What currently grows

All of the following are per agent, which prevents a global storage hotspot,
but their retained size and cold-read cost still grow with agent lifetime.

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

## Proposed topology

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

Only the owning AgentDO may seal one of its committed prefixes.

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

## Measurements required before choosing thresholds

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

The first prototype should use retained production-shaped agents to determine
whether checkpoints, tool output, assistant deltas, or workspaces dominate. A
threshold selected before those measurements would only hide the current
growth pattern.

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
