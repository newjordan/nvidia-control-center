//! Daemon configuration constants and helpers.

/// Default port for the HTTP/WebSocket API.
pub const DEFAULT_PORT: u16 = 7833;

/// Maximum number of concurrent agent processes.
pub const MAX_CONCURRENT_AGENTS: usize = 4;

/// How long to wait before restarting a crashed core process (ms).
pub const RESTART_DELAY_MS: u64 = 2000;

/// Maximum restart attempts before giving up.
pub const MAX_RESTART_ATTEMPTS: u32 = 10;

/// Heartbeat interval for WebSocket clients (seconds).
pub const HEARTBEAT_INTERVAL_SECS: u64 = 30;
