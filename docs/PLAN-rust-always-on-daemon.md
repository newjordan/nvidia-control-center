# Plan: Rust Always-On Daemon for SpeakMCP

## Overview

Extract SpeakMCP's core agent loop out from behind the Electron shell and run it as an always-on service, orchestrated by a lightweight Rust daemon. LiveDesktop subscribes to the daemon's event stream for real-time monitoring visuals.

## Architecture

```
┌──────────────────────────────────────────────────┐
│              Rust Daemon (always-on)              │
│                                                  │
│  ┌──────────┐  ┌────────┐  ┌──────────────────┐ │
│  │ HTTP/WS  │  │  Cron  │  │  File Watcher    │ │
│  │ Listener │  │Scheduler│  │  (notify crate)  │ │
│  └────┬─────┘  └───┬────┘  └───────┬──────────┘ │
│       └─────────┬───┴──────────────┘             │
│           ┌─────▼──────┐                         │
│           │ Task Queue │                         │
│           └─────┬──────┘                         │
│           ┌─────▼──────┐                         │
│           │Process Mgr │                         │
│           └─────┬──────┘                         │
│           ┌─────▼──────────────────────┐         │
│           │  Event Bus                 │         │
│           │  (tokio broadcast channel) │         │
│           └──┬────────────┬────────────┘         │
│         ┌────▼───┐  ┌─────▼────────┐            │
│         │  WS    │  │ Unix Socket  │            │
│         │/events │  │/tmp/speak.sock│           │
│         └────────┘  └──────────────┘            │
└──────────────┬───────────────────────────────────┘
               │ stdio / JSON-RPC (ACP-compatible)
      ┌────────▼────────┐
      │  SpeakMCP Core  │
      │  (Node.js)      │
      │  llm.ts + MCP   │
      └─────────────────┘
```

### Consumers

```
Rust Daemon ──WebSocket──► LiveDesktop (Electron, real-time visuals)
Rust Daemon ──WebSocket──► CLI monitor (optional, terminal dashboard)
Rust Daemon ──Unix Sock──► Other local agents / OpenClaw
```

## Components

### 1. Rust Daemon (`speakmcp-daemon`)

**Role:** Orchestration, scheduling, process supervision, event aggregation.

**Key crates:**
- `tokio` — async runtime
- `axum` — HTTP/WebSocket server
- `serde` / `serde_json` — JSON-RPC message serialization
- `tokio-cron-scheduler` — scheduled task execution
- `tracing` + `tracing-subscriber` — structured logging
- `notify` — filesystem watching for file-drop triggers

**Responsibilities:**
- Listen for inbound triggers (HTTP API, WebSocket, file drops, cron)
- Manage a prioritized task queue
- Spawn SpeakMCP Node.js agent as child process
- Communicate with agent over stdio using JSON-RPC (ACP-compatible)
- Aggregate events from agent into a broadcast channel
- Expose WebSocket `/api/events` endpoint for subscribers
- Expose Unix socket for local IPC with other agents
- Health checks, graceful shutdown, automatic restart on crash
- Resource limits (max concurrent agents, token budgets)

**Target:** ~2MB static binary, zero runtime dependencies.

### 2. SpeakMCP Core (Node.js, extracted)

**Role:** Agent intelligence — LLM calls, MCP tool execution, ACP delegation.

**What gets extracted from Electron:**
- `llm.ts` — agent loop, tool execution coordination
- `llm-fetch.ts` — LLM API calls
- `mcp-service.ts` — MCP client, tool discovery, OAuth
- `config.ts` — persistent config

**What gets removed/replaced:**
- All `@egoist/tipc` IPC handlers → replaced with stdio JSON-RPC
- `BrowserWindow` progress callbacks → replaced with JSON-RPC event emissions
- Electron-specific APIs (`app`, `shell`, `dialog`) → removed or shimmed

**Output:** A headless `@speakmcp/core` package that can be run via `node` or `tsx`.

### 3. LiveDesktop Integration

**Role:** Pure visualization layer consuming the Rust daemon's event stream.

**Connection:** WebSocket to `ws://localhost:{PORT}/api/events`

**Event types from daemon:**

