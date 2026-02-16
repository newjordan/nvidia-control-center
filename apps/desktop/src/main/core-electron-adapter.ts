/**
 * Core ↔ Electron Adapter
 *
 * Bridges @speakmcp/core's EventBus to Electron's tipc renderer handlers.
 * This is the glue that lets the extracted core package drive the Electron UI.
 *
 * Call `initCoreElectronBridge()` once during app startup (after windows are created).
 */

import { getRendererHandlers } from "@egoist/tipc/main"
import { coreEventBus } from "@speakmcp/core"
import { setShouldStopSession } from "@speakmcp/core"
import type { RendererHandlers } from "./renderer-handlers"
import { WINDOWS, showPanelWindow, resizePanelForAgentMode } from "./window"
import { isPanelAutoShowSuppressed, agentSessionStateManager } from "./state"
import { agentSessionTracker } from "@speakmcp/core"
import { configStore } from "./config"

/**
 * Send an event to a BrowserWindow's renderer via tipc.
 * Silently ignores errors (window may be closed, not ready, etc.)
 */
function sendToWindow(
  windowKey: string,
  fn: (handlers: ReturnType<typeof getRendererHandlers<RendererHandlers>>) => void,
): void {
  const win = WINDOWS.get(windowKey)
  if (!win) return
  try {
    const handlers = getRendererHandlers<RendererHandlers>(win.webContents)
    // Delay slightly to avoid IPC flooding during rapid updates
    setTimeout(() => {
      try {
        fn(handlers)
      } catch {
        // Silently ignore send failures
      }
    }, 10)
  } catch {
    // Silently ignore handler failures
  }
}

/**
 * Initialize the bridge between @speakmcp/core EventBus and Electron renderer.
 * Returns a cleanup function to remove all listeners.
 */
export function initCoreElectronBridge(): () => void {
  const unsubscribes: (() => void)[] = []

  // Wire session-stop checking into the core
  setShouldStopSession((sessionId) =>
    agentSessionStateManager.shouldStopSession(sessionId),
  )

  // agent:progress → renderer agentProgressUpdate + panel auto-show logic
  unsubscribes.push(
    coreEventBus.on("agent:progress", (update) => {
      // Send to main window if visible
      const main = WINDOWS.get("main")
      if (main && main.isVisible()) {
        sendToWindow("main", (h) => h.agentProgressUpdate.send(update))
      }

      // Panel window: auto-show logic + send update
      const panel = WINDOWS.get("panel")
      if (!panel) return

      const config = configStore.get()
      const floatingPanelAutoShowEnabled = config.floatingPanelAutoShow !== false
      const hidePanelWhenMainFocused = config.hidePanelWhenMainFocused !== false
      const isMainFocused = main?.isFocused() ?? false

      if (!panel.isVisible() && update.sessionId) {
        const isSnoozed = agentSessionTracker.isSessionSnoozed(update.sessionId)
        if (
          floatingPanelAutoShowEnabled &&
          !isPanelAutoShowSuppressed() &&
          !isSnoozed &&
          !(hidePanelWhenMainFocused && isMainFocused)
        ) {
          resizePanelForAgentMode()
          showPanelWindow()
        }
      }

      sendToWindow("panel", (h) => h.agentProgressUpdate.send(update))
    }),
  )

  // agent:sessions-updated → renderer agentSessionsUpdated
  unsubscribes.push(
    coreEventBus.on("agent:sessions-updated", (data) => {
      sendToWindow("main", (h) => h.agentSessionsUpdated?.send(data))
      sendToWindow("panel", (h) => h.agentSessionsUpdated?.send(data))
    }),
  )

  // queue:updated → renderer onMessageQueueUpdate
  unsubscribes.push(
    coreEventBus.on("queue:updated", (data) => {
      sendToWindow("main", (h) => h.onMessageQueueUpdate?.send(data))
      sendToWindow("panel", (h) => h.onMessageQueueUpdate?.send(data))
    }),
  )

  return () => {
    for (const unsub of unsubscribes) unsub()
  }
}
