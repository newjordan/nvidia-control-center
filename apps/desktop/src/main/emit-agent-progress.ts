/**
 * Agent Progress Emitter — re-exported from @speakmcp/core
 *
 * The implementation now lives in packages/core/.
 * This file preserves the import path so all existing consumers
 * in the desktop app continue to work unchanged.
 *
 * The Electron-specific window management (panel auto-show, etc.)
 * is handled by core-electron-adapter.ts which subscribes to
 * the core EventBus.
 */
export { emitAgentProgress, setShouldStopSession } from "@speakmcp/core"
