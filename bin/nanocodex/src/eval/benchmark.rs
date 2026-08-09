use std::path::PathBuf;

use clap::Args;
use eyre::{Result, WrapErr as _};
use nanocodex_eval::{Evaluation, EvaluationStatus, coordinator::CoordinatorClient};
use serde::Deserialize;

use super::{profile::default_state_dir, systemd};
use crate::{
    RetryableProcessExit, benchmark, config::AgentArgs, observability::ObservabilityArgs, run, tui,
    vm::VmArgs,
};

#[derive(Args)]
pub(super) struct Benchmark {
    /// Named benchmark stored in SQLite.
    profile: String,

    /// Runtime harness helper configuration. SQLite owns desired work.
    #[arg(long, env = "NANOCODEX_EVAL_CONFIG", default_value = "nanocodex.toml")]
    config: PathBuf,

    /// Durable SQLite ledger and retained artifacts.
    ///
    /// The workflow and child commands default to ~/.nanocodex/evals.
    #[arg(long, value_name = "DIRECTORY")]
    state_dir: Option<PathBuf>,

    /// Pull all status and execution claims from this coordinator.
    #[arg(long, value_name = "URL", conflicts_with = "state_dir")]
    coordinator: Option<String>,

    /// Run the same benchmark workflow as flushed JSONL without a TUI.
    #[arg(long)]
    headless: bool,

    /// Install and start this benchmark as a durable user systemd service.
    #[arg(long, conflicts_with = "coordinator")]
    systemd: bool,

    #[command(flatten)]
    agent: AgentArgs,

    #[command(flatten)]
    observability: ObservabilityArgs,

    #[command(flatten)]
    vm: VmArgs,
}

impl Benchmark {
    pub(super) async fn run(self) -> Result<()> {
        let Self {
            profile,
            config,
            state_dir,
            coordinator,
            headless,
            systemd,
            agent,
            observability,
            vm,
        } = self;
        if systemd {
            return systemd::install(Some(&profile), &config, state_dir.as_deref());
        }
        if let Some(coordinator) = coordinator.as_deref() {
            CoordinatorClient::new(coordinator)?
                .workers_interrupted(
                    "benchmark owner restarted after its worker process group was terminated",
                )
                .await?;
        }
        let agent = agent.enable_subagents();
        let prompt = benchmark::prompt(
            Some(&profile),
            &config,
            state_dir.as_deref(),
            coordinator.as_deref(),
            agent.max_subagents(),
        );
        let initial = BoardStatus::load(
            Some(&profile),
            &config,
            state_dir.as_deref(),
            coordinator.as_deref(),
        )
        .await?;
        if initial.is_complete() {
            return Ok(());
        }
        let workflow = if headless {
            let _observability = observability.install(false, agent.cwd())?;
            run::run_prompt(prompt, agent, vm).await
        } else {
            let _observability = observability.install(true, agent.cwd())?;
            let display = format!("/benchmark {profile}");
            tui::run(
                agent,
                vm,
                Some(tui::InitialPrompt::workflow(display, prompt)),
                None,
            )
            .await
        };
        let board = BoardStatus::load(
            Some(&profile),
            &config,
            state_dir.as_deref(),
            coordinator.as_deref(),
        )
        .await?;
        board.require_complete(workflow.as_ref().err())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
struct BoardCounts {
    unclaimed: i64,
    running: i64,
    success: i64,
    failed: i64,
}

impl BoardCounts {
    const fn total(self) -> i64 {
        self.unclaimed + self.running + self.success + self.failed
    }

    const fn is_complete(self) -> bool {
        self.unclaimed == 0 && self.running == 0
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
struct BoardStatus {
    tasks: BoardCounts,
}

impl BoardStatus {
    async fn load(
        profile: Option<&str>,
        config: &std::path::Path,
        state_dir: Option<&std::path::Path>,
        coordinator: Option<&str>,
    ) -> Result<Self> {
        if let Some(coordinator) = coordinator {
            let status = CoordinatorClient::new(coordinator)?.status().await?;
            return serde_json::from_value(status)
                .wrap_err("coordinator returned an invalid benchmark board status");
        }
        let state_dir = state_dir.map_or_else(default_state_dir, |path| Ok(path.to_path_buf()))?;
        let evaluation = Evaluation::open(config, profile, state_dir)?;
        Ok(evaluation.status()?.into())
    }

    const fn is_complete(self) -> bool {
        self.tasks.is_complete()
    }

    fn require_complete(self, workflow_error: Option<&eyre::Report>) -> Result<()> {
        if self.is_complete() {
            return Ok(());
        }
        let workflow_error = workflow_error.map_or_else(String::new, |error| {
            format!("; agent workflow ended with: {error:#}")
        });
        Err(RetryableProcessExit::new(format!(
            "benchmark board remains incomplete: {}/{} tasks finished ({} unclaimed, {} running, {} failed){workflow_error}",
            self.tasks.success + self.tasks.failed,
            self.tasks.total(),
            self.tasks.unclaimed,
            self.tasks.running,
            self.tasks.failed,
        ))
        .into())
    }
}

impl From<EvaluationStatus> for BoardStatus {
    fn from(status: EvaluationStatus) -> Self {
        Self {
            tasks: BoardCounts {
                unclaimed: status.tasks.unclaimed,
                running: status.tasks.running,
                success: status.tasks.success,
                failed: status.tasks.failed,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{BoardCounts, BoardStatus};
    use crate::{RETRYABLE_EXIT_CODE, process_exit_code};

    #[test]
    fn benchmark_succeeds_only_when_the_entire_board_is_terminal() {
        let complete = BoardStatus {
            tasks: BoardCounts {
                unclaimed: 0,
                running: 0,
                success: 27,
                failed: 3,
            },
        };
        assert!(complete.require_complete(None).is_ok());

        for incomplete in [
            BoardStatus {
                tasks: BoardCounts {
                    unclaimed: 1,
                    ..complete.tasks
                },
            },
            BoardStatus {
                tasks: BoardCounts {
                    running: 1,
                    ..complete.tasks
                },
            },
        ] {
            let error = incomplete.require_complete(None).unwrap_err();
            assert_eq!(process_exit_code(&error), RETRYABLE_EXIT_CODE);
        }
    }

    #[test]
    fn remote_status_uses_the_same_completion_contract() {
        let board: BoardStatus = serde_json::from_value(serde_json::json!({
            "profile": "release",
            "digest": "abc",
            "tasks": { "unclaimed": 0, "running": 0, "success": 18, "failed": 2 },
            "families": [],
        }))
        .unwrap();
        assert!(board.require_complete(None).is_ok());
    }

    #[test]
    fn agent_failure_is_retryable_while_the_board_remains_incomplete() {
        let board = BoardStatus {
            tasks: BoardCounts {
                unclaimed: 1,
                running: 0,
                success: 19,
                failed: 0,
            },
        };
        let workflow_error = eyre::eyre!("connection closed");
        let error = board.require_complete(Some(&workflow_error)).unwrap_err();
        assert_eq!(process_exit_code(&error), RETRYABLE_EXIT_CODE);
        assert!(error.to_string().contains("connection closed"));
    }
}
