/**
 * Message Queue Service — re-exported from @speakmcp/core
 *
 * The implementation now lives in packages/core/.
 * This file preserves the import path so all existing consumers
 * in the desktop app continue to work unchanged.
 *
 * The Electron-specific renderer notification is handled by
 * core-electron-adapter.ts which subscribes to the core EventBus.
 */
export { messageQueueService } from "@speakmcp/core"
