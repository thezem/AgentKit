import { createClaudeCodeClient, type ClaudeCodeCapsuleConfig } from '../capsules/claude-code/index.ts'
import { createCodexClient, type CodexCapsuleConfig } from '../capsules/codex/index.ts'
import { createMockClient, type MockCapsuleConfig } from '../capsules/mock/index.ts'
import { createOpenCodeClient, type OpenCodeCapsuleConfig } from '../capsules/opencode/index.ts'
import type {
  Capabilities,
  McpServerConfig,
  PersistenceHandle,
  ProviderCatalog,
  ProviderClient,
  ProviderId,
  SessionConfig,
  SessionSummary,
} from '../capsules/shared/contract.ts'
import { AgentKitError, UnsupportedCapabilityError } from './errors.ts'
import { modeForAccess, policies, type AccessLevel, type PermissionHandler } from './policy.ts'
import { AgentSession, storedSubmission, type SessionHandlers, type Submission } from './session.ts'
import { sqliteStore, type AgentStore, type StoredSession, type SubmissionRecord } from './store.ts'
import { randomUUID } from 'node:crypto'

export interface AgentKitOptions {
  /** Built-in capsules. `false` disables one. Mock is off unless configured. */
  claude?: ClaudeCodeCapsuleConfig | false
  codex?: CodexCapsuleConfig | false
  opencode?: OpenCodeCapsuleConfig | false
  mock?: MockCapsuleConfig | boolean
  /** Bring your own capsule (anything implementing ProviderClient). */
  providers?: ProviderClient[]
  /** How long catalogs stay cached. Default 5 min. */
  catalogTtlMs?: number
  /**
   * Durable store: a sqlite file path (node:sqlite, no deps) or your own AgentStore.
   * Events are written before they are shown; turns cut off by a crash come back
   * as `interrupted` and are never re-sent.
   */
  store?: string | AgentStore
}

export interface OpenSessionOptions extends Omit<SessionConfig, 'modeId' | 'thinkingOptionId'> {
  provider: ProviderId
  /** Native mode id (wins over `access`). */
  mode?: string
  /** Provider-neutral access level, mapped to each provider's native mode. */
  access?: AccessLevel
  /** Reasoning effort / thinking variant id from the model's `thinkingOptions`. */
  thinking?: string
  onPermission?: PermissionHandler
  onEvent?: SessionHandlers['onEvent']
  /** Stable id for the store. Default: a random uuid. */
  key?: string
  /** Your app data saved next to the session (title, settings...). */
  meta?: Record<string, unknown>
}

export interface ProviderStatus {
  provider: ProviderId
  label: string
  available: boolean
  capabilities: Capabilities
}

export type ResumeOptions = Partial<Omit<OpenSessionOptions, 'provider'>>

export class AgentKit {
  private readonly clients = new Map<ProviderId, ProviderClient>()
  private readonly catalogs = new Map<string, { at: number; value: Promise<ProviderCatalog> }>()
  private readonly sessions = new Set<AgentSession>()
  private readonly ttl: number
  private readonly submissions = new Map<string, Submission>()
  /** The durable store, if configured. */
  readonly store: AgentStore | null
  /** Submissions found cut off by a previous crash when this kit opened the store. */
  readonly recovered: SubmissionRecord[]

  constructor(options: AgentKitOptions = {}) {
    this.ttl = options.catalogTtlMs ?? 5 * 60_000
    this.store = typeof options.store === 'string' ? sqliteStore(options.store) : (options.store ?? null)
    this.recovered = this.store?.recover() ?? []
    if (options.claude !== false) this.register(createClaudeCodeClient(options.claude || {}))
    if (options.codex !== false) this.register(createCodexClient(options.codex || {}))
    if (options.opencode !== false) this.register(createOpenCodeClient(options.opencode || {}))
    if (options.mock) this.register(createMockClient(options.mock === true ? {} : options.mock))
    for (const client of options.providers ?? []) this.register(client)
  }

