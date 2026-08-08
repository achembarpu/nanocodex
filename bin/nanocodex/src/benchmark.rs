use std::path::Path;

pub(crate) const DEFAULT_ORCHESTRATOR_POLICY: &str =
    include_str!("../prompts/benchmark-orchestrator.md");

pub(crate) fn prompt(
    profile: Option<&str>,
    config: &Path,
    state_dir: Option<&Path>,
    coordinator: Option<&str>,
    worker: Option<&str>,
    executable: Option<&Path>,
    orchestration_policy: &str,
) -> String {
    let selected = profile.unwrap_or("the selected SQLite profile");
    let profile_argument =
        profile.map_or_else(String::new, |profile| format!(" {}", shell_quote(profile)));
    let state_argument = state_dir.map_or_else(String::new, |directory| {
        format!(" --state-dir {}", shell_quote(&directory.to_string_lossy()))
    });
    let coordinator_argument = coordinator.map_or_else(String::new, |coordinator| {
        format!(" --coordinator {}", shell_quote(coordinator))
    });
    let worker_argument = worker.map_or_else(String::new, |worker| {
        format!(" --worker {}", shell_quote(worker))
    });
    let config_argument = shell_quote(&config.to_string_lossy());
    let executable = executable.map_or_else(
        || "nanocodex".to_owned(),
        |executable| shell_quote(&executable.to_string_lossy()),
    );
    let ledger = if coordinator.is_some() {
        "the coordinator-backed SQLite ledger; do not open SQLite directly"
    } else {
        "SQLite"
    };
    format!(
        r#"Drive the Nanocodex evaluation profile {selected} to durable completion.

This is an operations task. Do not inspect or modify source code, benchmark tasks, verifiers, configuration, or expected outputs.

The work is already stored in {ledger}. Read its current state with:

    {executable} eval status{profile_argument}{state_argument}{coordinator_argument} --json --family-limit 128

For pending work, run this command in parallel process sessions:

    {executable} eval run{profile_argument} --config {config_argument}{state_argument}{coordinator_argument}{worker_argument} --task <exact-task> [treatment selectors]

Choose exact tasks and treatments from status. Treatment selectors are `--harness`, model, and thinking level as needed; omit `--harness` for built-in Nanocodex. Never pass a repetition number: the coordinator allocates it atomically.

Orchestration policy:

{orchestration_policy}

Poll every retained process session. When one exits, inspect it and start a replacement while work remains. Retry temporary infrastructure failures; accepted model and verifier outcomes are terminal even when they fail the benchmark.

Do not stop after launching a wave. Keep monitoring and refilling until status reports zero pending and zero running task preparation and benchmark coordinates. Then report the final counts."#,
        orchestration_policy = orchestration_policy.trim(),
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflow_leaves_task_choice_to_the_agent_and_demands_aggressive_saturation() {
        let prompt = prompt(
            Some("release"),
            Path::new("nanocodex.toml"),
            Some(Path::new("/mnt/evals")),
            None,
            None,
            None,
            DEFAULT_ORCHESTRATOR_POLICY,
        );

        assert!(prompt.contains("Choose exact tasks and treatments from status"));
        assert!(prompt.contains("omit `--harness` for built-in Nanocodex"));
        assert!(prompt.contains("Keep the host saturated with useful evaluation work"));
        assert!(prompt.contains("Launch normal `eval run` commands directly in parallel"));
        assert!(prompt.contains("Poll every retained process session"));
        assert!(prompt.contains("zero pending and zero running"));
        assert!(prompt.contains("Never pass a repetition number"));
        assert!(prompt.contains("--state-dir '/mnt/evals'"));
        assert!(!prompt.contains("unexpired leases"));
        assert!(!prompt.contains("memory_cap"));
        assert!(!prompt.contains("launch gate"));
    }

    #[test]
    fn workflow_quotes_paths_and_profile_names_as_shell_arguments() {
        let prompt = prompt(
            Some("release candidate"),
            Path::new("configs/eval profile.toml"),
            Some(Path::new("/mnt/eval state")),
            None,
            None,
            None,
            DEFAULT_ORCHESTRATOR_POLICY,
        );

        assert!(prompt.contains("status 'release candidate' --state-dir '/mnt/eval state'"));
        assert!(prompt.contains("--state-dir '/mnt/eval state'"));
    }

    #[test]
    fn workflow_can_point_every_run_at_a_coordinator() {
        let prompt = prompt(
            Some("release"),
            Path::new("nanocodex.toml"),
            None,
            Some("http://127.0.0.1:8789"),
            Some("dev-georgios-01"),
            Some(Path::new("/opt/nanocodex/bin/nanocodex")),
            DEFAULT_ORCHESTRATOR_POLICY,
        );

        assert!(prompt.contains("status 'release' --coordinator 'http://127.0.0.1:8789'"));
        assert!(prompt.contains("--json --family-limit 128"));
        assert!(prompt.contains(
            "'/opt/nanocodex/bin/nanocodex' eval run 'release' --config 'nanocodex.toml' --coordinator 'http://127.0.0.1:8789' --worker 'dev-georgios-01' --task"
        ));
        assert!(prompt.contains("do not open SQLite directly"));
        assert!(prompt.contains("This is an operations task"));
        assert!(!prompt.contains("--state-dir"));
    }

    #[test]
    fn workflow_accepts_a_runtime_orchestration_policy() {
        let prompt = prompt(
            Some("release"),
            Path::new("nanocodex.toml"),
            None,
            None,
            None,
            None,
            "Keep exactly three observed sessions.",
        );

        assert!(prompt.contains("Orchestration policy:\n\nKeep exactly three observed sessions."));
        assert!(!prompt.contains("Keep the host saturated"));
    }
}
