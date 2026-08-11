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
                "POST `{{\"worker\":<worker-id>,\"error\":\"confirmed worker process exit\"}}` once to {}/v1/workers/exited and require that request to succeed",
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
        r#"Drive the pre-materialized Nanocodex benchmark {selected} to completion while continuously saturating the host. The benchmark controller is disposable: every eval worker must continue running if this controller process or Code Mode cell dies. Your first and only action is one Code Mode cell beginning `// @exec: {{\"yield_time_ms\": 3600000}}`; put the entire loop in it. If that cell ever yields, only resume that same cell. Keep orchestration state and the outer loop in JavaScript. `exec_command` already invokes a shell: pass each shell snippet directly as its `cmd`. Never wrap a snippet or script in `bash -lc`, `sh -c`, or another quoted shell command, and never embed `JSON.stringify(script)` into `cmd`. The resolved `exec_command` object's `output` field is raw command stdout; parse it directly. Never search it for telemetry-only text such as `Chunk ID`, `Final output`, or `Output:` and never strip an imagined execution-report envelope from it. Keep using `exit_code` from the resolved object for command success. If any command exits nonzero, inspect its output and correct the command; never repeat the identical failing command. `notify` is the built-in reporting function: call it directly and never declare a variable, function, or parameter named `notify`.

- Use `{worker_directory_argument}` as the durable worker directory and create it before doing anything else. One marker named `<worker-id>.pid` contains the decimal PID of one independently running worker, and `<worker-id>.tmp` is that worker's private temporary directory. At startup and before every admission, rebuild the complete `active` map from these marker files, never from prior JavaScript memory. For each marker read and validate its PID, derive unit `nanocodex-eval-worker-<worker-id>.service`, then query `systemctl --user show` for `LoadState`, `ActiveState`, `MainPID`, `Result`, `ExecMainCode`, and `ExecMainStatus`. When requesting multiple systemd properties, never use `--value` or parse output by line position because systemd does not preserve requested property order. Parse named `Property=value` lines into a map and read each property by name. The initial scan must return only marker identity, PID, and these compact named properties: do not read any journal for an active or activating unit, do not concatenate journals across workers, and do not embed journal text in a multi-worker JSON stream. An explicit `active` or `activating` unit is live; update its marker atomically when `MainPID` becomes nonzero. If the unit query is malformed but the marker PID still passes `kill -0`, preserve it as live. With `systemd-run --collect`, a dead unit commonly appears as `LoadState=not-found`, `ActiveState=inactive`, and misleading default success values; if its marker PID no longer exists, this is a confirmed exit, not an indeterminate state. Only then inspect that one dead unit's journal in its own bounded command to classify and report it. Preserve the marker and retry only when the available evidence cannot establish whether the marker PID or unit is alive. This report is idempotent and only releases a still-running row. Never signal or stop a live worker merely because the controller is starting, yielding, failing, or exiting.

- There is no fixed worker, memory, or load target. Continuously search for the host's actual capacity instead of admitting one worker at a time or waiting for a wave to finish. Before each decision read counts with `{status_command}`. That command's JSON is the count object itself: use `counts.unclaimed` and `counts.running` directly; never treat it as an array or look for task rows. Sample `/proc/meminfo`, `/proc/loadavg`, `/proc/pressure/memory`, and `getconf _NPROCESSORS_ONLN`; `/proc/meminfo` field names include a trailing colon, so remove it before looking up `MemTotal` or `MemAvailable`. Keep the highest concurrency that completed a full 10-second observation window without a capacity-related death as the lower bound and the concurrency immediately before an OS capacity death as the upper bound. Never raise the lower bound merely because a batch launched. After every full healthy observation window, set the lower bound to at least the observed active concurrency whether or not an upper bound already exists; this is what makes binary search advance instead of sticking at its first midpoint. With no upper bound and clear idle capacity, target twice the current local concurrency, seeding one worker from zero. With an upper bound, target the integer midpoint between the bounds. Always clamp the target to `active + counts.unclaimed`, so `batch <= counts.unclaimed`; never launch workers that cannot claim one of the currently unclaimed tasks. Launch every worker needed to reach the clamped target as one immediate batch, never pausing between launches. Then observe the resulting memory, load, pressure, worker exits, and task throughput for 10 seconds before making the next growth decision so VM growth can become visible. Low available memory, load, or pressure pauses admission but never terminates work. Once the host recovers, continue from the observed bounds. Use `notify(JSON.stringify(...))` for every sample and decision with counts, active workers, bounds, target, batch size, CPUs, load, available/total memory, pressure, recent exits, and the reason for the decision; `console` is unavailable in Code Mode.

- Give each worker a unique lowercase ASCII worker ID containing only letters, digits, and hyphens. In the same launch shell snippet, assign `worker_tmp` to `{worker_directory_argument}/<actual-worker-id>.tmp` with the actual ID substituted and the complete path safely quoted. Before launch, atomically create `{worker_directory_argument}/<worker-id>.pid` containing `0`, remove any residue at `$worker_tmp`, and create that private temporary directory. Resolve the current `nanocodex` executable with `command -v nanocodex`, then launch exactly one `nanocodex eval run{profile_argument} --config {config_argument}{state_argument}{coordinator_argument} --worker <worker-id>` using `systemd-run --user --quiet --collect --service-type=exec --unit nanocodex-eval-worker-<worker-id>.service --working-directory "$PWD" --setenv "PATH=$PATH" --setenv "TMPDIR=$worker_tmp"`. The launch command must return after the independent unit starts; never wait for the eval process. Read the unit's `MainPID` and atomically replace the marker with that PID. Use an explicit multiline `if ...; then ...; else ...; fi` for launch success and failure cleanup; never place a brace group directly after `&&` or `||`. If launch fails, {exit_report}, remove the marker, and remove its private temporary directory. Never use `spawn_agent`, `wait_agent`, `close_agent`, a foreground eval command, or a Code Mode exec session to own a worker.

- Reconciliation is the first phase of every outer-loop iteration. For each confirmed dead marker, inspect the unit's recent user journal as well as any retained named systemd properties. When `LoadState=not-found`, do not trust the synthetic `Result=success`, `ExecMainCode=0`, or `ExecMainStatus=0`; the journal is authoritative. Journal text saying the OOM killer acted or the result was `oom-kill` is a capacity death. Only systemd lifecycle evidence saying the main process exited nonzero, was killed, or the unit failed is an abnormal infrastructure exit; an eval log field such as `score.status=failed`, `eval.score.status=failed`, or a verifier failure is a successfully completed benchmark task and is not a worker crash. Every confirmed dead worker requires {exit_report} before its marker is removed, including a journal-backed clean exit; the report is idempotent and becomes a no-op when the worker already recorded a terminal result. A capacity death also lowers the upper bound to the marker count immediately before reconciliation and must not be blindly replaced. A journal-backed clean process exit is a normally completed eval and creates an immediate replacement opportunity while unclaimed work remains. Remove the marker only after the exit report succeeds, then remove `{worker_directory_argument}/<worker-id>.tmp`. Never remove a live worker's private temporary directory. When neither replacement nor growth is currently justified, wait 10 seconds and reconcile again.

- The operating system alone owns worker termination under resource exhaustion. Never send a signal to a worker unit, never stop one to create headroom, and never perform manual load shedding from the controller. Treat OS worker deaths as expected search feedback, allow surviving independent units to continue, and adapt the next admission decision from the observed failure and recovery. The benchmark must remain autonomous when no operator is present.

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
