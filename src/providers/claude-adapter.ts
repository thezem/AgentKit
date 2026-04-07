import type {
  AgentCapabilities,
  AgentClient,
  AgentSession,
  AgentSessionOptions,
  ClaudeProviderHandle,
  CreateAgentOptions,
} from '../agent-types.ts'
import { mergeAgentSessionOptions } from '../agent-session.ts'
import { ClaudeSession } from './claude-session.ts'
import { getClaudeAvailability, isClaudeAvailable } from './claude-detection.ts'
import type { InternalAgentProvider, ProviderAvailabilityOptions } from './provider-types.ts'

type ClaudeAgentClientOptions = Extract<CreateAgentOptions, { provider: 'claude' }>

class ClaudeClientHandle implements ClaudeProviderHandle {
  private readonly client: ClaudeAgentClient

  constructor(client: ClaudeAgentClient) {
    this.client = client
  }

  getSessionRuntimeMetadata(): { sessionId: string | null; currentModel?: string; currentPermissionMode?: string } | null {
    const latest = this.client.getLastSession()
    return latest ? latest.getRuntimeMetadata() : null
  }

  getLastResumeState(): unknown | null {
    const latest = this.client.getLastSession()
    return latest ? latest.getLastResumeState() : null
  }

  getSessionInfo(): { sessionId: string | null; name: string } | null {
    const latest = this.client.getLastSession()
    return latest ? latest.getSessionInfo() : null
  }
}

class ClaudeAgentClient implements AgentClient {
  readonly provider = 'claude' as const
  private readonly defaults?: AgentSessionOptions
  private readonly createOptions?: ClaudeAgentClientOptions['claude']
  private readonly sessions = new Map<string, ClaudeSession>()
  private readonly handle = new ClaudeClientHandle(this)
  private lastSession: ClaudeSession | null = null

  constructor(createOptions?: ClaudeAgentClientOptions['claude'], defaults?: AgentSessionOptions) {
    this.createOptions = createOptions
    this.defaults = defaults
  }

  session(name: string, options?: AgentSessionOptions): AgentSession {
    const existing = this.sessions.get(name)
    if (existing) return existing

    const merged = mergeAgentSessionOptions(this.defaults, options)
    const session = new ClaudeSession(name, this.createOptions, merged)
    this.sessions.set(name, session)
    this.lastSession = session
    return session
  }

  clearSession(name: string): void {
    const existing = this.sessions.get(name)
    if (!existing) return
    this.sessions.delete(name)
    void existing.close()
  }

  clearSessions(): void {
    for (const session of this.sessions.values()) {
      void session.close()
    }
    this.sessions.clear()
  }

  async getAccountState() {
    return getClaudeAvailability({
      pathToClaudeCodeExecutable: this.createOptions?.pathToClaudeCodeExecutable,
    })
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      provider: 'claude',
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

  async close(): Promise<void> {
    const closing = Array.from(this.sessions.values()).map((session) => session.close())
    this.sessions.clear()
    await Promise.allSettled(closing)
  }

  asCodex() {
    return null
  }

  asClaude(): ClaudeProviderHandle {
    return this.handle
  }

  getLastSession(): ClaudeSession | null {
    return this.lastSession
  }
}

export async function createClaudeAgentClient(options: ClaudeAgentClientOptions): Promise<AgentClient> {
  const available = await isClaudeAvailable({ pathToClaudeCodeExecutable: options.claude?.pathToClaudeCodeExecutable })
  if (!available) {
    throw new Error(
      'Claude provider is not available. Install @anthropic-ai/claude-agent-sdk and verify the Claude executable path.',
    )
  }
  return new ClaudeAgentClient(options.claude, options.defaults)
}

export const claudeProvider: InternalAgentProvider = {
  id: 'claude',
  async isAvailable(options?: ProviderAvailabilityOptions): Promise<boolean> {
    return isClaudeAvailable(options)
  },
  async getAvailability(options?: ProviderAvailabilityOptions) {
    return getClaudeAvailability(options)
  },
  async createClient(options: CreateAgentOptions): Promise<AgentClient> {
    if (options.provider !== 'claude') {
      throw new Error(`claudeProvider cannot handle provider=${options.provider}`)
    }
    return createClaudeAgentClient(options)
  },
}