```jsonc
// Agent lifecycle
{"type": "agent_spawned", "id": "abc123", "task": "review PR #42", "ts": 1739...}
{"type": "agent_idle", "id": "abc123", "ts": 1739...}
{"type": "agent_exited", "id": "abc123", "code": 0, "ts": 1739...}

// Task flow
{"type": "task_queued", "task": "...", "priority": 1, "ts": 1739...}
{"type": "task_started", "task": "...", "agent_id": "abc123", "ts": 1739...}
{"type": "task_complete", "result": "success", "duration_ms": 34200, "ts": 1739...}

// Tool execution
{"type": "tool_call", "tool": "github_search", "server": "github-mcp", "status": "executing", "ts": 1739...}
{"type": "tool_result", "tool": "github_search", "status": "ok", "duration_ms": 230, "ts": 1739...}

// LLM activity
{"type": "llm_request", "model": "claude-sonnet-4-5-20250929", "tokens_in": 4200, "ts": 1739...}
{"type": "llm_response", "tokens_out": 1847, "duration_ms": 2100, "ts": 1739...}

// System health
{"type": "heartbeat", "uptime_s": 86400, "tasks_completed": 47, "ts": 1739...}
{"type": "resource_warning", "metric": "token_budget", "usage": 0.85, "ts": 1739...}
```

**LiveDesktop visualization ideas:**
- Agent pulse — live heartbeat indicator, active/idle/spawning states
- Task waterfall — visual timeline of tasks flowing through the queue
- Tool call activity — which MCP tools are firing, latency sparklines
- Token burn rate — real-time token consumption graph
- Status ribbon — minimal desktop overlay showing system health

## Implementation Phases

### Phase 1: Extract `@speakmcp/core` package
- Create `packages/core/` in the monorepo
- Move `llm.ts`, `llm-fetch.ts`, `mcp-service.ts`, `config.ts`
- Replace tipc/Electron IPC with a stdio JSON-RPC interface
- Desktop app imports from `@speakmcp/core` (no duplication)
- Verify existing tests pass against extracted package

### Phase 2: Build `speakmcp-daemon` in Rust
- Scaffold Rust project in `apps/daemon/` (or separate repo)
- Implement process manager — spawn Node core, restart on crash
- Implement event bus — parse JSON-RPC events from child, broadcast
- Implement WebSocket server — `/api/events` endpoint
- Implement HTTP API — `POST /api/tasks` to submit work
- Basic cron scheduler

### Phase 3: LiveDesktop integration
- Add WebSocket client to LiveDesktop connecting to daemon
- Build visualization widgets for event stream
- Desktop overlay / widget mode for always-visible monitoring

### Phase 4: Advanced features
- Task queue persistence (survive daemon restarts)
- Multi-agent support (multiple Node processes)
- Token budget enforcement in Rust layer
- Unix socket for local agent-to-agent communication
- OpenClaw integration via the event bus

## Why Rust for the Daemon

| Concern | Rust | Node alternative |
|---|---|---|
| Binary size | ~2MB static | ~80MB with node_modules |
| Memory at idle | ~3MB RSS | ~40MB RSS |
| Startup time | <10ms | ~500ms |
| Process supervision | Native, zero-cost | Needs pm2 or similar |
| Crash recovery | No GC pauses, predictable | Event loop can stall |
| Dependencies | Single binary, ship anywhere | Needs Node runtime installed |

The daemon's job is to be boring and reliable. Rust is perfect for boring and reliable.

## File Structure (Proposed)

```
nvidia-control-center/
├── apps/
│   ├── daemon/              # NEW — Rust always-on daemon
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs
│   │       ├── server.rs    # axum HTTP/WS server
│   │       ├── process.rs   # child process management
│   │       ├── queue.rs     # task queue
│   │       ├── scheduler.rs # cron scheduling
│   │       └── events.rs    # event bus + broadcast
│   ├── desktop/             # Existing Electron app
│   └── mobile/              # Existing mobile app
├── packages/
│   ├── core/                # NEW — extracted agent core
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts     # stdio JSON-RPC entry point
│   │       ├── llm.ts       # (moved from desktop)
│   │       ├── llm-fetch.ts
│   │       ├── mcp-service.ts
│   │       └── config.ts
│   ├── shared/              # Existing shared types
│   └── mcp-whatsapp/        # Existing MCP server
```
