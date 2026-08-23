use std::{
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::env;

use rusqlite::{Connection, OpenFlags, backup::Backup};
use url::Url;

/// A standard Chromium-family browser profile that can supply cookies.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BrowserProfileKind {
    Brave,
    Chrome,
    Chromium,
    Edge,
}

/// How a Chromium-family cookie source may access its encrypted cookie store.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum BrowserCookieAuthorization {
    /// Import cookies without opening a visible browser or credential prompt.
    #[default]
    Background,
    /// If background import cannot decrypt a populated store, open one visible
    /// temporary copied profile so the user can authorize Keychain access.
    Interactive,
}

impl BrowserProfileKind {
    /// Returns the browser's display name.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Brave => "Brave",
            Self::Chrome => "Google Chrome",
            Self::Chromium => "Chromium",
            Self::Edge => "Microsoft Edge",
        }
    }
}

/// A cookie-backed snapshot of an existing Chromium-family profile.
///
/// This is designed for authenticated headless automation while the ordinary
/// source browser remains open. Callers may copy cookies applicable to an
/// explicit origin allowlist or deliberately opt into every cookie in the
/// selected profile. The source profile is never passed to the launched browser
/// and is never mutated.
#[derive(Clone, Debug)]
pub struct BraveSession {
    executable: PathBuf,
    user_data_dir: PathBuf,
    profile_directory: PathBuf,
    allowed_origins: Vec<Url>,
    copy_all_cookies: bool,
    include_site_data: bool,
    cookie_authorization: BrowserCookieAuthorization,
}

impl BraveSession {
    /// Locates the standard Brave installation and user-data directory.
    ///
    /// # Errors
    ///
    /// Returns an error when the platform has no standard location, the home
    /// directory is unavailable, or Brave is not installed there.
    pub fn standard() -> Result<Self, BraveSessionError> {
        Self::standard_for(BrowserProfileKind::Brave)
    }

    /// Locates a standard Chromium-family installation and user-data directory.
    ///
    /// # Errors
    ///
    /// Returns an error when the platform has no standard location, the home
    /// directory is unavailable, or the selected browser is not installed.
    pub fn standard_for(browser: BrowserProfileKind) -> Result<Self, BraveSessionError> {
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            Err(BraveSessionError::StandardInstallationUnavailable {
                browser: browser.name(),
            })
        }

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let home = env::var_os("HOME").ok_or(BraveSessionError::HomeDirectoryUnavailable)?;
            #[cfg(target_os = "macos")]
            let (executable, user_data_dir) = match browser {
                BrowserProfileKind::Brave => (
                    PathBuf::from("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"),
                    PathBuf::from(&home)
                        .join("Library/Application Support/BraveSoftware/Brave-Browser"),
                ),
                BrowserProfileKind::Chrome => (
                    PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
                    PathBuf::from(&home).join("Library/Application Support/Google/Chrome"),
                ),
                BrowserProfileKind::Chromium => (
                    PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
                    PathBuf::from(&home).join("Library/Application Support/Chromium"),
                ),
                BrowserProfileKind::Edge => (
                    PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
                    PathBuf::from(&home).join("Library/Application Support/Microsoft Edge"),
                ),
            };
            #[cfg(target_os = "linux")]
            let (executables, user_data_directory): (&[&str], &str) = match browser {
                BrowserProfileKind::Brave => (
                    &["/usr/bin/brave-browser", "/usr/bin/brave-browser-stable"],
                    ".config/BraveSoftware/Brave-Browser",
                ),
                BrowserProfileKind::Chrome => (
                    &["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
                    ".config/google-chrome",
                ),
                BrowserProfileKind::Chromium => (
                    &["/usr/bin/chromium", "/usr/bin/chromium-browser"],
                    ".config/chromium",
                ),
                BrowserProfileKind::Edge => (
                    &["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
                    ".config/microsoft-edge",
                ),
            };
            #[cfg(target_os = "linux")]
            let (executable, user_data_dir) = (
                executables
                    .iter()
                    .copied()
                    .map(PathBuf::from)
                    .find(|path| path.is_file())
                    .ok_or(BraveSessionError::StandardInstallationUnavailable {
                        browser: browser.name(),
                    })?,
                PathBuf::from(home).join(user_data_directory),
            );

            let session = Self::new(executable, user_data_dir);
            session.validate_paths()?;
            Ok(session)
        }
    }

