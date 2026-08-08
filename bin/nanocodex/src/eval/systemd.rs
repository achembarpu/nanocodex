use std::{
    env,
    ffi::{OsStr, OsString},
    fmt::Write as _,
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    process::{Command, Output},
};

use eyre::{Result, WrapErr as _, bail, eyre};
use nanocodex_eval::{Evaluation, coordinator::CoordinatorClient};
use sha2::{Digest as _, Sha256};

use super::profile::default_state_dir;

const RESTART_DELAY: &str = "30s";
const COORDINATOR_RESTART_DELAY: &str = "2s";
const COORDINATOR_WATCHDOG: &str = "30s";

pub(super) fn install(
    profile: &str,
    config: &Path,
    state_dir: Option<&Path>,
    coordinator: Option<&str>,
    runtime_dir: Option<&Path>,
    orchestrator_prompt_file: Option<&Path>,
) -> Result<()> {
    if !cfg!(target_os = "linux") {
        bail!("--systemd is supported only on Linux");
    }

    let invocation_directory =
        env::current_dir().wrap_err("failed to resolve current directory")?;
    let config = absolute_existing(config, &invocation_directory, "runtime helper config")?;
    let orchestrator_prompt_file = orchestrator_prompt_file
        .map(|path| absolute_existing(path, &invocation_directory, "orchestrator prompt"))
        .transpose()?;
    let working_directory = config
        .parent()
        .ok_or_else(|| eyre!("runtime helper config has no parent directory"))?;
    let runtime_dir = runtime_dir.map_or_else(
        || working_directory.join(".nanocodex-runtime"),
        |runtime_dir| absolute(runtime_dir, &invocation_directory),
    );
    let temporary_directory = runtime_dir.join("tmp");
    fs::create_dir_all(&temporary_directory).wrap_err_with(|| {
        format!(
            "failed to create benchmark runtime directory {}",
            temporary_directory.display()
        )
    })?;
    let runtime_dir = runtime_dir.canonicalize().wrap_err_with(|| {
        format!(
            "failed to resolve benchmark runtime directory {}",
            runtime_dir.display()
        )
    })?;
    let temporary_directory = runtime_dir.join("tmp");
    if let Some(coordinator) = coordinator {
        CoordinatorClient::new(coordinator)?;
    }
    let state_dir = if coordinator.is_some() {
        None
    } else {
        let state_dir = state_dir.map_or_else(default_state_dir, |path| Ok(path.to_path_buf()))?;
        let state_dir = absolute(&state_dir, &invocation_directory);
        Evaluation::open(&config, profile, &state_dir)?;
        Some(state_dir.canonicalize().wrap_err_with(|| {
            format!("failed to resolve state directory {}", state_dir.display())
        })?)
    };
    let executable = env::current_exe().wrap_err("failed to resolve the nanocodex executable")?;
    let arguments = service_arguments(
        &config,
        state_dir.as_deref(),
        orchestrator_prompt_file.as_deref(),
    )?;
    let target = coordinator
        .map(OsStr::new)
        .or_else(|| state_dir.as_deref().map(Path::as_os_str))
        .ok_or_else(|| eyre!("benchmark service target is absent"))?;
    let unit_name = unit_name(profile, &config, target);
    let unit = render_unit(
        &executable,
        &arguments,
        working_directory,
        &runtime_dir,
        &temporary_directory,
    )?;
    let unit_path = user_unit_directory()?.join(&unit_name);

    fs::create_dir_all(
        unit_path
            .parent()
            .ok_or_else(|| eyre!("systemd unit path has no parent"))?,
    )
    .wrap_err_with(|| format!("failed to create user systemd directory for {unit_name}"))?;
    write_atomic(&unit_path, unit.as_bytes())?;
    systemctl(["daemon-reload"])?;
    systemctl(["enable", unit_name.as_str()])?;
    systemctl(["restart", unit_name.as_str()])?;

    println!("Installed and started {unit_name}");
    println!("  systemctl --user status {unit_name}");
    println!("  journalctl --user --unit {unit_name} --follow");
    print_linger_hint();
    Ok(())
}

