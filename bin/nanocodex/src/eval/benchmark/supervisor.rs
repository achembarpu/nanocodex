use std::{
    collections::HashMap, env, ffi::OsString, fs, io::Write as _, path::Path, process::Command,
    time::Duration,
};

use eyre::{Result, WrapErr as _, bail, eyre};
use nanocodex_eval::coordinator::CoordinatorClient;
use uuid::Uuid;

use super::BoardStatus;

const OBSERVATION_WINDOW: Duration = Duration::from_secs(10);
const WORKER_UNIT_PREFIX: &str = "nanocodex-eval-worker-";

pub(super) async fn run(profile: &str, config: &Path, coordinator: &str) -> Result<()> {
    if !cfg!(target_os = "linux") {
        bail!("headless coordinator benchmarks require systemd on Linux");
    }

    let cwd = env::current_dir().wrap_err("failed to resolve benchmark working directory")?;
    let config = if config.is_absolute() {
        config.to_path_buf()
    } else {
        cwd.join(config)
    };
    let worker_directory = crate::benchmark::worker_directory(Some(profile), &config);
    fs::create_dir_all(&worker_directory).wrap_err_with(|| {
        format!(
            "failed to create benchmark worker directory {}",
            worker_directory.display()
        )
    })?;
    let executable = env::current_exe().wrap_err("failed to resolve nanocodex executable")?;
    let path = env::var_os("PATH").unwrap_or_default();
    let client = CoordinatorClient::new(coordinator)?;

    let mut lower = 0_usize;
    let mut upper = None;
    let mut observed_window = false;

    loop {
        let workers = reconcile(&worker_directory, &client).await?;
        if workers.capacity_death {
            upper = Some(upper.map_or(workers.before, |prior: usize| prior.min(workers.before)));
        } else if observed_window {
            lower = lower.max(workers.active);
        }

        let board = BoardStatus::load(None, &config, None, Some(coordinator)).await?;
        if board.is_complete() && workers.active == 0 {
            emit(board, workers.active, lower, upper, 0, 0, 0, "complete")?;
            return Ok(());
        }

        let unclaimed = usize::try_from(board.tasks.unclaimed.max(0)).unwrap_or(usize::MAX);
        let running = usize::try_from(board.tasks.running.max(0)).unwrap_or(usize::MAX);
        let target = target_concurrency(workers.active, running, unclaimed, lower, upper);
        let batch = target.saturating_sub(workers.active);
        let reason = if workers.capacity_death {
            "capacity boundary"
        } else if unclaimed == 0 {
            "no unclaimed work"
        } else if upper.is_some() {
            "binary search"
        } else {
            "doubling"
        };

        for _ in 0..batch {
            launch_worker(
                profile,
                &config,
                coordinator,
                &worker_directory,
                &executable,
                &cwd,
                &path,
                &client,
            )
            .await?;
        }

        emit(
            board,
            workers.active,
            lower,
            upper,
            target,
            batch,
            workers.exited,
            reason,
        )?;
        observed_window = true;
        tokio::time::sleep(OBSERVATION_WINDOW).await;
    }
}

fn target_concurrency(
    active: usize,
    running: usize,
    unclaimed: usize,
    lower: usize,
    upper: Option<usize>,
) -> usize {
    let pending_claims = active.saturating_sub(running);
    let claimable = unclaimed.saturating_sub(pending_claims);
    if claimable == 0 {
        return active;
    }
    let wanted = match upper {
        None if active == 0 => 1,
        None => active.saturating_mul(2),
        Some(upper) if upper <= lower.saturating_add(1) => active,
        Some(upper) => active.max(lower.saturating_add(upper).saturating_div(2)),
    };
    wanted.min(active.saturating_add(claimable))
}

struct Reconciliation {
    active: usize,
    before: usize,
    exited: usize,
    capacity_death: bool,
}

