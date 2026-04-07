export class TransportRequestTimeoutError extends Error {
  readonly method: string
  readonly requestId: number
  readonly timeoutMs: number

  constructor(method: string, requestId: number, timeoutMs: number) {
    super(`JSON-RPC request timed out after ${timeoutMs}ms: ${method} (id=${requestId})`)
    this.name = 'TransportRequestTimeoutError'
    this.method = method
    this.requestId = requestId
    this.timeoutMs = timeoutMs
  }
}

export class ConcurrentTurnError extends Error {
  readonly threadId: string

  constructor(threadId: string) {
    super(`A turn is already starting or active for thread ${threadId}`)
    this.name = 'ConcurrentTurnError'
    this.threadId = threadId
  }
}

export class QueueOverflowError extends Error {
  readonly threadId: string
  readonly turnId: string
  readonly maxQueueSize: number

  constructor(threadId: string, turnId: string, maxQueueSize: number) {
    super(`Turn event queue overflow for ${threadId}:${turnId} (maxQueueSize=${maxQueueSize})`)
    this.name = 'QueueOverflowError'
    this.threadId = threadId
    this.turnId = turnId
    this.maxQueueSize = maxQueueSize
  }
}

export class ProviderProbeTimeoutError extends Error {
  readonly provider: 'codex' | 'claude'
  readonly timeoutMs: number

  constructor(provider: 'codex' | 'claude', timeoutMs: number) {
    super(`Provider probe timed out for ${provider} after ${timeoutMs}ms`)
    this.name = 'ProviderProbeTimeoutError'
    this.provider = provider
    this.timeoutMs = timeoutMs
  }
}
