import type { AgentProviderId, AgentSessionHandle } from './agent-types.ts'
import { ExpiredHandleError, InvalidHandleError } from './errors.ts'

type LegacyHandle = {
  provider?: unknown
  sessionId?: unknown
  name?: unknown
  resumeKey?: unknown
  resumeAt?: unknown
  raw?: unknown
}

type HandleState = NonNullable<AgentSessionHandle['state']>

export function normalizeSessionHandle(input: unknown): AgentSessionHandle {
  if (isVersionedHandleCandidate(input)) {
    return validateSessionHandle(input)
  }

  if (!input || typeof input !== 'object') {
    throw new InvalidHandleError('Session handle must be an object')
  }

  const legacy = input as LegacyHandle
  const provider = parseProvider(legacy.provider)
  const sessionId = parseSessionId(legacy.sessionId)
  const name = parseMaybeString(legacy.name, 'name')
  const state: HandleState = {}

  if (legacy.resumeKey !== undefined) {
    state.resumeKey = parseRequiredString(legacy.resumeKey, 'resumeKey')
  } else if (sessionId) {
    state.resumeKey = sessionId
  }

  if (legacy.resumeAt !== undefined) {
    state.resumeAt = parseRequiredString(legacy.resumeAt, 'resumeAt')
  }

  if (legacy.raw !== undefined) {
    state.raw = legacy.raw
  }

  return validateSessionHandle({
    version: 1,
    provider,
    sessionId,
    ...(name ? { name } : {}),
    ...(Object.keys(state).length > 0 ? { state } : {}),
  })
}

export function validateSessionHandle(input: unknown): AgentSessionHandle {
  if (!input || typeof input !== 'object') {
    throw new InvalidHandleError('Session handle must be an object')
  }

  const candidate = input as Record<string, unknown>
  if (candidate.version !== 1) {
    throw new InvalidHandleError('Session handle version must be 1')
  }

  const provider = parseProvider(candidate.provider)
  const sessionId = parseSessionId(candidate.sessionId)
  const name = parseMaybeString(candidate.name, 'name')
  const state = validateState(provider, candidate.state)

  if (isExpiredState(state)) {
    throw new ExpiredHandleError(provider)
  }

  return {
    version: 1,
    provider,
    sessionId,
    ...(name ? { name } : {}),
    ...(state ? { state } : {}),
  }
}

function validateState(provider: AgentProviderId, input: unknown): HandleState | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidHandleError('Session handle state must be an object')
  }

  const candidate = input as Record<string, unknown>
  const state: HandleState = {}

  if (candidate.resumeKey !== undefined) {
    state.resumeKey = parseRequiredString(candidate.resumeKey, 'state.resumeKey')
  }

  if (candidate.resumeAt !== undefined) {
    state.resumeAt = parseRequiredString(candidate.resumeAt, 'state.resumeAt')
  }

  if (provider === 'codex' && candidate.resumeAt !== undefined) {
    throw new InvalidHandleError('Codex handles do not support state.resumeAt')
  }

  if (candidate.raw !== undefined) {
    state.raw = candidate.raw
  }

  return Object.keys(state).length > 0 ? state : undefined
}

function isExpiredState(state: HandleState | undefined): boolean {
  if (!state?.raw || typeof state.raw !== 'object' || Array.isArray(state.raw)) return false
  const raw = state.raw as Record<string, unknown>
  return raw.expired === true || raw.isExpired === true
}

function parseProvider(value: unknown): AgentProviderId {
  if (value === 'codex' || value === 'claude') return value
  throw new InvalidHandleError(`Unsupported handle provider: ${String(value)}`)
}

function parseSessionId(value: unknown): string | null {
  if (value === null) return null
  if (typeof value === 'string') return value
  throw new InvalidHandleError('Session handle sessionId must be a string or null')
}

function parseMaybeString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return parseRequiredString(value, field)
}

function parseRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new InvalidHandleError(`Session handle ${field} must be a string`)
  }
  return value
}

function isVersionedHandleCandidate(input: unknown): input is AgentSessionHandle {
  if (!input || typeof input !== 'object') return false
  return 'version' in input
}
