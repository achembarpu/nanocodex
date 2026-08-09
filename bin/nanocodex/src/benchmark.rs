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
        r#"Drive the pre-materialized Nanocodex benchmark {selected} to completion. Your first and only action is one Code Mode cell beginning `// @exec: {{\"yield_time_ms\": 3600000}}`; put the entire loop in it. If that cell ever yields, only resume that same cell.

- Read counts only with `{status_command}`. Its JSON is the count object itself: use `counts.unclaimed` and `counts.running` directly; it is not a task-row array. Use exactly `while (active.size < min({max_subagents}, counts.unclaimed))` to sequentially `spawn_agent` once per free slot. Give each child a unique string worker ID and exactly one foreground `nanocodex eval run{profile_argument} --config {config_argument}{state_argument}{coordinator_argument} --worker <worker-id>`. The child keeps `exec_command` plus all `write_stdin` waits inside one Code Mode cell beginning `// @exec: {{\"yield_time_ms\": 300000}}`. While the command has a `session_id`, it must keep calling `write_stdin` in that cell; only a numeric `exit_code` permits submitting `{{ worker, exit_code }}`.

- Keep only `agent_id -> worker`. `wait_agent` on all active IDs; for every terminal result, `close_agent` first, then {exit_report}. Remove it and refill every free slot immediately. The report is idempotent and only changes a still-running row.

- Stop only when compact status has no unclaimed or running row; close all children and verify no eval worker, VMM, or proxy remains. Never use `Promise.all`, Bash, `&`, PID files, queues, heartbeats, waves, detached processes, or per-child waits. SQLite alone owns `unclaimed -> running -> success|failed`, and an interrupted owner releases `running -> unclaimed`."#,
        exit_report = exit_report,
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
