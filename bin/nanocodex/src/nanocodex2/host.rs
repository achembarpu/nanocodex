//! Workspace selection for the headless client.

use std::{
    env, fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use serde::Deserialize;

#[derive(Debug)]
pub(crate) struct HostConfig {
    workspace: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum HostConfigError {
    #[error("could not determine the config directory; set NANOCODEX_HOME")]
    HomeUnavailable,
    #[error("failed to determine the current directory: {0}")]
    CurrentDirectory(#[source] std::io::Error),
    #[error("failed to read configuration file {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to parse configuration file {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ConfigFile {
    agent: AgentConfigFile,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct AgentConfigFile {
    workspace: Option<PathBuf>,
}

impl HostConfig {
    pub(crate) fn load() -> Result<Self, HostConfigError> {
        let current_dir = env::current_dir().map_err(HostConfigError::CurrentDirectory)?;
        let config_path = config_path()?;
        let config = ConfigFile::read(&config_path)?;
        let config_dir = config_path.parent().unwrap_or(Path::new("."));
        let workspace = config
            .agent
            .workspace
            .map(|path| resolve_path(path, config_dir))
            .unwrap_or(current_dir);
        Ok(Self { workspace })
    }

    pub(crate) fn workspace(&self) -> &Path {
        &self.workspace
    }
}

impl ConfigFile {
    fn read(path: &Path) -> Result<Self, HostConfigError> {
        let contents = match fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(source) if source.kind() == ErrorKind::NotFound => String::new(),
            Err(source) => {
                return Err(HostConfigError::Read {
                    path: path.to_path_buf(),
                    source,
                });
            }
        };
        toml::from_str(&contents).map_err(|source| HostConfigError::Parse {
            path: path.to_path_buf(),
            source,
        })
    }
}

fn config_path() -> Result<PathBuf, HostConfigError> {
    if let Some(home) = env::var_os("NANOCODEX_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(home).join("config.toml"));
    }
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|home| home.join(".nanocodex2/config.toml"))
        .ok_or(HostConfigError::HomeUnavailable)
}

fn resolve_path(path: PathBuf, base: &Path) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}
