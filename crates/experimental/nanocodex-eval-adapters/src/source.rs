use std::{
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    process::{Command, Output},
};

use sha2::{Digest as _, Sha256};

#[derive(Clone, Debug)]
pub(crate) struct SourceStore {
    root: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum SourceError {
    #[error("benchmark source filesystem operation failed at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("benchmark source command failed: {0}")]
    Command(String),
    #[error("retained benchmark source is stale: {0}")]
    Stale(String),
}

impl SourceStore {
    pub(crate) fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    #[allow(dead_code)]
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    #[allow(dead_code)]
    pub(crate) fn git_checkout(
        &self,
        relative: &str,
        url: &str,
        revision: &str,
    ) -> Result<PathBuf, SourceError> {
        let destination = self.root.join(relative);
        if destination.exists() {
            let head = command_text(
                Command::new("git")
                    .arg("-C")
                    .arg(&destination)
                    .args(["rev-parse", "HEAD"]),
            )?;
            if head.trim() != revision {
                return Err(SourceError::Stale(format!(
                    "{} is at {}, expected {revision}",
                    destination.display(),
                    head.trim()
                )));
            }
            let dirty = command_text(
                Command::new("git")
                    .arg("-C")
                    .arg(&destination)
                    .args(["status", "--porcelain=v1"]),
            )?;
            if !dirty.trim().is_empty() {
                return Err(SourceError::Stale(format!(
                    "{} has local changes",
                    destination.display()
                )));
            }
            return Ok(destination);
        }
        fs::create_dir_all(&self.root).map_err(|source| io_error(&self.root, source))?;
        let temporary = tempfile::Builder::new()
            .prefix(".source-")
            .tempdir_in(&self.root)
            .map_err(|source| io_error(&self.root, source))?;
        command_status(Command::new("git").arg("init").arg(temporary.path()))?;
        command_status(Command::new("git").arg("-C").arg(temporary.path()).args([
            "fetch",
            "--depth=1",
            url,
            revision,
        ]))?;
        command_status(
            Command::new("git")
                .arg("-C")
                .arg(temporary.path())
                .args(["checkout", "--detach", "FETCH_HEAD"])
                .env("GIT_LFS_SKIP_SMUDGE", "1"),
        )?;
        fs::rename(temporary.keep(), &destination)
            .map_err(|source| io_error(&destination, source))?;
        Ok(destination)
    }

    #[allow(dead_code)]
    pub(crate) fn download(
        &self,
        relative: &str,
        url: &str,
        expected_sha256: &str,
    ) -> Result<PathBuf, SourceError> {
        let destination = self.root.join(relative);
        if destination.is_file() {
            validate_sha256(&destination, expected_sha256)?;
            return Ok(destination);
        }
        let parent = destination.parent().unwrap_or(&self.root);
        fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;
        let temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|source| io_error(parent, source))?;
        command_status(
            Command::new("curl")
                .args([
                    "--fail",
                    "--location",
                    "--silent",
                    "--show-error",
                    "--output",
                ])
                .arg(temporary.path())
                .arg(url),
        )?;
        validate_sha256(temporary.path(), expected_sha256)?;
        temporary
            .persist(&destination)
            .map_err(|error| io_error(&destination, error.error))?;
        Ok(destination)
    }

    #[allow(dead_code)]
    pub(crate) fn write_verified(
        &self,
        relative: &str,
        bytes: &[u8],
    ) -> Result<PathBuf, SourceError> {
        let destination = self.root.join(relative);
        if destination.is_file() {
            let retained =
                fs::read(&destination).map_err(|source| io_error(&destination, source))?;
            if retained != bytes {
                return Err(SourceError::Stale(format!(
                    "{} does not match the derived pinned content",
                    destination.display()
                )));
            }
            return Ok(destination);
        }
        let parent = destination.parent().unwrap_or(&self.root);
        fs::create_dir_all(parent).map_err(|source| io_error(parent, source))?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|source| io_error(parent, source))?;
        temporary
            .write_all(bytes)
            .and_then(|()| temporary.as_file().sync_all())
            .map_err(|source| io_error(temporary.path(), source))?;
        temporary
            .persist(&destination)
            .map_err(|error| io_error(&destination, error.error))?;
        Ok(destination)
    }
}

#[allow(dead_code)]
fn validate_sha256(path: &Path, expected: &str) -> Result<(), SourceError> {
    let bytes = fs::read(path).map_err(|source| io_error(path, source))?;
    let actual = hex::encode(Sha256::digest(bytes));
    if actual == expected {
        Ok(())
    } else {
        Err(SourceError::Stale(format!(
            "{} has digest {actual}, expected {expected}",
            path.display()
        )))
    }
}

#[allow(dead_code)]
fn command_status(command: &mut Command) -> Result<(), SourceError> {
    let rendered = format!("{command:?}");
    let output = command
        .output()
        .map_err(|error| SourceError::Command(format!("{rendered}: {error}")))?;
    ensure_success(rendered, output).map(drop)
}

#[allow(dead_code)]
fn command_text(command: &mut Command) -> Result<String, SourceError> {
    let rendered = format!("{command:?}");
    let output = command
        .output()
        .map_err(|error| SourceError::Command(format!("{rendered}: {error}")))?;
    let output = ensure_success(rendered, output)?;
    String::from_utf8(output.stdout).map_err(|error| SourceError::Command(error.to_string()))
}

#[allow(dead_code)]
fn ensure_success(rendered: String, output: Output) -> Result<Output, SourceError> {
    if output.status.success() {
        Ok(output)
    } else {
        Err(SourceError::Command(format!(
            "{rendered} exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }
}

#[allow(dead_code)]
fn io_error(path: &Path, source: std::io::Error) -> SourceError {
    SourceError::Io {
        path: path.to_path_buf(),
        source,
    }
}
