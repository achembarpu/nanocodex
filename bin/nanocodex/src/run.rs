use clap::{Args, builder::NonEmptyStringValueParser};
use eyre::{Result, eyre};
use nanocodex::AgentEvents;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::time::{Duration, timeout};

use crate::config::AgentArgs;
use crate::vm::VmArgs;

const TURN_SETTLE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Args)]
pub(crate) struct Run {
    /// Prompt submitted to the agent.
    #[arg(value_parser = NonEmptyStringValueParser::new())]
    prompt: String,

    /// Submit the same prompt as sequential follow-on turns on one owned session.
    #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u16).range(1..=100))]
    repeat: u16,
}

impl Run {
    pub(crate) async fn run(self, config: AgentArgs, vm: VmArgs) -> Result<()> {
        let configured = config.build(vm).await?;
        let handle = configured.handle;
        let mut events = configured.events;
        let mut stdout = tokio::io::stdout();
        let run_result: Result<()> = async {
            for _ in 0..self.repeat {
                let turn = handle.prompt(self.prompt.clone()).await?;
                let control = turn.control();
                let completion = async {
                    let events_result = write_turn_jsonl(&mut events, &mut stdout);
                    let turn_result = turn.result();
                    tokio::pin!(events_result);
                    tokio::pin!(turn_result);
                    tokio::select! {
                        result = &mut turn_result => {
                            let terminal = timeout(TURN_SETTLE_TIMEOUT, &mut events_result).await;
                            result?;
                            terminal
                                .map_err(|_| eyre!("terminal event did not settle after the turn completed"))??;
                        }
                        result = &mut events_result => match result {
                            Ok(()) => {
                                timeout(TURN_SETTLE_TIMEOUT, &mut turn_result)
                                    .await
                                    .map_err(|_| eyre!("turn result did not settle after its terminal event"))??;
                            }
                            Err(event_error) => {
                                let _ = timeout(TURN_SETTLE_TIMEOUT, control.cancel()).await;
                                if let Ok(Err(turn_error)) =
                                    timeout(TURN_SETTLE_TIMEOUT, &mut turn_result).await
                                {
                                    return Err(turn_error.into());
                                }
                                return Err(event_error);
                            }
                        }
                    }
                    Ok(())
                };
                tokio::pin!(completion);
                tokio::select! {
                    result = &mut completion => result?,
                    signal = interrupt_signal() => {
                        signal?;
                        // The driver may have completed while JSONL was still
                        // backpressured. A late cancellation rejection must not
                        // discard its already-produced terminal event.
                        let _ = control.cancel().await;
                        let _ = completion.await;
                        return Err(eyre!("interrupted"));
                    }
                }
                handle.flush_rollout().await?;
            }
            Ok(())
        }
        .await;
        if let Some(child_agents) = configured.child_agents {
            child_agents.shutdown().await;
        }
        let agent_shutdown = handle.shutdown().await;
        drop(handle);
        drop(events);
        let browser_shutdown_result = if let Some(browser) = configured.browser {
            browser.shutdown().await
        } else {
            Ok(())
        };
        let vm_shutdown_result = if let Some(vm) = configured.vm {
            vm.shutdown().await
        } else {
            Ok(())
        };
        let shutdown_result = if let Some(adapter) = configured.mpp_adapter {
            adapter.shutdown().await
        } else {
            Ok(())
        };
        run_result?;
        agent_shutdown?;
        browser_shutdown_result?;
        vm_shutdown_result?;
        shutdown_result
    }
}

async fn interrupt_signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            signal = terminate.recv() => {
                if signal.is_none() {
                    return Err(eyre!("SIGTERM listener closed"));
                }
            }
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await?;
        Ok(())
    }
}

pub(crate) async fn run_prompt(prompt: String, config: AgentArgs, vm: VmArgs) -> Result<()> {
    Run { prompt, repeat: 1 }.run(config, vm).await
}

async fn write_turn_jsonl(
    events: &mut AgentEvents,
    output: &mut (impl AsyncWrite + Unpin),
) -> Result<()> {
    while let Some(event) = events.recv().await {
        let terminal = event.kind.is_terminal();
        let mut record = serde_json::to_vec(&event)?;
        record.push(b'\n');
        output.write_all(&record).await?;
        output.flush().await?;
        if terminal {
            return Ok(());
        }
    }
    Err(eyre!(
        "agent event stream closed before the turn emitted a terminal event"
    ))
}
