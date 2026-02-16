//! Process manager — spawn, supervise, and restart the Node.js core process.
//!
//! The core process communicates over stdin/stdout using JSON-RPC 2.0.
//! Stderr is captured and logged. If the process crashes, the manager
//! restarts it with exponential backoff.

use crate::config;
use crate::events::{DaemonEvent, EventBus};
use crate::jsonrpc::{JsonRpcMessage, JsonRpcRequest};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

/// Manages the lifecycle of the Node.js core child process.
#[derive(Clone)]
pub struct ProcessManager {
    core_path: Option<String>,
    event_bus: EventBus,
    child: Arc<Mutex<Option<Child>>>,
    stdin_writer: Arc<Mutex<Option<tokio::process::ChildStdin>>>,
}

impl ProcessManager {
    pub fn new(core_path: Option<String>, event_bus: EventBus) -> Self {
        Self {
            core_path,
            event_bus,
            child: Arc::new(Mutex::new(None)),
            stdin_writer: Arc::new(Mutex::new(None)),
        }
    }

    /// Resolve the path to the core entry point.
    fn resolve_core_path(&self) -> String {
        if let Some(ref path) = self.core_path {
            return path.clone();
        }

        // Default: look for the core package relative to the daemon binary
        // In the monorepo: ../../packages/core/dist/index.mjs
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()));

        if let Some(dir) = exe_dir {
            // Try monorepo layout first
            let monorepo_path = dir
                .join("../../packages/core/dist/index.mjs")
                .canonicalize();
            if let Ok(p) = monorepo_path {
                return p.to_string_lossy().into_owned();
            }
        }

        // Fallback
        "packages/core/dist/index.mjs".to_string()
    }

    /// Start the core process.
    pub async fn start(&self) -> Result<(), String> {
        let core_path = self.resolve_core_path();
        info!(path = %core_path, "spawning core process");

        let mut cmd = Command::new("node");
        cmd.arg(&core_path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| format!("failed to spawn node: {e}"))?;

        // Take ownership of stdin for writing requests
        let stdin = child.stdin.take().ok_or("failed to capture child stdin")?;
        let stdout = child.stdout.take().ok_or("failed to capture child stdout")?;
        let stderr = child.stderr.take().ok_or("failed to capture child stderr")?;

        // Store stdin writer for sending requests
        *self.stdin_writer.lock().await = Some(stdin);

        // Spawn stdout reader — parse JSON-RPC messages and broadcast events
        let event_bus = self.event_bus.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(msg) = JsonRpcMessage::from_line(&line) {
                    if msg.is_notification() {
                        if let Some(method) = &msg.method {
                            let params = msg.params.unwrap_or(serde_json::Value::Null);
                            let event =
                                DaemonEvent::from_jsonrpc_notification(method, params);
                            event_bus.publish(event);
                        }
                    } else if msg.is_response() {
                        debug!(id = ?msg.id, "received response from core");
                        // TODO: match responses to pending requests
                    }
                }
            }

            warn!("core process stdout closed");
        });

        // Spawn stderr reader — log output
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    warn!(target: "core::stderr", "{}", line);
                }
            }
        });

        // Store child handle
        *self.child.lock().await = Some(child);

        // Publish a daemon event
        self.event_bus.publish(DaemonEvent::new(
            "daemon:core_started",
            serde_json::json!({ "core_path": core_path }),
        ));

        info!("core process started");
        Ok(())
    }

    /// Send a JSON-RPC request to the core process.
    pub async fn send_request(&self, request: JsonRpcRequest) -> Result<(), String> {
        let mut guard = self.stdin_writer.lock().await;
        let stdin = guard.as_mut().ok_or("core process not running")?;

        let line = request.to_line();
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("failed to write to core stdin: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("failed to flush core stdin: {e}"))?;

        Ok(())
    }

    /// Check if the core process is running.
    pub async fn is_running(&self) -> bool {
        let mut guard = self.child.lock().await;
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => true,  // Still running
                Ok(Some(_)) => false, // Exited
                Err(_) => false,
            }
        } else {
            false
        }
    }

    /// Stop the core process gracefully.
    pub async fn stop(&self) -> Result<(), String> {
        // Drop stdin to signal EOF
        *self.stdin_writer.lock().await = None;

        let mut guard = self.child.lock().await;
        if let Some(mut child) = guard.take() {
            info!("stopping core process");

            // Give it a moment to exit gracefully, then kill
            tokio::select! {
                result = child.wait() => {
                    match result {
                        Ok(status) => info!("core process exited: {status}"),
                        Err(e) => error!("error waiting for core process: {e}"),
                    }
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {
                    warn!("core process did not exit in time, killing");
                    let _ = child.kill().await;
                }
            }

            self.event_bus.publish(DaemonEvent::new(
                "daemon:core_stopped",
                serde_json::json!({}),
            ));
        }

        Ok(())
    }

    /// Spawn a supervisor task that restarts the core process on crash.
    pub fn spawn_supervisor(self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut restart_count: u32 = 0;

            loop {
                // Wait for the process to exit
                let exited = {
                    let mut guard = self.child.lock().await;
                    if let Some(child) = guard.as_mut() {
                        match child.wait().await {
                            Ok(status) => {
                                warn!("core process exited: {status}");
                                true
                            }
                            Err(e) => {
                                error!("error waiting for core process: {e}");
                                true
                            }
                        }
                    } else {
                        // No child — wait and check again
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        false
                    }
                };

                if !exited {
                    continue;
                }

                // Clean up
                *self.child.lock().await = None;
                *self.stdin_writer.lock().await = None;

                restart_count += 1;
                if restart_count > config::MAX_RESTART_ATTEMPTS {
                    error!(
                        "core process has crashed {} times, giving up",
                        restart_count
                    );
                    self.event_bus.publish(DaemonEvent::new(
                        "daemon:core_restart_failed",
                        serde_json::json!({
                            "restart_count": restart_count,
                            "max_attempts": config::MAX_RESTART_ATTEMPTS,
                        }),
                    ));
                    break;
                }

                // Exponential backoff: 2s, 4s, 8s, ...
                let delay = config::RESTART_DELAY_MS * 2u64.pow(restart_count.min(5) - 1);
                warn!(
                    attempt = restart_count,
                    delay_ms = delay,
                    "restarting core process"
                );

                self.event_bus.publish(DaemonEvent::new(
                    "daemon:core_restarting",
                    serde_json::json!({
                        "attempt": restart_count,
                        "delay_ms": delay,
                    }),
                ));

                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;

                if let Err(e) = self.start().await {
                    error!("failed to restart core process: {e}");
                } else {
                    info!("core process restarted successfully");
                    restart_count = 0; // Reset on successful restart
                }
            }
        })
    }
}
