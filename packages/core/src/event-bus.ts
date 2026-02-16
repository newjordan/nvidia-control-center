/**
 * Core Event Bus
 *
 * Replaces direct Electron IPC (getRendererHandlers / tipc) with a
 * transport-agnostic event system. Consumers (Electron renderer, Rust daemon
 * via JSON-RPC, LiveDesktop via WebSocket) subscribe to the same events.
 *
 * Design constraints:
 * - No Electron imports
 * - Synchronous emit (fire-and-forget), async listeners allowed
 * - Typed event map for compile-time safety
 * - Singleton per process
 */

import type { QueuedMessage, AgentProgressUpdate } from "./types"
import type { AgentSession } from "./agent-session-tracker"

// ---------------------------------------------------------------------------
// Event map — every event the core can emit
// ---------------------------------------------------------------------------

export interface CoreEventMap {
  /** Agent progress update (iteration status, tool calls, etc.) */
  "agent:progress": AgentProgressUpdate

  /** Active + recent session list changed */
  "agent:sessions-updated": {
    activeSessions: AgentSession[]
    recentSessions: AgentSession[]
  }

  /** Message queue changed for a conversation */
  "queue:updated": {
    conversationId: string
    queue: QueuedMessage[]
    isPaused: boolean
  }
}

// ---------------------------------------------------------------------------
// Listener types
// ---------------------------------------------------------------------------

export type CoreEventName = keyof CoreEventMap

export type CoreEventListener<E extends CoreEventName> = (
  payload: CoreEventMap[E],
) => void | Promise<void>

// ---------------------------------------------------------------------------
// EventBus implementation
// ---------------------------------------------------------------------------

class CoreEventBus {
  private listeners = new Map<CoreEventName, Set<CoreEventListener<any>>>()

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on<E extends CoreEventName>(
    event: E,
    listener: CoreEventListener<E>,
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(listener)

    return () => {
      this.listeners.get(event)?.delete(listener)
    }
  }

  /**
   * Emit an event. Listeners are called synchronously (but may return promises).
   * Errors in listeners are caught and logged — they never propagate to the emitter.
   */
  emit<E extends CoreEventName>(event: E, payload: CoreEventMap[E]): void {
    const set = this.listeners.get(event)
    if (!set) return

    for (const listener of set) {
      try {
        const result = listener(payload)
        // Swallow async errors
        if (result && typeof (result as Promise<void>).catch === "function") {
          ;(result as Promise<void>).catch((err) => {
            console.error(`[CoreEventBus] async listener error on "${event}":`, err)
          })
        }
      } catch (err) {
        console.error(`[CoreEventBus] listener error on "${event}":`, err)
      }
    }
  }

  /**
   * Remove all listeners (useful for testing / shutdown).
   */
  removeAllListeners(): void {
    this.listeners.clear()
  }
}

/** Singleton event bus for the process */
export const coreEventBus = new CoreEventBus()
