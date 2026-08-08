use std::{net::Ipv4Addr, path::PathBuf};

use clap::Args;
use eyre::{Result, WrapErr as _};
use nanocodex_eval::{Evaluation, coordinator::CoordinatorServer};
use tokio::net::TcpListener;

use super::watchdog::CoordinatorWatchdog;
use super::{profile::default_state_dir, systemd};

#[derive(Args)]
pub(super) struct Coordinator {
    /// Named durable profile served from SQLite.
    profile: String,

    /// Runtime harness helper configuration.
    #[arg(long, default_value = "nanocodex.toml")]
    config: PathBuf,

    /// Durable SQLite ledger and retained coordinator artifacts.
    #[arg(long, value_name = "DIRECTORY")]
    state_dir: Option<PathBuf>,

    /// Listen port. Use zero to allocate an available port.
    #[arg(long, default_value_t = 8789)]
    port: u16,

    /// Install and start this coordinator as a watchdog-supervised user service.
    #[arg(long)]
    systemd: bool,
}

impl Coordinator {
    pub(super) async fn run(self) -> Result<()> {
        let Self {
            profile,
            config,
            state_dir,
            port,
            systemd: install_systemd,
        } = self;
        let state = state_dir.map_or_else(default_state_dir, Ok)?;
        if install_systemd {
            return systemd::install_coordinator(&profile, &config, &state, port);
        }
        let evaluation = Evaluation::open(&config, &profile, state)?;
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .await
            .wrap_err("failed to bind the evaluation coordinator")?;
        let address = listener.local_addr()?;
        println!("http://{address}");
        let _watchdog = CoordinatorWatchdog::start(address)?;
        CoordinatorServer::new(evaluation)
            .serve(listener)
            .await
            .wrap_err("evaluation coordinator stopped")
    }
}
