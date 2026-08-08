use std::{fs, path::PathBuf};

use clap::{Args, builder::NonEmptyStringValueParser};
use eyre::{Result, WrapErr as _, bail};
use nanocodex_eval::{Evaluation, EvaluationStatus, coordinator::CoordinatorClient};
use serde::Deserialize;

use super::{profile::default_state_dir, systemd};
use crate::{
    RetryableProcessExit, benchmark, config::AgentArgs, observability::ObservabilityArgs, run, tui,
    vm::VmArgs,
};

#[derive(Args)]
pub(super) struct Benchmark {
    /// Named durable profile to drive to completion.
    profile: String,

    /// Runtime harness helper configuration passed to workers.
    #[arg(long, default_value = "nanocodex.toml")]
    config: PathBuf,

    /// Durable SQLite ledger and retained artifacts.
    ///
    /// The workflow and child commands default to ~/.nanocodex/evals.
    #[arg(long, value_name = "DIRECTORY")]
    state_dir: Option<PathBuf>,

    /// Pull all status and execution claims from this coordinator.
    #[arg(long, value_name = "URL", conflicts_with = "state_dir")]
    coordinator: Option<String>,

    /// Stable host identity used for coordinator task affinity.
    #[arg(
        long,
        env = "NANOCODEX_WORKER_NAME",
        value_name = "NAME",
        value_parser = NonEmptyStringValueParser::new(),
        requires = "coordinator"
    )]
    worker: Option<String>,

    /// Run the same benchmark workflow as flushed JSONL without a TUI.
    #[arg(long)]
    headless: bool,

    /// Install and start this benchmark as a durable user systemd service.
    ///
    /// When `--coordinator` is present, the supervised agent and every run it
    /// launches use that coordinator instead of opening SQLite directly.
    #[arg(long)]
    systemd: bool,

    /// Host-local cache and temporary workspace for the supervised benchmark.
    ///
    /// The systemd unit exports this as `NANOCODEX_HOME` and places `TMPDIR`
    /// beneath it so VM images and transient build contexts stay off the root
    /// filesystem.
    #[arg(long, value_name = "DIRECTORY", requires = "systemd")]
    runtime_dir: Option<PathBuf>,

    /// Replace the embedded agent-owned scheduling policy at runtime.
    ///
    /// The generated ledger and command contract remains fixed. The systemd
    /// installer resolves this path absolutely so editing the file followed by
    /// a service restart updates policy without rebuilding Nanocodex.
    #[arg(long, env = "NANOCODEX_BENCHMARK_PROMPT_FILE", value_name = "FILE")]
    orchestrator_prompt_file: Option<PathBuf>,

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
            worker,
            headless,
            systemd,
            runtime_dir,
            orchestrator_prompt_file,
            agent,
            observability,
            vm,
        } = self;
        if systemd {
            return systemd::install(
                &profile,
                &config,
                state_dir.as_deref(),
                coordinator.as_deref(),
                runtime_dir.as_deref(),
                orchestrator_prompt_file.as_deref(),
            );
        }
        let orchestration_policy = load_orchestration_policy(orchestrator_prompt_file.as_deref())?;
        let executable =
            std::env::current_exe().wrap_err("failed to resolve nanocodex executable")?;
        let prompt = benchmark::prompt(
            Some(profile.as_str()),
            &config,
            state_dir.as_deref(),
            coordinator.as_deref(),
            worker.as_deref(),
            Some(&executable),
            &orchestration_policy,
        );
        let initial = BoardStatus::load(
            &profile,
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
            &profile,
            &config,
            state_dir.as_deref(),
            coordinator.as_deref(),
        )
        .await?;
        board.require_complete(workflow.as_ref().err())
    }
}

