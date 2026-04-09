import { access } from 'node:fs/promises'
import type { AgentAccountState, AgentCapabilities, AgentProviderInventory, ProviderInventoryOptions } from '../agent-types.ts'
import { ProviderProbeTimeoutError } from '../errors.ts'
import type { ProviderAvailabilityOptions } from './provider-types.ts'

export async function getClaudeInventory(options?: ProviderInventoryOptions): Promise<AgentProviderInventory> {
  const probeMode = options?.probeMode ?? 'deep'
  const probeTimeoutMs = options?.probeTimeoutMs ?? 5000

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
        probeStrategy: 'sdk-import',
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
        probeStrategy: 'path-check',
        failureReason: 'Configured Claude executable path does not exist',
      },
        raw: {
          error: errorToString(error),
        },
        capabilitySupport: claudeCapabilities(),
      }
    }
  }

  const sdkVersion = readClaudeSdkVersion(sdk)

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
      ...(sdkVersion ? { version: sdkVersion } : {}),
      ...(sdkVersion ? { versionDetails: { source: 'sdk' as const, raw: sdkVersion } } : {}),
      account: null,
      diagnostics: {
        probeMode,
        probeStrategy: 'sdk-import',
        notes: ['Claude SDK is importable; runtime auth not checked in cheap mode.'],
      },
      raw: {
        importable: true,
      },
      capabilitySupport: claudeCapabilities(),
    }
  }

  let runtime: ReturnType<typeof sdk.query> | null = null
  try {
    runtime = sdk.query({
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

    const init = await withTimeout(
      runtime.initializationResult(),
      probeTimeoutMs,
      () => new ProviderProbeTimeoutError('claude', probeTimeoutMs),
    )
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
      ...(sdkVersion ? { version: sdkVersion } : {}),
      ...(sdkVersion ? { versionDetails: { source: 'sdk' as const, raw: sdkVersion } } : {}),
      account: init.account ?? null,
      diagnostics: {
        probeMode,
        probeStrategy: 'runtime-init',
      },
      raw: init,
      capabilitySupport: claudeCapabilities(),
    }
  } catch (error) {
    const timeout = error instanceof ProviderProbeTimeoutError
    return {
      provider: 'claude',
      installed: true,
      runnable: timeout ? true : false,
      authenticated: false,
      degraded: true,
      status: 'degraded',
      ...(options?.pathToClaudeCodeExecutable ? { executablePath: options.pathToClaudeCodeExecutable } : {}),
      ...(options?.pathToClaudeCodeExecutable ? { executableSource: 'configured' as const } : { executableSource: 'runtime-probe' as const }),
      ...(sdkVersion ? { version: sdkVersion } : {}),
      ...(sdkVersion ? { versionDetails: { source: 'sdk' as const, raw: sdkVersion } } : {}),
      account: null,
      diagnostics: {
        probeMode,
        probeStrategy: 'runtime-init',
        failureReason: `Claude runtime failed to initialize: ${errorToString(error)}`,
        ...(timeout ? { notes: [`Runtime probe exceeded ${probeTimeoutMs}ms and was degraded.`] } : {}),
      },
      raw: {
        error: errorToString(error),
      },
      capabilitySupport: claudeCapabilities(),
    }
  } finally {
    if (runtime) {
      runtime.close()
    }
  }
}

export async function getClaudeAvailability(options?: ProviderAvailabilityOptions): Promise<AgentAccountState> {
  const inventory = await getClaudeInventory({
    pathToClaudeCodeExecutable: options?.pathToClaudeCodeExecutable,
    cwd: options?.cwd,
    env: options?.env,
    probeMode: options?.probeRuntime === true ? 'deep' : 'cheap',
    probeTimeoutMs: options?.probeTimeoutMs,
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
      interactionModeSwitch: 'session',
      accessModeSwitch: 'session',
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
      modelListing: true,
      skillsListing: false,
      skillConfiguration: false,
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

function readClaudeSdkVersion(sdk: unknown): string | undefined {
  if (!sdk || typeof sdk !== 'object') return undefined
  const candidate = sdk as Record<string, unknown>
  if (typeof candidate.version === 'string' && candidate.version.trim().length > 0) {
    return candidate.version.trim()
  }
  if (typeof candidate.VERSION === 'string' && candidate.VERSION.trim().length > 0) {
    return candidate.VERSION.trim()
  }
  return undefined
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, createError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(createError()), timeoutMs)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}
