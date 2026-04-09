import type {
  AgentCapabilities,
  AgentClient,
  AgentEvent,
  AgentInput,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionHandle,
  AgentSessionOptions,
} from '../../src/agent-types.ts'

class FixtureSession implements AgentSession {
  readonly provider: 'codex' | 'claude'
  readonly name: string
  readonly id: string | null
  private closed = false
  private turnCounter = 0

  constructor(provider: 'codex' | 'claude', name: string, id: string) {
    this.provider = provider
    this.name = name
    this.id = id
  }

  getHandle(): AgentSessionHandle {
    return {
      version: 1,
      provider: this.provider,
      sessionId: this.id,
      name: this.name,
      ...(this.id
        ? {
            state: {
              resumeKey: this.id,
            },
          }
        : {}),
    }
  }

  getSessionInfo() {
    return {
      provider: this.provider,
      name: this.name,
      sessionId: this.id,
      handle: this.getHandle(),
      status: this.closed ? ('closed' as const) : ('idle' as const),
      model: 'fixture-model',
      cwd: process.cwd(),
      raw: { fixture: true },
    }
  }

  async run(input: AgentInput): Promise<AgentRunResult> {
    return (await this.start(input)).result
  }

  async stream(_input: AgentInput, options?: AgentRunOptions): Promise<AsyncIterable<AgentEvent>> {
    return (await this.start(_input, options)).events
  }

  async start(input: AgentInput, options?: AgentRunOptions) {
    this.assertOpen()
    this.turnCounter += 1
    const text = typeof input === 'string' ? input : '[non-text input]'
    const provider = this.provider
    const turnId = `turn-${this.turnCounter}`
    const request = {
      provider,
      kind: 'approval.command',
      payload: {
        command: 'echo fixture',
      },
    }
    const userRequest = {
      provider,
      question: 'Continue fixture turn?',
      options: [{ label: 'yes' }, { label: 'no' }],
    }
    const approval = options?.handlers?.onToolApproval ? await options.handlers.onToolApproval(request) : 'deny'
    const answer = options?.handlers?.onUserInput ? await options.handlers.onUserInput(userRequest) : ''
    const answerText = Array.isArray(answer) ? answer.join(',') : String(answer)

    const result = {
      provider,
      sessionId: this.id,
      turnId,
      status: 'completed' as const,
      text: `fixture:${text}`,
      items: [{ type: 'agentMessage', text: `fixture:${text}` }],
      handle: this.getHandle(),
      raw: { fixture: true, turn: this.turnCounter, input: text },
    }

    const events: AgentEvent[] = [
      { provider, type: 'status', status: 'running' },
      { provider, type: 'approval.tool', request },
      { provider, type: 'user.input', request: userRequest },
      { provider, type: 'message.delta', text: `approval=${approval};answer=${answerText}` },
      {
        provider,
        type: 'turn.completed',
        result,
      },
    ]

    return {
      runId: turnId,
      events: {
        [Symbol.asyncIterator]: async function* () {
          for (const event of events) {
            yield event
          }
        },
      },
      result: Promise.resolve(result),
      interrupt: async () => {},
    }
  }

  async interrupt(): Promise<void> {
    this.assertOpen()
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`Fixture session "${this.name}" is closed`)
    }
  }
}

export class FixtureAgentClient implements AgentClient {
  readonly provider: 'codex' | 'claude'
  private readonly sessions = new Map<string, FixtureSession>()
  private seq = 0

  constructor(provider: 'codex' | 'claude') {
    this.provider = provider
  }

  session(name: string, _options?: AgentSessionOptions): AgentSession {
    const existing = this.sessions.get(name)
    if (existing) return existing
    const created = this.newSession(name)
    this.sessions.set(name, created)
    return created
  }

  async openSession(options?: { name?: string }): Promise<AgentSession> {
    const name = options?.name ?? `open-${++this.seq}`
    return this.newSession(name)
  }

  async resumeSession(handle: AgentSessionHandle, options?: { name?: string }): Promise<AgentSession> {
    const name = options?.name ?? handle.name ?? `resume-${++this.seq}`
    return new FixtureSession(this.provider, name, String(handle.state?.resumeKey ?? handle.sessionId ?? `${name}-id`))
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
      account: { fixture: true, provider: this.provider },
      raw: { fixture: true },
    }
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      provider: this.provider,
      sessionLifecycle: { open: true, resume: true, list: false, clearLocalCache: true, deleteRemote: false },
      controls: { interrupt: true, modelSwitch: 'session', permissionModeSwitch: 'none' },
      interactions: { partialMessages: true, toolApproval: true, userInputRequests: true, dynamicToolCalls: false },
      discovery: { inventory: true, modelListing: true, skillsListing: false, skillConfiguration: false },
      semantics: { sessionIdentity: 'opaque', resumeHandle: 'structured', longLivedRuntime: false },
      supportsResume: true,
      supportsInterrupt: true,
      supportsModelSwitch: true,
      supportsPermissionModeSwitch: false,
      supportsPartialMessages: true,
      supportsToolApproval: true,
      supportsUserInputRequests: true,
      raw: { fixture: true },
    }
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.close()
    }
    this.sessions.clear()
  }

  asCodex() {
    return null
  }

  asClaude() {
    return null
  }

  private newSession(name: string): FixtureSession {
    this.seq += 1
    return new FixtureSession(this.provider, name, `${this.provider}-session-${this.seq}`)
  }
}

export function createFixtureAgentClient(provider: 'codex' | 'claude'): AgentClient {
  return new FixtureAgentClient(provider)
}
