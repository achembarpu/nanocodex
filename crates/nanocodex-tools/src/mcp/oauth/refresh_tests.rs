use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use async_trait::async_trait;
use oauth2::TokenResponse;
use rmcp::{
    model::ClientJsonRpcMessage,
    transport::{
        auth::AuthorizationMetadata,
        streamable_http_client::{StreamableHttpClient, StreamableHttpPostResponse},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{Mutex, oneshot},
    time::{Duration, timeout},
};

use super::super::{
    McpOAuthCredentials, McpOAuthStore, OAuthMetadataCache, OAuthRuntime, now_millis,
    transport_from_credentials,
};

struct TestStore {
    current: Mutex<Option<McpOAuthCredentials>>,
    saves: AtomicUsize,
    fail_save: AtomicBool,
}

impl TestStore {
    fn new(credentials: Option<McpOAuthCredentials>) -> Self {
        Self {
            current: Mutex::new(credentials),
            saves: AtomicUsize::new(0),
            fail_save: AtomicBool::new(false),
        }
    }

    async fn credentials(&self) -> Option<McpOAuthCredentials> {
        self.current.lock().await.clone()
    }
}

#[async_trait]
impl McpOAuthStore for TestStore {
    async fn load(
        &self,
        _server_name: &str,
        _server_url: &str,
    ) -> Result<Option<McpOAuthCredentials>, String> {
        Ok(self.credentials().await)
    }

    async fn save(
        &self,
        _server_name: &str,
        _server_url: &str,
        credentials: &McpOAuthCredentials,
    ) -> Result<(), String> {
        if self.fail_save.load(Ordering::SeqCst) {
            return Err("injected save failure".to_owned());
        }
        self.saves.fetch_add(1, Ordering::SeqCst);
        *self.current.lock().await = Some(credentials.clone());
        Ok(())
    }
}

async fn runtime_for(
    token_endpoint: String,
    store: Arc<TestStore>,
    credentials: McpOAuthCredentials,
) -> Arc<OAuthRuntime> {
    nanocodex_oai_api::transport::install_default_rustls_crypto_provider();
    let server_name = "refresh-test";
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
    transport_from_credentials(
        server_name,
        server_url,
        reqwest::Client::new(),
        store,
        credentials,
        &metadata_cache,
    )
    .await
    .unwrap()
    .runtime
}

fn expired_credentials() -> McpOAuthCredentials {
    McpOAuthCredentials::new("client", "expired-access")
        .refresh_token("refresh-token")
        .expires_at_millis(0)
        .scopes(["mcp:tools"])
}

async fn token_server(status: &str, body: &str) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/token", listener.local_addr().unwrap());
    let status = status.to_owned();
    let body = body.to_owned();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = vec![0_u8; 4096];
        let read = stream.read(&mut request).await.unwrap();
        let request = String::from_utf8_lossy(&request[..read]);
        assert!(request.contains("grant_type=refresh_token"));
        assert!(request.contains("refresh_token=refresh-token"));
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    (endpoint, task)
}

