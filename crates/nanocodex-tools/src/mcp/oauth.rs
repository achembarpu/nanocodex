use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, OnceLock, Weak},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use http::{HeaderName, HeaderValue};
use oauth2::{AccessToken, RefreshToken, Scope, TokenResponse, basic::BasicTokenType};
use rmcp::transport::{
    AuthorizationManager, AuthorizationRequest,
    auth::{
        AuthClient, AuthorizationMetadata, CredentialStore, InMemoryCredentialStore, OAuthState,
        OAuthTokenResponse, StoredCredentials, VendorExtraTokenFields,
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{Mutex, RwLock},
    task::JoinHandle,
};
use tracing::{Instrument, info_span};

use super::config::SecretSource;

mod refresh;

const LOGIN_TIMEOUT: Duration = Duration::from_mins(5);
const MAX_CALLBACK_BYTES: usize = 16 * 1024;

#[derive(Default)]
pub(crate) struct OAuthMetadataCache {
    entries: RwLock<HashMap<(String, String), AuthorizationMetadata>>,
}

impl OAuthMetadataCache {
    async fn get(&self, server_name: &str, server_url: &str) -> Option<AuthorizationMetadata> {
        self.entries
            .read()
            .await
            .get(&(server_name.to_owned(), server_url.to_owned()))
            .cloned()
    }

    async fn insert(&self, server_name: &str, server_url: &str, metadata: AuthorizationMetadata) {
        self.entries
            .write()
            .await
            .insert((server_name.to_owned(), server_url.to_owned()), metadata);
    }
}

/// OAuth credentials for one Streamable HTTP MCP server.
///
/// This value intentionally does not implement `Debug`: access and refresh tokens must not be
/// emitted by diagnostics. Embedders normally provide these through an [`McpOAuthStore`].
#[derive(Clone, PartialEq, Eq)]
pub struct McpOAuthCredentials {
    client_id: String,
    access_token: String,
    refresh_token: Option<String>,
    expires_at_millis: Option<u64>,
    scopes: Vec<String>,
}

/// An acquired refresh-transaction lock held until its boxed value is dropped.
pub trait McpOAuthRefreshGuard: Send {}

impl<T: Send> McpOAuthRefreshGuard for T {}

impl McpOAuthCredentials {
    /// Creates credentials from a dynamically registered client and access token.
    #[must_use]
    pub fn new(client_id: impl Into<String>, access_token: impl Into<String>) -> Self {
        Self {
            client_id: client_id.into(),
            access_token: access_token.into(),
            refresh_token: None,
            expires_at_millis: None,
            scopes: Vec::new(),
        }
    }

    /// Attaches the optional refresh token.
    #[must_use]
    pub fn refresh_token(mut self, refresh_token: impl Into<String>) -> Self {
        self.refresh_token = Some(refresh_token.into());
        self
    }

    /// Sets the access-token expiry as Unix epoch milliseconds.
    #[must_use]
    pub const fn expires_at_millis(mut self, expires_at_millis: u64) -> Self {
        self.expires_at_millis = Some(expires_at_millis);
        self
    }

    /// Records the scopes granted by the authorization server.
    #[must_use]
    pub fn scopes(mut self, scopes: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.scopes = scopes.into_iter().map(Into::into).collect();
        self
    }

    /// Returns the dynamically registered OAuth client ID.
    #[must_use]
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    /// Returns the bearer access token.
    #[must_use]
    pub fn access_token(&self) -> &str {
        &self.access_token
    }

    /// Returns the refresh token when one was issued.
    #[must_use]
    pub fn refresh_token_value(&self) -> Option<&str> {
        self.refresh_token.as_deref()
    }

    /// Returns access-token expiry as Unix epoch milliseconds.
    #[must_use]
    pub const fn expires_at(&self) -> Option<u64> {
        self.expires_at_millis
    }

    /// Returns the scopes granted by the authorization server.
    #[must_use]
    pub fn granted_scopes(&self) -> &[String] {
        &self.scopes
    }

    fn to_token_response(&self) -> OAuthTokenResponse {
        let mut response = OAuthTokenResponse::new(
            AccessToken::new(self.access_token.clone()),
            BasicTokenType::Bearer,
            VendorExtraTokenFields::default(),
        );
        if let Some(refresh_token) = &self.refresh_token {
            response.set_refresh_token(Some(RefreshToken::new(refresh_token.clone())));
        }
        if !self.scopes.is_empty() {
            response.set_scopes(Some(self.scopes.iter().cloned().map(Scope::new).collect()));
        }
        if let Some(expires_at) = self.expires_at_millis {
            response.set_expires_in(Some(&Duration::from_millis(
                expires_at.saturating_sub(now_millis()),
            )));
        }
        response
    }

    fn from_token_response(client_id: String, response: &OAuthTokenResponse) -> Self {
        let expires_at_millis = response.expires_in().and_then(|expires_in| {
            now_millis().checked_add(u64::try_from(expires_in.as_millis()).ok()?)
        });
        Self {
            client_id,
            access_token: response.access_token().secret().to_owned(),
            refresh_token: response
                .refresh_token()
                .map(|token| token.secret().to_owned()),
            expires_at_millis,
            scopes: response
                .scopes()
                .map(|scopes| {
                    scopes
                        .iter()
                        .map(|scope| scope.as_ref().to_owned())
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    fn same_token(&self, other: &Self) -> bool {
        self.client_id == other.client_id
            && self.access_token == other.access_token
            && self.refresh_token == other.refresh_token
            && self.scopes == other.scopes
    }
}

/// Persistence selected by an embedding application for MCP OAuth credentials.
#[async_trait]
pub trait McpOAuthStore: Send + Sync {
    /// Loads credentials for one configured server and exact URL.
    async fn load(
        &self,
        server_name: &str,
        server_url: &str,
    ) -> Result<Option<McpOAuthCredentials>, String>;

    /// Atomically persists the latest credentials after login or refresh.
    async fn save(
        &self,
        server_name: &str,
        server_url: &str,
        credentials: &McpOAuthCredentials,
    ) -> Result<(), String>;

    /// Serializes one credential's authoritative load, provider refresh, and save transaction.
    ///
    /// The default coordinates runtimes in this process. Stores shared by multiple processes must
    /// override this with a matching cross-process or provider-backed lock and bound lock waits.
    async fn acquire_refresh_lock(
        &self,
        server_name: &str,
        server_url: &str,
    ) -> Result<Box<dyn McpOAuthRefreshGuard>, String> {
        let key = format!("{server_name}\0{server_url}");
        let lock = {
            static LOCKS: OnceLock<
                std::sync::Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
            > = OnceLock::new();
            let locks = LOCKS.get_or_init(Default::default);
            let mut locks = locks
                .lock()
                .map_err(|_| "MCP OAuth refresh lock registry was poisoned".to_owned())?;
            locks.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(tokio::sync::Mutex::new(()));
                locks.insert(key, Arc::downgrade(&lock));
                lock
            }
        };
        Ok(Box::new(lock.lock_owned().await))
    }
}

pub(crate) struct OAuthRuntime {
    server_name: String,
    server_url: String,
    manager: Arc<Mutex<AuthorizationManager>>,
    store: Arc<dyn McpOAuthStore>,
    last_credentials: Mutex<Option<McpOAuthCredentials>>,
}

impl OAuthRuntime {
    pub(crate) fn new(
        server_name: String,
        server_url: String,
        manager: Arc<Mutex<AuthorizationManager>>,
        store: Arc<dyn McpOAuthStore>,
        credentials: McpOAuthCredentials,
    ) -> Self {
        Self {
            server_name,
            server_url,
            manager,
            store,
            last_credentials: Mutex::new(Some(credentials)),
        }
    }

    pub(crate) async fn persist_if_changed(&self, parent: &tracing::Span) -> Result<(), String> {
        let (client_id, response) = self
            .manager
            .lock()
            .await
            .get_credentials()
            .await
            .map_err(|error| format!("failed to read refreshed OAuth credentials: {error}"))?;
        let Some(response) = response else {
            return Err("OAuth transport no longer has credentials".to_owned());
        };
        let mut credentials = McpOAuthCredentials::from_token_response(client_id, &response);
        let mut previous = self.last_credentials.lock().await;
        if let Some(previous) = previous.as_ref() {
            if response.refresh_token().is_none() {
                credentials
                    .refresh_token
                    .clone_from(&previous.refresh_token);
            }
            if response.scopes().is_none() {
                credentials.scopes.clone_from(&previous.scopes);
            }
            if credentials.same_token(previous) {
                credentials.expires_at_millis = previous.expires_at_millis;
            }
        }
        if previous.as_ref() == Some(&credentials) {
            return Ok(());
        }
        let span = info_span!(
            target: "nanocodex_tools",
            parent: parent,
            "mcp.oauth.credentials_save",
            otel.kind = "internal",
            otel.status_code = tracing::field::Empty,
            reason = "refresh",
            status = tracing::field::Empty,
        );
        let result = self
            .store
            .save(&self.server_name, &self.server_url, &credentials)
            .instrument(span.clone())
            .await;
        span.record(
            "status",
            if result.is_ok() {
                "completed"
            } else {
                "failed"
            },
        );
        span.record(
            "otel.status_code",
            if result.is_ok() { "OK" } else { "ERROR" },
        );
        result?;
        *previous = Some(credentials);
        Ok(())
    }
}

pub(crate) struct OAuthTransport {
    pub(crate) client: AuthClient<reqwest::Client>,
    pub(crate) runtime: Arc<OAuthRuntime>,
    pub(crate) metadata_cache_hit: bool,
}

pub(crate) async fn transport_from_credentials(
    server_name: &str,
    server_url: &str,
    http_client: reqwest::Client,
    store: Arc<dyn McpOAuthStore>,
    credentials: McpOAuthCredentials,
    metadata_cache: &OAuthMetadataCache,
) -> Result<OAuthTransport, String> {
    let mut manager = AuthorizationManager::new(server_url)
        .await
        .map_err(|error| format!("failed to initialize MCP OAuth state: {error}"))?;
    manager
        .with_client(http_client.clone())
        .map_err(|error| format!("failed to configure MCP OAuth HTTP client: {error}"))?;
    let (metadata, metadata_cache_hit) =
        if let Some(metadata) = metadata_cache.get(server_name, server_url).await {
            (metadata, true)
        } else {
            let metadata = manager
                .resolve_metadata()
                .await
                .map_err(|error| format!("failed to discover MCP OAuth metadata: {error}"))?
                .metadata;
            metadata_cache
                .insert(server_name, server_url, metadata.clone())
                .await;
            (metadata, false)
        };
    manager.set_metadata(metadata);

    let credential_store = InMemoryCredentialStore::new();
    credential_store
        .save(StoredCredentials::new(
            credentials.client_id.clone(),
            Some(credentials.to_token_response()),
            credentials.scopes.clone(),
            Some(now_seconds()),
        ))
        .await
        .map_err(|error| format!("failed to stage MCP OAuth credentials: {error}"))?;
    manager.set_credential_store(credential_store);
    let restored = manager
        .initialize_from_store()
        .await
        .map_err(|error| format!("failed to restore MCP OAuth credentials: {error}"))?;
    if !restored {
        return Err("restored MCP OAuth state was not authorized".to_owned());
    }
    let client = AuthClient::new(http_client, manager);
    let runtime = Arc::new(OAuthRuntime::new(
        server_name.to_owned(),
        server_url.to_owned(),
        Arc::clone(&client.auth_manager),
        store,
        credentials,
    ));
    Ok(OAuthTransport {
        client,
        runtime,
        metadata_cache_hit,
    })
}

pub(crate) struct OAuthLoginFlow {
    pub(crate) authorization_url: String,
    pub(crate) completion: JoinHandle<Result<(), String>>,
}

pub(crate) async fn begin_login(
    server_name: String,
    server_url: String,
    headers: BTreeMap<String, SecretSource>,
    store: Arc<dyn McpOAuthStore>,
) -> Result<OAuthLoginFlow, String> {
    let client = oauth_http_client(headers)?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("failed to bind MCP OAuth callback: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("failed to inspect MCP OAuth callback: {error}"))?;
    let redirect_uri = format!("http://{address}/callback");
    let authorization_span = info_span!(
        target: "nanocodex_tools",
        "mcp.oauth.authorization_start",
        otel.kind = "client",
        otel.status_code = tracing::field::Empty,
        status = tracing::field::Empty,
    );
    let authorization = async {
        let mut state = OAuthState::new(&server_url, Some(client))
            .await
            .map_err(|error| format!("failed to discover MCP OAuth metadata: {error}"))?;
        state
            .start_authorization(
                AuthorizationRequest::new(&redirect_uri).with_client_name("Nanocodex"),
            )
            .await
            .map_err(|error| format!("failed to start MCP OAuth authorization: {error}"))?;
        let authorization_url = state
            .get_authorization_url()
            .await
            .map_err(|error| format!("failed to build MCP OAuth authorization URL: {error}"))?;
        Ok::<_, String>((state, authorization_url))
    }
    .instrument(authorization_span.clone())
    .await;
    authorization_span.record(
        "status",
        if authorization.is_ok() {
            "completed"
        } else {
            "failed"
        },
    );
    authorization_span.record(
        "otel.status_code",
        if authorization.is_ok() { "OK" } else { "ERROR" },
    );
    let (state, authorization_url) = authorization?;

    let parent = tracing::Span::current();
    let completion = tokio::spawn(
        complete_login(
            listener,
            redirect_uri,
            state,
            store,
            server_name,
            server_url,
        )
        .instrument(parent),
    );
    Ok(OAuthLoginFlow {
        authorization_url,
        completion,
    })
}

async fn complete_login(
    listener: TcpListener,
    redirect_uri: String,
    mut state: OAuthState,
    store: Arc<dyn McpOAuthStore>,
    server_name: String,
    server_url: String,
) -> Result<(), String> {
    let callback_span = info_span!(
        target: "nanocodex_tools",
        "mcp.oauth.callback_wait",
        otel.kind = "server",
        otel.status_code = tracing::field::Empty,
        status = tracing::field::Empty,
    );
    let callback =
        match tokio::time::timeout(LOGIN_TIMEOUT, receive_callback(listener, &redirect_uri))
            .instrument(callback_span.clone())
            .await
        {
            Ok(callback) => callback,
            Err(_) => Err("timed out waiting for MCP OAuth callback".to_owned()),
        };
    callback_span.record(
        "status",
        if callback.is_ok() {
            "completed"
        } else {
            "failed"
        },
    );
    callback_span.record(
        "otel.status_code",
        if callback.is_ok() { "OK" } else { "ERROR" },
    );
    let callback = callback?;
    let exchange_span = info_span!(
        target: "nanocodex_tools",
        "mcp.oauth.code_exchange",
        otel.kind = "client",
        otel.status_code = tracing::field::Empty,
        status = tracing::field::Empty,
    );
    let result = state
        .handle_callback_url(&callback)
        .instrument(exchange_span.clone())
        .await
        .map_err(|error| format!("failed to exchange MCP OAuth code: {error}"));
    exchange_span.record(
        "status",
        if result.is_ok() {
            "completed"
        } else {
            "failed"
        },
    );
    exchange_span.record(
        "otel.status_code",
        if result.is_ok() { "OK" } else { "ERROR" },
    );
    result?;
    let (client_id, response) = state
        .get_credentials()
        .await
        .map_err(|error| format!("failed to read MCP OAuth credentials: {error}"))?;
    let response =
        response.ok_or_else(|| "MCP OAuth provider returned no credentials".to_owned())?;
    let credentials = McpOAuthCredentials::from_token_response(client_id, &response);
    let save_span = info_span!(
        target: "nanocodex_tools",
        "mcp.oauth.credentials_save",
        otel.kind = "internal",
        otel.status_code = tracing::field::Empty,
        reason = "login",
        status = tracing::field::Empty,
    );
    let saved = store
        .save(&server_name, &server_url, &credentials)
        .instrument(save_span.clone())
        .await;
    save_span.record("status", if saved.is_ok() { "completed" } else { "failed" });
    save_span.record(
        "otel.status_code",
        if saved.is_ok() { "OK" } else { "ERROR" },
    );
    saved
}

fn oauth_http_client(headers: BTreeMap<String, SecretSource>) -> Result<reqwest::Client, String> {
    let mut resolved = reqwest::header::HeaderMap::with_capacity(headers.len());
    for (name, source) in headers {
        let name = name
            .parse::<HeaderName>()
            .map_err(|error| format!("invalid HTTP header name `{name}`: {error}"))?;
        let value = source.resolve()?;
        let mut value = HeaderValue::from_str(&value)
            .map_err(|error| format!("invalid value for HTTP header `{name}`: {error}"))?;
        value.set_sensitive(true);
        resolved.insert(name, value);
    }
    nanocodex_oai_api::transport::install_default_rustls_crypto_provider();
    reqwest::Client::builder()
        .default_headers(resolved)
        .pool_max_idle_per_host(0)
        .redirect(super::same_origin_redirect_policy())
        .build()
        .map_err(|error| format!("failed to build MCP OAuth HTTP client: {error}"))
}

async fn receive_callback(listener: TcpListener, redirect_uri: &str) -> Result<String, String> {
    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|error| format!("failed to accept MCP OAuth callback: {error}"))?;
    let mut bytes = Vec::with_capacity(2048);
    loop {
        let mut chunk = [0_u8; 1024];
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|error| format!("failed to read MCP OAuth callback: {error}"))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if bytes.len() > MAX_CALLBACK_BYTES {
            return Err("MCP OAuth callback headers were too large".to_owned());
        }
    }
    let request = std::str::from_utf8(&bytes)
        .map_err(|_| "MCP OAuth callback was not valid HTTP".to_owned())?;
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "MCP OAuth callback did not contain a request target".to_owned())?;
    let base = reqwest::Url::parse(redirect_uri)
        .map_err(|error| format!("invalid MCP OAuth redirect URI: {error}"))?;
    let callback = base
        .join(target)
        .map_err(|error| format!("invalid MCP OAuth callback target: {error}"))?;
    if callback.path() != base.path() {
        let _ = respond(&mut stream, 400, "Invalid OAuth callback path").await;
        return Err("MCP OAuth callback used an unexpected path".to_owned());
    }
    respond(
        &mut stream,
        200,
        "Authentication received. You may close this window.",
    )
    .await?;
    Ok(callback.to_string())
}

async fn respond(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    body: &str,
) -> Result<(), String> {
    let reason = if status == 200 { "OK" } else { "Bad Request" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|error| format!("failed to answer MCP OAuth callback: {error}"))
}

fn now_millis() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis();
    u64::try_from(millis).unwrap_or(u64::MAX)
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    #[derive(Default)]
    struct RecordingStore {
        current: Mutex<Option<McpOAuthCredentials>>,
        saved: Mutex<Vec<McpOAuthCredentials>>,
    }

    impl RecordingStore {
        fn with_credentials(credentials: McpOAuthCredentials) -> Self {
            Self {
                current: Mutex::new(Some(credentials)),
                saved: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait]
    impl McpOAuthStore for RecordingStore {
        async fn load(
            &self,
            _server_name: &str,
            _server_url: &str,
        ) -> Result<Option<McpOAuthCredentials>, String> {
            Ok(self.current.lock().await.clone())
        }

        async fn save(
            &self,
            _server_name: &str,
            _server_url: &str,
            credentials: &McpOAuthCredentials,
        ) -> Result<(), String> {
            self.saved.lock().await.push(credentials.clone());
            *self.current.lock().await = Some(credentials.clone());
            Ok(())
        }
    }

    #[tokio::test]
    async fn oauth_headers_do_not_follow_cross_origin_redirects() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_url = format!("http://{}/metadata", target.local_addr().unwrap());
        let (target_requested, mut target_requested_rx) = oneshot::channel();
        let target_task = tokio::spawn(async move {
            let (mut stream, _) = target.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            target_requested
                .send(String::from_utf8_lossy(&request[..read]).into_owned())
                .unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                .await
                .unwrap();
        });

        let redirect = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let source_url = format!("http://{}/metadata", redirect.local_addr().unwrap());
        let redirect_task = tokio::spawn(async move {
            let (mut stream, _) = redirect.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            assert!(String::from_utf8_lossy(&request[..read]).contains("x-api-key: secret"));
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: {target_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let client = oauth_http_client(BTreeMap::from([(
            "x-api-key".to_owned(),
            SecretSource::Value("secret".to_owned()),
        )]))
        .unwrap();
        let response = client.get(source_url).send().await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        assert!(matches!(
            target_requested_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        target_task.abort();
        redirect_task.await.unwrap();
    }

    #[tokio::test]
    async fn cached_metadata_preserves_refresh_and_rotated_token_persistence() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let token_endpoint = format!("http://{}/token", listener.local_addr().unwrap());
        let responder = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap();
            assert!(String::from_utf8_lossy(&request[..read]).contains("POST /token"));
            let body = r#"{"access_token":"refreshed-access","token_type":"Bearer","expires_in":3600,"refresh_token":"rotated-refresh","scope":"mcp:tools"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let server_name = "cached";
        let server_url = "http://127.0.0.1:9/mcp";
        let metadata: AuthorizationMetadata = serde_json::from_value(serde_json::json!({
            "authorization_endpoint": "http://127.0.0.1:9/authorize",
            "token_endpoint": token_endpoint,
        }))
        .unwrap();
        let metadata_cache = OAuthMetadataCache::default();
        metadata_cache
            .insert(server_name, server_url, metadata)
            .await;
        let credentials = McpOAuthCredentials::new("client", "expired-access")
            .refresh_token("refresh-token")
            .expires_at_millis(0)
            .scopes(["mcp:tools"]);
        let store = Arc::new(RecordingStore::with_credentials(credentials.clone()));

        nanocodex_oai_api::transport::install_default_rustls_crypto_provider();
        let transport = transport_from_credentials(
            server_name,
            server_url,
            reqwest::Client::new(),
            store.clone(),
            credentials,
            &metadata_cache,
        )
        .await
        .unwrap();
        assert!(transport.metadata_cache_hit);
        transport.runtime.refresh_if_needed().await.unwrap();
        responder.await.unwrap();

        let saved = store.saved.lock().await;
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].access_token(), "refreshed-access");
        assert_eq!(saved[0].refresh_token_value(), Some("rotated-refresh"));
        assert_eq!(saved[0].granted_scopes(), ["mcp:tools"]);
    }
}
