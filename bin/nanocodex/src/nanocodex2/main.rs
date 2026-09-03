//! Managed-agent CLI with a Tact-derived local terminal interface.
#![allow(
    clippy::missing_const_for_fn,
    clippy::too_many_arguments,
    clippy::use_self,
    reason = "preserve the reviewed Tact component ownership while adapting its engine boundary"
)]

#[allow(dead_code)]
mod config;
mod host;
#[allow(dead_code)]
mod installation;
#[allow(dead_code)]
mod skill;
#[allow(dead_code, unused_imports)]
mod tui;

use std::{
    env,
    io::{self, Write},
    process::ExitCode,
};

use clap::{Args, Parser, Subcommand, builder::NonEmptyStringValueParser};
use host::HostConfig;
use nanocodex_agent::{AgentEvents, Nanocodex, NanocodexError, PromptRequest, Turn, TurnResult};
use nanocodex_managed::{
    AgentSettings, AgentState, EventCursor, Managed, ManagedApiKey, ManagedClient, ManagedError,
    PromptInput,
};
use nanocodex_tools::{Tools, WorkspaceTools};

const MANAGED_URL_ENV: &str = "NANOCODEX_MANAGED_URL";
const API_KEY_ENV: &str = "NANOCODEX_API_KEY";
const API_KEY_FALLBACK_ENV: &str = "NC_API_KEY";
const DEFAULT_MANAGED_ORIGIN: &str = "https://nanocodex.gakonst.workers.dev";

#[derive(Parser)]
#[command(
    name = "nanocodex2",
    about = "Small managed Nanocodex client with local workspace tools"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Attach local workspace tools to an existing managed agent.
    Attach(Attach),
    /// Create a managed agent and print its receipt as JSON.
    New,
    /// List account-owned managed agents as JSON.
    List,
    /// Read one managed agent's durable state as JSON.
    State(AgentId),
    /// Read one managed turn's durable state as JSON.
    Turn(TurnId),
    /// Delete one managed agent and its retained state.
    Delete(AgentId),
    /// Submit one prompt and stream durable managed events as JSONL.
    Run(Run),
    /// Stream an owned agent's durable events from a cursor.
    Watch(Watch),
    /// Read one backward page of retained events.
    History(History),
    /// Steer an active managed turn.
    Steer(Steer),
    /// Cancel an active managed turn.
    Cancel(TurnId),
}

#[derive(Args)]
struct Attach {
    /// Account-owned managed agent ID. Choose from a list when omitted.
    #[arg(value_parser = NonEmptyStringValueParser::new())]
    agent_id: Option<String>,
}

#[derive(Args)]
struct AgentId {
    /// Account-owned managed agent ID.
    agent_id: String,
}

#[derive(Args)]
struct TurnId {
    /// Account-owned managed agent ID.
    agent_id: String,
    /// Managed turn ID.
    turn_id: String,
}

#[derive(Args)]
struct Run {
    /// Prompt text.
    #[arg(value_parser = NonEmptyStringValueParser::new())]
    prompt: String,
    /// Resume this account-owned agent. A new one is created when omitted.
    #[arg(long)]
    agent: Option<String>,
    /// Stable idempotency key. The managed backend generates one when omitted.
    #[arg(long)]
    idempotency_key: Option<String>,
}

#[derive(Args)]
struct Watch {
    /// Account-owned managed agent ID.
    agent_id: String,
    /// Resume strictly after this decimal cursor, or tail from `latest`.
    #[arg(long, default_value = "0")]
    cursor: String,
}

#[derive(Args)]
struct History {
    /// Account-owned managed agent ID.
    agent_id: String,
    /// Return rows strictly before this positive decimal cursor.
    #[arg(long)]
    before: Option<String>,
    /// Page size from 1 through 256.
    #[arg(long, default_value_t = 128)]
    limit: u16,
}

