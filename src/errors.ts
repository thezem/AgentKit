import type { CapabilityName, ProviderId } from '../capsules/shared/contract.ts'

export type AgentKitErrorCode = 'UNKNOWN_PROVIDER' | 'PROVIDER_UNAVAILABLE' | 'UNSUPPORTED_CAPABILITY' | 'SESSION_BUSY' | 'SESSION_CLOSED' | 'INVALID_INPUT' | 'SIGNED_OUT' | 'TRANSCRIBE_FAILED' | 'ABORTED'

export class AgentKitError extends Error {
  readonly code: AgentKitErrorCode
  readonly provider?: ProviderId
  constructor(code: AgentKitErrorCode, message: string, options?: { provider?: ProviderId; cause?: unknown }) {
    super(message, { cause: options?.cause })
    this.name = 'AgentKitError'
    this.code = code
    this.provider = options?.provider
  }
}

/** Thrown before calling a provider for a primitive it does not support. Check `session.capabilities` to hide the control instead. */
export class UnsupportedCapabilityError extends AgentKitError {
  readonly capability: CapabilityName
  constructor(provider: ProviderId, capability: CapabilityName, detail?: string) {
    super('UNSUPPORTED_CAPABILITY', `${provider} does not support ${capability}${detail ? ` (${detail})` : ''}`, { provider })
    this.name = 'UnsupportedCapabilityError'
    this.capability = capability
  }
}
