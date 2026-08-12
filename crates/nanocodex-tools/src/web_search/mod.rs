mod history;
mod schema;
mod wire;

use std::time::Duration;

use nanocodex_oai_api::{
    auth::{OpenAiAuth, OpenAiAuthError, OpenAiAuthMode, OpenAiAuthSnapshot},
    tools::ToolDefinition,
};
use reqwest::header::{AUTHORIZATION, USER_AGENT};
use serde_json::json;
use tokio::time::{sleep, timeout};

use self::{
    history::recent_input,
    schema::commands_schema,
    wire::{SearchCommands, SearchRequest, SearchResponse, SearchSettings},
};
use super::{Tool, ToolContext, ToolInput, ToolOutput, ToolResult, WebSearchConfig};

const DESCRIPTION: &str = include_str!("web_run_description.md");
const ERROR_BODY_LIMIT: usize = 4_096;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_ATTEMPTS: usize = 2;
const TOOL_TIMEOUT: Duration = Duration::from_secs(45);
const RETRY_DELAY: Duration = Duration::from_millis(200);

pub(super) struct WebSearchHandler {
    client: reqwest::Client,
    endpoint: String,
    auth: OpenAiAuth,
}

impl WebSearchHandler {
    #[cfg(test)]
    pub(super) fn new(config: WebSearchConfig) -> Self {
        nanocodex_oai_api::transport::install_default_rustls_crypto_provider();
        Self::with_client(config, reqwest::Client::new())
    }

    pub(super) fn with_client(config: WebSearchConfig, client: reqwest::Client) -> Self {
        Self {
            client,
            endpoint: config.endpoint,
            auth: config.auth,
        }
    }

    async fn run(&self, input: &str, context: ToolContext<'_>) -> ToolOutput {
        match timeout(TOOL_TIMEOUT, self.run_inner(input, context)).await {
            Ok(execution) => execution,
            Err(_) => ToolOutput::error(format!(
                "standalone web search timed out after {} seconds",
                TOOL_TIMEOUT.as_secs()
            )),
        }
    }

    async fn run_inner(&self, input: &str, context: ToolContext<'_>) -> ToolOutput {
        let commands = if input.trim().is_empty() {
            SearchCommands::default()
        } else {
            match serde_json::from_str(input) {
                Ok(commands) => commands,
                Err(error) => {
                    return ToolOutput::error(format!(
                        "failed to parse web.run arguments: {error}"
                    ));
                }
            }
        };
        if let Err(error) = commands.validate() {
            return ToolOutput::error(error);
        }

        let commands = commands.into_requests();
        let request_count = commands.len();
        let input = recent_input(context.history());
        let mut outputs = Vec::with_capacity(request_count);
        let mut failures = Vec::new();
        let mut results = Vec::new();
        let mut saw_results = false;

        for (index, commands) in commands.iter().enumerate() {
            let request = SearchRequest {
                id: context.session_id(),
                model: context.model(),
                input: input.as_deref(),
                commands,
                settings: SearchSettings {
                    allowed_callers: ["direct"],
                    external_web_access: true,
                },
                max_output_tokens: request_token_budget(
                    context.output_token_budget(),
                    index,
                    request_count,
                ),
            };
            let response = match self.search(&request).await {
                Ok(response) => response,
                Err(error) => {
                    failures.push(format!("web search request {} failed: {error}", index + 1));
                    continue;
                }
            };
            let SearchResponse {
                output,
                results: response_results,
                _encrypted_output: _,
            } = response;
            if let Some(response_results) = response_results {
                saw_results = true;
                results.extend(response_results);
            }
            if has_semantic_error(&output) {
                failures.push(format!(
                    "web search request {} returned an API error in its output",
                    index + 1
                ));
            } else {
                let missing = commands.missing_specialized_results(&output);
                if !missing.is_empty() {
                    failures.push(format!(
                        "web search request {} omitted results for: {}",
                        index + 1,
                        missing.join(", ")
                    ));
                }
            }
            if !output.is_empty() {
                outputs.push(output);
            }
        }

        let output = outputs.join("\n");
        let mut execution = if failures.is_empty() {
            ToolOutput::text(output)
        } else {
            let mut error = failures.join("\n");
            if !output.is_empty() {
                error.push_str("\n\nWeb search output:\n");
                error.push_str(&output);
            }
            ToolOutput::error(error)
        };
        if saw_results {
            execution = execution.with_metadata(json!({ "results": results }));
        }
        execution
    }

    async fn search(&self, request: &SearchRequest<'_>) -> Result<SearchResponse, String> {
        for attempt in 1..=MAX_ATTEMPTS {
            let (status, body) = match self.send(request).await {
                Ok(response) => response,
                Err(error) => {
                    if error.retryable && attempt < MAX_ATTEMPTS {
                        sleep(RETRY_DELAY).await;
                        continue;
                    }
                    return Err(error.message);
                }
            };
            let retryable = status.is_server_error();
            if retryable && attempt < MAX_ATTEMPTS {
                sleep(RETRY_DELAY).await;
                continue;
            }
            if !status.is_success() {
                return Err(format!(
                    "standalone web search returned HTTP {status}: {}",
                    body_preview(&body)
                ));
            }
            return serde_json::from_slice(&body).map_err(|error| {
                format!("failed to decode standalone web search response: {error}")
            });
        }
        Err("standalone web search exhausted its retry attempts".to_owned())
    }