#[derive(Args)]
struct Steer {
    /// Account-owned managed agent ID.
    agent_id: String,
    /// Active managed turn ID.
    turn_id: String,
    /// Additional prompt text.
    #[arg(value_parser = NonEmptyStringValueParser::new())]
    prompt: String,
}

fn main() -> ExitCode {
    match try_main() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Error: {error}");
            ExitCode::FAILURE
        }
    }
}

fn try_main() -> Result<(), ManagedError> {
    let _ = dotenvy::dotenv();
    let cli = Cli::parse();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| ManagedError::Configuration(format!("failed to start Tokio: {error}")))?
        .block_on(run(cli))
}

async fn run(cli: Cli) -> Result<(), ManagedError> {
    let client = client_from_environment()?;
    match cli.command {
        Some(Command::Attach(command)) => attach_tui(&client, command.agent_id).await,
        Some(Command::New) => write_json(&client.create().await?),
        Some(Command::List) => write_json(&client.list().await?),
        Some(Command::State(command)) => write_json(&client.state(&command.agent_id).await?),
        Some(Command::Turn(command)) => write_json(
            &client
                .turn_state(&command.agent_id, &command.turn_id)
                .await?,
        ),
        Some(Command::Delete(command)) => client.delete(&command.agent_id).await,
        Some(Command::Run(command)) => run_turn(&client, command).await,
        Some(Command::Watch(command)) => watch(&client, command).await,
        Some(Command::History(command)) => write_json(
            &client
                .history(&command.agent_id, command.before.as_deref(), command.limit)
                .await?,
        ),
        Some(Command::Steer(command)) => write_json(
            &client
                .steer(
                    &command.agent_id,
                    &command.turn_id,
                    &PromptInput::Text(command.prompt),
                )
                .await?,
        ),
        Some(Command::Cancel(command)) => {
            write_json(&client.cancel(&command.agent_id, &command.turn_id).await?)
        }
        None => new_tui(&client).await,
    }
}

fn client_from_environment() -> Result<ManagedClient, ManagedError> {
    let base_url = managed_url_from_environment()?;
    let api_key = api_key_from_environment().map_err(|_| {
        ManagedError::Configuration(format!(
            "{API_KEY_ENV} (or {API_KEY_FALLBACK_ENV}) must be set to an account-issued ncx_live key"
        ))
    })?;
    ManagedClient::new(base_url, ManagedApiKey::parse(api_key)?)
}

fn api_key_from_environment() -> Result<String, env::VarError> {
    env::var(API_KEY_ENV).or_else(|_| env::var(API_KEY_FALLBACK_ENV))
}

fn managed_url_from_environment() -> Result<String, ManagedError> {
    match env::var(MANAGED_URL_ENV) {
        Ok(value) if !value.trim().is_empty() => Ok(value),
        Ok(_) => Err(ManagedError::Configuration(format!(
            "{MANAGED_URL_ENV} must not be empty"
        ))),
        Err(env::VarError::NotPresent) => Ok(DEFAULT_MANAGED_ORIGIN.to_owned()),
        Err(env::VarError::NotUnicode(_)) => Err(ManagedError::Configuration(format!(
            "{MANAGED_URL_ENV} must be valid Unicode"
        ))),
    }
}

async fn run_turn(client: &ManagedClient, command: Run) -> Result<(), ManagedError> {
    let created = command.agent.is_none();
    let (agent, mut events, agent_id, _) =
        open_workspace_agent_from(client, command.agent, None).await?;
    if created {
        eprintln!("Managed agent: {agent_id}");
    }
    let mut request = PromptRequest::new(command.prompt);
    if let Some(request_id) = command.idempotency_key {
        request = request.request_id(request_id);
    }
    let turn: Turn = agent.prompt(request).await.map_err(agent_error)?;
    let outcome = await_turn(turn, &mut events).await;
    let shutdown = agent.shutdown().await.map_err(agent_error);
    match (outcome, shutdown) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(Some(result)), Ok(())) => {
            eprintln!("{}", result.final_message());
            Ok(())
        }
        (Ok(None), Ok(())) => Ok(()),
    }
}

