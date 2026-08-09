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
use nanocodex_eval::Evaluation;
use sha2::{Digest as _, Sha256};

use super::profile::default_state_dir;

const RESTART_DELAY: &str = "30s";

pub(super) fn install(
    profile: Option<&str>,
    config: &Path,
    state_dir: Option<&Path>,
) -> Result<()> {
    if !cfg!(target_os = "linux") {
        bail!("--systemd is supported only on Linux");
    }

    let working_directory = env::current_dir().wrap_err("failed to resolve current directory")?;
    let config = absolute_existing(config, &working_directory, "evaluation manifest")?;
    let state_dir = state_dir.map_or_else(default_state_dir, |path| Ok(path.to_path_buf()))?;
    let state_dir = absolute(&state_dir, &working_directory);
    let evaluation = Evaluation::open(&config, profile, &state_dir)?;
    let state_dir = state_dir
        .canonicalize()
        .wrap_err_with(|| format!("failed to resolve state directory {}", state_dir.display()))?;
    let executable = env::current_exe().wrap_err("failed to resolve the nanocodex executable")?;
    let arguments = service_arguments(&config, &state_dir)?;
    let unit_name = unit_name(evaluation.name(), &config, &state_dir);
    let unit = render_unit(&executable, &arguments, &working_directory)?;
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

fn service_arguments(config: &Path, state_dir: &Path) -> Result<Vec<OsString>> {
    let mut arguments = env::args_os().skip(1).collect::<Vec<_>>();
    arguments.retain(|argument| argument != "--systemd");
    replace_option(&mut arguments, "--config", config.as_os_str());
    replace_option(&mut arguments, "--state-dir", state_dir.as_os_str());
    replace_option(&mut arguments, "--thinking", OsStr::new("low"));
    if !arguments.iter().any(|argument| argument == "--headless") {
        arguments.push(OsString::from("--headless"));
    }
    Ok(arguments)
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
) -> Result<String> {
    let mut command = quote(executable.as_os_str())?;
    for argument in arguments {
        write!(command, " {}", quote(argument)?)?;
    }
    let mut path_assignment = OsString::from("PATH=");
    path_assignment.push(service_path(executable)?);
    let path_assignment = quote(&path_assignment)?;
    Ok(format!(
        "[Unit]\n\
         Description=Nanocodex benchmark\n\
         Wants=network-online.target\n\
         After=network-online.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         WorkingDirectory={}\n\
         Environment={path_assignment}\n\
         ExecStart={command}\n\
         Restart=on-failure\n\
         RestartSec={RESTART_DELAY}\n\
         KillMode=control-group\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        escape_path(working_directory.as_os_str())?,
    ))
}

fn service_path(executable: &Path) -> Result<OsString> {
    let executable_directory = executable
        .parent()
        .ok_or_else(|| eyre!("nanocodex executable has no parent directory"))?;
    let inherited = env::var_os("PATH").unwrap_or_default();
    env::join_paths(
        std::iter::once(executable_directory.to_path_buf()).chain(env::split_paths(&inherited)),
    )
    .map_err(|error| eyre!("failed to construct benchmark service PATH: {error}"))
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

fn unit_name(profile: &str, config: &Path, state_dir: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(config.as_os_str().as_encoded_bytes());
    digest.update([0]);
    digest.update(state_dir.as_os_str().as_encoded_bytes());
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
    use std::ffi::OsString;

    use super::{render_unit, replace_option, unit_name};

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
        )
        .unwrap();
        assert!(unit.contains(
            "ExecStart=\"/opt/nanocodex/bin/nanocodex\" \"eval\" \"benchmark\" \"terminal bench\" \"--headless\""
        ));
        assert!(unit.contains("WorkingDirectory=/srv/evals"));
        assert!(unit.contains("Environment=\"PATH=/opt/nanocodex/bin:"));
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
    fn unit_identity_is_stable_and_safe() {
        assert_eq!(
            unit_name(
                "Terminal Bench / k=5",
                "/srv/nanocodex.toml".as_ref(),
                "/srv/state".as_ref(),
            ),
            unit_name(
                "Terminal Bench / k=5",
                "/srv/nanocodex.toml".as_ref(),
                "/srv/state".as_ref(),
            )
        );
        assert!(
            unit_name(
                "Terminal Bench / k=5",
                "/srv/nanocodex.toml".as_ref(),
                "/srv/state".as_ref(),
            )
            .starts_with("nanocodex-benchmark-terminal-bench---k-5-")
        );
    }
}
