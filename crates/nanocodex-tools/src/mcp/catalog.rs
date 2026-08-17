use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use bm25::{Document, SearchEngine, SearchEngineBuilder, Tokenizer};
use nanocodex_oai_api::tools::ToolDefinition;
use rmcp::model::Tool as RmcpTool;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio::sync::watch;

use super::{
    client::Client,
    config::{McpServer, McpToolExposure},
};

const DEFAULT_SEARCH_LIMIT: usize = 8;
const MAX_SEARCH_LIMIT: usize = 32;

#[derive(Clone, Copy, Debug, Default)]
struct ToolSearchTokenizer;

type ToolSearchEngine = SearchEngine<usize, u32, ToolSearchTokenizer>;

pub(crate) struct ToolEntry {
    pub canonical_name: String,
    pub server_name: String,
    pub remote_name: String,
    namespace: String,
    namespace_description: String,
    pub definition: ToolDefinition,
    pub supports_parallel_tool_calls: bool,
    pub tool_exposure: McpToolExposure,
    pub search_text: String,
    pub client: Client,
    pub timeout: Duration,
}

struct Catalog {
    entries: BTreeMap<String, Arc<ToolEntry>>,
    active: BTreeSet<String>,
    clients: BTreeMap<String, Client>,
    failures: BTreeMap<String, String>,
    search_index: Option<Arc<SearchIndex>>,
    pending_servers: BTreeSet<String>,
    generations: BTreeMap<String, u64>,
}

pub(crate) struct ConnectedCatalog {
    pub client: Client,
    pub entries: Vec<ToolEntry>,
}

struct SearchIndex {
    entries: Vec<Arc<ToolEntry>>,
    engine: ToolSearchEngine,
}

pub(crate) struct ProviderState {
    catalog: Mutex<Catalog>,
    remaining: watch::Sender<usize>,
    discovery_timeout: Duration,
}

#[derive(Serialize)]
pub(crate) struct SearchResponse {
    tools: Vec<SearchTool>,
    pending_servers: usize,
    failed_servers: BTreeMap<String, String>,
    #[serde(skip)]
    loadable_tools: Vec<LoadableNamespace>,
}

impl SearchResponse {
    pub(crate) const fn tool_count(&self) -> usize {
        self.tools.len()
    }

    pub(crate) const fn pending_server_count(&self) -> usize {
        self.pending_servers
    }

    pub(crate) fn loadable_tools(&self) -> Result<Value, serde_json::Error> {
        serde_json::to_value(&self.loadable_tools)
    }
}

#[derive(Serialize)]
struct SearchTool {
    name: String,
    server: String,
    tool: String,
    description: String,
    supports_parallel_tool_calls: bool,
    input_schema: Value,
}

#[derive(Serialize)]
struct LoadableNamespace {
    r#type: &'static str,
    name: String,
    description: String,
    tools: Vec<LoadableFunction>,
}

#[derive(Serialize)]
struct LoadableFunction {
    r#type: &'static str,
    name: String,
    description: String,
    strict: bool,
    defer_loading: bool,
    parameters: Value,
}

impl ProviderState {
    pub(crate) fn new(
        server_names: impl IntoIterator<Item = String>,
        discovery_timeout: Duration,
    ) -> Self {
        let pending_servers = server_names.into_iter().collect::<BTreeSet<_>>();
        let generations = pending_servers
            .iter()
            .cloned()
            .map(|name| (name, 0))
            .collect();
        let (remaining, _) = watch::channel(pending_servers.len());
        Self {
            catalog: Mutex::new(Catalog {
                entries: BTreeMap::new(),
                active: BTreeSet::new(),
                clients: BTreeMap::new(),
                failures: BTreeMap::new(),
                search_index: None,
                pending_servers,
                generations,
            }),
            remaining,
            discovery_timeout,
        }
    }

