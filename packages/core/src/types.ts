/**
 * Core agent types
 *
 * These types define the core agent data model. They were originally in
 * apps/desktop/src/shared/types.ts and are now the canonical source.
 * The desktop app should import these from @speakmcp/core.
 */

// ---------------------------------------------------------------------------
// Shared types (mirrored from @speakmcp/shared for build independence)
// At runtime with pnpm workspace these resolve to the same package.
// ---------------------------------------------------------------------------

export interface ToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface ToolResult {
  success: boolean
  content: string
  error?: string
}

export interface QueuedMessage {
  id: string
  conversationId: string
  text: string
  createdAt: number
  status: "pending" | "processing" | "cancelled" | "failed"
  errorMessage?: string
  addedToHistory?: boolean
}

export interface MessageQueue {
  conversationId: string
  messages: QueuedMessage[]
}

// ---------------------------------------------------------------------------
// ACP (Agent Communication Protocol) types
// ---------------------------------------------------------------------------

export interface ACPSubAgentMessage {
  role: "user" | "assistant" | "tool"
  content: string
  toolName?: string
  toolInput?: unknown
  timestamp: number
}

export interface ACPDelegationProgress {
  runId: string
  agentName: string
  task: string
  status:
    | "pending"
    | "spawning"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
  progressMessage?: string
  startTime: number
  endTime?: number
  resultSummary?: string
  error?: string
  conversation?: ACPSubAgentMessage[]
}

export interface ACPDelegationState {
  parentSessionId: string
  delegations: ACPDelegationProgress[]
  activeCount: number
}

// ---------------------------------------------------------------------------
// Agent progress types
// ---------------------------------------------------------------------------

export interface AgentProgressStep {
  id: string
  type:
    | "thinking"
    | "tool_call"
    | "tool_result"
    | "completion"
    | "tool_approval"
  title: string
  description?: string
  status:
    | "pending"
    | "in_progress"
    | "completed"
    | "error"
    | "awaiting_approval"
  timestamp: number
  llmContent?: string
  toolCall?: ToolCall
  toolResult?: ToolResult
  approvalRequest?: {
    approvalId: string
    toolName: string
    arguments: any
  }
  delegation?: ACPDelegationProgress
  executionStats?: {
    durationMs?: number
    totalTokens?: number
    toolUseCount?: number
    inputTokens?: number
    outputTokens?: number
    cacheHitTokens?: number
  }
  subagentId?: string
}

export interface AgentProgressUpdate {
  sessionId: string
  conversationId?: string
  conversationTitle?: string
  currentIteration: number
  maxIterations: number
  steps: AgentProgressStep[]
  isComplete: boolean
  isSnoozed?: boolean
  finalContent?: string
  conversationHistory?: Array<{
    role: "user" | "assistant" | "tool"
    content: string
    toolCalls?: ToolCall[]
    toolResults?: ToolResult[]
    timestamp?: number
  }>
  sessionStartIndex?: number
  pendingToolApproval?: {
    approvalId: string
    toolName: string
    arguments: any
  }
  retryInfo?: {
    isRetrying: boolean
    attempt: number
    maxAttempts?: number
    delaySeconds: number
    reason: string
    startedAt: number
  }
  streamingContent?: {
    text: string
    isStreaming: boolean
  }
  contextInfo?: {
    estTokens: number
    maxTokens: number
  }
  modelInfo?: {
    provider: string
    model: string
  }
  profileName?: string
  acpSessionInfo?: {
    agentName?: string
    agentTitle?: string
    agentVersion?: string
    currentModel?: string
    currentMode?: string
    availableModels?: Array<{
      id: string
      name: string
      description?: string
    }>
    availableModes?: Array<{
      id: string
      name: string
      description?: string
    }>
  }
  stepSummaries?: AgentStepSummary[]
  latestSummary?: AgentStepSummary
}

export interface AgentStepSummary {
  id: string
  sessionId: string
  stepNumber: number
  timestamp: number
  actionSummary: string
  importance: "low" | "medium" | "high" | "critical"
  savedToMemory?: boolean
  userNotes?: string
  tags?: string[]
  keyFindings?: string[]
  nextSteps?: string
  decisionsMade?: string[]
}

// ---------------------------------------------------------------------------
// Profile types
// ---------------------------------------------------------------------------

export type ProfileMcpServerConfig = {
  disabledServers?: string[]
  disabledTools?: string[]
  allServersDisabledByDefault?: boolean
  enabledServers?: string[]
  enabledBuiltinTools?: string[]
}

export type ProfileModelConfig = {
  mcpToolsProviderId?: "openai" | "groq" | "gemini"
  mcpToolsOpenaiModel?: string
  mcpToolsGroqModel?: string
  mcpToolsGeminiModel?: string
  currentModelPresetId?: string
  sttProviderId?: "openai" | "groq" | "parakeet"
  transcriptPostProcessingProviderId?: "openai" | "groq" | "gemini"
  transcriptPostProcessingOpenaiModel?: string
  transcriptPostProcessingGroqModel?: string
  transcriptPostProcessingGeminiModel?: string
  ttsProviderId?: "openai" | "groq" | "gemini" | "kitten"
}

export type ProfileSkillsConfig = {
  enabledSkillIds?: string[]
  allSkillsDisabledByDefault?: boolean
}

export type SessionProfileSnapshot = {
  profileId: string
  profileName: string
  guidelines: string
  systemPrompt?: string
  mcpServerConfig?: ProfileMcpServerConfig
  modelConfig?: ProfileModelConfig
  skillsInstructions?: string
  personaProperties?: Record<string, string>
  skillsConfig?: ProfileSkillsConfig
}
