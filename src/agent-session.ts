import type { AgentRunOptions, AgentSessionOptions } from './agent-types.ts'

export function mergeAgentSessionOptions(
  base?: AgentSessionOptions,
  next?: AgentSessionOptions,
): AgentSessionOptions | undefined {
  if (!base && !next) return undefined
  return {
    ...base,
    ...next,
    env: {
      ...(base?.env ?? {}),
      ...(next?.env ?? {}),
    },
    additionalDirectories: next?.additionalDirectories ?? base?.additionalDirectories,
  }
}

export function mergeAgentRunOptions(base?: AgentRunOptions, next?: AgentRunOptions): AgentRunOptions | undefined {
  if (!base && !next) return undefined
  return {
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
}