#[tokio::test]
async fn refresh_preserves_omitted_refresh_token_and_scopes() {
    let (endpoint, server) = token_server(
        "200 OK",
        r#"{"access_token":"refreshed-access","token_type":"Bearer","expires_in":3600}"#,
    )
    .await;
    let credentials = expired_credentials();
    let store = Arc::new(TestStore::new(Some(credentials.clone())));
    let runtime = runtime_for(endpoint, Arc::clone(&store), credentials).await;

    runtime.refresh_if_needed().await.unwrap();
    server.await.unwrap();

    let saved = store.credentials().await.unwrap();
    assert_eq!(saved.access_token(), "refreshed-access");
    assert_eq!(saved.refresh_token_value(), Some("refresh-token"));
    assert_eq!(saved.granted_scopes(), ["mcp:tools"]);
    assert_eq!(store.saves.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn transient_refresh_failure_does_not_require_reauthorization() {
    let (endpoint, server) = token_server(
        "503 Service Unavailable",
        r#"{"error":"temporarily_unavailable"}"#,
    )
    .await;
    let credentials = expired_credentials();
    let store = Arc::new(TestStore::new(Some(credentials.clone())));
    let runtime = runtime_for(endpoint, Arc::clone(&store), credentials).await;

    let error = runtime.refresh_if_needed().await.unwrap_err();
    server.await.unwrap();

    assert!(error.contains("temporarily failed"), "{error}");
    assert!(!error.contains("authorization required"), "{error}");
    assert_eq!(store.saves.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn rejected_refresh_token_requires_reauthorization() {
    let (endpoint, server) = token_server(
        "400 Bad Request",
        r#"{"error":"invalid_grant","error_description":"refresh token was rotated"}"#,
    )
    .await;
    let credentials = expired_credentials();
    let store = Arc::new(TestStore::new(Some(credentials.clone())));
    let runtime = runtime_for(endpoint, Arc::clone(&store), credentials).await;

    let error = runtime.refresh_if_needed().await.unwrap_err();
    server.await.unwrap();

    assert!(error.contains("was rejected"), "{error}");
    assert!(error.contains("authorization required"), "{error}");
    assert_eq!(store.saves.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn concurrent_runtimes_refresh_a_rotating_token_once() {
    let (endpoint, server) = token_server(
        "200 OK",
        r#"{"access_token":"refreshed-access","token_type":"Bearer","expires_in":3600,"refresh_token":"rotated-refresh"}"#,
    )
    .await;
    let credentials = expired_credentials();
    let store = Arc::new(TestStore::new(Some(credentials.clone())));
    let first = runtime_for(endpoint.clone(), Arc::clone(&store), credentials.clone()).await;
    let second = runtime_for(endpoint, Arc::clone(&store), credentials).await;

    timeout(Duration::from_secs(5), async {
        let (first, second) = tokio::join!(first.refresh_if_needed(), second.refresh_if_needed());
        first.unwrap();
        second.unwrap();
    })
    .await
    .unwrap();
    server.await.unwrap();

    let saved = store.credentials().await.unwrap();
    assert_eq!(saved.refresh_token_value(), Some("rotated-refresh"));
    assert_eq!(store.saves.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn caller_cancellation_does_not_cancel_refresh_persistence() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/token", listener.local_addr().unwrap());
    let (requested, requested_rx) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = vec![0_u8; 4096];
        let _ = stream.read(&mut request).await.unwrap();
        requested.send(()).unwrap();
        release_rx.await.unwrap();
        let body = r#"{"access_token":"refreshed-access","token_type":"Bearer","expires_in":3600,"refresh_token":"rotated-refresh"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    let credentials = expired_credentials();
    let store = Arc::new(TestStore::new(Some(credentials.clone())));
    let runtime = runtime_for(endpoint, Arc::clone(&store), credentials).await;

    let caller = tokio::spawn({
        let runtime = Arc::clone(&runtime);
        async move { runtime.refresh_if_needed().await }
    });
    requested_rx.await.unwrap();
    caller.abort();
    release.send(()).unwrap();
    server.await.unwrap();
    timeout(Duration::from_secs(2), async {
        loop {
            if store
                .credentials()
                .await
                .is_some_and(|credentials| credentials.access_token() == "refreshed-access")
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn persistence_failure_restores_previous_in_memory_credentials() {
    let (endpoint, server) = token_server(
        "200 OK",
        r#"{"access_token":"refreshed-access","token_type":"Bearer","expires_in":3600,"refresh_token":"rotated-refresh"}"#,
    )
    .await;
    let credentials = expired_credentials();
    let store = Arc::new(TestStore::new(Some(credentials.clone())));
    store.fail_save.store(true, Ordering::SeqCst);
    let runtime = runtime_for(endpoint, Arc::clone(&store), credentials).await;

    let error = runtime.refresh_if_needed().await.unwrap_err();
    server.await.unwrap();

    assert!(error.contains("failed to persist"), "{error}");
    let (_, response) = runtime
        .manager
        .lock()
        .await
        .get_credentials()
        .await
        .unwrap();
    assert_eq!(response.unwrap().access_token().secret(), "expired-access");
    assert_eq!(store.saves.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn server_401_refreshes_and_retries_once() {
    nanocodex_oai_api::transport::install_default_rustls_crypto_provider();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server_url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let token_endpoint = format!("http://{}/token", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut rejected, _) = listener.accept().await.unwrap();
        let mut request = vec![0_u8; 4096];
        let read = rejected.read(&mut request).await.unwrap();
        assert!(
            String::from_utf8_lossy(&request[..read])
                .to_ascii_lowercase()
                .contains("authorization: bearer current-access")
        );
        rejected
            .write_all(
                b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer realm=\"mcp\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();

        let (mut token, _) = listener.accept().await.unwrap();
        let read = token.read(&mut request).await.unwrap();
        assert!(String::from_utf8_lossy(&request[..read]).contains("refresh_token=refresh-token"));
        let body = r#"{"access_token":"refreshed-access","token_type":"Bearer","expires_in":3600,"refresh_token":"rotated-refresh"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        token.write_all(response.as_bytes()).await.unwrap();

        let (mut retried, _) = listener.accept().await.unwrap();
        let read = retried.read(&mut request).await.unwrap();
        assert!(
            String::from_utf8_lossy(&request[..read])
                .to_ascii_lowercase()
                .contains("authorization: bearer refreshed-access")
        );
        retried
            .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    });
    let credentials = McpOAuthCredentials::new("client", "current-access")
        .refresh_token("refresh-token")
        .expires_at_millis(now_millis() + 3_600_000)
        .scopes(["mcp:tools"]);
    let store = Arc::new(TestStore::new(Some(credentials.clone())));
    let metadata: AuthorizationMetadata = serde_json::from_value(serde_json::json!({
        "authorization_endpoint": "http://127.0.0.1:9/authorize",
        "token_endpoint": token_endpoint,
    }))
    .unwrap();
    let metadata_cache = OAuthMetadataCache::default();
    metadata_cache
        .insert("refresh-test", &server_url, metadata)
        .await;
    let transport = transport_from_credentials(
        "refresh-test",
        &server_url,
        reqwest::Client::new(),
        Arc::clone(&store) as Arc<dyn McpOAuthStore>,
        credentials,
        &metadata_cache,
    )
    .await
    .unwrap();
    let message: ClientJsonRpcMessage = serde_json::from_value(serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "ping"
    }))
    .unwrap();

    let response = transport
        .client
        .post_message(Arc::from(server_url), message, None, None, HashMap::new())
        .await
        .unwrap();
    assert!(matches!(response, StreamableHttpPostResponse::Accepted));
    transport
        .runtime
        .persist_if_changed(&tracing::Span::none())
        .await
        .unwrap();
    server.await.unwrap();

    let saved = store.credentials().await.unwrap();
    assert_eq!(saved.access_token(), "refreshed-access");
    assert_eq!(saved.refresh_token_value(), Some("rotated-refresh"));
}
