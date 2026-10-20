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
import type { CompleteOptions, CompleteResult, NativeSkill, PlanUsage, PromptInput } from '../capsules/shared/contract.ts'
import { pageTranscript, type Transcript } from './transcript.ts'

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
  /** How long `providers()` reuses an availability probe. Default 60s. */
  availabilityTtlMs?: number
  /**
   * Durable store: a sqlite file path (node:sqlite, no deps) or your own AgentStore.
   * Events are written before they are shown; turns cut off by a crash come back
   * as `interrupted` and are never re-sent.
   */
  store?: string | AgentStore
  /**
   * `kit.hub` always exists: one MCP registry (servers + native tools) for every provider and model.
   * Sessions get its enabled servers automatically; an empty hub costs nothing (no port, no config).
   * - unset: the hub's servers are added next to each CLI's own MCP config.
   * - `true` / `{ exclusive: true }` (the default once you pass it): the hub is the only MCP list;
   *   each CLI's own config is switched off for AgentKit threads so nothing shows up twice.
   * - `false`: sessions never get hub servers (kit.hub stays usable, in memory only).
   * Default file: next to `store`, else ~/.agentkit/mcp-servers.json.
   */
  hub?: boolean | { file?: string; exclusive?: boolean }
  /**
   * Where `submit(..., { attachments })` saves files: `<dir>/<session key>/<submission id>/<name>`.
   * Every session may read this folder without asking. Default: `attachments/` next to `store`, else ~/.agentkit/attachments.
   */
  attachments?: { dir?: string }
  /** How long `planUsage()` reuses a reading. Default 60s. */
  planUsageTtlMs?: number
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
  private readonly availTtl: number
  private readonly availability = new Map<ProviderId, { at: number; value: Promise<boolean> }>()
  private readonly submissions = new Map<string, Submission>()
  /** The durable store, if configured. */
  readonly store: AgentStore | null
  /** Submissions found cut off by a previous crash when this kit opened the store. */
  readonly recovered: SubmissionRecord[]
  /** The shared MCP hub: servers and native tools for every provider. */
  readonly hub: ToolHub
  private readonly hubExclusive: boolean
  private readonly hubWired: boolean
  /** Root folder for prompt attachments (readable by every session). */
  readonly attachmentsDir: string
  private readonly planTtl: number
  private readonly planUsageCache = new Map<ProviderId, { at: number; value: Promise<PlanUsage> }>()

  constructor(options: AgentKitOptions = {}) {
    this.ttl = options.catalogTtlMs ?? 5 * 60_000
    this.availTtl = options.availabilityTtlMs ?? 60_000
    this.store = typeof options.store === 'string' ? sqliteStore(options.store) : (options.store ?? null)
    this.recovered = this.store?.recover() ?? []
    const hubConfig = typeof options.hub === 'object' ? options.hub : {}
    const defaultFile = typeof options.store === 'string' ? path.join(path.dirname(path.resolve(options.store)), 'mcp-servers.json') : path.join(os.homedir(), '.agentkit', 'mcp-servers.json')
    this.hubWired = options.hub !== false
    this.hub = new ToolHub({ file: options.hub === false ? undefined : (hubConfig.file ?? defaultFile) })
    this.hubExclusive = options.hub === undefined ? false : (hubConfig.exclusive ?? true)
    this.attachmentsDir = path.resolve(
      options.attachments?.dir ?? (typeof options.store === 'string' ? path.join(path.dirname(path.resolve(options.store)), 'attachments') : path.join(os.homedir(), '.agentkit', 'attachments')),
    )
    this.planTtl = options.planUsageTtlMs ?? 60_000
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

  /**
   * Which providers are installed, plus what each can do. Probes run in parallel and are cached
   * (`availabilityTtlMs`, default 60s); `{ force: true }` re-probes. For capabilities alone use `capabilities()`.
   */
  async providers(options: { force?: boolean } = {}): Promise<ProviderStatus[]> {
    return Promise.all(
      [...this.clients.values()].map(async (client) => ({
        provider: client.provider,
        label: client.label,
        available: await this.available(client, options.force),
        capabilities: client.capabilities,
      })),
    )
  }

  /** Static capabilities of a provider. Synchronous, no CLI probe. */
  capabilities(provider: ProviderId): Capabilities {
    return this.client(provider).capabilities
  }

  private available(client: ProviderClient, force?: boolean): Promise<boolean> {
    const hit = this.availability.get(client.provider)
    if (hit && !force && Date.now() - hit.at < this.availTtl) return hit.value
    const value = client.isAvailable().catch(() => false)
    this.availability.set(client.provider, { at: Date.now(), value })
    return value
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
    const key = options.key ?? randomUUID()
    const { token, ...mcp } = await this.mcpFor(client, options, { sessionKey: key, cwd: options.cwd })
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
      readableDirs: [...(options.readableDirs ?? []), this.attachmentsDir],
    }).catch((error) => {
      if (token) this.hub.release(token)
      throw error
    })
    return this.track(inner, { onPermission, onEvent: options.onEvent }, key, options.meta, token)
  }

  /** Reattach to a durable session (same or a different process) from `session.handle`. */
  async resume(handle: PersistenceHandle, options: ResumeOptions = {}): Promise<AgentSession> {
    const client = this.client(handle.provider)
    this.checkConfig(client, options)
    const { modeId, onPermission } = this.resolveAccess(client.provider, options)
    const key = options.key ?? randomUUID()
    const { token, ...mcp } = await this.mcpFor(client, options, { sessionKey: key, cwd: options.cwd ?? handle.cwd ?? null })
    const inner = await client.resumeSession(handle, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(modeId ? { modeId } : {}),
      ...(options.thinking ? { thinkingOptionId: options.thinking } : {}),
      ...(options.fast !== undefined ? { fast: options.fast } : {}),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...mcp,
      ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
      ...(options.env ? { env: options.env } : {}),
      readableDirs: [...(options.readableDirs ?? []), this.attachmentsDir],
    }).catch((error) => {
      if (token) this.hub.release(token)
      throw error
    })
    return this.track(inner, { onPermission, onEvent: options.onEvent }, key, options.meta, token)
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

  /**
   * A page of a session's transcript: the latest `limit` items (default 100) before `before`,
   * plus all current state. Walk back with `before: page.itemsOffset` until it is 0.
   * Live sessions in this process are read from memory, others from the store.
   */
  transcriptPage(key: string, options: { limit?: number; before?: number } = {}): Transcript {
    const live = [...this.sessions].find((session) => session.key === key)
    const transcript = live ? live.transcript : this.requireStore().loadTranscript(key)
    return pageTranscript(transcript, options)
  }

  /**
   * The signed-in account's plan rate-limit windows (5-hour, weekly…), normalized. Cached
   * (`planUsageTtlMs`, default 60s); `{ force: true }` re-reads. Unsupported → UNSUPPORTED_CAPABILITY.
   */
  async planUsage(provider: ProviderId, options: { force?: boolean } = {}): Promise<PlanUsage> {
    const client = this.client(provider)
    if (!client.capabilities.planUsage || !client.planUsage) throw new UnsupportedCapabilityError(provider, 'planUsage')
    const hit = this.planUsageCache.get(provider)
    if (hit && !options.force && Date.now() - hit.at < this.planTtl) return hit.value
    const value = client.planUsage()
    this.planUsageCache.set(provider, { at: Date.now(), value })
    value.catch(() => this.planUsageCache.delete(provider))
    return value
  }

  /**
   * One-shot completion: no tools, no session left behind, nothing in `listSessions()` or the store.
   * For titles, summaries, commit messages. Same provider/model choices as a session.
   */
  async complete(provider: ProviderId, prompt: string, options: CompleteOptions = {}): Promise<CompleteResult> {
    const client = this.client(provider)
    if (!client.capabilities.complete || !client.complete) throw new UnsupportedCapabilityError(provider, 'complete')
    if (!prompt.trim()) throw new AgentKitError('INVALID_INPUT', 'complete() needs a prompt', { provider })
    return client.complete(prompt, options)
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

  /** Session MCP config: the hub's servers (session-scoped loopback URLs) plus any you pass explicitly. */
  private async mcpFor(
    client: ProviderClient,
    options: { mcpServers?: Record<string, McpServerConfig>; hub?: boolean },
    context: { sessionKey: string; cwd?: string | null },
  ): Promise<{ mcpServers?: Record<string, McpServerConfig>; mcp?: { exclusive?: boolean; shared?: boolean }; token?: string }> {
    const plain = options.mcpServers ? { mcpServers: options.mcpServers } : {}
    // Empty hub / opted out / provider without MCP: leave the CLI exactly as it was.
    if (!this.hubWired || options.hub === false || !client.capabilities.mcpServers || !this.hub.active) return plain
    await this.hub.start()
    const token = this.hub.bind({ sessionKey: context.sessionKey, provider: client.provider, cwd: context.cwd ?? null })
    return { mcpServers: { ...this.hub.mcpServers(token), ...(options.mcpServers ?? {}) }, mcp: { exclusive: this.hubExclusive, shared: true }, token }
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
    await this.hub.close()
    this.store?.close()
  }

  private track(inner: Awaited<ReturnType<ProviderClient['createSession']>>, handlers: SessionHandlers, key: string = randomUUID(), meta?: Record<string, unknown>, hubToken?: string): AgentSession {
    const session: AgentSession = new AgentSession(inner, handlers, {
      key,
      store: this.store,
      registry: this.submissions,
      skills: (cwd) => this.skills({ cwd }),
      attachmentsDir: this.attachmentsDir,
      open: (handle, forkKey) => this.resume(handle, { key: forkKey, onPermission: handlers.onPermission, onEvent: handlers.onEvent }),
      onClose: () => {
        this.sessions.delete(session)
        if (hubToken) this.hub.release(hubToken)
      },
      // Interrupt cancels native tool calls right away, not when the provider gets around to it.
      onInterrupt: hubToken ? () => this.hub.abortCalls(hubToken, 'interrupted by the user') : undefined,
    })
    if (hubToken) session.on((event) => (event.type === 'turn_canceled' || event.type === 'turn_interrupted' ? this.hub.abortCalls(hubToken, 'turn canceled') : undefined))
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
