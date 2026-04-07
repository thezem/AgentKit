import type { AgentCapabilities, AgentClient, AgentSession } from '../../src/agent-types.ts'

class MockSession implements AgentSession {
  readonly provider: 'codex' | 'claude'
  readonly name: string
  readonly id: string | null = null

  constructor(provider: 'codex' | 'claude', name: string) {
    this.provider = provider
    this.name = name
  }

  getHandle() {
    return {
      provider: this.provider,
      sessionId: this.id,
      name: this.name,
    }
  }

  getSessionInfo() {
    return {
      provider: this.provider,
      name: this.name,
      sessionId: this.id,
      handle: this.getHandle(),
      status: 'idle' as const,
    }
  }

  async run() {
    return {
      provider: this.provider,
      sessionId: this.id,
      turnId: 'turn-test',
      status: 'completed' as const,
      text: 'ok',
      items: [],
      handle: this.getHandle(),
    }
  }

  async stream() {
    const provider = this.provider
    return {
      [Symbol.asyncIterator]: async function* () {
        yield {
          provider,
          type: 'status' as const,
          status: 'idle',
        }
      },
    }
  }

  async interrupt() {}

  async close() {}
}

export class MockAgentClient implements AgentClient {
  readonly provider: 'codex' | 'claude'
  private readonly sessions = new Map<string, AgentSession>()

  constructor(provider: 'codex' | 'claude') {
    this.provider = provider
  }

  session(name: string): AgentSession {
    const existing = this.sessions.get(name)
    if (existing) return existing
    const next = new MockSession(this.provider, name)
    this.sessions.set(name, next)
    return next
  }

  async openSession(options?: { name?: string }): Promise<AgentSession> {
    return this.session(options?.name ?? 'open-session')
  }

  async resumeSession(handle: { name?: string }): Promise<AgentSession> {
    return this.session(handle.name ?? 'resumed-session')
  }

  clearSession(name: string): void {
    this.sessions.delete(name)
  }

  clearSessions(): void {
    this.sessions.clear()
  }

  async getAccountState() {
    return {
      provider: this.provider,
      available: true,
      authenticated: true,
      account: { id: 'acct-1' },
    }
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      provider: this.provider,
      sessionLifecycle: { open: true, resume: true, list: false, clearLocalCache: true, deleteRemote: false },
      controls: { interrupt: true, modelSwitch: 'session', permissionModeSwitch: 'none' },
      interactions: { partialMessages: true, toolApproval: false, userInputRequests: false, dynamicToolCalls: false },
      discovery: { inventory: true, modelListing: true, skillsListing: false, skillConfiguration: false },
      semantics: { sessionIdentity: 'opaque', resumeHandle: 'structured', longLivedRuntime: false },
      supportsResume: true,
      supportsInterrupt: true,
      supportsModelSwitch: true,
      supportsPermissionModeSwitch: false,
      supportsPartialMessages: true,
      supportsToolApproval: false,
      supportsUserInputRequests: false,
    }
  }

  async close() {}

  asCodex() {
    return null
  }

  asClaude() {
    return null
  }
}

export function createMockAgentClient(provider: 'codex' | 'claude'): AgentClient {
  return new MockAgentClient(provider)
}
