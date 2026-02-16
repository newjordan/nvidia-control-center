//! HTTP + WebSocket server.
//!
//! Endpoints:
//! - `GET  /api/health`           — health check
//! - `GET  /api/status`           — daemon status (uptime, queue, core state)
//! - `POST /api/tasks`            — submit a task
//! - `GET  /api/tasks`            — list queued tasks
//! - `GET  /api/tasks/recent`     — recent completed tasks
//! - `DELETE /api/tasks/:id`      — cancel a queued task
//! - `GET  /api/events`           — WebSocket event stream

use crate::events::{DaemonEvent, EventBus};
use crate::process_manager::ProcessManager;
use crate::task_queue::{SubmitTaskRequest, TaskQueue};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::json;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tracing::{info, warn};

/// Shared application state.
#[derive(Clone)]
struct AppState {
    event_bus: EventBus,
    task_queue: TaskQueue,
    process_mgr: ProcessManager,
    start_time: Instant,
}

/// Start the HTTP/WebSocket server.
pub async fn run(
    port: u16,
    event_bus: EventBus,
    task_queue: TaskQueue,
    process_mgr: ProcessManager,
) {
    let state = AppState {
        event_bus,
        task_queue,
        process_mgr,
        start_time: Instant::now(),
    };

    let app = Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/status", get(status_handler))
        .route("/api/tasks", post(submit_task_handler))
        .route("/api/tasks", get(list_tasks_handler))
        .route("/api/tasks/recent", get(recent_tasks_handler))
        .route("/api/tasks/{id}", delete(cancel_task_handler))
        .route("/api/events", get(ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(Arc::new(state));

    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}"))
        .await
        .expect("failed to bind to port");

    info!("listening on http://127.0.0.1:{port}");

    axum::serve(listener, app)
        .await
        .expect("server error");
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn health_handler() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

async fn status_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let uptime = state.start_time.elapsed().as_secs();
    let core_running = state.process_mgr.is_running().await;
    let queue_len = state.task_queue.len().await;

    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_secs": uptime,
        "core_running": core_running,
        "queued_tasks": queue_len,
    }))
}

async fn submit_task_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SubmitTaskRequest>,
) -> impl IntoResponse {
    let task = state.task_queue.submit(req).await;

    state.event_bus.publish(DaemonEvent::new(
        "task_queued",
        serde_json::to_value(&task).unwrap_or_default(),
    ));

    (StatusCode::CREATED, Json(task))
}

async fn list_tasks_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let tasks = state.task_queue.list_queued().await;
    Json(json!({ "tasks": tasks }))
}

async fn recent_tasks_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let tasks = state.task_queue.list_recent(20).await;
    Json(json!({ "tasks": tasks }))
}

async fn cancel_task_handler(
    State(state): State<Arc<AppState>>,
    Path(task_id): Path<String>,
) -> impl IntoResponse {
    if state.task_queue.cancel(&task_id).await {
        state.event_bus.publish(DaemonEvent::new(
            "task_cancelled",
            json!({ "task_id": task_id }),
        ));
        Json(json!({ "cancelled": true }))
    } else {
        Json(json!({ "cancelled": false, "reason": "task not found or already running" }))
    }
}

// ---------------------------------------------------------------------------
// WebSocket event stream
// ---------------------------------------------------------------------------

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state.event_bus.clone()))
}

async fn handle_ws(mut socket: WebSocket, event_bus: EventBus) {
    info!("WebSocket client connected");

    let mut rx: broadcast::Receiver<DaemonEvent> = event_bus.subscribe();

    // Send a welcome event
    let welcome = DaemonEvent::new("connected", json!({ "version": env!("CARGO_PKG_VERSION") }));
    let _ = socket
        .send(Message::Text(serde_json::to_string(&welcome).unwrap().into()))
        .await;

    loop {
        tokio::select! {
            // Forward events from the bus to the WebSocket client
            event = rx.recv() => {
                match event {
                    Ok(event) => {
                        let json = match serde_json::to_string(&event) {
                            Ok(j) => j,
                            Err(_) => continue,
                        };
                        if socket.send(Message::Text(json.into())).await.is_err() {
                            break; // Client disconnected
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!("WebSocket client lagged, skipped {n} events");
                    }
                    Err(broadcast::error::RecvError::Closed) => {
                        break;
                    }
                }
            }

            // Handle incoming messages from the client (ping/pong, close)
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(data))) => {
                        let _ = socket.send(Message::Pong(data)).await;
                    }
                    _ => {} // Ignore text/binary from client for now
                }
            }
        }
    }

    info!("WebSocket client disconnected");
}
