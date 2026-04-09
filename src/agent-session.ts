import type { AgentRunOptions, AgentSessionOptions } from './agent-types.ts'
import { validateSharedControlOptions } from './control-layer.ts'

export function mergeAgentSessionOptions(
  base?: AgentSessionOptions,
  next?: AgentSessionOptions,
): AgentSessionOptions | undefined {
  if (!base && !next) return undefined
  const merged = {
    ...base,
    ...next,
    env: {
      ...(base?.env ?? {}),
      ...(next?.env ?? {}),
    },
    additionalDirectories: next?.additionalDirectories ?? base?.additionalDirectories,
  }
  validateSharedControlOptions(merged)
  return merged
}

export function mergeAgentRunOptions(base?: AgentRunOptions, next?: AgentRunOptions): AgentRunOptions | undefined {
  if (!base && !next) return undefined
  const merged = {
    ...base,
    ...next,
    env: {
      ...(base?.env ?? {}),
      ...(next?.env ?? {}),
    },
    additionalDirectories: next?.additionalDirectories ?? base?.additionalDirectories,
    handlers: {
      ...(base?.handlers ?? {}),
      ...(next?.handlers ?? {}),
    },
  }
  validateSharedControlOptions(merged)
  return merged
}