async fn reconcile(worker_directory: &Path, client: &CoordinatorClient) -> Result<Reconciliation> {
    let mut markers = fs::read_dir(worker_directory)
        .wrap_err_with(|| {
            format!(
                "failed to read benchmark worker directory {}",
                worker_directory.display()
            )
        })?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "pid"))
        .collect::<Vec<_>>();
    markers.sort();

    let before = markers.len();
    let mut active = 0;
    let mut exited = 0;
    let mut capacity_death = false;
    for marker in markers {
        let worker = worker_name(&marker)?;
        let marker_pid = read_pid(&marker)?;
        let unit = format!("{WORKER_UNIT_PREFIX}{worker}.service");
        let properties = unit_properties(&unit)?;
        let main_pid = properties
            .get("MainPID")
            .and_then(|pid| pid.parse::<u32>().ok())
            .unwrap_or(0);
        let unit_live = properties
            .get("ActiveState")
            .is_some_and(|state| state == "active" || state == "activating");
        let pid_live = marker_pid > 0 && process_exists(marker_pid);
        if unit_live || pid_live {
            if main_pid > 0 && main_pid != marker_pid {
                write_marker(&marker, main_pid)?;
            }
            active += 1;
            continue;
        }

        let journal = unit_journal(&unit);
        let result_oom = properties
            .get("Result")
            .is_some_and(|result| result == "oom-kill");
        capacity_death |= result_oom || journal_indicates_oom(&journal);
        client
            .clone()
            .worker(worker.clone())
            .worker_exited("confirmed worker process exit")
            .await
            .wrap_err_with(|| format!("failed to release exited worker {worker}"))?;
        remove_if_present(&marker)?;
        remove_directory_if_present(&worker_directory.join(format!("{worker}.tmp")))?;
        exited += 1;
    }

    Ok(Reconciliation {
        active,
        before,
        exited,
        capacity_death,
    })
}

#[allow(clippy::too_many_arguments)]
async fn launch_worker(
    profile: &str,
    config: &Path,
    coordinator: &str,
    worker_directory: &Path,
    executable: &Path,
    cwd: &Path,
    path: &std::ffi::OsStr,
    client: &CoordinatorClient,
) -> Result<()> {
    let worker = format!("worker-{}", Uuid::new_v4().simple());
    let marker = worker_directory.join(format!("{worker}.pid"));
    let temporary = worker_directory.join(format!("{worker}.tmp"));
    remove_directory_if_present(&temporary)?;
    fs::create_dir_all(&temporary)
        .wrap_err_with(|| format!("failed to create worker directory {}", temporary.display()))?;
    write_marker(&marker, 0)?;

    let unit = format!("{WORKER_UNIT_PREFIX}{worker}.service");
    let mut path_assignment = OsString::from("PATH=");
    path_assignment.push(path);
    let mut temporary_assignment = OsString::from("TMPDIR=");
    temporary_assignment.push(&temporary);
    let output = Command::new("systemd-run")
        .args([
            "--user",
            "--quiet",
            "--collect",
            "--service-type=exec",
            "--unit",
        ])
        .arg(&unit)
        .arg("--working-directory")
        .arg(cwd)
        .arg("--setenv")
        .arg(path_assignment)
        .arg("--setenv")
        .arg(temporary_assignment)
        .arg(executable)
        .args(["eval", "run"])
        .arg(profile)
        .arg("--config")
        .arg(config)
        .arg("--coordinator")
        .arg(coordinator)
        .arg("--worker")
        .arg(&worker)
        .output()
        .wrap_err_with(|| format!("failed to launch worker {worker}"))?;
    if !output.status.success() {
        client
            .clone()
            .worker(worker.clone())
            .worker_exited("worker launch failed")
            .await?;
        remove_if_present(&marker)?;
        remove_directory_if_present(&temporary)?;
        bail!(
            "failed to launch worker {worker}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    for _ in 0..20 {
        let properties = unit_properties(&unit)?;
        if let Some(pid) = properties
            .get("MainPID")
            .and_then(|pid| pid.parse::<u32>().ok())
            .filter(|pid| *pid > 0)
        {
            write_marker(&marker, pid)?;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

fn worker_name(marker: &Path) -> Result<String> {
    let worker = marker
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| eyre!("worker marker is not valid UTF-8: {}", marker.display()))?;
    if worker.is_empty()
        || !worker
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        bail!("invalid worker marker name: {}", marker.display());
    }
    Ok(worker.to_owned())
}

fn read_pid(marker: &Path) -> Result<u32> {
    fs::read_to_string(marker)
        .wrap_err_with(|| format!("failed to read worker marker {}", marker.display()))?
        .trim()
        .parse()
        .wrap_err_with(|| format!("invalid worker PID in {}", marker.display()))
}

fn write_marker(marker: &Path, pid: u32) -> Result<()> {
    let parent = marker
        .parent()
        .ok_or_else(|| eyre!("worker marker has no parent: {}", marker.display()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    writeln!(temporary, "{pid}")?;
    temporary.as_file_mut().sync_all()?;
    temporary
        .persist(marker)
        .map_err(|error| error.error)
        .wrap_err_with(|| format!("failed to update worker marker {}", marker.display()))?;
    Ok(())
}

fn unit_properties(unit: &str) -> Result<HashMap<String, String>> {
    let output = Command::new("systemctl")
        .args([
            "--user",
            "show",
            unit,
            "--property=LoadState",
            "--property=ActiveState",
            "--property=MainPID",
            "--property=Result",
            "--property=ExecMainCode",
            "--property=ExecMainStatus",
        ])
        .output()
        .wrap_err_with(|| format!("failed to inspect worker unit {unit}"))?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect())
}

fn unit_journal(unit: &str) -> String {
    Command::new("journalctl")
        .args([
            "--user",
            "--unit",
            unit,
            "--lines=60",
            "--no-pager",
            "-o",
            "cat",
        ])
        .output()
        .map_or_else(
            |_| String::new(),
            |output| String::from_utf8_lossy(&output.stdout).into_owned(),
        )
}

fn journal_indicates_oom(journal: &str) -> bool {
    let journal = journal.to_ascii_lowercase();
    journal.contains("oom-kill")
        || journal.contains("out of memory")
        || journal.contains("killed process")
}

fn process_exists(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success())
}

fn remove_if_present(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error)
            .wrap_err_with(|| format!("failed to remove worker marker {}", path.display())),
    }
}