    pub(crate) fn complete_server(
        &self,
        server_name: &str,
        generation: u64,
        result: Result<ConnectedCatalog, String>,
    ) {
        let mut catalog = self.catalog();
        if catalog.generations.get(server_name).copied() != Some(generation) {
            return;
        }
        match result {
            Ok(ConnectedCatalog { client, entries }) => {
                let removed = catalog
                    .entries
                    .iter()
                    .filter_map(|(name, entry)| {
                        (entry.server_name == server_name).then_some(name.clone())
                    })
                    .collect::<Vec<_>>();
                for name in removed {
                    catalog.entries.remove(&name);
                }
                for entry in entries {
                    if catalog.entries.contains_key(&entry.canonical_name) {
                        catalog.failures.insert(
                            server_name.to_owned(),
                            format!(
                                "MCP tool name collision after normalization: `{}`",
                                entry.canonical_name
                            ),
                        );
                        continue;
                    }
                    catalog
                        .entries
                        .insert(entry.canonical_name.clone(), Arc::new(entry));
                }
                catalog.clients.insert(server_name.to_owned(), client);
                let available = catalog.entries.keys().cloned().collect::<BTreeSet<_>>();
                catalog.active.retain(|name| available.contains(name));
            }
            Err(error) => {
                catalog.failures.insert(server_name.to_owned(), error);
            }
        }
        catalog.pending_servers.remove(server_name);
        if catalog.pending_servers.is_empty() {
            tracing::info!(
                target: "nanocodex_tools",
                tool_count = catalog.entries.len(),
                "prewarming MCP tool search index"
            );
            catalog.search_index = Some(Arc::new(SearchIndex::new(
                catalog
                    .entries
                    .values()
                    .filter(|entry| entry.tool_exposure.is_deferred())
                    .cloned(),
            )));
        } else {
            catalog.search_index = None;
        }
        let pending_servers = catalog.pending_servers.len();
        drop(catalog);
        self.remaining.send_replace(pending_servers);
    }

    pub(crate) fn begin_server(&self, server_name: &str) -> u64 {
        let mut catalog = self.catalog();
        let generation = catalog
            .generations
            .entry(server_name.to_owned())
            .and_modify(|generation| *generation = generation.saturating_add(1))
            .or_insert(0);
        let generation = *generation;
        catalog.failures.remove(server_name);
        catalog.pending_servers.insert(server_name.to_owned());
        let pending_servers = catalog.pending_servers.len();
        drop(catalog);
        self.remaining.send_replace(pending_servers);
        generation
    }

    pub(crate) async fn search(
        &self,
        query: &str,
        limit: Option<usize>,
    ) -> Result<SearchResponse, String> {
        let query = query.trim();
        if query.is_empty() {
            return Err("query must not be empty".to_owned());
        }
        let limit = limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
        if limit == 0 {
            return Err("limit must be greater than zero".to_owned());
        }
        self.wait_for_startup().await;
        let mut catalog = self.catalog();
        if catalog.search_index.is_none() {
            tracing::info!(
                target: "nanocodex_tools",
                tool_count = catalog.entries.len(),
                "building MCP tool search index"
            );
            catalog.search_index = Some(Arc::new(SearchIndex::new(
                catalog
                    .entries
                    .values()
                    .filter(|entry| entry.tool_exposure.is_deferred())
                    .cloned(),
            )));
        }
        let index = catalog
            .search_index
            .clone()
            .ok_or_else(|| "MCP search index was not initialized".to_owned())?;
        let pending_servers = catalog.pending_servers.len();
        let failed_servers = catalog.failures.clone();
        drop(catalog);

        let selected = index.search(query, limit.min(MAX_SEARCH_LIMIT));
        let tools = selected.iter().map(|entry| entry.summary()).collect();
        let loadable_tools = coalesce_loadable_tools(&selected);
        let mut catalog = self.catalog();
        for entry in &selected {
            catalog.active.insert(entry.canonical_name.clone());
        }
        tracing::debug!(
            target: "nanocodex_tools",
            result_count = selected.len(),
            active_count = catalog.active.len(),
            "searched MCP tool catalog"
        );
        Ok(SearchResponse {
            tools,
            pending_servers,
            failed_servers,
            loadable_tools,
        })
    }

    pub(crate) fn available_definitions(&self) -> Vec<ToolDefinition> {
        let catalog = self.catalog();
        catalog
            .entries
            .values()
            .filter(|entry| entry.tool_exposure.is_available_in_code_mode())
            .map(|entry| entry.definition.clone())
            .collect()
    }

    pub(crate) fn entry(&self, name: &str) -> Option<Arc<ToolEntry>> {
        self.catalog().entries.get(name).cloned()
    }

    pub(crate) async fn ready_entry(&self, name: &str) -> Option<Arc<ToolEntry>> {
        self.wait_for_startup().await;
        self.entry(name)
    }

    pub(crate) async fn client(&self, server_name: &str) -> Result<Client, String> {
        self.wait_for_startup().await;
        let catalog = self.catalog();
        if let Some(client) = catalog.clients.get(server_name) {
            return Ok(Arc::clone(client));
        }
        if let Some(error) = catalog.failures.get(server_name) {
            return Err(format!(
                "MCP server `{server_name}` is unavailable: {error}"
            ));
        }
        Err(format!("unknown MCP server `{server_name}`"))
    }

