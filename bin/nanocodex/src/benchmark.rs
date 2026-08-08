use std::path::Path;

pub(crate) const DEFAULT_ORCHESTRATOR_POLICY: &str =
    include_str!("../prompts/benchmark-orchestrator.md");

pub(crate) fn prompt(
    benchmark: Option<&str>,
    state_dir: Option<&Path>,
    coordinator: Option<&str>,
    policy: &str,
) -> String {
    let benchmark = benchmark.unwrap_or("the selected benchmark");
    let target = coordinator.map_or_else(
        || {
            state_dir.map_or_else(
                || "the default local eval state".to_owned(),
                |path| format!("local eval state at {}", path.display()),
            )
        },
        |url| format!("coordinator {url}"),
    );
    format!(
        "Drive benchmark {benchmark} to completion using only the `nanocodex eval` CLI against {target}. Do not do anything else.\n\n{}",
        policy.trim(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_names_only_the_benchmark_target_and_policy() {
        let prompt = prompt(
            Some("terminal-bench"),
            None,
            Some("http://127.0.0.1:8788"),
            DEFAULT_ORCHESTRATOR_POLICY,
        );

        assert!(prompt.contains("benchmark terminal-bench"));
        assert!(prompt.contains("coordinator http://127.0.0.1:8788"));
        assert!(prompt.contains("using only the `nanocodex eval` CLI"));
        assert!(prompt.contains("Run as many evals in parallel as the host can sustain"));
        assert!(!prompt.contains("lease"));
        assert!(!prompt.contains("SQLite ledger"));
    }

    #[test]
    fn prompt_supports_local_eval_state() {
        let prompt = prompt(
            Some("terminal-bench"),
            Some(Path::new("/mnt/evals")),
            None,
            DEFAULT_ORCHESTRATOR_POLICY,
        );

        assert!(prompt.contains("local eval state at /mnt/evals"));
    }
}
