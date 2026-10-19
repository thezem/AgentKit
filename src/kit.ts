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
import { ToolHub } from './hub.ts'
import os from 'node:os'
import path from 'node:path'
import { discoverSkills, expandSkillPrompt, searchSkills, type Skill } from './skills.ts'
import type { NativeSkill, PromptInput } from '../capsules/shared/contract.ts'

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
  /**
   * One MCP registry for every provider and model (`kit.hub`). Servers you add there reach
   * Claude, Codex and OpenCode alike. `exclusive` (default true): sessions use only the hub's
   * servers, not each CLI's own MCP config, so nothing shows up twice.
   * Default file: next to `store`, else ~/.agentkit/mcp-servers.json.
   */
  hub?: boolean | { file?: string; exclusive?: boolean }
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
  /** Include the hub's servers (default true when the kit has a hub). */
  hub?: boolean
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
  /** The shared MCP hub, when `hub` is enabled. */
  readonly hub: ToolHub | null
  private readonly hubExclusive: boolean

  constructor(options: AgentKitOptions = {}) {
    this.ttl = options.catalogTtlMs ?? 5 * 60_000
    this.store = typeof options.store === 'string' ? sqliteStore(options.store) : (options.store ?? null)
    this.recovered = this.store?.recover() ?? []
    if (options.hub) {
      const config = options.hub === true ? {} : options.hub
      const file = config.file ?? (typeof options.store === 'string' ? path.join(path.dirname(path.resolve(options.store)), 'mcp-servers.json') : path.join(os.homedir(), '.agentkit', 'mcp-servers.json'))
      this.hub = new ToolHub({ file })
      this.hubExclusive = config.exclusive ?? true
    } else {
      this.hub = null
      this.hubExclusive = false
    }
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
  /**
   * `sources` keeps only models whose `source` is listed (OpenCode: `['opencode-go']` = your Go plan).
   * OpenCode has no plan-entitlement API, so this filters by connection, not by what the account may call.
   */
  async catalog(provider: ProviderId, options: { cwd?: string; force?: boolean; sources?: string[] } = {}): Promise<ProviderCatalog> {
    const key = `${provider}:${options.cwd ?? ''}`
    const hit = this.catalogs.get(key)
    let value: Promise<ProviderCatalog>
    if (hit && !options.force && Date.now() - hit.at < this.ttl) value = hit.value
    else {
      value = this.client(provider).fetchCatalog({ cwd: options.cwd })
      this.catalogs.set(key, { at: Date.now(), value })
      value.catch(() => this.catalogs.delete(key))
    }
    const catalog = await value
    if (!options.sources?.length) return catalog
    const keep = new Set(options.sources)
    const models = catalog.models.filter((m) => m.source !== undefined && keep.has(m.source))
    // Nothing matched (e.g. no Go connection): fall back to everything rather than an empty picker.
    if (!models.length) return catalog
    if (!models.some((m) => m.isDefault)) models[0] = { ...models[0], isDefault: true }
    return { ...catalog, models }
  }

  /** Open a new session on any provider with one shape of options. */
  async session(options: OpenSessionOptions): Promise<AgentSession> {
    const client = this.client(options.provider)
    this.checkConfig(client, options)
    const { modeId, onPermission } = this.resolveAccess(client.provider, options)
    const mcp = await this.mcpFor(client, options)
    const inner = await client.createSession({
      cwd: options.cwd,
      model: options.model,
      modeId,
      thinkingOptionId: options.thinking,
      fast: options.fast,
      systemPrompt: options.systemPrompt,
      ...mcp,
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
      ...(await this.mcpFor(client, options)),
      ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
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

  private readonly skillCache = new Map<string, { at: number; value: Promise<Skill[]> }>()

  /**
   * Every installed skill (project, user, plugin, system), deduped by name, with
   * where copies live and which CLIs load it natively. Cached ~30s per cwd.
   */
  skills(options: { cwd?: string; refresh?: boolean } = {}): Promise<Skill[]> {
    const cwd = options.cwd ?? process.cwd()
    const hit = this.skillCache.get(cwd)
    if (hit && !options.refresh && Date.now() - hit.at < 30_000) return hit.value
    const value = (async () => {
      const native: Partial<Record<ProviderId, NativeSkill[]>> = {}
      await Promise.all(
        [...this.clients.values()]
          .filter((client) => client.listSkills)
          .map(async (client) => {
            if (!(await client.isAvailable().catch(() => false))) return
            native[client.provider] = await client.listSkills!({ cwd }).catch(() => undefined)
          }),
      )
      return discoverSkills({ cwd, native })
    })()
    this.skillCache.set(cwd, { at: Date.now(), value })
    value.catch(() => this.skillCache.delete(cwd))
    return value
  }

  /** For your `/` menu: exact name, then prefix, word, substring, fuzzy, then description. */
  async searchSkills(query: string, options: { cwd?: string; limit?: number; nativeTo?: ProviderId } = {}): Promise<Skill[]> {
    return searchSkills(await this.skills(options), query, options)
  }

  /** What `submit` would send for this provider (preview / your own transport). */
  async expandSkills(prompt: PromptInput, options: { provider: ProviderId; cwd?: string; mode?: 'reference' | 'inline' }): Promise<{ prompt: PromptInput; invoked: Skill[] }> {
    return expandSkillPrompt(prompt, { provider: options.provider, mode: options.mode, skills: await this.skills({ cwd: options.cwd }) })
  }

  /** Session MCP config: the hub's servers (as loopback URLs) plus any you pass explicitly. */
  private async mcpFor(client: ProviderClient, options: { mcpServers?: Record<string, McpServerConfig>; hub?: boolean }): Promise<{ mcpServers?: Record<string, McpServerConfig>; mcp?: { exclusive?: boolean; shared?: boolean } }> {
    if (!this.hub || options.hub === false || !client.capabilities.mcpServers) return options.mcpServers ? { mcpServers: options.mcpServers } : {}
    await this.hub.start()
    return { mcpServers: { ...this.hub.mcpServers(), ...(options.mcpServers ?? {}) }, mcp: { exclusive: this.hubExclusive, shared: true } }
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
    await this.hub?.close()
    this.store?.close()
  }

  private track(inner: Awaited<ReturnType<ProviderClient['createSession']>>, handlers: SessionHandlers, key: string = randomUUID(), meta?: Record<string, unknown>): AgentSession {
    const session: AgentSession = new AgentSession(inner, handlers, {
      key,
      store: this.store,
      registry: this.submissions,
      skills: (cwd) => this.skills({ cwd }),
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