  /** Add or replace a provider capsule. */
  register(client: ProviderClient): void {
    this.clients.set(client.provider, client)
  }

  client(provider: ProviderId): ProviderClient {
    const client = this.clients.get(provider)
    if (!client) throw new AgentKitError('UNKNOWN_PROVIDER', `unknown provider "${provider}"; registered: ${[...this.clients.keys()].join(', ')}`)
    return client
  }

  get providerIds(): ProviderId[] {
    return [...this.clients.keys()]
  }

  /** Which providers are installed, plus what each can do. Probes run in parallel. */
  async providers(): Promise<ProviderStatus[]> {
    return Promise.all(
      [...this.clients.values()].map(async (client) => ({
        provider: client.provider,
        label: client.label,
        available: await client.isAvailable().catch(() => false),
        capabilities: client.capabilities,
      })),
    )
  }

  /** Models + modes for a provider (cached). Use it to render model / mode / thinking pickers. */
  catalog(provider: ProviderId, options: { cwd?: string; force?: boolean } = {}): Promise<ProviderCatalog> {
    const key = `${provider}:${options.cwd ?? ''}`
    const hit = this.catalogs.get(key)
    if (hit && !options.force && Date.now() - hit.at < this.ttl) return hit.value
    const value = this.client(provider).fetchCatalog({ cwd: options.cwd })
    this.catalogs.set(key, { at: Date.now(), value })
    value.catch(() => this.catalogs.delete(key))
    return value
  }

  /** Open a new session on any provider with one shape of options. */
  async session(options: OpenSessionOptions): Promise<AgentSession> {
    const client = this.client(options.provider)
    this.checkConfig(client, options)
    const { modeId, onPermission } = this.resolveAccess(client.provider, options)
    const inner = await client.createSession({
      cwd: options.cwd,
      model: options.model,
      modeId,
      thinkingOptionId: options.thinking,
      fast: options.fast,
      systemPrompt: options.systemPrompt,
      mcpServers: options.mcpServers,
      title: options.title,
      env: options.env,
      providerOptions: options.providerOptions,
      persist: options.persist,
    })
    return this.track(inner, { onPermission, onEvent: options.onEvent }, options.key, options.meta)
  }

