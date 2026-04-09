import type {
  AgentCapabilities,
  AgentClient,
  AgentModelInfo,
  AgentModelListOptions,
  AgentOpenSessionOptions,
  AgentProviderInventory,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionHandle,
  AgentSessionOptions,
  ClaudeProviderHandle,
  CreateAgentOptions,
  ProviderInventoryOptions,
} from '../agent-types.ts'
import { mergeAgentSessionOptions } from '../agent-session.ts'
import { validateSessionHandle } from '../handle.ts'
import { claudeCapabilities, getClaudeAvailability, getClaudeInventory, isClaudeAvailable } from './claude-detection.ts'
import { listClaudeModels } from './claude-models.ts'
import { ClaudeSession } from './claude-session.ts'
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
    if (!latest) return null
    const info = latest.getSessionInfo()
    return {
      sessionId: info.sessionId,
      name: info.name ?? latest.name,
    }
  }
}

class ClaudeAgentClient implements AgentClient {
  readonly provider = 'claude' as const
  private readonly defaults?: AgentSessionOptions
  private readonly createOptions?: ClaudeAgentClientOptions['claude']
  private readonly sessions = new Map<string, ClaudeSession>()
  private readonly handle = new ClaudeClientHandle(this)
  private lastSession: ClaudeSession | null = null
  private unnamedCounter = 0

  constructor(createOptions?: ClaudeAgentClientOptions['claude'], defaults?: AgentSessionOptions) {
    this.createOptions = createOptions
    this.defaults = defaults
  }

  session(name: string, options?: AgentSessionOptions): AgentSession {
    const existing = this.sessions.get(name)
    if (existing && !existing.isClosed()) return existing

    const merged = mergeAgentSessionOptions(this.defaults, options)
    const session = new ClaudeSession(name, this.createOptions, merged, (sessionName, current) => {
      if (this.sessions.get(sessionName) === current) {
        this.sessions.delete(sessionName)
      }
    })
    this.sessions.set(name, session)
    this.lastSession = session
    return session
  }

  async openSession(options?: AgentOpenSessionOptions): Promise<AgentSession> {
    const name = options?.name ?? this.newSessionName('claude-open')
    const merged = mergeAgentSessionOptions(this.defaults, options)
    const session = new ClaudeSession(name, this.createOptions, merged)
    this.lastSession = session
    return session
  }

  async resumeSession(handle: AgentSessionHandle, options?: AgentResumeSessionOptions): Promise<AgentSession> {
    const validated = validateSessionHandle(handle)
    if (validated.provider !== 'claude') {
      throw new Error(`Cannot resume provider=${validated.provider} with claude client`)
    }

    const resume = validated.state?.resumeKey ?? validated.sessionId ?? undefined
    if (!resume) {
      throw new Error('Claude resume handle requires resumeKey or sessionId')
    }

    const name = options?.name ?? validated.name ?? this.newSessionName('claude-resume')
    const merged = mergeAgentSessionOptions(this.defaults, options)
    const session = new ClaudeSession(
      name,
      {
        ...(this.createOptions ?? {}),
        resume,
        ...(validated.state?.resumeAt ? { resumeSessionAt: validated.state.resumeAt } : {}),
      },
      merged,
    )

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
    return claudeCapabilities()
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

  private newSessionName(prefix: string): string {
    this.unnamedCounter += 1
    return `${prefix}-${this.unnamedCounter}`
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
  async getInventory(options?: ProviderInventoryOptions): Promise<AgentProviderInventory> {
    return getClaudeInventory(options)
  },
  async isAvailable(options?: ProviderInventoryOptions): Promise<boolean> {
    return isClaudeAvailable(options)
  },
  async getAvailability(options?: ProviderAvailabilityOptions) {
    return getClaudeAvailability(options)
  },
  async listModels(options?: AgentModelListOptions): Promise<AgentModelInfo[]> {
    const models = listClaudeModels().filter((model) => options?.includeHidden === true || model.hidden !== true)
    if (typeof options?.limit === 'number' && options.limit >= 0) {
      return models.slice(0, options.limit)
    }
    return models
  },
  async createClient(options: CreateAgentOptions): Promise<AgentClient> {
    if (options.provider !== 'claude') {
      throw new Error(`claudeProvider cannot handle provider=${options.provider}`)
    }
    return createClaudeAgentClient(options)
  },
}