    /// Creates a profile session from explicit executable and user-data paths.
    #[must_use]
    pub fn new(executable: impl Into<PathBuf>, user_data_dir: impl Into<PathBuf>) -> Self {
        Self {
            executable: executable.into(),
            user_data_dir: user_data_dir.into(),
            profile_directory: PathBuf::from("Default"),
            allowed_origins: Vec::new(),
            copy_all_cookies: false,
            include_site_data: false,
            cookie_authorization: BrowserCookieAuthorization::Background,
        }
    }

    /// Selects a profile directory such as `Default` or `Profile 1`.
    #[must_use]
    pub fn profile_directory(mut self, directory: impl Into<PathBuf>) -> Self {
        self.profile_directory = directory.into();
        self
    }

    /// Allows cookies applicable to one exact HTTP(S) origin to enter the
    /// private headless profile.
    #[must_use]
    pub fn allow_origin(mut self, origin: Url) -> Self {
        self.allowed_origins.push(origin);
        self
    }

    /// Copies every cookie from the selected source profile.
    ///
    /// This deliberately gives the dedicated browser the profile's complete
    /// authenticated cookie state. Cookie values remain outside the
    /// model-callable browser action schema.
    #[must_use]
    pub const fn copy_all_cookies(mut self) -> Self {
        self.copy_all_cookies = true;
        self
    }

    /// Also copies `localStorage`, `IndexedDB`, and storage-bucket metadata.
    ///
    /// The source browser must be closed when the lazy launch takes this snapshot
    /// because those stores use `LevelDB` and do not provide `SQLite`'s online
    /// backup guarantee. On APFS, Rust uses copy-on-write clones for the files,
    /// so the private snapshot consumes space only as either side changes.
    #[must_use]
    pub const fn include_site_data(mut self) -> Self {
        self.include_site_data = true;
        self
    }

    /// Allows an explicit visible authorization retry for encrypted cookies.
    ///
    /// The retry launches the source browser executable with a copied temporary
    /// profile. It never opens or mutates the ordinary source profile.
    #[must_use]
    pub const fn cookie_authorization(mut self, authorization: BrowserCookieAuthorization) -> Self {
        self.cookie_authorization = authorization;
        self
    }

    /// Returns the source browser executable selected by this session.
    #[must_use]
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub(crate) fn allowed_origins(&self) -> &[Url] {
        &self.allowed_origins
    }

    pub(crate) const fn includes_site_data(&self) -> bool {
        self.include_site_data
    }

    pub(crate) const fn copies_all_cookies(&self) -> bool {
        self.copy_all_cookies
    }

    pub(crate) const fn cookie_authorization_policy(&self) -> BrowserCookieAuthorization {
        self.cookie_authorization
    }

    pub(crate) fn trace_value(&self) -> serde_json::Value {
        serde_json::json!({
            "executable": self.executable,
            "userDataDirectory": self.user_data_dir,
            "profileDirectory": self.profile_directory,
            "allowedOrigins": self.allowed_origins,
            "copyAllCookies": self.copy_all_cookies,
            "includeSiteData": self.include_site_data,
            "cookieAuthorization": format!("{:?}", self.cookie_authorization),
        })
    }

