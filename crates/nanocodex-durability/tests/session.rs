use nanocodex_durability::{
    Admission, BeginStep, DurableSession, Error, JournalStore, MemoryStore, OwnedJournal, OwnerId,
    OwnerToken, RetryPolicy, StoreError, StoreFuture, StoredBatch, StoredJournal,
};
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

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

struct NotCommittedOnceStore {
    inner: MemoryStore,
    fail_at_revision: u64,
    failed: Arc<AtomicBool>,
}

struct SeededStore {
    journal: StoredJournal,
}

impl JournalStore for SeededStore {
    fn acquire_owner<'a>(
        &'a mut self,
        _journal_id: &'a str,
        owner_id: OwnerId,
    ) -> StoreFuture<'a, Result<OwnedJournal, StoreError>> {
        let journal = self.journal.clone();
        Box::pin(async move {
            Ok(OwnedJournal {
                owner: OwnerToken::new(owner_id, 1),
                journal,
            })
        })
    }

    fn append<'a>(
        &'a mut self,
        _journal_id: &'a str,
        _owner: &'a OwnerToken,
        _expected_revision: u64,
        _payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        Box::pin(async {
            Err(StoreError::Backend(
                "the seeded legacy store is read-only".to_owned(),
            ))
        })
    }
}

impl JournalStore for NotCommittedOnceStore {
    fn acquire_owner<'a>(
        &'a mut self,
        journal_id: &'a str,
        owner_id: OwnerId,
    ) -> StoreFuture<'a, Result<OwnedJournal, StoreError>> {
        self.inner.acquire_owner(journal_id, owner_id)
    }

    fn append<'a>(
        &'a mut self,
        journal_id: &'a str,
        owner: &'a OwnerToken,
        expected_revision: u64,
        payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        if expected_revision == self.fail_at_revision && !self.failed.swap(true, Ordering::SeqCst) {
            return Box::pin(async {
                Err(StoreError::NotCommitted(
                    "injected retryable append failure".to_owned(),
                ))
            });
        }
        self.inner
            .append(journal_id, owner, expected_revision, payload)
    }
}

