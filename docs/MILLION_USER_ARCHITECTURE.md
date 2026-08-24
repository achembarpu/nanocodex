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

The compaction bounds journal row count and repeated checkpoint copies, not the
total lifetime receipt bytes inside the checkpoint. Exact completed-ID replay
still grows linearly until the product chooses a retention contract and the R2
archive/read path exists.

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
                 |  managed_turns              input + terminal forever   |
                 |  managed_events             managed API projection     |
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

The journal is deleted only when the agent is destroyed. Model compaction
changes the checkpoint's conversation content; it does not currently seal and
discard the older persistence batches.

### Managed turns and idempotency

`managed_turns` retains the request hash, complete input, state, terminal JSON,
cursor, diagnostics, retry state, and timestamps for every accepted turn. It
provides exact-ID replay and idempotency conflict detection, but has no age or
count compaction policy.

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

Possible deterministic keys:

```text
agents/<agent-id>/events/<first-cursor>-<last-cursor>-<sha256>.cbor.zst
agents/<agent-id>/operations/<first-revision>-<last-revision>-<sha256>.cbor.zst
agents/<agent-id>/checkpoints/<revision>-<sha256>.json.zst
```

Objects are immutable. The AgentDO's SQLite manifest is authoritative; bucket
listing is never part of correctness or normal restoration.

The manifest must also remain bounded. Recent segment descriptors can remain in
SQLite, but older descriptors are packed into immutable R2 index nodes. SQLite
retains the current index root, chained hash, and a small recent window rather
than one row for every lifetime segment. History pagination walks the immutable
per-agent index; it never lists the bucket or consults a global catalog.

The archive body serves full transcript/history pagination, old exact-ID result
lookup if that contract remains indefinite, audit/debug export, and recovery
evidence. It does not sit between turn admission and provider execution.

### Sealing protocol

Only the owning AgentDO may seal one of its committed prefixes.

```text
 1. Select a closed prefix ending at a safe checkpoint.
    It must contain no unresolved operation or ambiguous tool step.

 2. Encode the immutable segment with:
      agent ID
      owner epoch
      first/last revision or cursor
      previous segment hash
      ending checkpoint hash
      payload checksum

 3. PUT an immutable content-addressed R2 object with a create-only condition.
    Await the successful, checksum-validated write.

 4. In one AgentDO SQLite transaction:
      insert the recent sealed descriptor or advance the archive-index root
      advance the local base revision/cursor
      retain the ending checkpoint locally
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

1. **Implemented:** measure bytes and rows independently for journal batches,
   managed events, raw AgentEvents, turn receipts, checkpoints, and workspace
   data.
2. **Implemented:** remove the second full event projection or make the managed
   stream a typed view over one canonical retained event log.
3. **Implemented for capable stores:** teach the durability journal to
   checkpoint and discard a closed prefix while retaining the latest
   checkpoint, unresolved work, and required replay receipts.
4. Keep recent reconnect and idempotency data locally.
5. Add R2 segments only for product-required long history, old replay, audit,
   or export.

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

Open questions:

- Is exact-ID terminal replay required forever, or only within a documented
  retention window?
- Must the complete public event stream be retained forever, or can old
  assistant deltas be reduced to typed messages, tool records, and terminals?
- Is R2 history part of the normal transcript API or an explicit archive API?
- Which workspace paths are durable product state versus disposable tool
  scratch data?
- Should archived content preserve JSON byte-for-byte or use a versioned
  compact binary representation?
- What checkpoint and local-tail sizes keep cold restoration within the target
  p99 latency?