    pub(crate) async fn clients(&self) -> Vec<(String, Client)> {
        self.wait_for_startup().await;
        self.catalog()
            .clients
            .iter()
            .map(|(name, client)| (name.clone(), Arc::clone(client)))
            .collect()
    }

    async fn wait_for_startup(&self) {
        if self.catalog().search_index.is_some() {
            return;
        }
        let mut remaining = self.remaining.subscribe();
        if *remaining.borrow() == 0 {
            return;
        }
        let wait = async {
            while *remaining.borrow_and_update() > 0 {
                if remaining.changed().await.is_err() {
                    break;
                }
            }
        };
        drop(tokio::time::timeout(self.discovery_timeout, wait).await);
    }

    fn catalog(&self) -> MutexGuard<'_, Catalog> {
        self.catalog
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl SearchIndex {
    fn new(entries: impl IntoIterator<Item = Arc<ToolEntry>>) -> Self {
        let entries = entries.into_iter().collect::<Vec<_>>();
        let documents = entries
            .iter()
            .enumerate()
            .map(|(index, entry)| Document::new(index, entry.search_text.clone()));
        let engine =
            SearchEngineBuilder::<usize, u32, ToolSearchTokenizer>::with_tokenizer_and_documents(
                ToolSearchTokenizer,
                documents,
            )
            .build();
        Self { entries, engine }
    }

    fn search(&self, query: &str, limit: usize) -> Vec<Arc<ToolEntry>> {
        self.engine
            .search(query, limit)
            .into_iter()
            .filter_map(|result| self.entries.get(result.document.id).cloned())
            .collect()
    }
}

impl Tokenizer for ToolSearchTokenizer {
    fn tokenize(&self, input_text: &str) -> Vec<String> {
        let mut tokens = Vec::new();
        let mut token = String::new();
        let mut previous = None;
        let mut characters = input_text.chars().peekable();

        while let Some(character) = characters.next() {
            if !character.is_alphanumeric() {
                push_search_token(&mut tokens, &mut token);
                previous = None;
                continue;
            }

            let starts_word = !token.is_empty()
                && character.is_uppercase()
                && (previous.is_some_and(char::is_lowercase)
                    || characters.peek().is_some_and(|next| next.is_lowercase()));
            if starts_word {
                push_search_token(&mut tokens, &mut token);
            }
            token.extend(character.to_lowercase());
            previous = Some(character);
        }
        push_search_token(&mut tokens, &mut token);
        tokens
    }
}

fn push_search_token(tokens: &mut Vec<String>, token: &mut String) {
    if !token.is_empty() {
        tokens.push(std::mem::take(token));
    }
}

impl ToolEntry {
    pub(crate) fn new(
        server_name: &str,
        tool: &RmcpTool,
        client: Client,
        config: &McpServer,
    ) -> Self {
        let remote_name = tool.name.to_string();
        let canonical_name = canonical_tool_name(server_name, &remote_name);
        let namespace = canonical_namespace(server_name);
        let namespace_description = config
            .description
            .as_deref()
            .map(str::trim)
            .filter(|description| !description.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("Tools in the {namespace} namespace."));
        let description = tool.description.as_deref().unwrap_or_default().to_owned();
        let supports_parallel_tool_calls = tool_supports_parallel_calls(
            tool,
            config.supports_parallel_tool_calls,
            config.parallel_tools.contains(tool.name.as_ref()),
        );
        let mut input_schema = tool.input_schema.as_ref().clone();
        if input_schema.get("properties").is_none_or(Value::is_null) {
            input_schema.insert("properties".to_owned(), Value::Object(Map::new()));
        }
        let definition = ToolDefinition::function(
            canonical_name.clone(),
            description.clone(),
            Value::Object(input_schema.clone()),
        )
        .with_output_schema(json!({
            "type": "object",
            "properties": {
                "content": { "type": "array", "items": { "type": "object" } },
                "structuredContent": tool.output_schema
                    .as_ref()
                    .map_or_else(|| json!({}), |schema| Value::Object(schema.as_ref().clone())),
                "isError": { "type": "boolean" },
                "_meta": { "type": "object" }
            },
            "required": ["content"],
            "additionalProperties": false
        }));
        let mut properties = input_schema
            .get("properties")
            .and_then(Value::as_object)
            .map(|properties| properties.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        properties.sort();
        let search_text = [
            canonical_name.as_str(),
            server_name,
            remote_name.as_str(),
            tool.title.as_deref().unwrap_or_default(),
            description.as_str(),
            &properties.join(" "),
        ]
        .join(" ");
        Self {
            canonical_name,
            server_name: server_name.to_owned(),
            remote_name,
            namespace,
            namespace_description,
            definition,
            supports_parallel_tool_calls,
            tool_exposure: config.tool_exposure,
            search_text,
            client,
            timeout: config.tool_timeout,
        }
    }

    fn summary(&self) -> SearchTool {
        SearchTool {
            name: self.canonical_name.clone(),
            server: self.server_name.clone(),
            tool: self.remote_name.clone(),
            description: self.definition.description().to_owned(),
            supports_parallel_tool_calls: self.supports_parallel_tool_calls,
            input_schema: self
                .definition
                .parameters()
                .map_or(Value::Null, |schema| schema.as_value().clone()),
        }
    }

    fn loadable_function(&self) -> LoadableFunction {
        LoadableFunction {
            r#type: "function",
            name: normalize_name(&self.remote_name),
            description: self.definition.description().to_owned(),
            strict: false,
            defer_loading: true,
            parameters: self
                .definition
                .parameters()
                .map_or_else(|| json!({}), |schema| schema.as_value().clone()),
        }
    }
}

fn tool_is_read_only(tool: &RmcpTool) -> bool {
    tool.annotations
        .as_ref()
        .is_some_and(|annotations| annotations.read_only_hint == Some(true))
}

fn tool_supports_parallel_calls(tool: &RmcpTool, server_opt_in: bool, tool_policy: bool) -> bool {
    server_opt_in || tool_policy || tool_is_read_only(tool)
}

fn canonical_tool_name(server_name: &str, tool_name: &str) -> String {
    format!(
        "{}{}",
        canonical_namespace(server_name),
        normalize_name(tool_name)
    )
}

fn canonical_namespace(server_name: &str) -> String {
    format!("mcp__{}__", normalize_name(server_name))
}

fn normalize_name(name: &str) -> String {
    name.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn coalesce_loadable_tools(selected: &[Arc<ToolEntry>]) -> Vec<LoadableNamespace> {
    let mut namespaces: Vec<LoadableNamespace> = Vec::new();
    for entry in selected {
        if let Some(namespace) = namespaces
            .iter_mut()
            .find(|namespace| namespace.name == entry.namespace)
        {
            namespace.tools.push(entry.loadable_function());
        } else {
            namespaces.push(LoadableNamespace {
                r#type: "namespace",
                name: entry.namespace.clone(),
                description: entry.namespace_description.clone(),
                tools: vec![entry.loadable_function()],
            });
        }
    }
    namespaces
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::model::ToolAnnotations;

    #[test]
    fn canonical_names_are_stable_and_javascript_safe() {
        assert_eq!(
            canonical_tool_name("Google Drive", "files/search"),
            "mcp__Google_Drive__files_search"
        );
    }

    #[test]
    fn search_tokenizer_splits_identifiers_without_language_dependencies() {
        assert_eq!(
            ToolSearchTokenizer.tokenize("mcp__GoogleDrive/files-search-v2 HTTPServer"),
            [
                "mcp", "google", "drive", "files", "search", "v2", "http", "server"
            ]
        );
    }

    #[test]
    fn tool_search_ranks_identifier_components() {
        let documents = [
            Document::new(0, "mcp__github__listIssues GitHub list repository issues"),
            Document::new(1, "mcp__slack__sendMessage Slack send channel message"),
        ];
        let engine =
            SearchEngineBuilder::<usize, u32, ToolSearchTokenizer>::with_tokenizer_and_documents(
                ToolSearchTokenizer,
                documents,
            )
            .build();

        let results = engine.search("github issues", 1);
        assert_eq!(results.first().map(|result| result.document.id), Some(0));
    }

    #[test]
    fn parallel_safety_requires_server_opt_in_or_explicit_read_only_hint() {
        let schema = Arc::new(Map::new());
        let mut tool = RmcpTool::new("lookup", "Lookup", schema);
        assert!(!tool_supports_parallel_calls(&tool, false, false));
        assert!(tool_supports_parallel_calls(&tool, true, false));
        assert!(tool_supports_parallel_calls(&tool, false, true));

        tool.annotations = Some(ToolAnnotations::new().read_only(false));
        assert!(!tool_supports_parallel_calls(&tool, false, false));

        tool.annotations = Some(ToolAnnotations::new().read_only(true));
        assert!(tool_supports_parallel_calls(&tool, false, false));
    }
}
