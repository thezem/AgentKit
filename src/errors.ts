export abstract class AgentError extends Error {
  abstract readonly code: string
}

export class InputValidationError extends AgentError {
  readonly code = 'INPUT_VALIDATION_ERROR'
  readonly field?: string

  constructor(message: string, field?: string) {
    super(message)
    this.name = 'InputValidationError'
    if (field !== undefined) this.field = field
  }
}

export class TransportRequestTimeoutError extends AgentError {
  readonly code = 'TRANSPORT_REQUEST_TIMEOUT'
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

export class ConcurrentTurnError extends AgentError {
  readonly code = 'CONCURRENT_TURN'
  readonly threadId: string

  constructor(threadId: string) {
    super(`A turn is already starting or active for thread ${threadId}`)
    this.name = 'ConcurrentTurnError'
    this.threadId = threadId
  }
}

export class QueueOverflowError extends AgentError {
  readonly code = 'QUEUE_OVERFLOW'
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

export class ProviderProbeTimeoutError extends AgentError {
  readonly code = 'PROVIDER_PROBE_TIMEOUT'
  readonly provider: 'codex' | 'claude'
  readonly timeoutMs: number

  constructor(provider: 'codex' | 'claude', timeoutMs: number) {
    super(`Provider probe timed out for ${provider} after ${timeoutMs}ms`)
    this.name = 'ProviderProbeTimeoutError'
    this.provider = provider
    this.timeoutMs = timeoutMs
  }
}
