import { Deferred } from '../../src/utils.ts'
import type { JsonRpcNotification, JsonRpcRequest } from '../../src/types.ts'

type PendingRequest = {
  method: string
  params: unknown
  deferred: Deferred<unknown>
}

type QueuedOutcome =
  | { type: 'resolve'; value: unknown }
  | { type: 'reject'; error: unknown }

/**
 * Minimal in-memory transport used by tests to exercise CodexClient logic
 * without spawning a real app-server process.
 */
export class FakeTransport {
  requestLog: Array<{ method: string; params: unknown }> = []
  responses: Array<{ id: number; result: unknown }> = []
  responseErrors: Array<{ id: number; message: string; data?: unknown }> = []

  private readonly notificationListeners = new Set<(payload: JsonRpcNotification) => void>()
  private readonly serverRequestListeners = new Set<(payload: JsonRpcRequest) => void>()
  private readonly closeListeners = new Set<(error: unknown) => void>()
  private readonly pending: PendingRequest[] = []
  private readonly queuedByMethod = new Map<string, QueuedOutcome[]>()

  onNotification(cb: (payload: JsonRpcNotification) => void): void {
    this.notificationListeners.add(cb)
  }

  onServerRequest(cb: (payload: JsonRpcRequest) => void): void {
    this.serverRequestListeners.add(cb)
  }

  onClosed(cb: (error: unknown) => void): void {
    this.closeListeners.add(cb)
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requestLog.push({ method, params })

    const queued = this.queuedByMethod.get(method)
    if (queued && queued.length > 0) {
      const next = queued.shift() as QueuedOutcome
      if (next.type === 'resolve') {
        return next.value as T
      }
      throw next.error
    }

    const deferred = new Deferred<unknown>()
    this.pending.push({ method, params, deferred })
    return deferred.promise as Promise<T>
  }

  respond(id: number, result: unknown): void {
    this.responses.push({ id, result })
  }

  respondError(id: number, message: string, data?: unknown): void {
    this.responseErrors.push({ id, message, data })
  }

  close(): void {
    this.simulateClose(new Error('fake transport closed'))
  }

  respondWith(method: string, result: unknown): void {
    const pending = this.shiftPending(method)
    if (pending) {
      pending.deferred.resolve(result)
      return
    }

    this.enqueueOutcome(method, { type: 'resolve', value: result })
  }

  rejectWith(method: string, error: unknown): void {
    const pending = this.shiftPending(method)
    if (pending) {
      pending.deferred.reject(error)
      return
    }

    this.enqueueOutcome(method, { type: 'reject', error })
  }

  simulateClose(error: unknown = new Error('fake transport closed')): void {
    while (this.pending.length > 0) {
      this.pending.shift()?.deferred.reject(error)
    }
    for (const listener of this.closeListeners) {
      listener(error)
    }
  }

  simulateNotification(payload: JsonRpcNotification): void {
    for (const listener of this.notificationListeners) {
      listener(payload)
    }
  }

  simulateServerRequest(payload: JsonRpcRequest): void {
    for (const listener of this.serverRequestListeners) {
      listener(payload)
    }
  }

  private shiftPending(method: string): PendingRequest | undefined {
    const index = this.pending.findIndex((candidate) => candidate.method === method)
    if (index === -1) return undefined
    return this.pending.splice(index, 1)[0]
  }

  private enqueueOutcome(method: string, outcome: QueuedOutcome): void {
    const queue = this.queuedByMethod.get(method)
    if (queue) {
      queue.push(outcome)
      return
    }
    this.queuedByMethod.set(method, [outcome])
  }
}
