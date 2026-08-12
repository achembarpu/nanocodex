use std::path::Path;

pub(crate) fn prompt(
    profile: Option<&str>,
    config: &Path,
    state_dir: Option<&Path>,
    coordinator: Option<&str>,
    executable: Option<&Path>,
) -> String {
    let selected = profile.unwrap_or("the manifest default profile");
    let profile_argument =
        profile.map_or_else(String::new, |profile| format!(" {}", shell_quote(profile)));
    let config_argument = shell_quote(&config.to_string_lossy());
    let state_argument = state_dir.map_or_else(String::new, |directory| {
        format!(" --state-dir {}", shell_quote(&directory.to_string_lossy()))
    });
    let coordinator_argument = coordinator.map_or_else(String::new, |coordinator| {
        format!(" --coordinator {}", shell_quote(coordinator))
    });
    let status_command = coordinator.map_or_else(
        || {
            format!(
                "nanocodex eval status{profile_argument} --config {config_argument}{state_argument} --json"
            )
        },
        |coordinator| format!("curl -fsS {}/v1/status", coordinator.trim_end_matches('/')),
    );
    let reconciliation = coordinator.map_or_else(
        || {
            "Local status releases rows whose worker process disappeared; do not maintain another recovery record."
                .to_owned()
        },
        |coordinator| {
            format!(
                "For every name in status.workers whose nanocodex-eval-worker@<name>.service is not live, POST {{\"worker\":<name>,\"error\":\"worker process exited\"}} to {}/v1/workers/exited before admitting replacements. The operation is idempotent. Never perform the inverse: a live unit absent from status.workers is not an exited worker and must never be posted to this endpoint.",
                coordinator.trim_end_matches('/')
            )
        },
    );
    let executable = executable.map_or_else(
        || "nanocodex".to_owned(),
        |path| shell_quote(&path.to_string_lossy()),
    );
    let worker_command = format!(
        "{executable} eval run{profile_argument} --config {config_argument}{state_argument}{coordinator_argument} --worker <name>"
    );

    format!(
        r#"Drive the pre-materialized benchmark {selected} to completion at the highest productive host occupancy. You are the neural controller. SQLite is the only task authority, systemd is the only process authority, and every worker is one independent `{worker_command}` process.

Repeat this short control cycle until the board is terminal:

1. Observe, in one fresh compact Code Mode call, `{status_command}`; live or activating `nanocodex-eval-worker@*.service` user units with only their `Id`, `ActiveState`, `SubState`, and `ExecStart`; the `nanocodex-eval.slice` aggregate `MemoryCurrent`, `MemoryPeak`, `CPUUsageNSec`, and `TasksCurrent`; and the relevant lines from `/proc/meminfo`, `/proc/loadavg`, `/proc/pressure/memory`, and `df -B1 / "${{TMPDIR:-/tmp}}"`. Status includes terminal attempt outcomes and the newest eight retryable failures from the last five minutes; reason from their exact errors and compare terminal attempts across cycles for throughput. For an interrupted attempt, use its retained worker name to read at most that unit's last 20 warning-or-higher journal lines and distinguish OOM from another process exit. A unit belongs to this board only when its `ExecStart` has the `{worker_command}` shape for this selected profile; unrelated eval units affect host pressure but never this board's live count or reconciliation. Do not list inactive units, request unselected systemd properties, read other journals or tracing during normal control, or keep a JavaScript loop, PID marker, worker pool, or other controller state.
2. Reconcile before admission. {reconciliation}
3. Reason from the current and recent observations and choose an absolute desired live-worker count that maximizes terminal completions per hour. Starting units count as live. With backlog and no measured overload or throughput stall, grow aggressively in a batch; unused healthy capacity is a controller failure. OOMs and infrastructure retries are acceptable calibration signals. High utilization alone is not overload.
4. Let `live` be this board's live or activating unit count. Launch `min(unclaimed, max(0, desired - live))` workers immediately with unique lowercase systemd-safe names. For each worker set `worker_tmp="${{TMPDIR:-/tmp}}/workers/<name>"`, create it, then use `systemd-run --user --quiet --collect --service-type=exec --unit nanocodex-eval-worker@<name>.service --slice nanocodex-eval.slice --property OOMScoreAdjust=500 --property OOMPolicy=kill --property "ExecStopPost=/usr/bin/rm -rf -- $worker_tmp" --working-directory "$PWD" --setenv "PATH=$PATH" --setenv "TMPDIR=$worker_tmp" {worker_command}`. Remove `worker_tmp` yourself only if the launch command fails. The worker's systemd unit owns both its process cgroup and scratch directory, including cleanup after kernel OOM; the controller and tool session own neither.
5. With live workers and no elevated pressure or vanished worker, combine waiting and observation in one Code Mode call: start it with `// @exec: {{"yield_time_ms": 30000, "max_output_tokens": 2000}}`, await a 25-second `setTimeout` promise, and then collect the next compact observation. Never create a sleep subprocess, yielded background cell, or separate wait call. Let existing workers drain under overload; never stop, signal, or shed one manually.

Controller failure or restart must leave every worker untouched. On restart, derive the complete situation again from SQLite and systemd. Do not use subagents to own workers and do not wait for worker processes in Code Mode. Finish only when status has zero unclaimed and running rows and no live unit belonging to this board remains."#,
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