impl JournalStore for CommitThenFailStore {
    fn acquire_owner<'a>(
        &'a mut self,
        journal_id: &'a str,
        owner_id: OwnerId,
    ) -> StoreFuture<'a, Result<OwnedJournal, StoreError>> {
        self.inner.acquire_owner(journal_id, owner_id)
    }

    fn append<'a>(
        &'a mut self,
        journal_id: &'a str,
        owner: &'a OwnerToken,
        expected_revision: u64,
        payload: &'a str,
    ) -> StoreFuture<'a, Result<u64, StoreError>> {
        Box::pin(async move {
            let revision = self
                .inner
                .append(journal_id, owner, expected_revision, payload)
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
async fn failed_operations_replay_their_error_and_do_not_block_follow_on_work() {
    let store = MemoryStore::new().unwrap();
    let session = DurableSession::open(store.clone(), "failed-session")
        .await
        .unwrap();
    let input = PromptInput {
        prompt: "bad image".to_owned(),
    };
    session.admit("turn-1", &input).await.unwrap();
    session.begin_attempt("turn-1").await.unwrap();
    session
        .fail("turn-1", &Checkpoint { version: 2 }, "invalid image")
        .await
        .unwrap();

    let replay = session
        .admit_typed::<_, Checkpoint, TurnOutput>("turn-1", &input)
        .await
        .unwrap();
    let Admission::Failed { checkpoint, error } = replay else {
        panic!("failed operation must replay its terminal checkpoint and error");
    };
    assert_eq!(checkpoint, Checkpoint { version: 2 });
    assert_eq!(error, "invalid image");

    session.admit("turn-2", &"continue").await.unwrap();
    session.begin_attempt("turn-2").await.unwrap();
    session.cancel("turn-2").await.unwrap();

    let reopened = DurableSession::open(store, "failed-session").await.unwrap();
    let checkpoint = reopened
        .latest_checkpoint()
        .await
        .unwrap()
        .expect("failed operation checkpoint");
    assert_eq!(
        checkpoint.decode::<Checkpoint>().unwrap(),
        Checkpoint { version: 2 }
    );
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
        reopened.admit("turn-1", &"hi").await,
        Ok(Admission::Pending)
    ));
    reopened.begin_attempt("turn-1").await.unwrap();
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
async fn reopens_a_seeded_legacy_journal_with_repeated_attempt_starts() {
    let batches = [
        r#"{"operation_accepted":{"operation_id":"legacy-turn","input":"prompt"}}"#,
        r#"{"attempt_started":{"operation_id":"legacy-turn"}}"#,
        r#"{"attempt_started":{"operation_id":"legacy-turn"}}"#,
        r#"{"operation_completed":{"operation_id":"legacy-turn","checkpoint":{"version":7},"output":{"message":"legacy done"}}}"#,
    ]
    .into_iter()
    .enumerate()
    .map(|(index, payload)| StoredBatch {
        revision: u64::try_from(index + 1).unwrap(),
        payload: payload.to_owned(),
    })
    .collect();
    let session = DurableSession::open(
        SeededStore {
            journal: StoredJournal {
                revision: 4,
                batches,
            },
        },
        "legacy-repeated-attempts",
    )
    .await
    .unwrap();

    let state = session.state().await.unwrap();
    let operation = state.operation("legacy-turn").unwrap();
    assert_eq!(operation.attempts, 2);
    assert!(matches!(
        &operation.status,
        nanocodex_durability::OperationStatus::Completed { checkpoint, output }
            if checkpoint.decode::<Checkpoint>().unwrap() == Checkpoint { version: 7 }
                && output.decode::<TurnOutput>().unwrap().message == "legacy done"
    ));
}

fn seeded_legacy_store(payloads: &[&str]) -> SeededStore {
    let batches = payloads
        .iter()
        .enumerate()
        .map(|(index, payload)| StoredBatch {
            revision: u64::try_from(index + 1).unwrap(),
            payload: (*payload).to_owned(),
        })
        .collect::<Vec<_>>();
    SeededStore {
        journal: StoredJournal {
            revision: u64::try_from(batches.len()).unwrap(),
            batches,
        },
    }
}

#[tokio::test]
async fn reopens_a_seeded_legacy_step_start_without_an_attempt_start() {
    let session = DurableSession::open(
        seeded_legacy_store(&[
            r#"{"operation_accepted":{"operation_id":"legacy-turn","input":"prompt"}}"#,
            r#"{"step_started":{"operation_id":"legacy-turn","step_id":"tool-1","kind":"tool","input":"charge","retry":"idempotent"}}"#,
        ]),
        "legacy-step-start",
    )
    .await
    .unwrap();

    let state = session.state().await.unwrap();
    let operation = state.operation("legacy-turn").unwrap();
    assert_eq!(operation.attempts, 0);
    assert!(!operation.active_attempt);
    assert!(matches!(
        operation.steps.get("tool-1").map(|step| &step.status),
        Some(nanocodex_durability::StepStatus::Started)
    ));
}

#[tokio::test]
async fn reopens_a_seeded_legacy_step_completion_without_an_attempt_start() {
    let session = DurableSession::open(
        seeded_legacy_store(&[
            r#"{"operation_accepted":{"operation_id":"legacy-turn","input":"prompt"}}"#,
            r#"{"step_started":{"operation_id":"legacy-turn","step_id":"tool-1","kind":"tool","input":"charge","retry":"idempotent"}}"#,
            r#"{"step_completed":{"operation_id":"legacy-turn","step_id":"tool-1","output":"receipt"}}"#,
        ]),
        "legacy-step-completion",
    )
    .await
    .unwrap();

    let state = session.state().await.unwrap();
    let operation = state.operation("legacy-turn").unwrap();
    assert_eq!(operation.attempts, 0);
    assert!(!operation.active_attempt);
    assert!(matches!(
        operation.steps.get("tool-1").map(|step| &step.status),
        Some(nanocodex_durability::StepStatus::Completed(output))
            if output.decode::<String>().unwrap() == "receipt"
    ));
}

#[tokio::test]
async fn reopens_a_seeded_legacy_attempt_failure_without_an_attempt_start() {
    let session = DurableSession::open(
        seeded_legacy_store(&[
            r#"{"operation_accepted":{"operation_id":"legacy-turn","input":"prompt"}}"#,
            r#"{"attempt_failed":{"operation_id":"legacy-turn","error":"temporary"}}"#,
        ]),
        "legacy-attempt-failure",
    )
    .await
    .unwrap();

    let state = session.state().await.unwrap();
    let operation = state.operation("legacy-turn").unwrap();
    assert_eq!(operation.attempts, 0);
    assert!(!operation.active_attempt);
    assert_eq!(operation.last_error.as_deref(), Some("temporary"));
}

#[tokio::test]
async fn reopens_a_seeded_legacy_completion_without_an_attempt_start() {
    let session = DurableSession::open(
        seeded_legacy_store(&[
            r#"{"operation_accepted":{"operation_id":"legacy-turn","input":"prompt"}}"#,
            r#"{"operation_completed":{"operation_id":"legacy-turn","checkpoint":{"version":7},"output":{"message":"legacy done"}}}"#,
        ]),
        "legacy-completion",
    )
    .await
    .unwrap();

    let replay = session
        .admit_typed::<_, Checkpoint, TurnOutput>("legacy-turn", &"prompt")
        .await
        .unwrap();
    assert!(matches!(
        replay,
        Admission::Completed { checkpoint, output }
            if checkpoint == Checkpoint { version: 7 } && output.message == "legacy done"
    ));
    let state = session.state().await.unwrap();
    assert_eq!(state.operation("legacy-turn").unwrap().attempts, 0);
}

#[tokio::test]
async fn reopens_a_seeded_legacy_terminal_failure_without_an_attempt_start() {
    let session = DurableSession::open(
        seeded_legacy_store(&[
            r#"{"operation_accepted":{"operation_id":"legacy-turn","input":"prompt"}}"#,
            r#"{"operation_failed":{"operation_id":"legacy-turn","checkpoint":{"version":8},"error":"legacy failure"}}"#,
        ]),
        "legacy-terminal-failure",
    )
    .await
    .unwrap();

    let replay = session
        .admit_typed::<_, Checkpoint, TurnOutput>("legacy-turn", &"prompt")
        .await
        .unwrap();
    assert!(matches!(
        replay,
        Admission::Failed { checkpoint, error }
            if checkpoint == Checkpoint { version: 8 } && error == "legacy failure"
    ));
    let state = session.state().await.unwrap();
    assert_eq!(state.operation("legacy-turn").unwrap().attempts, 0);
}

#[tokio::test]
async fn queued_unstarted_operation_can_cancel_behind_a_pending_predecessor() {
    let store = MemoryStore::new().unwrap();
    let session = DurableSession::open(store, "queued-cancel").await.unwrap();
    session.admit("turn-1", &"one").await.unwrap();
    session.admit("turn-2", &"two").await.unwrap();
    session.begin_attempt("turn-1").await.unwrap();
    session.cancel("turn-2").await.unwrap();
    assert!(matches!(
        &session
            .state()
            .await
            .unwrap()
            .operation("turn-2")
            .unwrap()
            .status,
        nanocodex_durability::OperationStatus::Cancelled { checkpoint: None }
    ));
    session.complete("turn-1", &1, &"one").await.unwrap();
}

#[tokio::test]
async fn definitely_uncommitted_terminal_append_reopens_the_exact_claim_for_retry() {
    let store = MemoryStore::new().unwrap();
    let failed = Arc::new(AtomicBool::new(false));
    let session = DurableSession::open(
        NotCommittedOnceStore {
            inner: store,
            fail_at_revision: 1,
            failed: Arc::clone(&failed),
        },
        "retry-terminal-claim",
    )
    .await
    .unwrap();

    session.admit("turn-1", &"queued").await.unwrap();
    assert!(matches!(
        session.cancel("turn-1").await,
        Err(Error::Store(StoreError::NotCommitted(_)))
    ));
    assert!(failed.load(Ordering::SeqCst));

    assert!(matches!(
        session.admit("turn-1", &"queued").await,
        Ok(Admission::Pending)
    ));
    session.cancel("turn-1").await.unwrap();
    assert!(matches!(
        session.admit("turn-1", &"queued").await,
        Ok(Admission::Cancelled)
    ));
}

#[tokio::test]
async fn definitely_uncommitted_completion_reopens_the_exact_claim_for_retry() {
    let store = MemoryStore::new().unwrap();
    let session = DurableSession::open(
        NotCommittedOnceStore {
            inner: store,
            fail_at_revision: 2,
            failed: Arc::new(AtomicBool::new(false)),
        },
        "retry-completion-claim",
    )
    .await
    .unwrap();
    session.admit("turn-1", &"prompt").await.unwrap();
    session.begin_attempt("turn-1").await.unwrap();
    assert!(matches!(
        session.complete("turn-1", &1, &"answer").await,
        Err(Error::Store(StoreError::NotCommitted(_)))
    ));
    assert!(matches!(
        session.admit("turn-1", &"prompt").await,
        Ok(Admission::Pending)
    ));
    session.complete("turn-1", &1, &"answer").await.unwrap();
}

#[tokio::test]
async fn definitely_uncommitted_attempt_failure_reopens_the_exact_claim_for_retry() {
    let store = MemoryStore::new().unwrap();
    let session = DurableSession::open(
        NotCommittedOnceStore {
            inner: store,
            fail_at_revision: 2,
            failed: Arc::new(AtomicBool::new(false)),
        },
        "retry-attempt-failure-claim",
    )
    .await
    .unwrap();
    session.admit("turn-1", &"prompt").await.unwrap();
    session.begin_attempt("turn-1").await.unwrap();
    assert!(matches!(
        session.fail_attempt("turn-1", "temporary").await,
        Err(Error::Store(StoreError::NotCommitted(_)))
    ));
    assert!(matches!(
        session.admit("turn-1", &"prompt").await,
        Ok(Admission::Pending)
    ));
    session.fail_attempt("turn-1", "temporary").await.unwrap();
    assert!(matches!(
        session.admit("turn-1", &"prompt").await,
        Ok(Admission::Pending)
    ));
}

#[tokio::test]
async fn attempts_require_one_fresh_begin_for_each_claimed_execution() {
    let store = MemoryStore::new().unwrap();
    let session = DurableSession::open(store, "active-attempt-state")
        .await
        .unwrap();
    session.admit("turn-1", &"prompt").await.unwrap();
    session.begin_attempt("turn-1").await.unwrap();
    assert!(matches!(
        session.begin_attempt("turn-1").await,
        Err(Error::AttemptActive { .. })
    ));

    session.fail_attempt("turn-1", "retry").await.unwrap();
    assert!(matches!(
        session.admit("turn-1", &"prompt").await,
        Ok(Admission::Pending)
    ));
    assert!(matches!(
        session.complete("turn-1", &1, &"stale").await,
        Err(Error::AttemptNotStarted { .. })
    ));
    session.begin_attempt("turn-1").await.unwrap();
    session.complete("turn-1", &2, &"fresh").await.unwrap();
}

#[tokio::test]
async fn reclaim_after_release_requires_a_fresh_attempt() {
    let store = MemoryStore::new().unwrap();
    let session = DurableSession::open(store, "released-attempt-state")
        .await
        .unwrap();
    session.admit("turn-1", &"prompt").await.unwrap();
    session.begin_attempt("turn-1").await.unwrap();
    session.release("turn-1").await.unwrap();
    assert!(matches!(
        session.admit("turn-1", &"prompt").await,
        Ok(Admission::Pending)
    ));
    assert!(matches!(
        session.complete("turn-1", &1, &"stale").await,
        Err(Error::AttemptNotStarted { .. })
    ));
    session.begin_attempt("turn-1").await.unwrap();
    session.complete("turn-1", &2, &"fresh").await.unwrap();
}

#[tokio::test]
async fn cloned_handle_cannot_mutate_another_handles_claim() {
    let store = MemoryStore::new().unwrap();
    let owner = DurableSession::open(store, "claim-capability")
        .await
        .unwrap();
    let foreign = owner.clone();
    owner.admit("turn-1", &"prompt").await.unwrap();
    assert!(matches!(
        foreign.begin_attempt("turn-1").await,
        Err(Error::OperationNotClaimed { .. })
    ));
    assert!(matches!(
        foreign.complete("turn-1", &1, &"foreign").await,
        Err(Error::OperationNotClaimed { .. })
    ));
    owner.begin_attempt("turn-1").await.unwrap();
    owner.complete("turn-1", &2, &"owned").await.unwrap();
}

#[tokio::test]
async fn dropping_a_direct_claimant_releases_its_exact_pending_operation() {
    let store = MemoryStore::new().unwrap();
    let root = DurableSession::open(store, "direct-claimant-drop")
        .await
        .unwrap();
    let claimant = root.clone();
    assert!(matches!(
        claimant.admit("turn-1", &"prompt").await,
        Ok(Admission::Accepted)
    ));
    drop(claimant);

    let successor = root.clone();
    assert!(matches!(
        successor.admit("turn-1", &"prompt").await,
        Ok(Admission::Pending)
    ));
    successor.begin_attempt("turn-1").await.unwrap();
    successor
        .complete("turn-1", &1, &"reclaimed")
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn clone_drop_churn_and_claim_release_bursts_do_not_starve_commands() {
    let store = MemoryStore::new().unwrap();
    let root = DurableSession::open(store, "clone-drop-liveness")
        .await
        .unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let churn = {
        let session = root.clone();
        let stop = Arc::clone(&stop);
        tokio::spawn(async move {
            while !stop.load(Ordering::Acquire) {
                for _ in 0..256 {
                    drop(session.clone());
                }
                tokio::task::yield_now().await;
            }
        })
    };

    let state = root.state();
    tokio::pin!(state);
    tokio::select! {
        outcome = &mut state => {
            outcome.unwrap();
        }
        () = scheduler_budget() => panic!("idle clone/drop churn starved state"),
    }
    let admission = root.admit("live-turn", &"prompt");
    tokio::pin!(admission);
    tokio::select! {
        outcome = &mut admission => {
            assert!(matches!(outcome, Ok(Admission::Accepted)));
        }
        () = scheduler_budget() => panic!("idle clone/drop churn starved admission"),
    }
    stop.store(true, Ordering::Release);
    churn.await.unwrap();
    root.release("live-turn").await.unwrap();

    let mut claimants = Vec::new();
    for index in 0..(RELEASE_BURST_TEST_SIZE) {
        let claimant = root.clone();
        claimant
            .admit(format!("burst-{index}"), &"queued")
            .await
            .unwrap();
        claimants.push(claimant);
    }
    drop(claimants);
    let state = root.state();
    tokio::pin!(state);
    tokio::select! {
        outcome = &mut state => {
            outcome.unwrap();
        }
        () = scheduler_budget() => panic!("claim-release burst starved state"),
    }
}

const RELEASE_BURST_TEST_SIZE: usize = 128;

async fn scheduler_budget() {
    for _ in 0..10_000 {
        tokio::task::yield_now().await;
    }
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
        Err(Error::OperationNotClaimed { .. })
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