async fn attach_tui(
    client: &ManagedClient,
    requested_agent_id: Option<String>,
) -> Result<(), ManagedError> {
    tui::run(client, requested_agent_id).await
}

async fn new_tui(client: &ManagedClient) -> Result<(), ManagedError> {
    tui::run_new(client).await
}

async fn open_workspace_agent_from(
    client: &ManagedClient,
    agent_id: Option<String>,
    state: Option<AgentState>,
) -> Result<(Nanocodex, AgentEvents, String, std::path::PathBuf), ManagedError> {
    open_workspace_agent_with_settings(client, agent_id, state, AgentSettings::default()).await
}

async fn open_workspace_agent_with_settings(
    client: &ManagedClient,
    agent_id: Option<String>,
    state: Option<AgentState>,
    settings: AgentSettings,
) -> Result<(Nanocodex, AgentEvents, String, std::path::PathBuf), ManagedError> {
    let config =
        HostConfig::load().map_err(|error| ManagedError::Configuration(error.to_string()))?;
    let workspace = config.workspace().to_path_buf();
    let tools = Tools::builder()
        .without_defaults()
        .add(WorkspaceTools::new(&workspace))
        .build()
        .map_err(|error| ManagedError::Configuration(error.to_string()))?;
    let backend = match (agent_id, state) {
        (None, None) => Managed::create_live(client.clone()).with_settings(settings),
        (Some(agent_id), Some(state)) => {
            Managed::open_live_from_state(client.clone(), agent_id, state)
        }
        (Some(agent_id), None) => Managed::open_live(client.clone(), agent_id),
        (None, Some(_)) => {
            return Err(ManagedError::Configuration(
                "managed state requires an agent identifier".to_owned(),
            ));
        }
    };
    let (agent, events) = Nanocodex::builder(backend)
        .tools(tools)
        .build()
        .await
        .map_err(agent_error)?;
    let agent_id = agent.agent_id().to_owned();
    Ok((agent, events, agent_id, workspace))
}

async fn await_turn(
    turn: Turn,
    events: &mut AgentEvents,
) -> Result<Option<TurnResult>, ManagedError> {
    tokio::pin!(turn);
    let interrupt = tokio::signal::ctrl_c();
    tokio::pin!(interrupt);
    loop {
        tokio::select! {
            result = &mut turn => {
                let result = result.map_err(agent_error)?;
                while let Some(event) = events.try_recv_timed() {
                    write_json_line(&event.event)?;
                }
                return Ok(Some(result));
            }
            event = events.recv() => match event {
                Some(event) => {
                    write_json_line(&event)?;
                }
                None => return Err(ManagedError::Configuration(
                    "agent event stream stopped before turn completion".to_owned(),
                )),
            },
            signal = &mut interrupt => {
                signal.map_err(|error| ManagedError::Configuration(
                    format!("failed to listen for Ctrl-C: {error}")
                ))?;
                return Ok(None);
            },
        }
    }
}

fn agent_error(error: NanocodexError) -> ManagedError {
    ManagedError::Configuration(error.to_string())
}

async fn watch(client: &ManagedClient, command: Watch) -> Result<(), ManagedError> {
    let mut events = client.events(&command.agent_id, EventCursor::parse(command.cursor)?)?;
    loop {
        write_json_line(&events.next().await?)?;
    }
}

fn write_json<T: serde::Serialize>(value: &T) -> Result<(), ManagedError> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    serde_json::to_writer(&mut output, value)
        .map_err(|_| ManagedError::InvalidResponse("failed to encode output"))?;
    output
        .write_all(b"\n")
        .and_then(|()| output.flush())
        .map_err(|_| ManagedError::InvalidResponse("failed to write output"))
}

fn write_json_line<T: serde::Serialize>(value: &T) -> Result<(), ManagedError> {
    write_json(value)
}
