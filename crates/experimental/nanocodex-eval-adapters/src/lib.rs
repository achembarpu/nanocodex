//! Pinned third-party benchmark adapters for `nanocodex-eval`.
//!
//! Adapters acquire authoritative source material and normalize it into the
//! evaluator's immutable task boundary. Scheduling and runtime policy remain
//! owned by `nanocodex-eval`.

#![deny(missing_docs, rustdoc::broken_intra_doc_links)]

mod source;

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use nanocodex_eval::{
    ResolvedTask,
    import::{ImportError, ImportStore, ImportedDataset},
};
use source::SourceStore;

/// Installed adapter catalog bound to one durable evaluator state directory.
#[derive(Clone, Debug)]
pub struct AdapterCatalog {
    imports: PathBuf,
    sources: PathBuf,
}

/// Adapter source acquisition, normalization, or task selection failed.
#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    /// A selector did not use the stable `<benchmark>/<task>` shape.
    #[error("invalid benchmark selector {0:?}; expected <benchmark>/<task> or <benchmark>/*")]
    InvalidSelector(String),
    /// A profile selected the same benchmark task more than once.
    #[error("duplicate benchmark selector {0:?}")]
    DuplicateSelector(String),
    /// No installed adapter owns the benchmark name.
    #[error("no installed evaluation adapter owns benchmark {0:?}")]
    UnknownBenchmark(String),
    /// An installed dataset did not contain requested normalized tasks.
    #[error("benchmark {benchmark:?} has no normalized task(s): {tasks}")]
    MissingTasks {
        /// Selected benchmark.
        benchmark: String,
        /// Missing task names.
        tasks: String,
    },
    /// Adapter source acquisition failed.
    #[error("adapter source acquisition failed: {0}")]
    Source(String),
    /// Immutable dataset import failed.
    #[error(transparent)]
    Import(#[from] ImportError),
    /// A blocking adapter worker failed.
    #[error("evaluation adapter worker failed: {0}")]
    Worker(String),
}

#[derive(Clone, Debug)]
pub(crate) struct BenchmarkRequest {
    name: String,
    all: bool,
    tasks: BTreeSet<String>,
}

#[derive(Clone, Copy)]
struct InstalledAdapter {
    names: &'static [&'static str],
    import:
        fn(&BenchmarkRequest, &SourceStore, &ImportStore) -> Result<ImportedDataset, AdapterError>,
    matches: fn(&str, &str) -> bool,
}

const INSTALLED_ADAPTERS: &[InstalledAdapter] = &[];

impl AdapterCatalog {
    /// Uses `imports/` and `sources/` below one durable evaluator state root.
    #[must_use]
    pub fn new(state_directory: impl AsRef<Path>) -> Self {
        let root = state_directory.as_ref();
        Self {
            imports: root.join("imports"),
            sources: root.join("sources"),
        }
    }

    /// Acquires, imports, and selects every configured benchmark task.
    pub async fn resolve(&self, selectors: &[String]) -> Result<Vec<ResolvedTask>, AdapterError> {
        let requests = parse_requests(selectors)?;
        let mut jobs = tokio::task::JoinSet::new();
        for request in requests.into_values() {
            let adapter = installed_adapter(&request.name)?;
            let imports = self.imports.clone();
            let sources = self.sources.clone();
            jobs.spawn_blocking(move || {
                let store = ImportStore::new(imports);
                let sources = SourceStore::new(sources);
                let dataset = (adapter.import)(&request, &sources, &store)?;
                select_tasks(&request, &dataset, adapter.matches)
            });
        }
        let mut selected = Vec::new();
        while let Some(result) = jobs.join_next().await {
            selected.extend(result.map_err(|error| AdapterError::Worker(error.to_string()))??);
        }
        selected.sort_by(|left, right| left.selector.cmp(&right.selector));
        Ok(selected)
    }
}

fn installed_adapter(name: &str) -> Result<InstalledAdapter, AdapterError> {
    INSTALLED_ADAPTERS
        .iter()
        .copied()
        .find(|adapter| adapter.names.contains(&name))
        .ok_or_else(|| AdapterError::UnknownBenchmark(name.to_owned()))
}

fn parse_requests(
    selectors: &[String],
) -> Result<BTreeMap<String, BenchmarkRequest>, AdapterError> {
    let mut unique = BTreeSet::new();
    let mut requests = BTreeMap::<String, BenchmarkRequest>::new();
    for selector in selectors {
        if !unique.insert(selector) {
            return Err(AdapterError::DuplicateSelector(selector.clone()));
        }
        let (benchmark, task) = selector
            .split_once('/')
            .filter(|(benchmark, task)| !benchmark.is_empty() && !task.is_empty())
            .ok_or_else(|| AdapterError::InvalidSelector(selector.clone()))?;
        let request = requests
            .entry(benchmark.to_owned())
            .or_insert_with(|| BenchmarkRequest {
                name: benchmark.to_owned(),
                all: false,
                tasks: BTreeSet::new(),
            });
        if task == "*" {
            request.all = true;
        } else {
            request.tasks.insert(task.to_owned());
        }
    }
    for request in requests.values() {
        if request.all && !request.tasks.is_empty() {
            return Err(AdapterError::InvalidSelector(format!(
                "{} mixes * with explicit tasks",
                request.name
            )));
        }
    }
    Ok(requests)
}

fn select_tasks(
    request: &BenchmarkRequest,
    dataset: &ImportedDataset,
    matches: fn(&str, &str) -> bool,
) -> Result<Vec<ResolvedTask>, AdapterError> {
    let mut missing = request.tasks.clone();
    let mut selected = Vec::new();
    for task in dataset.tasks() {
        let selected_name = request
            .tasks
            .iter()
            .find(|selected| matches(selected, task.name()));
        if request.all || selected_name.is_some() {
            if let Some(name) = selected_name {
                missing.remove(name);
            }
            selected.push(ResolvedTask {
                selector: format!(
                    "{}/{}",
                    request.name,
                    selected_name.map_or_else(|| task.name(), String::as_str)
                ),
                task: task.clone(),
            });
        }
    }
    if !missing.is_empty() {
        return Err(AdapterError::MissingTasks {
            benchmark: request.name.clone(),
            tasks: missing.into_iter().collect::<Vec<_>>().join(", "),
        });
    }
    Ok(selected)
}

#[allow(dead_code)]
pub(crate) fn exact_task(selected: &str, normalized: &str) -> bool {
    selected == normalized
}

impl From<source::SourceError> for AdapterError {
    fn from(error: source::SourceError) -> Self {
        Self::Source(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_exact_and_all_task_selections() {
        let requests =
            parse_requests(&["one/a".to_owned(), "one/b".to_owned(), "two/*".to_owned()]).unwrap();

        assert_eq!(requests["one"].tasks.len(), 2);
        assert!(!requests["one"].all);
        assert!(requests["two"].all);
    }

    #[test]
    fn rejects_ambiguous_all_selection() {
        let error = parse_requests(&["one/*".to_owned(), "one/a".to_owned()]).unwrap_err();

        assert!(error.to_string().contains("mixes *"));
    }
}
