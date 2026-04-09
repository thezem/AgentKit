import type { AgentHandlers, AgentToolApprovalRequest, SafetyConfirmDangerousOptions, SafetyPresets } from './agent-types.ts'

type ApprovalCategory = 'readOnly' | 'fileEdits' | 'commands' | 'unknown'

const FILE_EDIT_PATTERNS = ['edit', 'write', 'patch', 'apply', 'file']
const COMMAND_PATTERNS = ['command', 'shell', 'exec', 'run', 'terminal', 'process']
const READ_ONLY_PATTERNS = ['read', 'view', 'list', 'inspect', 'search', 'find', 'grep', 'query']

export const safety: SafetyPresets = {
  readOnly(): AgentHandlers {
    return createApprovalHandlers(() => 'deny')
  },

  acceptEditsOnly(): AgentHandlers {
    return createApprovalHandlers((request) => (classifyApprovalKind(request) === 'fileEdits' ? 'allow' : 'deny'))
  },

  confirmDangerous(options: SafetyConfirmDangerousOptions = {}): AgentHandlers {
    return createApprovalHandlers((request) => {
      switch (classifyApprovalKind(request)) {
        case 'readOnly':
          return options.allowReadOnly === true ? 'allow' : 'deny'
        case 'fileEdits':
          return options.allowFileEdits === true ? 'allow' : 'deny'
        case 'commands':
          return options.allowCommands === true ? 'allow' : 'deny'
        default:
          return 'deny'
      }
    })
  },
}

function createApprovalHandlers(
  decide: (request: AgentToolApprovalRequest) => 'allow' | 'deny',
): AgentHandlers {
  return {
    onToolApproval: (request) => decide(request),
  }
}

function classifyApprovalKind(request: AgentToolApprovalRequest): ApprovalCategory {
  const normalizedKind = request.kind.trim().toLowerCase().replace(/[\s.-]+/g, '_')

  if (matchesAny(normalizedKind, COMMAND_PATTERNS)) return 'commands'
  if (matchesAny(normalizedKind, FILE_EDIT_PATTERNS)) return 'fileEdits'
  if (matchesAny(normalizedKind, READ_ONLY_PATTERNS)) return 'readOnly'
  return 'unknown'
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern))
}
