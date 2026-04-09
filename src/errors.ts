export type AgentErrorCode =
  | 'INPUT_VALIDATION'
  | 'INVALID_PROVIDER'
  | 'UNSUPPORTED_CAPABILITY'
  | 'TRANSPORT_REQUEST_TIMEOUT'
  | 'CONCURRENT_TURN'
  | 'QUEUE_OVERFLOW'
  | 'PROVIDER_PROBE_TIMEOUT'
  | 'INVALID_HANDLE'
  | 'EXPIRED_HANDLE'
  | 'RUN_IN_PROGRESS'
  | 'NO_ACTIVE_RUN'
  | 'SESSION_CLOSED'
  | 'RUNTIME_ERROR'

type AgentErrorOptions = ErrorOptions & {
  retryable: boolean
  provider?: 'codex' | 'claude'
}

/** Base class for all public SDK errors. */
export abstract class AgentError extends Error {
  abstract readonly code: AgentErrorCode
  readonly retryable: boolean
  readonly provider?: 'codex' | 'claude'
  override readonly cause?: unknown

  protected constructor(message: string, options: AgentErrorOptions) {
    super(message, options)
    this.retryable = options.retryable
    this.provider = options.provider
    this.cause = options.cause
  }
}

/** Thrown when caller input fails runtime validation checks. */
export class InputValidationError extends AgentError {
  readonly code: AgentErrorCode
  readonly field?: string

  constructor(message: string, field?: string, options?: ErrorOptions & { code?: 'INPUT_VALIDATION' | 'INVALID_PROVIDER' }) {
    super(message, {
      ...options,
      retryable: false,
    })
    this.name = 'InputValidationError'
    this.code = options?.code ?? 'INPUT_VALIDATION'
    if (field !== undefined) this.field = field
  }
}

/** Thrown when a provider cannot honor a requested shared capability. */
export class UnsupportedCapabilityError extends AgentError {
  readonly code = 'UNSUPPORTED_CAPABILITY'
  readonly capability: string

  constructor(
    provider: 'codex' | 'claude',
    capability: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, {
      ...options,
      retryable: false,
      provider,
    })
    this.name = 'UnsupportedCapabilityError'
    this.capability = capability
  }
}

/** Thrown when a JSON-RPC request does not receive a response before timeout. */
export class TransportRequestTimeoutError extends AgentError {
  readonly code = 'TRANSPORT_REQUEST_TIMEOUT'
  readonly method: string
  readonly requestId: number
  readonly timeoutMs: number

  constructor(method: string, requestId: number, timeoutMs: number) {
    super(`JSON-RPC request timed out after ${timeoutMs}ms: ${method} (id=${requestId})`, {
      retryable: true,
      provider: 'codex',
    })
    this.name = 'TransportRequestTimeoutError'
    this.method = method
    this.requestId = requestId
    this.timeoutMs = timeoutMs
  }
}

/** Thrown when a second turn is started on a thread with an active/starting turn. */
export class ConcurrentTurnError extends AgentError {
  readonly code = 'CONCURRENT_TURN'
  readonly threadId: string

  constructor(threadId: string) {
    super(`A turn is already starting or active for thread ${threadId}`, {
      retryable: true,
      provider: 'codex',
    })
    this.name = 'ConcurrentTurnError'
    this.threadId = threadId
  }
}

/** Thrown when a turn event queue exceeds the configured max size. */
export class QueueOverflowError extends AgentError {
  readonly code = 'QUEUE_OVERFLOW'
  readonly threadId: string
  readonly turnId: string
  readonly maxQueueSize: number

  constructor(threadId: string, turnId: string, maxQueueSize: number) {
    super(`Turn event queue overflow for ${threadId}:${turnId} (maxQueueSize=${maxQueueSize})`, {
      retryable: true,
      provider: 'codex',
    })
    this.name = 'QueueOverflowError'
    this.threadId = threadId
    this.turnId = turnId
    this.maxQueueSize = maxQueueSize
  }
}

/** Thrown when a provider runtime probe exceeds the configured timeout. */
export class ProviderProbeTimeoutError extends AgentError {
  readonly code = 'PROVIDER_PROBE_TIMEOUT'
  readonly provider: 'codex' | 'claude'
  readonly timeoutMs: number

  constructor(provider: 'codex' | 'claude', timeoutMs: number) {
    super(`Provider probe timed out for ${provider} after ${timeoutMs}ms`, {
      retryable: true,
      provider,
    })
    this.name = 'ProviderProbeTimeoutError'
    this.provider = provider
    this.timeoutMs = timeoutMs
  }
}

/** Thrown when a persisted session handle is malformed or unsupported. */
export class InvalidHandleError extends AgentError {
  readonly code = 'INVALID_HANDLE'

  constructor(message: string, options?: ErrorOptions & { provider?: 'codex' | 'claude' }) {
    super(message, {
      ...options,
      retryable: false,
      ...(options?.provider ? { provider: options.provider } : {}),
    })
    this.name = 'InvalidHandleError'
  }
}

/** Thrown when a persisted session handle has expired and can no longer be resumed. */
export class ExpiredHandleError extends AgentError {
  readonly code = 'EXPIRED_HANDLE'

  constructor(provider?: 'codex' | 'claude', options?: ErrorOptions) {
    super('Session handle has expired and can no longer be resumed', {
      ...options,
      retryable: false,
      ...(provider ? { provider } : {}),
    })
    this.name = 'ExpiredHandleError'
  }
}

/** Thrown when a caller attempts to start a second run on the same session. */
export class RunInProgressError extends AgentError {
  readonly code = 'RUN_IN_PROGRESS'

  constructor(provider: 'codex' | 'claude', sessionName?: string, options?: ErrorOptions) {
    super(
      sessionName
        ? `Session "${sessionName}" already has an active run in progress`
        : 'An active run is already in progress',
      {
        ...options,
        retryable: true,
        provider,
      },
    )
    this.name = 'RunInProgressError'
  }
}

/** Thrown when interruption is requested but no session run is active. */
export class NoActiveRunError extends AgentError {
  readonly code = 'NO_ACTIVE_RUN'

  constructor(provider: 'codex' | 'claude', sessionName?: string, options?: ErrorOptions) {
    super(
      sessionName
        ? `Session "${sessionName}" has no active run`
        : 'No active run is available for this session',
      {
        ...options,
        retryable: false,
        provider,
      },
    )
    this.name = 'NoActiveRunError'
  }
}

/** Thrown when a session wrapper has been closed and can no longer be used. */
export class SessionClosedError extends AgentError {
  readonly code = 'SESSION_CLOSED'

  constructor(provider: 'codex' | 'claude', sessionName?: string, options?: ErrorOptions) {
    super(
      sessionName ? `Session "${sessionName}" is closed` : 'Session is closed',
      {
        ...options,
        retryable: false,
        provider,
      },
    )
    this.name = 'SessionClosedError'
  }
}
