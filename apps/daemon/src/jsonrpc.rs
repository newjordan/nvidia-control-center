//! JSON-RPC 2.0 client for communicating with the Node.js core process.
//!
//! The daemon sends requests on the child's stdin and reads
//! responses + notifications from stdout, one JSON object per line.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

/// Auto-incrementing request ID generator.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// A JSON-RPC 2.0 request (daemon → core).
#[derive(Debug, Serialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: &'static str,
    pub id: u64,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl JsonRpcRequest {
    pub fn new(method: impl Into<String>, params: Option<serde_json::Value>) -> Self {
        Self {
            jsonrpc: "2.0",
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            method: method.into(),
            params,
        }
    }

    /// Serialize to a single-line JSON string with trailing newline.
    pub fn to_line(&self) -> String {
        let mut s = serde_json::to_string(self).expect("request serialization should not fail");
        s.push('\n');
        s
    }
}

/// An incoming JSON-RPC message from the core process (core → daemon).
///
/// This can be either:
/// - A response (has `id` + `result` or `error`)
/// - A notification (has `method` + `params`, no `id`)
#[derive(Debug, Deserialize)]
pub struct JsonRpcMessage {
    pub jsonrpc: String,
    pub id: Option<u64>,
    pub method: Option<String>,
    pub params: Option<serde_json::Value>,
    pub result: Option<serde_json::Value>,
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<serde_json::Value>,
}

impl JsonRpcMessage {
    /// Parse a single line of JSON from the core process.
    pub fn from_line(line: &str) -> Option<Self> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }
        serde_json::from_str(trimmed).ok()
    }

    /// Check if this is a notification (no id field).
    pub fn is_notification(&self) -> bool {
        self.id.is_none() && self.method.is_some()
    }

    /// Check if this is a response (has id field).
    pub fn is_response(&self) -> bool {
        self.id.is_some()
    }
}
