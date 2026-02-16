/**
 * Agent Session Tracker (Core)
 *
 * Tracks active agent sessions. Emits updates through the CoreEventBus
 * instead of directly calling Electron renderer handlers.
 *
 * Extracted from: apps/desktop/src/main/agent-session-tracker.ts
 */

import type { SessionProfileSnapshot } from "./types"
import { coreEventBus } from "./event-bus"

export interface AgentSession {
  id: string
  conversationId?: string
  conversationTitle?: string
  status: "active" | "completed" | "error" | "stopped"
  startTime: number
  endTime?: number
  currentIteration?: number
  maxIterations?: number
  lastActivity?: string
  errorMessage?: string
  isSnoozed?: boolean
  profileSnapshot?: SessionProfileSnapshot
}

function emitSessionUpdate(tracker: AgentSessionTracker) {
  coreEventBus.emit("agent:sessions-updated", {
    activeSessions: tracker.getActiveSessions(),
    recentSessions: tracker.getRecentSessions(4),
  })
}

class AgentSessionTracker {
  private static instance: AgentSessionTracker | null = null
  private sessions: Map<string, AgentSession> = new Map()
  private completedSessions: AgentSession[] = []

  static getInstance(): AgentSessionTracker {
    if (!AgentSessionTracker.instance) {
      AgentSessionTracker.instance = new AgentSessionTracker()
    }
    return AgentSessionTracker.instance
  }

  private constructor() {}

  startSession(
    conversationId?: string,
    conversationTitle?: string,
    startSnoozed: boolean = true,
    profileSnapshot?: SessionProfileSnapshot,
  ): string {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

    const session: AgentSession = {
      id: sessionId,
      conversationId,
      conversationTitle: conversationTitle || "Untitled Agent Session",
      status: "active",
      startTime: Date.now(),
      currentIteration: 0,
      maxIterations: 10,
      lastActivity: "Starting agent session...",
      isSnoozed: startSnoozed,
      profileSnapshot,
    }

    this.sessions.set(sessionId, session)
    emitSessionUpdate(this)
    return sessionId
  }

  updateSession(
    sessionId: string,
    updates: Partial<Omit<AgentSession, "id" | "startTime">>,
  ): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      Object.assign(session, updates)
      emitSessionUpdate(this)
    }
  }

  completeSession(sessionId: string, finalActivity?: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.status = "completed"
    session.endTime = Date.now()
    if (finalActivity) session.lastActivity = finalActivity
    this.completedSessions.unshift({ ...session })
    if (this.completedSessions.length > 20) this.completedSessions.length = 20
    this.sessions.delete(sessionId)
    emitSessionUpdate(this)
  }

  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.status = "stopped"
    session.endTime = Date.now()
    this.completedSessions.unshift({ ...session })
    if (this.completedSessions.length > 20) this.completedSessions.length = 20
    this.sessions.delete(sessionId)
    emitSessionUpdate(this)
  }

  errorSession(sessionId: string, errorMessage: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.status = "error"
    session.errorMessage = errorMessage
    session.endTime = Date.now()
    this.completedSessions.unshift({ ...session })
    if (this.completedSessions.length > 20) this.completedSessions.length = 20
    this.sessions.delete(sessionId)
    emitSessionUpdate(this)
  }

  getActiveSessions(): AgentSession[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.startTime - a.startTime,
    )
  }

  getRecentSessions(limit: number = 4): AgentSession[] {
    return this.completedSessions
      .slice(0, limit)
      .sort((a, b) => (b.endTime || 0) - (a.endTime || 0))
  }

  snoozeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.isSnoozed = true
      emitSessionUpdate(this)
    }
  }

  unsnoozeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.isSnoozed = false
      emitSessionUpdate(this)
    }
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId)
  }

  isSessionSnoozed(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.isSnoozed ?? false
  }

  getSessionProfileSnapshot(
    sessionId: string,
  ): SessionProfileSnapshot | undefined {
    return this.sessions.get(sessionId)?.profileSnapshot
  }

  findSessionByConversationId(conversationId: string): string | undefined {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.conversationId === conversationId) return sessionId
    }
    for (const session of this.completedSessions) {
      if (session.conversationId === conversationId) return session.id
    }
    return undefined
  }

  reviveSession(sessionId: string, startSnoozed: boolean = false): boolean {
    const completedIndex = this.completedSessions.findIndex(
      (s) => s.id === sessionId,
    )
    if (completedIndex === -1) {
      if (this.sessions.has(sessionId)) return true
      return false
    }
    const [session] = this.completedSessions.splice(completedIndex, 1)
    session.status = "active"
    session.isSnoozed = startSnoozed
    delete session.endTime
    this.sessions.set(sessionId, session)
    emitSessionUpdate(this)
    return true
  }

  clearAllSessions(): void {
    this.sessions.clear()
  }

  clearCompletedSessions(): void {
    this.completedSessions = []
    emitSessionUpdate(this)
  }
}

export const agentSessionTracker = AgentSessionTracker.getInstance()