pub(super) fn install_coordinator(
    profile: &str,
    config: &Path,
    state_dir: &Path,
    port: u16,
) -> Result<()> {
    if !cfg!(target_os = "linux") {
        bail!("--systemd is supported only on Linux");
    }
    if port == 0 {
        bail!("a systemd coordinator requires a stable non-zero port");
    }

    let invocation_directory =
        env::current_dir().wrap_err("failed to resolve current directory")?;
    let config = absolute_existing(config, &invocation_directory, "runtime helper config")?;
    let state_dir = absolute_existing(state_dir, &invocation_directory, "evaluation state")?;
    Evaluation::open(&config, profile, &state_dir)?;
    let working_directory = config
        .parent()
        .ok_or_else(|| eyre!("runtime helper config has no parent directory"))?;
    let executable = env::current_exe().wrap_err("failed to resolve the nanocodex executable")?;
    let arguments =
        normalize_coordinator_arguments(env::args_os().skip(1).collect(), &config, &state_dir);
    let unit_name = coordinator_unit_name(profile, &config, &state_dir, port);
    let unit = render_coordinator_unit(&executable, &arguments, working_directory)?;
    let unit_path = user_unit_directory()?.join(&unit_name);

    fs::create_dir_all(
        unit_path
            .parent()
            .ok_or_else(|| eyre!("systemd unit path has no parent"))?,
    )
    .wrap_err_with(|| format!("failed to create user systemd directory for {unit_name}"))?;
    write_atomic(&unit_path, unit.as_bytes())?;
    systemctl(["daemon-reload"])?;
    systemctl(["enable", unit_name.as_str()])?;
    systemctl(["restart", unit_name.as_str()])?;

    println!("Installed and started {unit_name}");
    println!("  systemctl --user status {unit_name}");
    println!("  journalctl --user --unit {unit_name} --follow");
    print_linger_hint();
    Ok(())
}

fn normalize_coordinator_arguments(
    mut arguments: Vec<OsString>,
    config: &Path,
    state_dir: &Path,
) -> Vec<OsString> {
    arguments.retain(|argument| argument != "--systemd");
    replace_option(&mut arguments, "--config", config.as_os_str());
    replace_option(&mut arguments, "--state-dir", state_dir.as_os_str());
    arguments
}

fn service_arguments(
    config: &Path,
    state_dir: Option<&Path>,
    orchestrator_prompt_file: Option<&Path>,
) -> Result<Vec<OsString>> {
    Ok(normalize_service_arguments(
        env::args_os().skip(1).collect(),
        config,
        state_dir,
        orchestrator_prompt_file,
    ))
}

fn normalize_service_arguments(
    mut arguments: Vec<OsString>,
    config: &Path,
    state_dir: Option<&Path>,
    orchestrator_prompt_file: Option<&Path>,
) -> Vec<OsString> {
    arguments.retain(|argument| argument != "--systemd");
    remove_option(&mut arguments, "--runtime-dir");
    replace_option(&mut arguments, "--config", config.as_os_str());
    if let Some(state_dir) = state_dir {
        replace_option(&mut arguments, "--state-dir", state_dir.as_os_str());
    }
    if let Some(orchestrator_prompt_file) = orchestrator_prompt_file {
        replace_option(
            &mut arguments,
            "--orchestrator-prompt-file",
            orchestrator_prompt_file.as_os_str(),
        );
    }
    if !arguments.iter().any(|argument| argument == "--headless") {
        arguments.push(OsString::from("--headless"));
    }
    arguments
}

fn remove_option(arguments: &mut Vec<OsString>, option: &str) {
    let with_equals = format!("{option}=");
    let mut index = 0;
    while index < arguments.len() {
        if arguments[index] == option {
            arguments.remove(index);
            if index < arguments.len() {
                arguments.remove(index);
            }
            continue;
        }
        if arguments[index]
            .to_str()
            .is_some_and(|argument| argument.starts_with(&with_equals))
        {
            arguments.remove(index);
            continue;
        }
        index += 1;
    }
}

