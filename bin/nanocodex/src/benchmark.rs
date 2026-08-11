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
                "For every name in status.workers whose nanocodex-eval-worker-<name>.service is not live, POST {{\"worker\":<name>,\"error\":\"worker process exited\"}} to {}/v1/workers/exited before admitting replacements. The operation is idempotent.",
                coordinator.trim_end_matches('/')
            )
        },
    );
    let worker_command = format!(
        "nanocodex eval run{profile_argument} --config {config_argument}{state_argument}{coordinator_argument} --worker <name>"
    );

    format!(
        r#"Drive the pre-materialized benchmark {selected} to completion at the highest productive host occupancy. You are the neural controller. SQLite is the only task authority, systemd is the only process authority, and every worker is one independent `{worker_command}` process.

Repeat this short control cycle until the board is terminal:

1. Observe, in a fresh Code Mode call, `{status_command}`, live or activating `nanocodex-eval-worker-*.service` user units and their `ExecStart`, `/proc/meminfo`, `/proc/loadavg`, `/proc/pressure/memory`, swap activity, and recent completions or worker exits. A unit belongs to this board only when its command is the `{worker_command}` shape for this selected profile; unrelated eval units affect host pressure but never this board's live count or reconciliation. Do not keep a JavaScript loop, PID marker, worker pool, or other controller state.
2. Reconcile before admission. {reconciliation}
3. Reason from the current and recent observations and choose an absolute desired live-worker count that maximizes terminal completions per hour. Starting units count as live. With backlog and no measured overload or throughput stall, grow aggressively in a batch; unused healthy capacity is a controller failure. OOMs and infrastructure retries are acceptable calibration signals. High utilization alone is not overload.
4. Let `live` be this board's live or activating unit count. Launch `min(unclaimed, max(0, desired - live))` workers immediately with unique lowercase names using `systemd-run --user --quiet --collect --service-type=exec --unit nanocodex-eval-worker-<name>.service --working-directory "$PWD" --setenv "PATH=$PATH" {worker_command}`. The systemd unit, never this controller or a tool session, owns the worker lifetime.
5. Observe again after the launched processes have had time to affect throughput and host pressure. Let existing workers drain under overload; never stop, signal, or shed one manually.

Controller failure or restart must leave every worker untouched. On restart, derive the complete situation again from SQLite and systemd. Do not use subagents to own workers and do not wait for worker processes in Code Mode. Finish only when status has zero unclaimed and running rows and no live unit belonging to this board remains."#,
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
