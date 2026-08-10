use std::path::Path;

pub(crate) fn prompt(
    profile: Option<&str>,
    config: &Path,
    state_dir: Option<&Path>,
    coordinator: Option<&str>,
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
    let worker_directory = worker_directory(profile, config);
    let worker_directory_argument = shell_quote(&worker_directory.to_string_lossy());
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
        r#"Drive the pre-materialized Nanocodex benchmark {selected} to completion while continuously saturating the host. The benchmark controller is disposable: every eval worker must continue running if this controller process or Code Mode cell dies. Your first and only action is one Code Mode cell beginning `// @exec: {{\"yield_time_ms\": 3600000}}`; put the entire loop in it. If that cell ever yields, only resume that same cell.

- Use `{worker_directory_argument}` as the durable worker directory and create it before doing anything else. One marker named `<worker-id>.pid` contains the decimal PID of one independently running worker. At startup and before every admission, rebuild the complete `active` map from these marker files, never from prior JavaScript memory. For each marker derive unit `nanocodex-eval-worker-<worker-id>.service`, then query `systemctl --user show` for `ActiveState` and `MainPID`. An `active` or `activating` unit is live; update its marker atomically when `MainPID` becomes nonzero. For every inactive or absent unit, {exit_report}, then remove its marker. This report is idempotent and only releases a still-running row. Never signal or stop a live worker merely because the controller is starting, yielding, failing, or exiting.

- There is no fixed worker target and never run in waves. Every 15 seconds read counts with `{status_command}`. That command's JSON is the count object itself: use `counts.unclaimed` and `counts.running` directly; never treat it as an array or look for task rows. Sample the Linux host from `/proc/meminfo`, `/proc/loadavg`, `/proc/pressure/memory`, and `getconf _NPROCESSORS_ONLN`. Keep `/proc/meminfo` values in KiB throughout. Parse memory pressure by finding the named `avg10=` token on the `some` line. Compute `projectedReserveKiB = max(10485760, 15% of total KiB) + active.size * 524288`: this is a 10 GiB host reserve plus 512 MiB of latent-growth headroom for every live VM, not a worker-count cap. Admit exactly one net-new worker when work remains unclaimed, one-minute load is below the online CPU count, available memory exceeds `projectedReserveKiB`, and memory `some` pressure `avg10` is below 1.0. After a net-new admission, wait exactly 15 seconds and rebuild `active` plus all capacity inputs before admitting again. A capacity check that says no only delays growth. Use `notify(JSON.stringify(...))` for every sample and admission decision with counts, active workers, CPUs, load, available/total memory, projected reserve, and memory pressure; `console` is unavailable in Code Mode.

- Give each worker a unique lowercase ASCII worker ID containing only letters, digits, and hyphens. Before launch, atomically create `{worker_directory_argument}/<worker-id>.pid` containing `0`. Resolve the current `nanocodex` executable with `command -v nanocodex`, then launch exactly one `nanocodex eval run{profile_argument} --config {config_argument}{state_argument}{coordinator_argument} --worker <worker-id>` using `systemd-run --user --quiet --collect --service-type=exec --unit nanocodex-eval-worker-<worker-id>.service --working-directory "$PWD" --setenv "PATH=$PATH"`. The launch command must return after the independent unit starts; never wait for the eval process. Read the unit's `MainPID` and atomically replace the marker with that PID. If launch fails, {exit_report} and remove the marker. Never use `spawn_agent`, `wait_agent`, `close_agent`, a foreground eval command, or a Code Mode exec session to own a worker.

- Reconciliation is the first phase of every outer-loop iteration. Every inactive marker creates one replacement opportunity. Immediately launch replacements one at a time while unclaimed work remains and the same reserve/pressure safety test passes; rebuild capacity after each replacement. Replacements restore departed capacity and do not require the 15-second net-growth dwell. When neither replacement nor growth is possible, wait 15 seconds and reconcile again.

- Prevent a kernel OOM from killing every worker. After reconciliation and sampling, but before replacement or growth, treat available memory below 8388608 KiB or memory `some avg10 >= 1.0` as an emergency. Only in that emergency, stop exactly one newest active worker unit, {exit_report}, remove its marker, wait 15 seconds, and re-sample. Repeat one at a time only while the emergency remains.

- Stop the controller only when compact status has no unclaimed or running row and reconciliation finds no active worker marker. Never stop live worker units during normal controller shutdown. SQLite alone owns `unclaimed -> running -> success|failed`, and an interrupted owner releases `running -> unclaimed`."#,
        exit_report = exit_report,
    )
}

fn worker_directory(profile: Option<&str>, config: &Path) -> std::path::PathBuf {
    let profile = profile.unwrap_or("default");
    let profile = profile
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    config
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(".nanocodex-benchmark-workers")
        .join(profile.trim_matches('-'))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{prompt, worker_directory};

    #[test]
    fn benchmark_prompt_never_closes_running_wait_snapshots() {
        let prompt = prompt(
            Some("release"),
            Path::new("nanocodex.toml"),
            None,
            Some("http://127.0.0.1:8788"),
        );

        assert!(prompt.contains("controller is disposable"));
        assert!(prompt.contains("rebuild the complete `active` map from these marker files"));
        assert!(prompt.contains("Never signal or stop a live worker merely because"));
        assert!(prompt.contains("never wait for the eval process"));
    }

    #[test]
    fn benchmark_prompt_admits_workers_from_live_host_capacity() {
        let prompt = prompt(
            Some("release"),
            Path::new("nanocodex.toml"),
            None,
            Some("http://127.0.0.1:8788"),
        );

        assert!(prompt.contains("There is no fixed worker target"));
        assert!(prompt.contains("/proc/meminfo"));
        assert!(prompt.contains("/proc/loadavg"));
        assert!(prompt.contains("/proc/pressure/memory"));
        assert!(prompt.contains("use `counts.unclaimed` and `counts.running` directly"));
        assert!(prompt.contains("never treat it as an array"));
        assert!(prompt.contains("named `avg10=` token"));
        assert!(prompt.contains("Admit exactly one net-new worker"));
        assert!(prompt.contains("wait exactly 15 seconds"));
        assert!(prompt.contains("rebuild `active` plus all capacity inputs"));
        assert!(prompt.contains("Reconciliation is the first phase"));
        assert!(prompt.contains("Every inactive marker creates one replacement opportunity"));
        assert!(prompt.contains("do not require the 15-second net-growth dwell"));
        assert!(prompt.contains("projectedReserveKiB"));
        assert!(prompt.contains("active.size * 524288"));
        assert!(prompt.contains("not a worker-count cap"));
        assert!(prompt.contains("available memory below 8388608 KiB"));
        assert!(prompt.contains("stop exactly one newest active worker unit"));
        assert!(prompt.contains("Repeat one at a time only while the emergency remains"));
        assert!(prompt.contains("notify(JSON.stringify(...))"));
        assert!(prompt.contains("`console` is unavailable"));
        assert!(prompt.contains("systemd-run --user"));
        assert!(prompt.contains("<worker-id>.pid"));
        assert!(prompt.contains("Never use `spawn_agent`"));
    }

    #[test]
    fn worker_markers_are_scoped_beside_the_selected_config() {
        assert_eq!(
            worker_directory(Some("Terminal Bench/2.1"), Path::new("runs/release.toml")),
            Path::new("runs/.nanocodex-benchmark-workers/terminal-bench-2-1")
        );
    }
}