    pub(crate) async fn prepare(
        &self,
        target_user_data_dir: &Path,
    ) -> Result<i64, BraveSessionError> {
        self.validate()?;
        let source_profile = self.user_data_dir.join(&self.profile_directory);
        if self.include_site_data
            && std::fs::symlink_metadata(self.user_data_dir.join("SingletonLock")).is_ok()
        {
            return Err(BraveSessionError::SourceBrowserRunning {
                user_data_dir: self.user_data_dir.clone(),
            });
        }
        let source_cookies = [
            source_profile.join("Cookies"),
            source_profile.join("Network/Cookies"),
        ]
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| BraveSessionError::CookiesUnavailable {
            profile: source_profile.clone(),
        })?;
        let source_local_state = self.user_data_dir.join("Local State");
        let target_profile = target_user_data_dir.join("Default");
        let target_cookies = target_profile.join("Cookies");
        tokio::fs::create_dir_all(&target_profile).await?;
        tokio::fs::copy(source_local_state, target_user_data_dir.join("Local State")).await?;

        let allowed_hosts = (!self.copy_all_cookies).then(|| {
            self.allowed_origins
                .iter()
                .filter_map(Url::host_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        });
        let cookie_count = tokio::task::spawn_blocking(move || {
            snapshot_cookies(&source_cookies, &target_cookies, allowed_hosts.as_deref())
        })
        .await
        .map_err(BraveSessionError::SnapshotTask)??;
        if self.include_site_data {
            let source_profile = source_profile.clone();
            tokio::task::spawn_blocking(move || {
                for directory in ["Local Storage", "IndexedDB", "WebStorage"] {
                    let source = source_profile.join(directory);
                    if source.is_dir() {
                        copy_directory(&source, &target_profile.join(directory))?;
                    }
                }
                Ok::<_, std::io::Error>(())
            })
            .await
            .map_err(BraveSessionError::SnapshotTask)??;
        }
        Ok(cookie_count)
    }

    pub(crate) fn validate(&self) -> Result<(), BraveSessionError> {
        self.validate_paths()?;
        if self.allowed_origins.is_empty() && !self.copy_all_cookies {
            return Err(BraveSessionError::MissingAllowedOrigin);
        }
        for origin in &self.allowed_origins {
            if !matches!(origin.scheme(), "http" | "https")
                || origin.host_str().is_none()
                || origin.path() != "/"
                || origin.query().is_some()
                || origin.fragment().is_some()
                || !origin.username().is_empty()
                || origin.password().is_some()
            {
                return Err(BraveSessionError::InvalidOrigin {
                    origin: origin.clone(),
                });
            }
        }
        let mut components = self.profile_directory.components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            return Err(BraveSessionError::InvalidProfileDirectory {
                directory: self.profile_directory.clone(),
            });
        }
        Ok(())
    }

    fn validate_paths(&self) -> Result<(), BraveSessionError> {
        if !self.executable.is_file() {
            return Err(BraveSessionError::ExecutableUnavailable {
                path: self.executable.clone(),
            });
        }
        if !self.user_data_dir.is_dir() {
            return Err(BraveSessionError::UserDataUnavailable {
                path: self.user_data_dir.clone(),
            });
        }
        Ok(())
    }
}

fn snapshot_cookies(
    source: &Path,
    target: &Path,
    allowed_hosts: Option<&[String]>,
) -> Result<i64, BraveSessionError> {
    let source = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let mut target = Connection::open(target)?;
    let backup = Backup::new(&source, &mut target)?;
    backup.run_to_completion(64, Duration::from_millis(5), None)?;
    drop(backup);

    if let Some(allowed_hosts) = allowed_hosts {
        let mut statement = target.prepare("SELECT rowid, host_key FROM cookies")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut rejected = Vec::new();
        for row in rows {
            let (row_id, cookie_host) = row?;
            if !allowed_hosts
                .iter()
                .any(|allowed| cookie_applies_to(&cookie_host, allowed))
            {
                rejected.push(row_id);
            }
        }
        drop(statement);
        let transaction = target.transaction()?;
        {
            let mut delete = transaction.prepare("DELETE FROM cookies WHERE rowid = ?1")?;
            for row_id in rejected {
                delete.execute([row_id])?;
            }
        }
        transaction.commit()?;
    }
    let transaction = target.transaction()?;
    transaction.execute(
        "UPDATE cookies
         SET is_persistent = 1, has_expires = 1, expires_utc = ?1
         WHERE is_persistent = 0",
        [temporary_cookie_expiry()?],
    )?;
    transaction.commit()?;
    Ok(target.query_row("SELECT COUNT(*) FROM cookies", [], |row| row.get(0))?)
}