    async fn send(
        &self,
        request: &SearchRequest<'_>,
    ) -> Result<(reqwest::StatusCode, Vec<u8>), RequestFailure> {
        let auth = self
            .auth
            .snapshot()
            .await
            .map_err(|error| auth_failure(&error))?;
        let response = self.send_authorized(request, &auth).await?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED
            && auth.mode() == OpenAiAuthMode::ChatGpt
        {
            self.auth
                .recover_unauthorized(&auth)
                .await
                .map_err(|error| auth_failure(&error))?;
            let refreshed = self
                .auth
                .snapshot()
                .await
                .map_err(|error| auth_failure(&error))?;
            return self
                .read_response(self.send_authorized(request, &refreshed).await?)
                .await;
        }
        self.read_response(response).await
    }

    async fn send_authorized(
        &self,
        body: &SearchRequest<'_>,
        auth: &OpenAiAuthSnapshot,
    ) -> Result<reqwest::Response, RequestFailure> {
        let mut request = self
            .client
            .post(&self.endpoint)
            .header(USER_AGENT, concat!("nanocodex/", env!("CARGO_PKG_VERSION")))
            .header(AUTHORIZATION, format!("Bearer {}", auth.bearer()));
        if let Some(account_id) = auth.account_id() {
            request = request.header("ChatGPT-Account-ID", account_id);
        }
        if auth.is_fedramp() {
            request = request.header("X-OpenAI-Fedramp", "true");
        }
        request
            .json(body)
            .send()
            .await
            .map_err(|error| RequestFailure {
                message: format!("standalone web search request failed: {error}"),
                retryable: true,
            })
    }

    async fn read_response(
        &self,
        response: reqwest::Response,
    ) -> Result<(reqwest::StatusCode, Vec<u8>), RequestFailure> {
        let status = response.status();
        let body = read_response_body(response).await.map_err(|mut failure| {
            failure.retryable |= status.is_server_error();
            failure
        })?;
        Ok((status, body))
    }
}

fn auth_failure(error: &OpenAiAuthError) -> RequestFailure {
    RequestFailure {
        message: error.to_string(),
        retryable: false,
    }
}

#[async_trait::async_trait]
impl Tool for WebSearchHandler {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::function("web__run", DESCRIPTION, commands_schema())
    }

    fn supports_parallel_tool_calls(&self) -> bool {
        true
    }

    async fn execute(&self, input: ToolInput, context: ToolContext<'_>) -> ToolResult {
        let input = input.function_json()?;
        Ok(self.run(input.get(), context).await)
    }
}

fn body_preview(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let mut end = text.len().min(ERROR_BODY_LIMIT);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let suffix = if end < text.len() { "…" } else { "" };
    format!("{}{suffix}", &text[..end])
}

struct RequestFailure {
    message: String,
    retryable: bool,
}

async fn read_response_body(mut response: reqwest::Response) -> Result<Vec<u8>, RequestFailure> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(response_too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| RequestFailure {
        message: format!("failed to read standalone web search response: {error}"),
        retryable: true,
    })? {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(response_too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn response_too_large() -> RequestFailure {
    RequestFailure {
        message: format!(
            "standalone web search response exceeded the {MAX_RESPONSE_BYTES}-byte limit"
        ),
        retryable: false,
    }
}

fn request_token_budget(total: usize, index: usize, request_count: usize) -> u64 {
    let base = total / request_count;
    let remainder = total % request_count;
    u64::try_from(base + usize::from(index < remainder))
        .unwrap_or(u64::MAX)
        .max(1)
}

fn has_semantic_error(output: &str) -> bool {
    output.lines().any(|line| {
        let line = line.trim();
        line.starts_with("Error parsing function call:")
            || line.starts_with("Found no tool response.")
            || line == "Internal Error ()"
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Tool, WebSearchConfig, WebSearchHandler};

    #[test]
    fn exposes_codex_web_run_schema_and_description() {
        let handler = WebSearchHandler::new(WebSearchConfig {
            endpoint: "http://127.0.0.1:1/v1/alpha/search".to_owned(),
            auth: nanocodex_oai_api::auth::OpenAiAuth::api_key("test-key"),
        });
        let spec = serde_json::to_value(handler.definition()).unwrap();

        assert_eq!(spec["name"], "web__run");
        assert_eq!(spec["strict"], false);
        assert_eq!(
            spec.pointer("/parameters/properties/time/description"),
            Some(&json!("Get time for the given UTC offsets."))
        );
        assert!(
            spec["description"]
                .as_str()
                .is_some_and(|description| description.contains("turn2search5"))
        );
    }
}