fn load_orchestration_policy(path: Option<&std::path::Path>) -> Result<String> {
    let policy = match path {
        Some(path) => fs::read_to_string(path)
            .wrap_err_with(|| format!("failed to read orchestrator prompt {}", path.display()))?,
        None => benchmark::DEFAULT_ORCHESTRATOR_POLICY.to_owned(),
    };
    if policy.trim().is_empty() {
        bail!("benchmark orchestrator prompt must not be empty");
    }
    Ok(policy)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
struct BoardCounts {
    pending: i64,
    running: i64,
    complete: i64,
}

impl BoardCounts {
    const fn total(self) -> i64 {
        self.pending + self.running + self.complete
    }

    const fn is_complete(self) -> bool {
        self.pending == 0 && self.running == 0
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
struct BoardStatus {
    preparation: BoardCounts,
    coordinates: BoardCounts,
}

impl BoardStatus {
    async fn load(
        profile: &str,
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
        self.preparation.is_complete() && self.coordinates.is_complete()
    }

    fn require_complete(self, workflow_error: Option<&eyre::Report>) -> Result<()> {
        if self.is_complete() {
            return Ok(());
        }
        let workflow_error = workflow_error.map_or_else(String::new, |error| {
            format!("; agent workflow ended with: {error:#}")
        });
        Err(RetryableProcessExit::new(format!(
            "benchmark board remains incomplete: preparation {}/{} ready ({} pending, {} running); coordinates {}/{} terminal ({} pending, {} running){workflow_error}",
            self.preparation.complete,
            self.preparation.total(),
            self.preparation.pending,
            self.preparation.running,
            self.coordinates.complete,
            self.coordinates.total(),
            self.coordinates.pending,
            self.coordinates.running,
        ))
        .into())
    }
}

impl From<EvaluationStatus> for BoardStatus {
    fn from(status: EvaluationStatus) -> Self {
        Self {
            preparation: BoardCounts {
                pending: status.preparation.pending,
                running: status.preparation.running,
                complete: status.preparation.complete,
            },
            coordinates: BoardCounts {
                pending: status.coordinates.pending,
                running: status.coordinates.running,
                complete: status.coordinates.complete,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{BoardCounts, BoardStatus, load_orchestration_policy};
    use crate::{RETRYABLE_EXIT_CODE, process_exit_code};

    #[test]
    fn orchestration_policy_uses_the_embedded_default_or_a_runtime_file() {
        let default = load_orchestration_policy(None).unwrap();
        assert!(default.contains("Keep the host saturated with useful evaluation work"));
        assert!(!default.contains("lease"));

        let directory = tempfile::tempdir().unwrap();
        let custom = directory.path().join("benchmark-policy.md");
        std::fs::write(&custom, "Keep four useful workers.\n").unwrap();
        assert_eq!(
            load_orchestration_policy(Some(&custom)).unwrap(),
            "Keep four useful workers.\n"
        );

        std::fs::write(&custom, "  \n").unwrap();
        let error = load_orchestration_policy(Some(&custom)).unwrap_err();
        assert!(error.to_string().contains("must not be empty"));
    }

    #[test]
    fn benchmark_succeeds_only_when_the_entire_board_is_terminal() {
        let complete = BoardStatus {
            preparation: BoardCounts {
                pending: 0,
                running: 0,
                complete: 3,
            },
            coordinates: BoardCounts {
                pending: 0,
                running: 0,
                complete: 30,
            },
        };
        assert!(complete.require_complete(None).is_ok());

        for incomplete in [
            BoardStatus {
                coordinates: BoardCounts {
                    pending: 1,
                    ..complete.coordinates
                },
                ..complete
            },
            BoardStatus {
                coordinates: BoardCounts {
                    running: 1,
                    ..complete.coordinates
                },
                ..complete
            },
            BoardStatus {
                preparation: BoardCounts {
                    running: 1,
                    ..complete.preparation
                },
                ..complete
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
            "generation": "abc",
            "preparation": { "pending": 0, "running": 0, "complete": 2 },
            "coordinates": { "pending": 0, "running": 0, "complete": 20 },
            "families": [],
        }))
        .unwrap();
        assert!(board.require_complete(None).is_ok());
    }

    #[test]
    fn agent_failure_is_retryable_while_the_board_remains_incomplete() {
        let board = BoardStatus {
            preparation: BoardCounts {
                pending: 0,
                running: 0,
                complete: 2,
            },
            coordinates: BoardCounts {
                pending: 1,
                running: 0,
                complete: 19,
            },
        };
        let workflow_error = eyre::eyre!("connection closed");
        let error = board.require_complete(Some(&workflow_error)).unwrap_err();
        assert_eq!(process_exit_code(&error), RETRYABLE_EXIT_CODE);
        assert!(error.to_string().contains("connection closed"));
    }
}