pub(crate) fn cookie_applies_to(cookie_host: &str, allowed_host: &str) -> bool {
    let cookie_host = cookie_host.trim_start_matches('.');
    allowed_host == cookie_host
        || allowed_host
            .strip_suffix(cookie_host)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn temporary_cookie_expiry() -> Result<i64, BraveSessionError> {
    const WINDOWS_EPOCH_OFFSET_SECONDS: u64 = 11_644_473_600;
    const PRIVATE_SESSION_LIFETIME: Duration = Duration::from_hours(24);
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(BraveSessionError::SystemClock)?;
    let seconds = unix
        .as_secs()
        .saturating_add(WINDOWS_EPOCH_OFFSET_SECONDS)
        .saturating_add(PRIVATE_SESSION_LIFETIME.as_secs());
    let micros = u128::from(seconds)
        .saturating_mul(1_000_000)
        .saturating_add(u128::from(unix.subsec_micros()));
    i64::try_from(micros).map_err(|_| BraveSessionError::CookieExpiryOverflow)
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let source = entry.path();
        let target = target.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_directory(&source, &target)?;
        } else if file_type.is_file() {
            std::fs::copy(source, target)?;
        } else if file_type.is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "site-data snapshot does not follow symlink {}",
                    source.display()
                ),
            ));
        }
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum BraveSessionError {
    #[error("the home directory is unavailable")]
    HomeDirectoryUnavailable,
    #[error("the standard {browser} installation is unavailable on this platform")]
    StandardInstallationUnavailable { browser: &'static str },
    #[error("source browser executable does not exist at {path}")]
    ExecutableUnavailable { path: PathBuf },
    #[error("source browser user-data directory does not exist at {path}")]
    UserDataUnavailable { path: PathBuf },
    #[error("source profile directory must be one relative path component, got {directory}")]
    InvalidProfileDirectory { directory: PathBuf },
    #[error("at least one HTTP(S) origin must be explicitly allowed")]
    MissingAllowedOrigin,
    #[error("profile session origin must contain only a scheme, host, and optional port: {origin}")]
    InvalidOrigin { origin: Url },
    #[error("source cookie database is unavailable under {profile}")]
    CookiesUnavailable { profile: PathBuf },
    #[error(
        "the source browser must be closed before copying site data from {user_data_dir}; cookie-only snapshots remain available while it is running"
    )]
    SourceBrowserRunning { user_data_dir: PathBuf },
    #[error("profile session filesystem operation failed")]
    Io(#[from] std::io::Error),
    #[error("cookie snapshot failed")]
    Sqlite(#[from] rusqlite::Error),
    #[error("cookie snapshot task failed")]
    SnapshotTask(#[source] tokio::task::JoinError),
    #[error("the system clock is before the Unix epoch")]
    SystemClock(#[source] std::time::SystemTimeError),
    #[error("temporary cookie expiration does not fit Chromium's timestamp range")]
    CookieExpiryOverflow,
}

#[cfg(test)]
mod tests {
    use std::error::Error;

    use rusqlite::Connection;
    use tempfile::tempdir;

    #[test]
    fn interactive_cookie_authorization_is_explicit_session_policy() {
        let session = super::BraveSession::new("/brave", "/profile")
            .cookie_authorization(super::BrowserCookieAuthorization::Interactive);

        assert_eq!(
            session.cookie_authorization_policy(),
            super::BrowserCookieAuthorization::Interactive
        );
        assert_eq!(session.trace_value()["cookieAuthorization"], "Interactive");
    }

    #[test]
    fn cookie_domains_are_filtered_by_request_applicability() {
        assert!(super::cookie_applies_to(
            ".example.com",
            "console.example.com"
        ));
        assert!(super::cookie_applies_to(
            "console.example.com",
            "console.example.com"
        ));
        assert!(!super::cookie_applies_to(
            "admin.example.com",
            "console.example.com"
        ));
        assert!(!super::cookie_applies_to("notexample.com", "example.com"));
    }

    #[test]
    fn snapshot_is_independent_and_keeps_only_applicable_domains() -> Result<(), Box<dyn Error>> {
        let directory = tempdir()?;
        let source_path = directory.path().join("source.sqlite");
        let target_path = directory.path().join("target.sqlite");
        let source = Connection::open(&source_path)?;
        source.execute(
            "CREATE TABLE cookies(
                host_key TEXT NOT NULL,
                encrypted_value BLOB NOT NULL,
                is_persistent INTEGER NOT NULL,
                has_expires INTEGER NOT NULL,
                expires_utc INTEGER NOT NULL
            )",
            [],
        )?;
        source.execute(
            "INSERT INTO cookies(
                host_key, encrypted_value, is_persistent, has_expires, expires_utc
            ) VALUES (?1, ?2, 0, 0, 0)",
            (".example.com", b"parent".as_slice()),
        )?;
        source.execute(
            "INSERT INTO cookies(
                host_key, encrypted_value, is_persistent, has_expires, expires_utc
            ) VALUES (?1, ?2, 1, 1, 1)",
            ("admin.example.com", b"sibling".as_slice()),
        )?;
        drop(source);

        super::snapshot_cookies(
            &source_path,
            &target_path,
            Some(&["console.example.com".to_owned()]),
        )?;

        let source = Connection::open(source_path)?;
        let target = Connection::open(target_path)?;
        assert_eq!(
            source.query_row("SELECT COUNT(*) FROM cookies", [], |row| row
                .get::<_, i64>(0))?,
            2
        );
        assert_eq!(
            target.query_row("SELECT COUNT(*) FROM cookies", [], |row| row
                .get::<_, i64>(0))?,
            1
        );
        assert_eq!(
            target.query_row("SELECT host_key FROM cookies", [], |row| row
                .get::<_, String>(0))?,
            ".example.com"
        );
        assert_eq!(
            target.query_row("SELECT is_persistent FROM cookies", [], |row| row
                .get::<_, i64>(0))?,
            1
        );
        Ok(())
    }

    #[test]
    fn all_cookie_snapshot_keeps_every_domain() -> Result<(), Box<dyn Error>> {
        let directory = tempdir()?;
        let source_path = directory.path().join("source.sqlite");
        let target_path = directory.path().join("target.sqlite");
        let source = Connection::open(&source_path)?;
        source.execute(
            "CREATE TABLE cookies(
                host_key TEXT NOT NULL,
                encrypted_value BLOB NOT NULL,
                is_persistent INTEGER NOT NULL,
                has_expires INTEGER NOT NULL,
                expires_utc INTEGER NOT NULL
            )",
            [],
        )?;
        source.execute(
            "INSERT INTO cookies(
                host_key, encrypted_value, is_persistent, has_expires, expires_utc
            ) VALUES (?1, ?2, 0, 0, 0)",
            (".example.com", b"first".as_slice()),
        )?;
        source.execute(
            "INSERT INTO cookies(
                host_key, encrypted_value, is_persistent, has_expires, expires_utc
            ) VALUES (?1, ?2, 1, 1, 1)",
            ("dashboard.stripe.com", b"second".as_slice()),
        )?;
        drop(source);

        super::snapshot_cookies(&source_path, &target_path, None)?;

        let target = Connection::open(target_path)?;
        assert_eq!(
            target.query_row("SELECT COUNT(*) FROM cookies", [], |row| row
                .get::<_, i64>(0))?,
            2
        );
        assert_eq!(
            target.query_row(
                "SELECT COUNT(*) FROM cookies WHERE is_persistent = 1",
                [],
                |row| row.get::<_, i64>(0),
            )?,
            2
        );
        Ok(())
    }
}
