import { access } from 'node:fs/promises'
import type { AgentAccountState } from '../agent-types.ts'
import type { ProviderAvailabilityOptions } from './provider-types.ts'

export async function getClaudeAvailability(options?: ProviderAvailabilityOptions): Promise<AgentAccountState> {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')

    if (options?.pathToClaudeCodeExecutable) {
      try {
        await access(options.pathToClaudeCodeExecutable)
      } catch (error) {
        return {
          provider: 'claude',
          available: false,
          authenticated: false,
          account: null,
          raw: {
            reason: 'Configured Claude executable path does not exist',
            pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
            error: errorToString(error),
          },
        }
      }
    }

    if (options?.probeRuntime === false) {
      return {
        provider: 'claude',
        available: true,
        authenticated: false,
        account: null,
        raw: {
          note: 'Claude package is importable; auth not probed until runtime start.',
        },
      }
    }

    try {
      const runtime = sdk.query({
        prompt: '',
        options: {
          cwd: options?.cwd,
          env: options?.env,
          permissionMode: 'plan',
          persistSession: false,
          maxTurns: 1,
          includePartialMessages: false,
          ...(options?.pathToClaudeCodeExecutable
            ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable }
            : {}),
        },
      })

      const init = await runtime.initializationResult()
      runtime.close()

      return {
        provider: 'claude',
        available: true,
        authenticated: true,
        account: init.account ?? null,
        raw: init,
      }
    } catch (error) {
      return {
        provider: 'claude',
        available: true,
        authenticated: false,
        account: null,
        raw: {
          note: 'Claude runtime available but authentication could not be validated.',
          error: errorToString(error),
        },
      }
    }
  } catch (error) {
    return {
      provider: 'claude',
      available: false,
      authenticated: false,
      account: null,
      raw: {
        reason: 'Claude SDK package is not importable',
        error: errorToString(error),
      },
    }
  }
}

export async function isClaudeAvailable(options?: ProviderAvailabilityOptions): Promise<boolean> {
  const availability = await getClaudeAvailability({ ...options, probeRuntime: false })
  return availability.available
}

function errorToString(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
