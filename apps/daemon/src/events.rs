//! Event bus — broadcast events from the core process to all WebSocket subscribers.
//!
//! Uses tokio::sync::broadcast for fan-out to multiple WebSocket clients.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::debug;

/// Maximum number of events buffered in the broadcast channel.
const EVENT_BUFFER_SIZE: usize = 256;

/// A daemon event that gets broadcast to all WebSocket subscribers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonEvent {
    /// Event type identifier (e.g., "agent:progress", "task_queued")
    #[serde(rename = "type")]
    pub event_type: String,

    /// Event payload (arbitrary JSON)
    pub data: serde_json::Value,

    /// Unix timestamp in milliseconds
    pub ts: i64,
}

impl DaemonEvent {
    pub fn new(event_type: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            event_type: event_type.into(),
            data,
            ts: chrono::Utc::now().timestamp_millis(),
        }
    }

    /// Create a heartbeat event.
    pub fn heartbeat(uptime_secs: u64, tasks_completed: u64) -> Self {
        Self::new(
            "heartbeat",
            serde_json::json!({
                "uptime_s": uptime_secs,
                "tasks_completed": tasks_completed,
            }),
        )
    }

    /// Create an event from a JSON-RPC notification received from the core process.
    pub fn from_jsonrpc_notification(method: &str, params: serde_json::Value) -> Self {
        Self::new(method, params)
    }
}

/// Broadcast event bus.
///
/// Cheap to clone — all clones share the same underlying channel.
#[derive(Clone)]
pub struct EventBus {
    sender: Arc<broadcast::Sender<DaemonEvent>>,
}

impl EventBus {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(EVENT_BUFFER_SIZE);
        Self {
            sender: Arc::new(sender),
        }
    }

    /// Publish an event to all subscribers.
    pub fn publish(&self, event: DaemonEvent) {
        let subscriber_count = self.sender.receiver_count();
        debug!(
            event_type = %event.event_type,
            subscribers = subscriber_count,
            "publishing event"
        );
        // Ignore the error if there are no active receivers
        let _ = self.sender.send(event);
    }

    /// Subscribe to the event stream. Returns a receiver.
    pub fn subscribe(&self) -> broadcast::Receiver<DaemonEvent> {
        self.sender.subscribe()
    }
}
