# nanocodex-durability

`nanocodex-durability` is the portable durable-execution boundary used by
Nanocodex agents. Rust owns the journal format, optimistic revision protocol,
state reduction, deduplication, checkpoint selection, and recovery decisions.
Hosts provide only atomic journal loading and compare-and-append.

See [the end-to-end durability model and correctness review](../../docs/DURABILITY.md)
for the Rust state machine, Agent/WASM/application consumption, crash matrix,
and current implementation gaps.

This crate is an optional layer over `nanocodex-agent`: durability depends on
the agent, never the reverse. It implements the agent's neutral execution
policy seam at prompt admission, model calls, tool calls, and committed
session boundaries.

The pieces compose progressively; none of the lower layers imports this crate:

```text
nanocodex-oai-api <- nanocodex-tools <- nanocodex-agent
                                             ^
                                             |
                                  nanocodex-durability
```

Construct only the layer an application needs, or attach the journal after the
OpenAI client and tool registry have been composed into an agent:

```rust,ignore
use nanocodex_agent::{Nanocodex, OpenAi, PromptRequest};
use nanocodex_durability::{DurableAgentExt, DurableSession, MemoryStore};
use nanocodex_tools::Tools;

let openai = OpenAi::new(std::env::var("OPENAI_API_KEY")?)?;
let tools = Tools::builder().without_defaults().build()?;

let store = MemoryStore::new()?;
let journal = DurableSession::open(store, "agent-123").await?;
let (agent, events) = Nanocodex::builder(openai)
    .tools(tools)
    .durability(journal)
    .await?
    .build()?;

// Omit request_id() to let the durable agent generate one during admission.
let turn = agent
    .prompt(PromptRequest::new("hello").request_id("request-7"))
    .await?;
assert_eq!(turn.request_id(), Some("request-7"));
```

Without `.durability(...)`, the same builder is an ordinary non-durable agent.
An OpenAI-only consumer can stop at `OpenAi::instructions(...).build()`, and a
tools-only consumer can stop at `Tools::builder().build()`. A caller that owns
either lower-level lifecycle can use `DurableSession` directly, choose its own
operation and step IDs, and persist its own typed checkpoints and outputs. The
automatic model/tool/checkpoint integration is specifically the
`DurableAgentExt` adapter.

The crate includes an in-memory store on every target and optional native
SQLite and Postgres stores. JavaScript runtimes implement the same small store
contract through the Nanocodex WASM host bridge.

Operations are durable accepted units of work. Steps are replayable boundaries
inside an operation. An unfinished step is classified from its retry policy:
retry-safe steps can start another attempt, while an unfinished unsafe step is
reported as ambiguous and is never silently repeated.

Completed tool outputs are replayed only while the recovered agent still owns
the named tool. If a deployment removes a runtime-owned tool, recovery emits an
explicit failed tool result rather than returning an opaque handle whose owner
no longer exists. Child agents need independent execution policies; the root
policy is never silently discarded during `spawn` or `fork`.

The runtime follows the same ownership model as the agent SDK. A
`DurableSession` is a cheap channel handle; one spawned task owns its reducer,
live claims, revision, and store. The store itself is moved into that task.
There is no shared mutable reducer or `Arc<Mutex<Connection>>` contract.

```rust
use nanocodex_durability::{Admission, DurableSession, MemoryStore};

# async fn example() -> nanocodex_durability::Result<()> {
let store = MemoryStore::new()?;
let journal = DurableSession::open(store.clone(), "agent-123").await?;

match journal.admit_typed::<_, String, String>("request-7", &"hello").await? {
    Admission::Accepted | Admission::Pending => {
        journal.begin_attempt("request-7").await?;
        journal.complete("request-7", &"checkpoint", &"answer").await?;
    }
    Admission::Completed { checkpoint, output } => {
        assert_eq!((checkpoint, output), ("checkpoint".to_owned(), "answer".to_owned()));
    }
    Admission::Failed { checkpoint, error } => {
        assert_eq!((checkpoint, error), ("checkpoint".to_owned(), "provider rejected input".to_owned()));
    }
    Admission::Cancelled => {}
}
# Ok(())
# }
```

Enable `sqlite` and open `SqliteStore` for a directly owned native connection.
Enable `postgres` and pass a driven `tokio_postgres::Client` to
`PostgresStore::new`. Both implement the exact same `JournalStore` contract.

The host contract has only two operations:

- `acquire_owner(journal_id, owner_id)` atomically advances the persisted owner
  fence and returns that token with one coherent journal snapshot.
- `append(journal_id, owner_token, expected_revision, payload)` checks owner
  authority before revision and atomically appends the opaque payload.

Hosts do not deserialize entries, snapshots, model outputs, or tool results.
Rust owns those types and all recovery decisions.

Only a definite `NotCommitted` append may be retried on the same owner.
`Fenced`, revision `Conflict`, and unknown `Backend` outcomes require a fresh
owner acquisition and complete journal reduction before deciding what ran.
