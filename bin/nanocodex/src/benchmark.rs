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

- There is no fixed worker target and never run in waves. `{max_subagents}` is only the runtime's mechanical tree ceiling, not the desired concurrency. Every 15 seconds read counts with `{status_command}`. That command's JSON is the count object itself: use `counts.unclaimed` and `counts.running` directly; never treat it as an array or look for task rows. Sample the Linux host from `/proc/meminfo`, `/proc/loadavg`, `/proc/pressure/memory`, and `getconf _NPROCESSORS_ONLN`. Keep `/proc/meminfo` values in KiB throughout; do not multiply them or print them through a fixed-width integer format. Parse memory pressure by finding the named `avg10=` token on the `some` line, not by token position. Compute `projectedReserveKiB = max(10485760, 15% of total KiB) + active.size * 524288`: this is a 10 GiB host reserve plus 512 MiB of latent-growth headroom for every live VM, not a worker-count cap. After terminal workers have been reaped and backfilled as described below, admit exactly one net-new growth worker when all of these are true: work remains unclaimed, `active.size < {max_subagents}`, one-minute load is below the online CPU count, available memory exceeds `projectedReserveKiB`, and memory `some` pressure `avg10` is below 1.0. Immediately after that net-new growth admission, execute exactly `await new Promise(resolve => setTimeout(resolve, 15000));` before the next capacity sample so the new VM's load and memory footprint become observable. This dwell is mandatory for growth: never `continue` directly from a growth spawn to another sample or admission. Re-sample after the dwell; never grow multiple slots from one stale sample. A capacity check that says no must only delay growth. Use `notify(JSON.stringify(...))` for each capacity sample and admission decision with counts, active workers, CPUs, load, available/total memory, projected reserve, and memory pressure; `console` is unavailable in Code Mode.

- Give each admitted child a unique string worker ID and exactly one foreground `nanocodex eval run{profile_argument} --config {config_argument}{state_argument}{coordinator_argument} --worker <worker-id>`. The child keeps `exec_command` plus all `write_stdin` waits inside one Code Mode cell beginning `// @exec: {{\"yield_time_ms\": 300000}}`. While the command has a `session_id`, it must keep calling `write_stdin` in that cell; only a numeric `exit_code` permits submitting `{{ worker, exit_code }}`.

- Keep only `agent_id -> worker`, and make reaping/backfill the first phase of every outer-loop iteration, before any growth decision. When active IDs exist, call `wait_agent` on all of them with `timeout_ms: 1`; this is a nonblocking terminal poll. Its `agents` array is a snapshot of every requested ID, so it also contains `pending`, `running`, or `closing` entries. Define `terminalStates = new Set(["completed", "failed", "interrupted", "closed"])` and begin the result loop with exactly `if (!terminalStates.has(item.status.state)) continue;`. Never close, report, or remove a nonterminal entry. For each terminal entry only, read a successful worker exit from `item.status.output.exit_code`, `close_agent` first, then {exit_report}, remove it from `active`, and increment `replacementSlots`. The report is idempotent and only changes a still-running row. Immediately and sequentially spawn one replacement for every `replacementSlots` while unclaimed work remains and the projected-reserve/pressure safety test passes. A replacement restores capacity that just exited: do not apply the 15-second growth dwell between replacements. Never leave terminal entries in `active` until the mechanical ceiling forces a reap. When neither replacement nor growth is possible, use `wait_agent` with a 15-second timeout before the next outer iteration.

- Prevent a kernel OOM from killing the complete benchmark tree. After reaping and sampling, but before any backfill or growth, treat `available memory < 8388608 KiB` or memory `some avg10 >= 1.0` as an emergency. In an emergency, select exactly one newest active `agent_id -> worker`, `close_agent`, {exit_report}, remove it from `active`, discard one replacement slot, wait 15 seconds, and re-sample. Repeat one at a time only while the emergency remains. This intentionally releases that one durable claim to `unclaimed`; never let the kernel kill every live claim together.

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
        assert!(prompt.contains("use `counts.unclaimed` and `counts.running` directly"));
        assert!(prompt.contains("never treat it as an array"));
        assert!(prompt.contains("named `avg10=` token"));
        assert!(prompt.contains("admit exactly one net-new growth worker"));
        assert!(prompt.contains("await new Promise(resolve => setTimeout(resolve, 15000));"));
        assert!(prompt.contains("never `continue` directly from a growth spawn"));
        assert!(prompt.contains("Re-sample after the dwell"));
        assert!(prompt.contains("first phase of every outer-loop iteration"));
        assert!(prompt.contains("`timeout_ms: 1`"));
        assert!(prompt.contains("increment `replacementSlots`"));
        assert!(prompt.contains("one replacement for every `replacementSlots`"));
        assert!(prompt.contains("do not apply the 15-second growth dwell between replacements"));
        assert!(prompt.contains("Never leave terminal entries in `active`"));
        assert!(prompt.contains("projectedReserveKiB"));
        assert!(prompt.contains("active.size * 524288"));
        assert!(prompt.contains("not a worker-count cap"));
        assert!(prompt.contains("available memory < 8388608 KiB"));
        assert!(prompt.contains("select exactly one newest active"));
        assert!(prompt.contains("Repeat one at a time only while the emergency remains"));
        assert!(prompt.contains("never let the kernel kill every live claim together"));
        assert!(prompt.contains("notify(JSON.stringify(...))"));
        assert!(prompt.contains("`console` is unavailable"));
        assert!(!prompt.contains("while (active.size < min"));
    }
}