fn remove_directory_if_present(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error)
            .wrap_err_with(|| format!("failed to remove worker directory {}", path.display())),
    }
}

#[allow(clippy::too_many_arguments)]
fn emit(
    board: BoardStatus,
    active_workers: usize,
    lower_bound: usize,
    upper_bound: Option<usize>,
    target: usize,
    batch: usize,
    exited: usize,
    reason: &str,
) -> Result<()> {
    let meminfo = fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let memory = |name: &str| {
        meminfo.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            (key == name)
                .then(|| value.split_whitespace().next()?.parse::<u64>().ok())
                .flatten()
        })
    };
    let load_one = fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|load| load.split_whitespace().next()?.parse::<f64>().ok());
    let pressure = fs::read_to_string("/proc/pressure/memory")
        .ok()
        .and_then(|pressure| {
            pressure
                .lines()
                .find(|line| line.starts_with("some "))?
                .split_whitespace()
                .find_map(|field| field.strip_prefix("avg10="))?
                .parse::<f64>()
                .ok()
        });
    let sample = serde_json::json!({
        "protocol_version": 1,
        "type": "benchmark.sample",
        "counts": {
            "unclaimed": board.tasks.unclaimed,
            "running": board.tasks.running,
            "success": board.tasks.success,
            "failed": board.tasks.failed,
        },
        "active_workers": active_workers,
        "lower_bound": lower_bound,
        "upper_bound": upper_bound,
        "target": target,
        "batch": batch,
        "exited": exited,
        "reason": reason,
        "host": {
            "memory_total_kib": memory("MemTotal"),
            "memory_available_kib": memory("MemAvailable"),
            "load_one": load_one,
            "memory_pressure_some_avg10": pressure,
        },
    });
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    serde_json::to_writer(&mut stdout, &sample)?;
    writeln!(stdout)?;
    stdout.flush()?;
    Ok(())
}
