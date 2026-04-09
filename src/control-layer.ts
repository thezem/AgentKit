import { InputValidationError, UnsupportedCapabilityError } from './errors.ts'
import type {
  AgentAccessMode,
  AgentInteractionMode,
  AgentRunOptions,
  AgentSessionOptions,
} from './agent-types.ts'
import type { ApprovalPolicy, ReasoningEffort, SandboxMode, ThreadOptions } from './types.ts'

type SharedControlOptions = Pick<
  AgentSessionOptions,
  'interactionMode' | 'accessMode' | 'reasoningEffort' | 'permissionMode'
>

export type ResolvedClaudeControlOptions = {
  permissionMode?: string
  allowDangerouslySkipPermissions?: boolean
}

export function validateSharedControlOptions(options?: SharedControlOptions): void {
  if (!options) return
  if (options.accessMode && options.permissionMode) {
    throw new InputValidationError(
      'Shared builder controls cannot mix accessMode with legacy permissionMode. Pick one control surface.',
      'accessMode',
    )
  }
}

export function resolveCodexThreadControls(options?: AgentSessionOptions): ThreadOptions | undefined {
  validateSharedControlOptions(options)
  if (!options) return undefined

  const interactionMode = resolveInteractionMode(options)
  const accessMode = resolveAccessMode(options)
  const collaborationMode: ThreadOptions['collaborationMode'] | undefined = interactionMode
    ? {
        mode: interactionMode === 'plan' ? 'plan' : 'default',
        settings: options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {},
      }
    : undefined

  return {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort as ReasoningEffort } : {}),
    ...(accessMode ? codexAccessModeToThread(accessMode) : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
  }
}

export function resolveCodexRunControls(options?: AgentRunOptions): ThreadOptions | undefined {
  return resolveCodexThreadControls(options)
}

export function resolveClaudeSessionControls(
  options?: AgentSessionOptions,
): (AgentSessionOptions & ResolvedClaudeControlOptions) | undefined {
  validateSharedControlOptions(options)
  if (!options) return undefined
  const { interactionMode: _interactionMode, accessMode: _accessMode, reasoningEffort: _reasoningEffort, ...rest } = options

  return {
    ...rest,
    ...resolveClaudeControlMapping('claude', options),
  }
}

export function resolveClaudeRunControls(
  options?: AgentRunOptions,
): (AgentRunOptions & ResolvedClaudeControlOptions) | undefined {
  validateSharedControlOptions(options)
  if (!options) return undefined
  const { interactionMode: _interactionMode, accessMode: _accessMode, reasoningEffort: _reasoningEffort, ...rest } = options

  return {
    ...rest,
    ...resolveClaudeControlMapping('claude', options),
  }
}

function resolveClaudeControlMapping(provider: 'claude', options: SharedControlOptions): ResolvedClaudeControlOptions {
  if (options.reasoningEffort) {
    throw new UnsupportedCapabilityError(
      provider,
      'reasoningEffort',
      `Provider "${provider}" does not support runtime reasoningEffort on the shared session/run API yet.`,
    )
  }

  if (!options.interactionMode && !options.accessMode) {
    return {}
  }

  const interactionMode = resolveInteractionMode(options)
  const accessMode = resolveAccessMode(options)

  if (interactionMode === 'plan') {
    if (accessMode !== 'supervised') {
      throw new UnsupportedCapabilityError(
        provider,
        'accessMode',
        `Unsupported shared control combination for provider "${provider}": interactionMode="${interactionMode}" with accessMode="${accessMode}".`,
      )
    }
    return { permissionMode: 'plan' }
  }

  if (accessMode === 'supervised') {
    return { permissionMode: 'default' }
  }

  if (accessMode === 'auto-edit') {
    return { permissionMode: 'acceptEdits' }
  }

  return {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  }
}

function resolveInteractionMode(options: SharedControlOptions): AgentInteractionMode | undefined {
  if (options.interactionMode) return options.interactionMode
  if (options.accessMode || options.reasoningEffort) return 'chat'
  return undefined
}

function resolveAccessMode(options: SharedControlOptions): AgentAccessMode | undefined {
  if (options.accessMode) return options.accessMode
  if (options.interactionMode) return 'supervised'
  return undefined
}

function codexAccessModeToThread(accessMode: AgentAccessMode): Pick<ThreadOptions, 'approvalPolicy' | 'sandboxMode'> {
  switch (accessMode) {
    case 'supervised':
      return {
        approvalPolicy: 'on-request' satisfies ApprovalPolicy,
        sandboxMode: 'workspace-write' satisfies SandboxMode,
      }
    case 'auto-edit':
      return {
        approvalPolicy: 'never' satisfies ApprovalPolicy,
        sandboxMode: 'workspace-write' satisfies SandboxMode,
      }
    case 'full-access':
      return {
        approvalPolicy: 'never' satisfies ApprovalPolicy,
        sandboxMode: 'danger-full-access' satisfies SandboxMode,
      }
  }
}
