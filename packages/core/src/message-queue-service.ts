/**
 * Message Queue Service (Core)
 *
 * Manages per-conversation message queues. Emits updates through CoreEventBus
 * instead of Electron renderer handlers.
 *
 * Extracted from: apps/desktop/src/main/message-queue-service.ts
 */

import type { QueuedMessage, MessageQueue } from "./types"
import { coreEventBus } from "./event-bus"

class MessageQueueService {
  private static instance: MessageQueueService | null = null
  private queues: Map<string, QueuedMessage[]> = new Map()
  private processingConversations: Set<string> = new Set()
  private pausedConversations: Set<string> = new Set()

  static getInstance(): MessageQueueService {
    if (!MessageQueueService.instance) {
      MessageQueueService.instance = new MessageQueueService()
    }
    return MessageQueueService.instance
  }

  private constructor() {}

  pauseQueue(conversationId: string): void {
    this.pausedConversations.add(conversationId)
    this.emitQueueUpdate(conversationId)
  }

  resumeQueue(conversationId: string): void {
    this.pausedConversations.delete(conversationId)
    this.emitQueueUpdate(conversationId)
  }

  isQueuePaused(conversationId: string): boolean {
    return this.pausedConversations.has(conversationId)
  }

  tryAcquireProcessingLock(conversationId: string): boolean {
    if (this.pausedConversations.has(conversationId)) return false
    if (this.processingConversations.has(conversationId)) return false
    this.processingConversations.add(conversationId)
    return true
  }

  releaseProcessingLock(conversationId: string): void {
    this.processingConversations.delete(conversationId)
  }

  isProcessing(conversationId: string): boolean {
    return this.processingConversations.has(conversationId)
  }

  private generateMessageId(): string {
    return `qmsg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
  }

  enqueue(conversationId: string, text: string): QueuedMessage {
    const message: QueuedMessage = {
      id: this.generateMessageId(),
      conversationId,
      text,
      createdAt: Date.now(),
      status: "pending",
    }

    const queue = this.queues.get(conversationId) || []
    queue.push(message)
    this.queues.set(conversationId, queue)
    this.emitQueueUpdate(conversationId)
    return message
  }

  getQueue(conversationId: string): QueuedMessage[] {
    return this.queues.get(conversationId) || []
  }

  getAllQueues(): MessageQueue[] {
    const result: MessageQueue[] = []
    this.queues.forEach((messages, conversationId) => {
      if (messages.length > 0) {
        result.push({ conversationId, messages })
      }
    })
    return result
  }

  removeFromQueue(conversationId: string, messageId: string): boolean {
    const queue = this.queues.get(conversationId)
    if (!queue) return false

    const index = queue.findIndex((m) => m.id === messageId)
    if (index === -1) return false
    if (queue[index].status === "processing") return false

    queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(conversationId)
    this.emitQueueUpdate(conversationId)
    return true
  }

  clearQueue(conversationId: string): boolean {
    const queue = this.queues.get(conversationId)
    if (!queue) return true
    if (queue.some((m) => m.status === "processing")) return false

    this.queues.delete(conversationId)
    this.emitQueueUpdate(conversationId)
    return true
  }

  updateMessageText(
    conversationId: string,
    messageId: string,
    newText: string,
  ): boolean {
    const queue = this.queues.get(conversationId)
    if (!queue) return false

    const message = queue.find((m) => m.id === messageId)
    if (!message) return false
    if (message.status === "processing") return false
    if (message.addedToHistory) return false

    message.text = newText
    if (message.status === "failed") {
      message.status = "pending"
      delete message.errorMessage
    }
    this.emitQueueUpdate(conversationId)
    return true
  }

  peek(conversationId: string): QueuedMessage | null {
    const queue = this.queues.get(conversationId)
    if (!queue || queue.length === 0) return null
    const firstMessage = queue[0]
    return firstMessage.status === "pending" ? firstMessage : null
  }

  markProcessing(conversationId: string, messageId: string): boolean {
    const queue = this.queues.get(conversationId)
    if (!queue) return false
    const message = queue.find((m) => m.id === messageId)
    if (!message) return false
    message.status = "processing"
    this.emitQueueUpdate(conversationId)
    return true
  }

  markProcessed(conversationId: string, messageId: string): boolean {
    const queue = this.queues.get(conversationId)
    if (!queue || queue.length === 0) return false
    const index = queue.findIndex((m) => m.id === messageId)
    if (index === -1) return false
    queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(conversationId)
    this.emitQueueUpdate(conversationId)
    return true
  }

  markFailed(
    conversationId: string,
    messageId: string,
    errorMessage: string,
  ): boolean {
    const queue = this.queues.get(conversationId)
    if (!queue || queue.length === 0) return false
    const message = queue.find((m) => m.id === messageId)
    if (!message) return false
    message.status = "failed"
    message.errorMessage = errorMessage
    this.emitQueueUpdate(conversationId)
    return true
  }

  markAddedToHistory(conversationId: string, messageId: string): boolean {
    const queue = this.queues.get(conversationId)
    if (!queue) return false
    const message = queue.find((m) => m.id === messageId)
    if (!message) return false
    message.addedToHistory = true
    return true
  }

  resetToPending(conversationId: string, messageId: string): boolean {
    const queue = this.queues.get(conversationId)
    if (!queue) return false
    const message = queue.find((m) => m.id === messageId)
    if (!message || message.status !== "failed") return false
    message.status = "pending"
    delete message.errorMessage
    this.emitQueueUpdate(conversationId)
    return true
  }

  reorderQueue(conversationId: string, messageIds: string[]): boolean {
    const queue = this.queues.get(conversationId)
    if (!queue) return false

    const messageMap = new Map(queue.map((m) => [m.id, m]))
    const newQueue: QueuedMessage[] = []
    for (const id of messageIds) {
      const message = messageMap.get(id)
      if (message) {
        newQueue.push(message)
        messageMap.delete(id)
      }
    }
    messageMap.forEach((m) => newQueue.push(m))
    this.queues.set(conversationId, newQueue)
    this.emitQueueUpdate(conversationId)
    return true
  }

  hasQueuedMessages(conversationId: string): boolean {
    const queue = this.queues.get(conversationId)
    return !!queue && queue.length > 0
  }

  private emitQueueUpdate(conversationId: string): void {
    coreEventBus.emit("queue:updated", {
      conversationId,
      queue: this.getQueue(conversationId),
      isPaused: this.isQueuePaused(conversationId),
    })
  }
}

export const messageQueueService = MessageQueueService.getInstance()
