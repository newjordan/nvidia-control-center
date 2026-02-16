//! Task processor — polls the task queue and sends work to the core process.
//!
//! Runs as a background task, pulling queued tasks and dispatching them
//! to the Node.js core via JSON-RPC over stdin.

use crate::events::{DaemonEvent, EventBus};
use crate::jsonrpc::JsonRpcRequest;
use crate::process_manager::ProcessManager;
use crate::task_queue::TaskQueue;
use serde_json::json;
use tokio::task::JoinHandle;
use tracing::{info, warn};

/// Poll interval for checking the task queue (ms).
const POLL_INTERVAL_MS: u64 = 1000;

/// Spawn the task processor loop.
///
/// Continuously polls the task queue. When a task is available and the
/// core process is running, it sends a `task.submit` JSON-RPC request
/// and marks the task as running.
pub fn spawn(
    task_queue: TaskQueue,
    process_mgr: ProcessManager,
    event_bus: EventBus,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval =
            tokio::time::interval(std::time::Duration::from_millis(POLL_INTERVAL_MS));

        loop {
            interval.tick().await;

            // Only process if core is running
            if !process_mgr.is_running().await {
                continue;
            }

            // Check for the next queued task
            let task = match task_queue.pop_next().await {
                Some(t) => t,
                None => continue,
            };

            info!(task_id = %task.id, prompt = %task.prompt, "processing task");

            // Mark as running
            task_queue
                .mark_running(&task.id, &format!("daemon_{}", task.id))
                .await;

            event_bus.publish(DaemonEvent::new(
                "task_started",
                json!({
                    "task_id": task.id,
                    "prompt": task.prompt,
                }),
            ));

            // Send to core via JSON-RPC
            let request = JsonRpcRequest::new(
                "task.submit",
                Some(json!({
                    "task_id": task.id,
                    "prompt": task.prompt,
                })),
            );

            match process_mgr.send_request(request).await {
                Ok(()) => {
                    info!(task_id = %task.id, "task submitted to core");
                    // The task will be marked completed when we receive
                    // a completion event from the core process.
                    // For now, mark it completed optimistically.
                    task_queue.mark_completed(&task.id).await;

                    event_bus.publish(DaemonEvent::new(
                        "task_complete",
                        json!({
                            "task_id": task.id,
                            "result": "submitted",
                        }),
                    ));
                }
                Err(e) => {
                    warn!(task_id = %task.id, error = %e, "failed to submit task to core");
                    task_queue
                        .mark_failed(&task.id, format!("Failed to send to core: {e}"))
                        .await;

                    event_bus.publish(DaemonEvent::new(
                        "task_failed",
                        json!({
                            "task_id": task.id,
                            "error": e,
                        }),
                    ));
                }
            }
        }
    })
}
