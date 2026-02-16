/**
 * @speakmcp/core — Headless agent core
 *
 * This package contains the transport-agnostic agent infrastructure
 * that can run inside Electron, as a standalone Node process managed
 * by the Rust daemon, or in any other host environment.
 */

// Event bus — the central nervous system
export {
  coreEventBus,
  type CoreEventMap,
  type CoreEventName,
  type CoreEventListener,
} from "./event-bus"

// Agent session tracking
export {
  agentSessionTracker,
  type AgentSession,
} from "./agent-session-tracker"

// Agent progress emission
export {
  emitAgentProgress,
  setShouldStopSession,
} from "./emit-agent-progress"

// Message queue
export { messageQueueService } from "./message-queue-service"

// JSON-RPC stdio transport (for Rust daemon communication)
export { startJsonRpcTransport, onRequest } from "./jsonrpc"

// Core agent types
export type {
  AgentProgressUpdate,
  AgentProgressStep,
  AgentStepSummary,
  ACPDelegationProgress,
  ACPDelegationState,
  ACPSubAgentMessage,
  SessionProfileSnapshot,
  ProfileMcpServerConfig,
  ProfileModelConfig,
  ProfileSkillsConfig,
} from "./types"
