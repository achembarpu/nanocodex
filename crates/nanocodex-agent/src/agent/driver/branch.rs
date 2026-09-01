use super::*;

pub(in crate::agent) struct BranchSpawner<S> {
    pub(in crate::agent) config: Arc<ModelConfig>,
    pub(in crate::agent) tools: ToolsConfiguration,
    pub(in crate::agent) lineage_id: Arc<str>,
    pub(in crate::agent) provider_session_id: Arc<str>,
    pub(in crate::agent) prompt_cache_key: Option<Arc<str>>,
    pub(in crate::agent) shared_prompt_cache: Option<SharedPromptCache>,
    pub(in crate::agent) context_config: ContextSourceConfig,
    pub(in crate::agent) context_source: ContextSource,
    pub(in crate::agent) depth: u32,
    pub(in crate::agent) execution: ExecutionConfig,
    pub(in crate::agent) service_factory: ServiceFactory<S>,
}

#[derive(Clone)]
pub(in crate::agent) struct AgentOrigin {
    pub(in crate::agent) kind: &'static str,
    pub(in crate::agent) depth: u32,
    pub(in crate::agent) parent_session_id: Option<Arc<str>>,
}

impl<S> BranchSpawner<S> {
    fn for_fork(&self) -> Result<Self> {
        Ok(Self {
            config: Arc::clone(&self.config),
            tools: self.tools.clone(),
            lineage_id: Arc::clone(&self.lineage_id),
            provider_session_id: Arc::clone(&self.provider_session_id),
            prompt_cache_key: self.prompt_cache_key.as_ref().map(Arc::clone),
            shared_prompt_cache: self.shared_prompt_cache.clone(),
            context_config: self.context_config.clone(),
            context_source: self.context_source.clone(),
            depth: self.depth,
            execution: self.execution.for_fork()?,
            service_factory: Arc::clone(&self.service_factory),
        })
    }
}

impl<S> BranchSpawner<S>
where
    S: Service<ResponsesAttempt, Response = ResponsesServiceResponse> + AgentSend + 'static,
    S::Error: Into<ResponseError> + AgentSend + 'static,
    S::Future: AgentSend,
{
    pub(super) fn spawn_fork(
        &self,
        checkpoint: &CommittedSession,
        parent_session_id: &str,
        model: Model,
        thinking: Thinking,
        fast_mode: bool,
    ) -> Result<(Nanocodex, AgentEvents)> {
        let session_id = SessionId::new();
        let workspace = Some(Arc::<str>::from(checkpoint.model().workspace()));
        let mut spawner = self.for_fork()?;
        spawner.context_source = spawner.context_config.build();
        let mut config = (*spawner.config).clone();
        config.model = model;
        config.thinking = thinking;
        config.fast_mode = fast_mode;
        spawner.config = Arc::new(config);
        spawner.depth = self.depth.saturating_add(1);
        let service = (spawner.service_factory)(Arc::clone(&spawner.config));
        spawn_agent_driver(
            spawner,
            session_id,
            workspace,
            service,
            Some(InitialResume::Exact(Box::new(checkpoint.model().clone()))),
            AgentOrigin {
                kind: "fork",
                depth: self.depth.saturating_add(1),
                parent_session_id: Some(Arc::from(parent_session_id)),
            },
        )
    }

    pub(super) async fn spawn_clean(
        &self,
        workspace: Option<Arc<str>>,
        parent_session_id: &str,
        session_id: Option<SessionId>,
        model: Model,
        thinking: Thinking,
        fast_mode: bool,
    ) -> Result<(Nanocodex, AgentEvents)> {
        let session_id = session_id.unwrap_or_default();
        let session_id_text = session_id.to_string();
        let depth = self.depth.saturating_add(1);
        let mut config = (*self.config).clone();
        config.model = model;
        config.thinking = thinking;
        config.fast_mode = fast_mode;
        let inherited_prompt_cache_key = self
            .prompt_cache_key
            .as_ref()
            .map_or_else(|| Arc::clone(&self.lineage_id), Arc::clone);
        let (execution, initial_resume) = self
            .execution
            .for_spawn(session_id_text.clone(), parent_session_id.to_owned())
            .await?;
        let (lineage_id, prompt_cache_key, workspace, initial_resume) = if let Some(snapshot) =
            initial_resume
        {
            let SessionResume {
                model,
                lineage_id,
                prompt_cache_key,
                workspace: restored_workspace,
                canonical_context,
                history,
                context_baseline,
                checkpoint,
            } = snapshot.into_resume()?;
            if prompt_cache_key != inherited_prompt_cache_key {
                return Err(NanocodexError::InvalidSessionSnapshot(
                    "spawned durable agent changed prompt cache identity".to_owned(),
                ));
            }
            config.model = model;
            let context_source = self.context_config.build();
            let restored_workspace = context_source.resolve_workspace(Some(&restored_workspace))?;
            if let Some(requested_workspace) = workspace.as_deref()
                && context_source.resolve_workspace(Some(requested_workspace))?
                    != restored_workspace
            {
                return Err(NanocodexError::WorkspaceChanged {
                    current: restored_workspace,
                    requested: requested_workspace.to_owned(),
                });
            }
            let initial_resume = checkpoint.map_or_else(
                || {
                    InitialResume::History(Box::new(HistoryCheckpoint {
                        workspace: restored_workspace.clone(),
                        provider_session_id: Arc::clone(&lineage_id),
                        canonical_context,
                        history,
                        prompt_cache_key: Arc::clone(&prompt_cache_key),
                        context_baseline,
                    }))
                },
                |checkpoint| InitialResume::Exact(Box::new(checkpoint)),
            );
            (
                lineage_id,
                prompt_cache_key,
                Some(Arc::from(restored_workspace)),
                Some(initial_resume),
            )
        } else {
            (
                Arc::from(session_id_text.as_str()),
                inherited_prompt_cache_key,
                workspace,
                None,
            )
        };
        let spawner = Self {
            config: Arc::new(config),
            tools: self.tools.clone(),
            lineage_id,
            provider_session_id: Arc::clone(&self.provider_session_id),
            prompt_cache_key: Some(prompt_cache_key),
            shared_prompt_cache: self.shared_prompt_cache.clone(),
            context_config: self.context_config.clone(),
            context_source: self.context_config.build(),
            depth,
            execution,
            service_factory: Arc::clone(&self.service_factory),
        };
        let service = (spawner.service_factory)(Arc::clone(&spawner.config));
        spawn_agent_driver(
            spawner,
            session_id,
            workspace,
            service,
            initial_resume,
            AgentOrigin {
                kind: "spawn",
                depth,
                parent_session_id: Some(Arc::from(parent_session_id)),
            },
        )
    }

    pub(super) async fn spawn_clean_many(
        &self,
        workspace: Option<Arc<str>>,
        parent_session_id: &str,
        defaults: TurnDefaults,
        count: usize,
        observer: Option<&SpawnObserver>,
    ) -> Result<Vec<(Nanocodex, AgentEvents)>> {
        let mut children = Vec::with_capacity(count);
        for _ in 0..count {
            let child = self
                .spawn_clean(
                    workspace.clone(),
                    parent_session_id,
                    None,
                    defaults.model,
                    defaults.thinking,
                    defaults.fast_mode,
                )
                .await?;
            if let Some(observer) = observer {
                observer(child.0.session_id());
            }
            children.push(child);
        }
        Ok(children)
    }
}