fn replace_option(arguments: &mut Vec<OsString>, option: &str, value: &OsStr) {
    let with_equals = format!("{option}=");
    let mut index = 0;
    while index < arguments.len() {
        if arguments[index] == option {
            if index + 1 < arguments.len() {
                arguments[index + 1] = value.to_os_string();
            } else {
                arguments.push(value.to_os_string());
            }
            return;
        }
        if arguments[index]
            .to_str()
            .is_some_and(|argument| argument.starts_with(&with_equals))
        {
            arguments[index] = OsString::from(format!("{option}={}", value.to_string_lossy()));
            return;
        }
        index += 1;
    }
    arguments.push(OsString::from(option));
    arguments.push(value.to_os_string());
}

fn render_unit(
    executable: &Path,
    arguments: &[OsString],
    working_directory: &Path,
    runtime_directory: &Path,
    temporary_directory: &Path,
) -> Result<String> {
    let command = render_command(executable, arguments)?;
    Ok(format!(
        "[Unit]\n\
         Description=Nanocodex benchmark\n\
         Wants=network-online.target\n\
         After=network-online.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         WorkingDirectory={}\n\
         Environment={}\n\
         Environment={}\n\
         ExecStart={command}\n\
         Restart=on-failure\n\
         RestartSec={RESTART_DELAY}\n\
         KillMode=control-group\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        escape_path(working_directory.as_os_str())?,
        quote(
            OsString::from(format!("NANOCODEX_HOME={}", runtime_directory.display())).as_os_str()
        )?,
        quote(OsString::from(format!("TMPDIR={}", temporary_directory.display())).as_os_str())?,
    ))
}

fn render_coordinator_unit(
    executable: &Path,
    arguments: &[OsString],
    working_directory: &Path,
) -> Result<String> {
    let command = render_command(executable, arguments)?;
    Ok(format!(
        "[Unit]\n\
         Description=Nanocodex evaluation coordinator API\n\
         Wants=network-online.target\n\
         After=network-online.target\n\
         \n\
         [Service]\n\
         Type=notify\n\
         NotifyAccess=main\n\
         WorkingDirectory={}\n\
         ExecStart={command}\n\
         Restart=always\n\
         RestartSec={COORDINATOR_RESTART_DELAY}\n\
         WatchdogSec={COORDINATOR_WATCHDOG}\n\
         TimeoutStartSec=45s\n\
         TimeoutStopSec=30s\n\
         KillMode=control-group\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        escape_path(working_directory.as_os_str())?,
    ))
}

fn render_command(executable: &Path, arguments: &[OsString]) -> Result<String> {
    let mut command = quote(executable.as_os_str())?;
    for argument in arguments {
        write!(command, " {}", quote(argument)?)?;
    }
    Ok(command)
}

fn escape_path(value: &OsStr) -> Result<String> {
    let value = value
        .to_str()
        .ok_or_else(|| eyre!("systemd paths must be valid UTF-8"))?;
    let mut escaped = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'/' | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z' | b':' | b'_' | b'.' | b'-' => {
                escaped.push(char::from(byte));
            }
            b'%' => escaped.push_str("%%"),
            byte => write!(escaped, "\\x{byte:02x}")?,
        }
    }
    Ok(escaped)
}

fn quote(value: &OsStr) -> Result<String> {
    let value = value
        .to_str()
        .ok_or_else(|| eyre!("systemd arguments must be valid UTF-8"))?;
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for character in value.chars() {
        match character {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            '%' => quoted.push_str("%%"),
            '$' => quoted.push_str("$$"),
            character => quoted.push(character),
        }
    }
    quoted.push('"');
    Ok(quoted)
}

fn unit_name(profile: &str, config: &Path, target: &OsStr) -> String {
    let mut digest = Sha256::new();
    digest.update(config.as_os_str().as_encoded_bytes());
    digest.update([0]);
    digest.update(target.as_encoded_bytes());
    digest.update([0]);
    digest.update(profile.as_bytes());
    let digest = hex::encode(digest.finalize());
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
    format!(
        "nanocodex-benchmark-{}-{}.service",
        profile.trim_matches('-'),
        &digest[..12]
    )
}

fn coordinator_unit_name(profile: &str, config: &Path, state_dir: &Path, port: u16) -> String {
    let mut digest = Sha256::new();
    digest.update(config.as_os_str().as_encoded_bytes());
    digest.update([0]);
    digest.update(state_dir.as_os_str().as_encoded_bytes());
    digest.update([0]);
    digest.update(port.to_le_bytes());
    digest.update([0]);
    digest.update(profile.as_bytes());
    let digest = hex::encode(digest.finalize());
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
    format!(
        "nanocodex-coordinator-{}-{}.service",
        profile.trim_matches('-'),
        &digest[..12]
    )
}

