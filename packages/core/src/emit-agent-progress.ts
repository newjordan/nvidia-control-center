/**
 * Agent Progress Emitter (Core)
 *
 * Emits agent progress updates through the CoreEventBus.
 * No Electron dependencies — window management is handled by
 * the consumer (Electron adapter, Rust daemon, etc.).
 *
 * Extracted from: apps/desktop/src/main/emit-agent-progress.ts
 */

import type { AgentProgressUpdate } from "./types"
import { coreEventBus } from "./event-bus"

/**
 * Optional hook for session-stop checking.
 * Set this from the host (Electron app, daemon) to wire in session state logic.
 */
export let shouldStopSession: ((sessionId: string) => boolean) | undefined

export function setShouldStopSession(
  fn: (sessionId: string) => boolean,
): void {
  shouldStopSession = fn
}

export function emitAgentProgress(update: AgentProgressUpdate): void {
  // Skip updates for stopped sessions, except final completion updates
  if (update.sessionId && !update.isComplete) {
    if (shouldStopSession?.(update.sessionId)) {
      return
    }
  }

  coreEventBus.emit("agent:progress", update)
}
