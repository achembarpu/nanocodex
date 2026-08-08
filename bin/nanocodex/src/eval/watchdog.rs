use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
};

#[cfg(any(target_os = "linux", test))]
use std::{
    io::{Read as _, Write as _},
    net::TcpStream,
    time::Duration,
};

use eyre::Result;

pub(super) struct CoordinatorWatchdog {
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl CoordinatorWatchdog {
    #[cfg(target_os = "linux")]
    pub(super) fn start(address: SocketAddr) -> Result<Option<Self>> {
        linux::start(address)
    }

    #[cfg(not(target_os = "linux"))]
    pub(super) const fn start(_address: SocketAddr) -> Result<Option<Self>> {
        Ok(None)
    }
}

impl Drop for CoordinatorWatchdog {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            thread.thread().unpark();
            let _ = thread.join();
        }
    }
}

#[cfg(any(target_os = "linux", test))]
fn probe(address: SocketAddr, timeout: Duration) -> std::io::Result<()> {
    let mut stream = TcpStream::connect_timeout(&address, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    write!(
        stream,
        "GET /v1/health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()?;
    let mut response = [0_u8; 128];
    let read = stream.read(&mut response)?;
    if response[..read].starts_with(b"HTTP/1.1 204")
        || response[..read].starts_with(b"HTTP/1.0 204")
    {
        return Ok(());
    }
    Err(std::io::Error::other(
        "coordinator health endpoint did not return HTTP 204",
    ))
}

#[cfg(target_os = "linux")]
mod linux {
    use std::{
        env,
        ffi::OsStr,
        os::{fd::AsRawFd as _, unix::ffi::OsStrExt as _},
    };

    use eyre::{WrapErr as _, bail};
    use nix::sys::socket::{AddressFamily, MsgFlags, SockFlag, SockType, UnixAddr, sendto, socket};

    use super::*;

    struct SystemdNotifier {
        socket: std::os::fd::OwnedFd,
        address: UnixAddr,
    }

    impl SystemdNotifier {
        fn from_environment() -> Result<Option<Self>> {
            let Some(path) = env::var_os("NOTIFY_SOCKET") else {
                return Ok(None);
            };
            let bytes = path.as_bytes();
            if bytes.is_empty() {
                bail!("NOTIFY_SOCKET is empty");
            }
            let address = if bytes[0] == b'@' {
                UnixAddr::new_abstract(&bytes[1..])
            } else {
                UnixAddr::new(OsStr::from_bytes(bytes))
            }
            .wrap_err("failed to parse NOTIFY_SOCKET")?;
            let socket = socket(
                AddressFamily::Unix,
                SockType::Datagram,
                SockFlag::SOCK_CLOEXEC,
                None,
            )
            .wrap_err("failed to create systemd notification socket")?;
            Ok(Some(Self { socket, address }))
        }

        fn send(&self, state: &str) -> Result<()> {
            sendto(
                self.socket.as_raw_fd(),
                state.as_bytes(),
                &self.address,
                MsgFlags::empty(),
            )
            .wrap_err("failed to notify systemd")?;
            Ok(())
        }
    }

    pub(super) fn start(address: SocketAddr) -> Result<Option<CoordinatorWatchdog>> {
        let Some(notifier) = SystemdNotifier::from_environment()? else {
            return Ok(None);
        };
        let Some(watchdog_usec) = env::var_os("WATCHDOG_USEC") else {
            bail!("NOTIFY_SOCKET is set but WATCHDOG_USEC is missing");
        };
        if let Some(pid) = env::var_os("WATCHDOG_PID") {
            let pid = pid
                .to_string_lossy()
                .parse::<u32>()
                .wrap_err("WATCHDOG_PID is invalid")?;
            if pid != std::process::id() {
                return Ok(None);
            }
        }
        let watchdog_usec = watchdog_usec
            .to_string_lossy()
            .parse::<u64>()
            .wrap_err("WATCHDOG_USEC is invalid")?;
        if watchdog_usec == 0 {
            bail!("WATCHDOG_USEC must be greater than zero");
        }
        let watchdog_period = Duration::from_micros(watchdog_usec);
        let interval = (watchdog_period / 3).max(Duration::from_millis(250));
        let probe_timeout =
            (interval / 2).clamp(Duration::from_millis(100), Duration::from_secs(2));
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread = thread::Builder::new()
            .name("coordinator-watchdog".to_owned())
            .spawn(move || {
                let mut ready = false;
                while !thread_stop.load(Ordering::Acquire) {
                    match probe(address, probe_timeout) {
                        Ok(()) => {
                            let state = if ready {
                                "WATCHDOG=1"
                            } else {
                                "READY=1\nWATCHDOG=1\nSTATUS=Coordinator HTTP API is responsive"
                            };
                            if let Err(error) = notifier.send(state) {
                                tracing::warn!(%error, "failed to refresh coordinator systemd watchdog");
                            }
                            ready = true;
                        }
                        Err(error) => {
                            tracing::warn!(%error, %address, "coordinator health probe failed");
                        }
                    }
                    thread::park_timeout(interval);
                }
            })
            .wrap_err("failed to spawn coordinator watchdog thread")?;
        Ok(Some(CoordinatorWatchdog {
            stop,
            thread: Some(thread),
        }))
    }
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;

    use super::*;

    #[test]
    fn health_probe_requires_a_complete_http_204_response() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 256];
            let _ = stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .unwrap();
        });

        probe(address, Duration::from_secs(1)).unwrap();
        server.join().unwrap();
    }
}
