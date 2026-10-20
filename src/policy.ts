import type { PermissionRequest, PermissionResponse, ProviderId } from '../capsules/shared/contract.ts'

/**
 * Provider-neutral access levels. Each maps to a native mode; a provider that
 * lacks a native match gets an approval handler that enforces the level.
 */
export type AccessLevel = 'plan' | 'supervised' | 'auto-edit' | 'full-access'

export const ACCESS_MODE_MAP: Record<string, Record<AccessLevel, string>> = {
  claude: { plan: 'plan', supervised: 'default', 'auto-edit': 'acceptEdits', 'full-access': 'bypassPermissions' },
  codex: { plan: 'plan', supervised: 'read-only', 'auto-edit': 'auto', 'full-access': 'full-access' },
  opencode: { plan: 'plan', supervised: 'build', 'auto-edit': 'build', 'full-access': 'build' },
  mock: { plan: 'ask', supervised: 'ask', 'auto-edit': 'ask', 'full-access': 'auto' },
}

export function modeForAccess(provider: ProviderId, access: AccessLevel): string | undefined {
  return ACCESS_MODE_MAP[provider]?.[access]
}

export type PermissionDecision = PermissionResponse | 'allow' | 'deny' | undefined
/** Return a decision to auto-answer, or undefined to leave it pending for your UI. */
export type PermissionHandler = (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>

export type ToolCategory = 'read' | 'edit' | 'command' | 'network' | 'question' | 'plan' | 'other'

/** Classify a permission request into a coarse category, using typed detail first, then the tool name. */
export function categorize(request: PermissionRequest): ToolCategory {
  if (request.kind === 'question') return 'question'
  if (request.kind === 'plan') return 'plan'
  switch (request.detail?.type) {
    case 'shell':
      return 'command'
    case 'edit':
    case 'write':
      return 'edit'
    case 'read':
    case 'search':
      return request.detail.type === 'search' && request.detail.kind === 'web' ? 'network' : 'read'
    case 'fetch':
      return 'network'
  }
  const name = request.name.toLowerCase()
  if (/bash|shell|exec|command/.test(name)) return 'command'
  if (/edit|write|patch/.test(name)) return 'edit'
  if (/read|glob|grep|list|view|search/.test(name)) return 'read'
  if (/fetch|web/.test(name)) return 'network'
  return 'other'
}

/** Ready-made permission handlers. Compose with `firstOf`. */
export const policies = {
  allowAll: (): PermissionHandler => (request) => (request.kind === 'question' ? undefined : 'allow'),
  denyAll: (): PermissionHandler => (request) => (request.kind === 'question' ? undefined : 'deny'),
  readOnly: (): PermissionHandler => (request) => (categorize(request) === 'read' ? 'allow' : request.kind === 'question' ? undefined : 'deny'),
  acceptEdits: (): PermissionHandler => (request) => {
    const category = categorize(request)
    return category === 'read' || category === 'edit' ? 'allow' : undefined
  },
  /** Allow the given categories, leave the rest for the UI. */
  allow: (...categories: ToolCategory[]): PermissionHandler => (request) => (categories.includes(categorize(request)) ? 'allow' : undefined),
  firstOf:
    (...handlers: PermissionHandler[]): PermissionHandler =>
    async (request) => {
      for (const handler of handlers) {
        const decision = await handler(request)
        if (decision !== undefined) return decision
      }
      return undefined
    },
}

export function normalizeDecision(decision: PermissionDecision): PermissionResponse | undefined {
  if (decision === 'allow') return { behavior: 'allow' }
  if (decision === 'deny') return { behavior: 'deny', message: 'Denied by policy' }
  return decision
}