fn user_unit_directory() -> Result<PathBuf> {
    if let Some(config_home) = env::var_os("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(config_home).join("systemd/user"));
    }
    let home = env::var_os("HOME")
        .ok_or_else(|| eyre!("HOME is not set; cannot install a user systemd service"))?;
    Ok(PathBuf::from(home).join(".config/systemd/user"))
}

fn absolute_existing(path: &Path, cwd: &Path, description: &str) -> Result<PathBuf> {
    absolute(path, cwd)
        .canonicalize()
        .wrap_err_with(|| format!("failed to resolve {description} {}", path.display()))
}

fn absolute(path: &Path, cwd: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| eyre!("systemd unit path has no parent"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .wrap_err_with(|| format!("failed to create temporary unit beside {}", path.display()))?;
    temporary.write_all(contents)?;
    temporary.as_file_mut().sync_all()?;
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .wrap_err_with(|| format!("failed to install systemd unit {}", path.display()))?;
    Ok(())
}

fn systemctl<const N: usize>(arguments: [&str; N]) -> Result<Output> {
    let output = Command::new("systemctl")
        .arg("--user")
        .args(arguments)
        .output()
        .wrap_err("failed to execute systemctl --user")?;
    if !output.status.success() {
        bail!(
            "systemctl --user failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(output)
}

fn print_linger_hint() {
    let Some(user) = env::var_os("USER") else {
        return;
    };
    let output = Command::new("loginctl")
        .args([
            "show-user",
            &user.to_string_lossy(),
            "--property=Linger",
            "--value",
        ])
        .output();
    if output.ok().is_some_and(|output| {
        output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "yes"
    }) {
        return;
    }
    eprintln!(
        "To keep this service running after logout, run once:\n  sudo loginctl enable-linger {}",
        user.to_string_lossy()
    );
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::{OsStr, OsString},
        path::Path,
    };

    use super::{
        coordinator_unit_name, normalize_coordinator_arguments, normalize_service_arguments,
        render_coordinator_unit, render_unit, replace_option, unit_name,
    };

    #[test]
    fn coordinator_unit_is_watchdog_supervised_and_restarts_hangs() {
        let arguments = normalize_coordinator_arguments(
            [
                "eval",
                "coordinator",
                "release",
                "--config=relative.toml",
                "--state-dir",
                "relative-state",
                "--port",
                "8788",
                "--systemd",
            ]
            .map(OsString::from)
            .into(),
            Path::new("/srv/nanocodex.toml"),
            Path::new("/mnt/evals"),
        );
        let unit = render_coordinator_unit(
            Path::new("/opt/nanocodex/bin/nanocodex"),
            &arguments,
            Path::new("/srv"),
        )
        .unwrap();

        assert!(unit.contains("Type=notify"));
        assert!(unit.contains("NotifyAccess=main"));
        assert!(unit.contains("WatchdogSec=30s"));
        assert!(unit.contains("Restart=always"));
        assert!(unit.contains(
            "ExecStart=\"/opt/nanocodex/bin/nanocodex\" \"eval\" \"coordinator\" \"release\" \"--config=/srv/nanocodex.toml\" \"--state-dir\" \"/mnt/evals\" \"--port\" \"8788\""
        ));
        assert!(!unit.contains("--systemd"));
    }

    #[test]
    fn unit_runs_the_plain_headless_benchmark_and_restarts_failures() {
        let unit = render_unit(
            "/opt/nanocodex/bin/nanocodex".as_ref(),
            &[
                OsString::from("eval"),
                OsString::from("benchmark"),
                OsString::from("terminal bench"),
                OsString::from("--headless"),
            ],
            "/srv/evals".as_ref(),
            "/mnt/eval-runtime".as_ref(),
            "/mnt/eval-runtime/tmp".as_ref(),
        )
        .unwrap();
        assert!(unit.contains(
            "ExecStart=\"/opt/nanocodex/bin/nanocodex\" \"eval\" \"benchmark\" \"terminal bench\" \"--headless\""
        ));
        assert!(unit.contains("WorkingDirectory=/srv/evals"));
        assert!(unit.contains("Environment=\"NANOCODEX_HOME=/mnt/eval-runtime\""));
        assert!(unit.contains("Environment=\"TMPDIR=/mnt/eval-runtime/tmp\""));
        assert!(unit.contains("Restart=on-failure"));
        assert!(!unit.contains("RestartPreventExitStatus"));
    }

    #[test]
    fn absolute_paths_replace_user_supplied_service_arguments() {
        let mut arguments = vec![
            OsString::from("eval"),
            OsString::from("benchmark"),
            OsString::from("release"),
            OsString::from("--config=relative.toml"),
        ];
        replace_option(&mut arguments, "--config", "/srv/nanocodex.toml".as_ref());
        replace_option(&mut arguments, "--state-dir", "/srv/state".as_ref());
        assert_eq!(
            arguments,
            [
                "eval",
                "benchmark",
                "release",
                "--config=/srv/nanocodex.toml",
                "--state-dir",
                "/srv/state",
            ]
            .map(OsString::from)
        );
    }

    #[test]
    fn coordinator_backed_service_keeps_remote_routing_without_sqlite_state() {
        let arguments = normalize_service_arguments(
            [
                "eval",
                "benchmark",
                "release",
                "--config",
                "relative.toml",
                "--coordinator",
                "http://127.0.0.1:8788",
                "--worker",
                "dev-georgios-01",
                "--orchestrator-prompt-file",
                "relative-policy.md",
                "--runtime-dir=/mnt/eval-runtime",
                "--systemd",
            ]
            .map(OsString::from)
            .into(),
            Path::new("/srv/nanocodex.toml"),
            None,
            Some(Path::new("/srv/benchmark-policy.md")),
        );

        assert_eq!(
            arguments,
            [
                "eval",
                "benchmark",
                "release",
                "--config",
                "/srv/nanocodex.toml",
                "--coordinator",
                "http://127.0.0.1:8788",
                "--worker",
                "dev-georgios-01",
                "--orchestrator-prompt-file",
                "/srv/benchmark-policy.md",
                "--headless",
            ]
            .map(OsString::from)
        );
        assert!(!arguments.iter().any(|argument| argument == "--state-dir"));
        assert!(!arguments.iter().any(|argument| {
            argument
                .to_str()
                .is_some_and(|argument| argument.starts_with("--runtime-dir"))
        }));
    }

    #[test]
    fn unit_identity_is_stable_and_safe() {
        assert_eq!(
            unit_name(
                "Terminal Bench / k=5",
                "/srv/nanocodex.toml".as_ref(),
                OsStr::new("/srv/state"),
            ),
            unit_name(
                "Terminal Bench / k=5",
                "/srv/nanocodex.toml".as_ref(),
                OsStr::new("/srv/state"),
            )
        );
        assert!(
            unit_name(
                "Terminal Bench / k=5",
                "/srv/nanocodex.toml".as_ref(),
                OsStr::new("/srv/state"),
            )
            .starts_with("nanocodex-benchmark-terminal-bench---k-5-")
        );

        assert_ne!(
            unit_name(
                "Terminal Bench / k=5",
                "/srv/nanocodex.toml".as_ref(),
                OsStr::new("/srv/state"),
            ),
            unit_name(
                "Terminal Bench / k=5",
                "/srv/nanocodex.toml".as_ref(),
                OsStr::new("http://127.0.0.1:8788"),
            )
        );

        assert_eq!(
            coordinator_unit_name(
                "release",
                Path::new("/srv/nanocodex.toml"),
                Path::new("/mnt/evals"),
                8788,
            ),
            coordinator_unit_name(
                "release",
                Path::new("/srv/nanocodex.toml"),
                Path::new("/mnt/evals"),
                8788,
            )
        );
        assert_ne!(
            coordinator_unit_name(
                "release",
                Path::new("/srv/nanocodex.toml"),
                Path::new("/mnt/evals"),
                8788,
            ),
            coordinator_unit_name(
                "release",
                Path::new("/srv/nanocodex.toml"),
                Path::new("/mnt/evals"),
                8789,
            )
        );
    }
}
