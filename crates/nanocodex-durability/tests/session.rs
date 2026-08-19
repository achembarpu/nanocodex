use nanocodex_durability::{
    Admission, BeginStep, DurableSession, Error, JournalStore, MemoryStore, RetryPolicy,
    StoreError, StoreFuture, StoredJournal,
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
struct PromptInput {
    prompt: String,
}

#[derive(Deserialize, Serialize)]
struct ModelInput {
    history: u32,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
struct ModelOutput {
    answer: u32,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
struct Checkpoint {
    version: u32,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
struct TurnOutput {
    message: String,
}

struct CommitThenFailStore {
    inner: MemoryStore,
    fail_after_revision: u64,
}

impl JournalStore for CommitThenFailStore {
    fn load<'a>(
        &'a mut self,
        journal_id: &'a str,
    ) -> StoreFuture<'a, Result<StoredJournal, StoreError>> {
        self.inner.load(journal_id)
    }

    fn append<'a>(
        &'a mut self,
        journal_id: &'a str,
        expected_revision: u64,
        payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        Box::pin(async move {
            let revision = self
                .inner
                .append(journal_id, expected_revision, payload)
                .await?;
            if expected_revision == self.fail_after_revision {
                return Err(StoreError::Backend(
                    "append response was lost after commit".to_owned(),
                ));
            }
            Ok(revision)
        })
    }
}

#[test]
fn memory_store_requires_an_owner_runtime() {
    assert!(matches!(MemoryStore::new(), Err(Error::RuntimeUnavailable)));
}

#[tokio::test]
async fn replays_completed_operations_and_steps_after_reopen() {
    let store = MemoryStore::new().unwrap();
    let session = DurableSession::open(store.clone(), "session")
        .await
        .unwrap();
    assert!(matches!(
        session
            .admit_typed::<_, Checkpoint, TurnOutput>(
                "turn-1",
                &PromptInput {
                    prompt: "hi".to_owned(),
                },
            )
            .await,
        Ok(Admission::Accepted)
    ));
    assert_eq!(session.begin_attempt("turn-1").await.unwrap(), 1);
    assert!(matches!(
        session
            .begin_step_typed::<_, ModelOutput>(
                "turn-1",
                "model-1",
                "model",
                &ModelInput { history: 0 },
                RetryPolicy::Idempotent,
            )
            .await,
        Ok(BeginStep::Execute)
    ));
    session
        .complete_step("turn-1", "model-1", &ModelOutput { answer: 42 })
        .await
        .unwrap();
    session
        .complete(
            "turn-1",
            &Checkpoint { version: 1 },
            &TurnOutput {
                message: "done".to_owned(),
            },
        )
        .await
        .unwrap();

    let reopened = DurableSession::open(store, "session").await.unwrap();
    let admission = reopened
        .admit_typed::<_, Checkpoint, TurnOutput>(
            "turn-1",
            &PromptInput {
                prompt: "hi".to_owned(),
            },
        )
        .await
        .unwrap();
    let Admission::Completed { checkpoint, output } = admission else {
        panic!("completed operation must replay typed terminal values");
    };
    assert_eq!(checkpoint, Checkpoint { version: 1 });
    assert_eq!(output.message, "done");
    assert_eq!(reopened.state().await.unwrap().revision(), 5);
}

#[tokio::test]
async fn refuses_to_repeat_an_ambiguous_unsafe_step() {
    let store = MemoryStore::new().unwrap();
    let session = DurableSession::open(store.clone(), "session")
        .await
        .unwrap();
    session.admit("turn-1", &"hi").await.unwrap();
    session.begin_attempt("turn-1").await.unwrap();
    session
        .begin_step("turn-1", "tool-1", "tool", &"charge", RetryPolicy::Never)
        .await
        .unwrap();

    let reopened = DurableSession::open(store, "session").await.unwrap();
    assert!(matches!(
        reopened
            .begin_step("turn-1", "tool-1", "tool", &"charge", RetryPolicy::Never)
            .await,
        Err(Error::AmbiguousStep { .. })
    ));
}

#[tokio::test]
async fn queues_admission_but_serializes_attempts() {
    let store = MemoryStore::new().unwrap();
    let session = DurableSession::open(store, "session").await.unwrap();
    session.admit("turn-1", &"one").await.unwrap();
    session.admit("turn-2", &"two").await.unwrap();
    assert!(matches!(
        session.begin_attempt("turn-2").await,
        Err(Error::OperationBlocked { .. })
    ));
    session.begin_attempt("turn-1").await.unwrap();
    session.complete("turn-1", &1, &"one").await.unwrap();
    session.begin_attempt("turn-2").await.unwrap();
}

#[tokio::test]
async fn automatic_admission_reclaims_matching_unclaimed_work() {
    let store = MemoryStore::new().unwrap();
    let session = DurableSession::open(store.clone(), "automatic")
        .await
        .unwrap();
    let first = session
        .admit_automatic_typed::<_, Checkpoint, TurnOutput>(
            "candidate-1",
            &PromptInput {
                prompt: "resume me".to_owned(),
            },
        )
        .await
        .unwrap();
    assert_eq!(first.operation_id(), "candidate-1");
    assert!(matches!(first.into_parts().1, Admission::Accepted));
    drop(session);

    let reopened = DurableSession::open(store, "automatic").await.unwrap();
    let resumed = reopened
        .admit_automatic_typed::<_, Checkpoint, TurnOutput>(
            "candidate-2",
            &PromptInput {
                prompt: "resume me".to_owned(),
            },
        )
        .await
        .unwrap();
    assert_eq!(resumed.operation_id(), "candidate-1");
    assert!(matches!(resumed.into_parts().1, Admission::Pending));
    assert_eq!(reopened.state().await.unwrap().operations().len(), 1);
}

#[tokio::test]
async fn automatic_admission_does_not_guess_past_different_recovered_work() {
    let store = MemoryStore::new().unwrap();
    let session = DurableSession::open(store.clone(), "automatic-blocked")
        .await
        .unwrap();
    session.admit("turn-1", &"first").await.unwrap();
    drop(session);

    let reopened = DurableSession::open(store, "automatic-blocked")
        .await
        .unwrap();
    assert!(matches!(
        reopened
            .admit_automatic_typed::<_, Checkpoint, TurnOutput>("candidate-2", &"different")
            .await,
        Err(Error::OperationBlocked { pending_id, .. }) if pending_id == "turn-1"
    ));
    assert_eq!(reopened.state().await.unwrap().operations().len(), 1);
}

#[tokio::test]
async fn automatic_admission_reclaims_multiple_queued_operations_in_order() {
    let store = MemoryStore::new().unwrap();
    let session = DurableSession::open(store.clone(), "automatic-queue")
        .await
        .unwrap();
    session
        .admit_automatic_typed::<_, Checkpoint, TurnOutput>("turn-1", &"first")
        .await
        .unwrap();
    session
        .admit_automatic_typed::<_, Checkpoint, TurnOutput>("turn-2", &"second")
        .await
        .unwrap();
    drop(session);

    let reopened = DurableSession::open(store, "automatic-queue")
        .await
        .unwrap();
    let first = reopened
        .admit_automatic_typed::<_, Checkpoint, TurnOutput>("new-1", &"first")
        .await
        .unwrap();
    let second = reopened
        .admit_automatic_typed::<_, Checkpoint, TurnOutput>("new-2", &"second")
        .await
        .unwrap();
    assert_eq!(first.operation_id(), "turn-1");
    assert_eq!(second.operation_id(), "turn-2");
    assert!(matches!(first.into_parts().1, Admission::Pending));
    assert!(matches!(second.into_parts().1, Admission::Pending));
    assert_eq!(reopened.state().await.unwrap().operations().len(), 2);
}

#[tokio::test]
async fn rejects_invalid_transitions_before_the_host_append() {
    let store = MemoryStore::new().unwrap();
    let session = DurableSession::open(store.clone(), "session")
        .await
        .unwrap();
    assert!(matches!(
        session.cancel("missing-operation").await,
        Err(Error::InvalidJournal(_))
    ));
    assert_eq!(session.state().await.unwrap().revision(), 0);

    drop(session);
    let reopened = DurableSession::open(store, "session").await.unwrap();
    assert_eq!(reopened.state().await.unwrap().revision(), 0);
}

#[tokio::test]
async fn stops_a_stale_owner_when_an_append_outcome_is_ambiguous() {
    let store = MemoryStore::new().unwrap();
    let session = DurableSession::open(
        CommitThenFailStore {
            inner: store.clone(),
            fail_after_revision: 2,
        },
        "session",
    )
    .await
    .unwrap();
    session.admit("turn-1", &"hello").await.unwrap();
    session.begin_attempt("turn-1").await.unwrap();
    assert!(matches!(
        session.complete("turn-1", &1, &"done").await,
        Err(Error::Store(StoreError::Backend(_)))
    ));
    assert!(matches!(session.state().await, Err(Error::DriverStopped)));

    let reopened = DurableSession::open(store, "session").await.unwrap();
    assert!(matches!(
        reopened.admit("turn-1", &"hello").await,
        Ok(Admission::Completed { .. })
    ));
}

#[cfg(feature = "sqlite")]
#[tokio::test]
async fn sqlite_compare_and_append_survives_reopen() {
    use nanocodex_durability::SqliteStore;

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("durability.sqlite3");
    let session = DurableSession::open(SqliteStore::open(&path).unwrap(), "session")
        .await
        .unwrap();
    session.admit("turn-1", &"hello").await.unwrap();
    session.begin_attempt("turn-1").await.unwrap();
    session
        .complete("turn-1", &Checkpoint { version: 1 }, &"done")
        .await
        .unwrap();
    drop(session);

    let reopened = DurableSession::open(SqliteStore::open(path).unwrap(), "session")
        .await
        .unwrap();
    assert!(matches!(
        reopened.admit("turn-1", &"hello").await,
        Ok(Admission::Completed { .. })
    ));
}
