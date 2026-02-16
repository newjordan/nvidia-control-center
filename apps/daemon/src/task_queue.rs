//! Task queue — manages submitted tasks awaiting execution.
//!
//! Tasks are submitted via the HTTP API and processed sequentially
//! by the core process. The queue supports priority ordering.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

/// A task submitted to the daemon for execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub prompt: String,
    pub priority: u8,
    pub status: TaskStatus,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub session_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

/// Request body for submitting a new task.
#[derive(Debug, Deserialize)]
pub struct SubmitTaskRequest {
    pub prompt: String,
    #[serde(default = "default_priority")]
    pub priority: u8,
}

fn default_priority() -> u8 {
    5
}

/// Thread-safe task queue.
#[derive(Clone)]
pub struct TaskQueue {
    queue: Arc<Mutex<VecDeque<Task>>>,
    completed: Arc<Mutex<Vec<Task>>>,
}

impl TaskQueue {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
            completed: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Submit a new task to the queue.
    pub async fn submit(&self, request: SubmitTaskRequest) -> Task {
        let task = Task {
            id: Uuid::new_v4().to_string(),
            prompt: request.prompt,
            priority: request.priority,
            status: TaskStatus::Queued,
            created_at: chrono::Utc::now().timestamp_millis(),
            started_at: None,
            completed_at: None,
            session_id: None,
            error: None,
        };

        let mut queue = self.queue.lock().await;

        // Insert in priority order (lower number = higher priority)
        let pos = queue
            .iter()
            .position(|t| t.priority > task.priority)
            .unwrap_or(queue.len());
        queue.insert(pos, task.clone());

        task
    }

    /// Pop the next task from the queue for execution.
    pub async fn pop_next(&self) -> Option<Task> {
        let mut queue = self.queue.lock().await;
        queue.pop_front()
    }

    /// Mark a task as running.
    pub async fn mark_running(&self, task_id: &str, session_id: &str) {
        let mut queue = self.queue.lock().await;
        if let Some(task) = queue.iter_mut().find(|t| t.id == task_id) {
            task.status = TaskStatus::Running;
            task.started_at = Some(chrono::Utc::now().timestamp_millis());
            task.session_id = Some(session_id.to_string());
        }
    }

    /// Mark a task as completed and move to history.
    pub async fn mark_completed(&self, task_id: &str) {
        let mut queue = self.queue.lock().await;
        if let Some(pos) = queue.iter().position(|t| t.id == task_id) {
            let mut task = queue.remove(pos).unwrap();
            task.status = TaskStatus::Completed;
            task.completed_at = Some(chrono::Utc::now().timestamp_millis());
            self.completed.lock().await.push(task);
        }
    }

    /// Mark a task as failed and move to history.
    pub async fn mark_failed(&self, task_id: &str, error: String) {
        let mut queue = self.queue.lock().await;
        if let Some(pos) = queue.iter().position(|t| t.id == task_id) {
            let mut task = queue.remove(pos).unwrap();
            task.status = TaskStatus::Failed;
            task.completed_at = Some(chrono::Utc::now().timestamp_millis());
            task.error = Some(error);
            self.completed.lock().await.push(task);
        }
    }

    /// Cancel a queued task.
    pub async fn cancel(&self, task_id: &str) -> bool {
        let mut queue = self.queue.lock().await;
        if let Some(pos) = queue.iter().position(|t| t.id == task_id) {
            if queue[pos].status == TaskStatus::Queued {
                let mut task = queue.remove(pos).unwrap();
                task.status = TaskStatus::Cancelled;
                task.completed_at = Some(chrono::Utc::now().timestamp_millis());
                self.completed.lock().await.push(task);
                return true;
            }
        }
        false
    }

    /// Get all queued tasks.
    pub async fn list_queued(&self) -> Vec<Task> {
        self.queue.lock().await.iter().cloned().collect()
    }

    /// Get recent completed/failed tasks.
    pub async fn list_recent(&self, limit: usize) -> Vec<Task> {
        let completed = self.completed.lock().await;
        completed.iter().rev().take(limit).cloned().collect()
    }

    /// Get queue length.
    pub async fn len(&self) -> usize {
        self.queue.lock().await.len()
    }
}
