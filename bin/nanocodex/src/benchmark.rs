use std::path::Path;

pub(crate) fn prompt(
    profile: Option<&str>,
    config: &Path,
    state_dir: Option<&Path>,
    coordinator: Option<&str>,
    max_subagents: usize,
) -> String {
    let selected = profile.unwrap_or("the manifest default profile");
    let profile_argument =
        profile.map_or_else(String::new, |profile| format!(" {}", shell_quote(profile)));
    let state_argument = state_dir.map_or_else(String::new, |directory| {
        format!(" --state-dir {}", shell_quote(&directory.to_string_lossy()))
    });
    let coordinator_argument = coordinator.map_or_else(String::new, |coordinator| {
        format!(" --coordinator {}", shell_quote(coordinator))
    });
    let exit_report = coordinator.map_or_else(
        || "let SQLite observe the released local claim lock".to_owned(),
        |coordinator| {
            format!(
                "POST `{{\"worker\":<worker-id>,\"error\":<exit-status>}}` once to {}/v1/workers/exited",
                coordinator.trim_end_matches('/')
            )
        },
    );
    let config_argument = shell_quote(&config.to_string_lossy());
    let status_command = coordinator.map_or_else(
        || {
            format!(
                "nanocodex eval status{profile_argument} --config {config_argument}{state_argument} --json | jq -c .tasks"
            )
        },
        |coordinator| {
            format!(
                "curl -fsS {}/v1/status | jq -c .tasks",
                coordinator.trim_end_matches('/')
            )
        },
    );
    format!(
        r#"Drive the pre-materialized Nanocodex benchmark {selected} to completion while continuously saturating the host. Your first and only action is one Code Mode cell beginning `// @exec: {{\"yield_time_ms\": 3600000}}`; put the entire loop in it. If that cell ever yields, only resume that same cell.

- There is no fixed worker target and never run in waves. `{max_subagents}` is only the runtime's mechanical tree ceiling, not the desired concurrency. Every 15 seconds read counts with `{status_command}` and sample the Linux host from `/proc/meminfo`, `/proc/loadavg`, `/proc/pressure/memory`, and `getconf _NPROCESSORS_ONLN`. Keep `/proc/meminfo` values in KiB throughout (`8 GiB = 8388608 KiB`); do not multiply them or print them through a fixed-width integer format. Admit exactly one new worker when all of these are true: work remains unclaimed, `active.size < {max_subagents}`, one-minute load is below the online CPU count, available memory exceeds `max(8 GiB, 15% of total memory)`, and memory `some` pressure `avg10` is below 1.0. Re-sample after every admission; never fill multiple slots from one stale sample. A capacity check that says no must only delay admission, never stop the loop or cancel running work. Use `notify(JSON.stringify(...))` for each capacity sample and admission decision with counts, active workers, CPUs, load, available/total memory, and memory pressure; `console` is unavailable in Code Mode.

- Give each admitted child a unique string worker ID and exactly one foreground `nanocodex eval run{profile_argument} --config {config_argument}{state_argument}{coordinator_argument} --worker <worker-id>`. The child keeps `exec_command` plus all `write_stdin` waits inside one Code Mode cell beginning `// @exec: {{\"yield_time_ms\": 300000}}`. While the command has a `session_id`, it must keep calling `write_stdin` in that cell; only a numeric `exit_code` permits submitting `{{ worker, exit_code }}`.

- Keep only `agent_id -> worker`. Use `wait_agent` with a 15-second timeout on all active IDs so capacity is measured even while no child finishes. Its `agents` array is a snapshot of every requested ID when any one finishes, so it also contains `pending`, `running`, or `closing` entries. Define `terminalStates = new Set(["completed", "failed", "interrupted", "closed"])` and begin the result loop with exactly `if (!terminalStates.has(item.status.state)) continue;`. Never close, report, or remove a nonterminal entry. For each terminal entry only, read a successful worker exit from `item.status.output.exit_code`, `close_agent` first, then {exit_report}. Remove it, re-sample current host capacity, and admit a replacement only when the live capacity test passes. The report is idempotent and only changes a still-running row.

- Stop only when compact status has no unclaimed or running row; close all children and verify no eval worker, VMM, or proxy remains. Never use `Promise.all`, Bash, `&`, PID files, queues, heartbeats, waves, detached processes, or per-child waits. SQLite alone owns `unclaimed -> running -> success|failed`, and an interrupted owner releases `running -> unclaimed`."#,
        exit_report = exit_report,
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::prompt;

    #[test]
    fn benchmark_prompt_never_closes_running_wait_snapshots() {
        let prompt = prompt(
            Some("release"),
            Path::new("nanocodex.toml"),
            None,
            Some("http://127.0.0.1:8788"),
            30,
        );

        assert!(prompt.contains("if (!terminalStates.has(item.status.state)) continue;"));
        assert!(prompt.contains("Never close, report, or remove a nonterminal entry"));
        assert!(prompt.contains("item.status.output.exit_code"));
    }

    #[test]
    fn benchmark_prompt_admits_workers_from_live_host_capacity() {
        let prompt = prompt(
            Some("release"),
            Path::new("nanocodex.toml"),
            None,
            Some("http://127.0.0.1:8788"),
            128,
        );

        assert!(prompt.contains("There is no fixed worker target"));
        assert!(prompt.contains("/proc/meminfo"));
        assert!(prompt.contains("/proc/loadavg"));
        assert!(prompt.contains("/proc/pressure/memory"));
        assert!(prompt.contains("Admit exactly one new worker"));
        assert!(prompt.contains("Re-sample after every admission"));
        assert!(prompt.contains("wait_agent` with a 15-second timeout"));
        assert!(prompt.contains("8 GiB = 8388608 KiB"));
        assert!(prompt.contains("notify(JSON.stringify(...))"));
        assert!(prompt.contains("`console` is unavailable"));
        assert!(!prompt.contains("while (active.size < min"));
    }
}