  /** Reattach to a durable session (same or a different process) from `session.handle`. */
  async resume(handle: PersistenceHandle, options: ResumeOptions = {}): Promise<AgentSession> {
    const client = this.client(handle.provider)
    this.checkConfig(client, options)
    const { modeId, onPermission } = this.resolveAccess(client.provider, options)
    const inner = await client.resumeSession(handle, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(modeId ? { modeId } : {}),
      ...(options.thinking ? { thinkingOptionId: options.thinking } : {}),
      ...(options.fast !== undefined ? { fast: options.fast } : {}),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
      ...(options.env ? { env: options.env } : {}),
    })
    return this.track(inner, { onPermission, onEvent: options.onEvent }, options.key, options.meta)
  }

  /**
   * Reopen a stored session by key: native resume + the saved transcript
   * (including anything shown before a crash). Needs a store.
   */
  async restore(key: string, options: ResumeOptions = {}): Promise<AgentSession> {
    const store = this.requireStore()
    const saved = store.getSession(key)
    if (!saved) throw new AgentKitError('INVALID_INPUT', `no stored session "${key}"`)
    if (!saved.handle) throw new AgentKitError('INVALID_INPUT', `stored session "${key}" has no resume handle yet`)
    const transcript = store.loadTranscript(key)
    const session = await this.resume(saved.handle, { ...options, key, meta: options.meta ?? saved.meta })
    session.hydrate(transcript)
    return session
  }

  /** Sessions in the store, newest first. */
  storedSessions(): StoredSession[] {
    return this.requireStore().listSessions()
  }

  /**
   * Reattach to a submission by id — live in this process, or from the store
   * (a previous run, or another process sharing the file). Null if unknown.
   */
  submission(id: string): Submission | null {
    const live = this.submissions.get(id)
    if (live) return live
    const stored = this.store?.getSubmission(id)
    return stored ? storedSubmission(stored, this.store!) : null
  }

  private requireStore(): AgentStore {
    if (!this.store) throw new AgentKitError('INVALID_INPUT', 'no store configured; pass createAgentKit({ store: "path/to/agentkit.db" })')
    return this.store
  }

  /** Native sessions across providers, newest first. Each summary is resumable via `resume({ provider, sessionId, cwd })`. */
  async listSessions(options: { provider?: ProviderId; cwd?: string; limit?: number; query?: string } = {}): Promise<SessionSummary[]> {
    const targets = options.provider ? [this.client(options.provider)] : [...this.clients.values()]
    const lists = await Promise.all(
      targets.filter((client) => client.capabilities.sessionListing && client.listSessions).map((client) => client.listSessions!(options).catch(() => [] as SessionSummary[])),
    )
    return lists
      .flat()
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, options.limit ?? 100)
  }

  async archive(handle: PersistenceHandle): Promise<void> {
    const client = this.client(handle.provider)
    if (!client.capabilities.archive || !client.archiveSession) throw new UnsupportedCapabilityError(client.provider, 'archive')
    await client.archiveSession(handle)
  }

  /** Close every open session and stop background processes. */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.sessions].map((session) => session.close()))
    await Promise.allSettled([...this.clients.values()].map((client) => client.shutdown()))
    this.store?.close()
  }

  private track(inner: Awaited<ReturnType<ProviderClient['createSession']>>, handlers: SessionHandlers, key: string = randomUUID(), meta?: Record<string, unknown>): AgentSession {
    const session: AgentSession = new AgentSession(inner, handlers, {
      key,
      store: this.store,
      registry: this.submissions,
      open: (handle, forkKey) => this.resume(handle, { key: forkKey, onPermission: handlers.onPermission, onEvent: handlers.onEvent }),
      onClose: () => this.sessions.delete(session),
    })
    this.store?.putSession(key, { provider: inner.provider, handle: inner.describePersistence(), ...(meta ? { meta } : {}) })
    this.sessions.add(session)
    return session
  }

  private checkConfig(client: ProviderClient, options: { mcpServers?: Record<string, McpServerConfig>; systemPrompt?: string; fast?: boolean }): void {
    if (options.mcpServers && Object.keys(options.mcpServers).length && !client.capabilities.mcpServers) throw new UnsupportedCapabilityError(client.provider, 'mcpServers')
    if (options.fast && !client.capabilities.fastMode) throw new UnsupportedCapabilityError(client.provider, 'fastMode')
    if (options.systemPrompt && !client.capabilities.systemPrompt) throw new UnsupportedCapabilityError(client.provider, 'systemPrompt')
  }

  /**
   * Turn `access` into a native mode. Where the provider has no native unattended
   * mode (OpenCode), full-access is enforced with an allow-all handler instead.
   */
  private resolveAccess(provider: ProviderId, options: { mode?: string; access?: AccessLevel; onPermission?: PermissionHandler }) {
    const modeId = options.mode ?? (options.access ? modeForAccess(provider, options.access) : undefined)
    let onPermission = options.onPermission
    if (!options.mode && options.access) {
      const native = modeForAccess(provider, options.access)
      const nativeIsUnattended = (provider === 'claude' && native === 'bypassPermissions') || (provider === 'codex' && native === 'full-access') || (provider === 'mock' && native === 'auto')
      if (options.access === 'full-access' && !nativeIsUnattended) onPermission = onPermission ? policies.firstOf(onPermission, policies.allowAll()) : policies.allowAll()
      if (options.access === 'auto-edit' && provider === 'opencode') onPermission = onPermission ? policies.firstOf(onPermission, policies.acceptEdits()) : policies.acceptEdits()
    }
    return { modeId, onPermission }
  }
}

export function createAgentKit(options?: AgentKitOptions): AgentKit {
  return new AgentKit(options)
}
