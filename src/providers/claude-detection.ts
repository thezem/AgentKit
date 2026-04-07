import { access } from 'node:fs/promises'
import type { AgentAccountState, AgentCapabilities, AgentProviderInventory, ProviderInventoryOptions } from '../agent-types.ts'
import type { ProviderAvailabilityOptions } from './provider-types.ts'

export async function getClaudeInventory(options?: ProviderInventoryOptions): Promise<AgentProviderInventory> {
  const probeMode = options?.probeMode ?? 'deep'

  let sdk: (typeof import('@anthropic-ai/claude-agent-sdk')) | null = null
  try {
    sdk = await import('@anthropic-ai/claude-agent-sdk')
  } catch (error) {
    return {
      provider: 'claude',
      installed: false,
      runnable: false,
      authenticated: false,
      degraded: false,
      status: 'missing',
      executableSource: 'sdk',
      account: null,
      diagnostics: {
        probeMode,
        failureReason: 'Claude SDK package is not importable',
      },
      raw: {
        error: errorToString(error),
      },
      capabilitySupport: claudeCapabilities(),
    }
  }

  if (options?.pathToClaudeCodeExecutable) {
    try {
      await access(options.pathToClaudeCodeExecutable)
    } catch (error) {
      return {
        provider: 'claude',
        installed: true,
        runnable: false,
        authenticated: false,
        degraded: true,
        status: 'degraded',
        executablePath: options.pathToClaudeCodeExecutable,
        executableSource: 'configured',
        account: null,
        diagnostics: {
          probeMode,
          failureReason: 'Configured Claude executable path does not exist',
        },
        raw: {
          error: errorToString(error),
        },
        capabilitySupport: claudeCapabilities(),
      }
    }
  }

  if (probeMode === 'cheap') {
    return {
      provider: 'claude',
      installed: true,
      runnable: true,
      authenticated: false,
      degraded: false,
      status: 'runnable',
      ...(options?.pathToClaudeCodeExecutable ? { executablePath: options.pathToClaudeCodeExecutable } : {}),
      ...(options?.pathToClaudeCodeExecutable ? { executableSource: 'configured' as const } : { executableSource: 'sdk' as const }),
      account: null,
      diagnostics: {
        probeMode,
        notes: ['Claude SDK is importable; runtime auth not checked in cheap mode.'],
      },
      raw: {
        importable: true,
      },
      capabilitySupport: claudeCapabilities(),
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

    const authenticated = init.account !== null && init.account !== undefined

    return {
      provider: 'claude',
      installed: true,
      runnable: true,
      authenticated,
      degraded: false,
      status: deriveInventoryStatus({
        installed: true,
        runnable: true,
        authenticated,
        degraded: false,
      }),
      ...(options?.pathToClaudeCodeExecutable ? { executablePath: options.pathToClaudeCodeExecutable } : {}),
      ...(options?.pathToClaudeCodeExecutable ? { executableSource: 'configured' as const } : { executableSource: 'sdk' as const }),
      account: init.account ?? null,
      diagnostics: {
        probeMode,
      },
      raw: init,
      capabilitySupport: claudeCapabilities(),
    }
  } catch (error) {
    return {
      provider: 'claude',
      installed: true,
      runnable: false,
      authenticated: false,
      degraded: true,
      status: 'degraded',
      ...(options?.pathToClaudeCodeExecutable ? { executablePath: options.pathToClaudeCodeExecutable } : {}),
      ...(options?.pathToClaudeCodeExecutable ? { executableSource: 'configured' as const } : { executableSource: 'runtime-probe' as const }),
      account: null,
      diagnostics: {
        probeMode,
        failureReason: 'Claude runtime failed to initialize',
      },
      raw: {
        error: errorToString(error),
      },
      capabilitySupport: claudeCapabilities(),
    }
  }
}

export async function getClaudeAvailability(options?: ProviderAvailabilityOptions): Promise<AgentAccountState> {
  const inventory = await getClaudeInventory({
    pathToClaudeCodeExecutable: options?.pathToClaudeCodeExecutable,
    cwd: options?.cwd,
    env: options?.env,
    probeMode: options?.probeRuntime === false ? 'cheap' : 'deep',
  })

  return {
    provider: 'claude',
    available: inventory.runnable,
    authenticated: inventory.authenticated,
    account: inventory.account,
    raw: inventory.raw,
  }
}

export async function isClaudeAvailable(options?: ProviderInventoryOptions): Promise<boolean> {
  const inventory = await getClaudeInventory({ ...options, probeMode: 'cheap' })
  return inventory.runnable
}

export function claudeCapabilities(): AgentCapabilities {
  return {
    provider: 'claude',
    sessionLifecycle: {
      open: true,
      resume: true,
      list: false,
      clearLocalCache: true,
      deleteRemote: false,
    },
    controls: {
      interrupt: true,
      modelSwitch: 'session',
      permissionModeSwitch: 'session',
    },
    interactions: {
      partialMessages: true,
      toolApproval: true,
      userInputRequests: true,
      dynamicToolCalls: false,
    },
    discovery: {
      inventory: true,
      modelListing: false,
      skillsListing: false,
    },
    semantics: {
      sessionIdentity: 'runtime-session',
      resumeHandle: 'structured',
      longLivedRuntime: true,
    },
    supportsResume: true,
    supportsInterrupt: true,
    supportsModelSwitch: true,
    supportsPermissionModeSwitch: true,
    supportsPartialMessages: true,
    supportsToolApproval: true,
    supportsUserInputRequests: true,
    raw: {
      eventModel: 'claude-agent-sdk',
    },
  }
}

function deriveInventoryStatus(flags: {
  installed: boolean
  runnable: boolean
  authenticated: boolean
  degraded: boolean
}): AgentProviderInventory['status'] {
  if (!flags.installed) return 'missing'
  if (flags.degraded) return 'degraded'
  if (flags.authenticated) return 'authenticated'
  if (flags.runnable) return 'runnable'
  return 'installed'
}

function errorToString(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
