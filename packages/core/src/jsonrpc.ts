/**
 * JSON-RPC 2.0 stdio interface for the SpeakMCP core.
 *
 * This is the communication layer the Rust daemon uses to talk to
 * the Node.js agent process over stdin/stdout.
 *
 * Protocol:
 * - Daemon → Core: JSON-RPC requests on stdin (one JSON object per line)
 * - Core → Daemon: JSON-RPC responses + notifications on stdout
 * - Events are sent as JSON-RPC notifications (no id field)
 *
 * Example notification (core → daemon):
 *   {"jsonrpc":"2.0","method":"agent:progress","params":{...}}
 *
 * Example request (daemon → core):
 *   {"jsonrpc":"2.0","id":1,"method":"task.submit","params":{"prompt":"..."}}
 *
 * Example response (core → daemon):
 *   {"jsonrpc":"2.0","id":1,"result":{"sessionId":"session_123..."}}
 */

import { coreEventBus, type CoreEventName, type CoreEventMap } from "./event-bus"

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type JsonRpcMessage = JsonRpcNotification | JsonRpcRequest

// ---------------------------------------------------------------------------
// Request handler registry
// ---------------------------------------------------------------------------

type RequestHandler = (params: unknown) => Promise<unknown>

const requestHandlers = new Map<string, RequestHandler>()

/**
 * Register a handler for incoming JSON-RPC requests from the daemon.
 */
export function onRequest(method: string, handler: RequestHandler): void {
  requestHandlers.set(method, handler)
}

// ---------------------------------------------------------------------------
// Output — write JSON-RPC messages to stdout
// ---------------------------------------------------------------------------

function writeMessage(msg: JsonRpcNotification | JsonRpcResponse): void {
  const line = JSON.stringify(msg)
  process.stdout.write(line + "\n")
}

/**
 * Send a JSON-RPC notification (no response expected).
 */
function sendNotification(method: string, params: unknown): void {
  writeMessage({ jsonrpc: "2.0", method, params })
}

function sendResponse(id: number | string, result: unknown): void {
  writeMessage({ jsonrpc: "2.0", id, result })
}

function sendError(
  id: number | string,
  code: number,
  message: string,
  data?: unknown,
): void {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message, data } })
}

// ---------------------------------------------------------------------------
// Input — read JSON-RPC messages from stdin
// ---------------------------------------------------------------------------

function handleMessage(msg: JsonRpcMessage): void {
  if ("id" in msg && msg.id !== undefined) {
    // It's a request
    const handler = requestHandlers.get(msg.method)
    if (!handler) {
      sendError(msg.id, -32601, `Method not found: ${msg.method}`)
      return
    }
    handler(msg.params)
      .then((result) => sendResponse(msg.id as number | string, result))
      .catch((err) =>
        sendError(
          msg.id as number | string,
          -32000,
          err instanceof Error ? err.message : String(err),
        ),
      )
  }
  // Notifications from daemon (no id) can be handled here if needed
}

// ---------------------------------------------------------------------------
// Bridge: CoreEventBus → JSON-RPC notifications on stdout
// ---------------------------------------------------------------------------

const BRIDGED_EVENTS: CoreEventName[] = [
  "agent:progress",
  "agent:sessions-updated",
  "queue:updated",
]

function bridgeEvents(): (() => void)[] {
  return BRIDGED_EVENTS.map((eventName) =>
    coreEventBus.on(eventName, (payload: CoreEventMap[typeof eventName]) => {
      sendNotification(eventName, payload)
    }),
  )
}

// ---------------------------------------------------------------------------
// Public API: start the stdio transport
// ---------------------------------------------------------------------------

/**
 * Start the JSON-RPC stdio transport.
 *
 * - Subscribes to CoreEventBus and forwards events as notifications
 * - Reads requests from stdin and dispatches to registered handlers
 * - Returns a cleanup function
 */
export function startJsonRpcTransport(): () => void {
  const unsubscribes = bridgeEvents()

  let buffer = ""

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const msg = JSON.parse(trimmed) as JsonRpcMessage
        if (msg.jsonrpc !== "2.0") continue
        handleMessage(msg)
      } catch {
        // Skip malformed lines
      }
    }
  }

  process.stdin.setEncoding("utf8")
  process.stdin.on("data", onData)
  process.stdin.resume()

  // Send a ready notification so the daemon knows the process is up
  sendNotification("core.ready", { pid: process.pid, ts: Date.now() })

  return () => {
    process.stdin.off("data", onData)
    for (const unsub of unsubscribes) unsub()
  }
}
