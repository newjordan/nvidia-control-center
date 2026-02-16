//! SpeakMCP Daemon — always-on process supervisor and event hub.
//!
//! Spawns the Node.js `@speakmcp/core` process, supervises it,
//! and exposes an HTTP/WebSocket API for task submission and
//! real-time event streaming.

mod config;
mod events;
mod jsonrpc;
mod process_manager;
mod server;
mod task_queue;

use clap::Parser;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "speakmcp-daemon", about = "SpeakMCP always-on daemon")]
struct Args {
    /// Port for the HTTP/WebSocket API
    #[arg(long, default_value_t = 7833)]
    port: u16,

    /// Path to the Node.js core entry point
    /// (defaults to packages/core/dist/index.mjs relative to the monorepo root)
    #[arg(long)]
    core_path: Option<String>,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, default_value = "info")]
    log_level: String,
}

#[tokio::main]
async fn main() {
    let args = Args::parse();

    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new(&args.log_level)),
        )
        .init();

    info!("speakmcp-daemon v{}", env!("CARGO_PKG_VERSION"));
    info!("starting on port {}", args.port);

    // Create shared state
    let event_bus = events::EventBus::new();
    let task_queue = task_queue::TaskQueue::new();
    let process_mgr = process_manager::ProcessManager::new(
        args.core_path.clone(),
        event_bus.clone(),
    );

    // Start the Node.js core process
    if let Err(e) = process_mgr.start().await {
        warn!("failed to start core process: {e}");
        warn!("daemon will run without a core process — submit tasks to queue them");
    }

    // Start the HTTP/WebSocket server
    server::run(args.port, event_bus, task_queue, process_mgr).await;
}
