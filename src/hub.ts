import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig } from '../capsules/shared/contract.ts'

/**
 * One MCP registry for every provider and model.
 *
 * You add servers once (a command, a remote URL, or plain functions). The hub connects
 * to each upstream once, shares it across sessions, and serves every server on
 * `http://127.0.0.1:<port>/<secret>/<name>`. Claude, Codex and OpenCode all get those
 * same URLs, so a tool you add here reaches every model.
 */

export type HubTransport =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'http'; url: string; headers?: Record<string, string> }

export type HubLoad = 'on-demand' | 'always'
export type HubStatus = 'off' | 'starting' | 'connected' | 'failed' | 'needs_auth'

export interface HubServerConfig {
  name: string
  transport: HubTransport
  enabled: boolean
  /** 'always' keeps the tools in every thread's context (Claude `alwaysLoad`); others always load anyway. */
  load: HubLoad
  /** Where it came from: you, or an import from a CLI config. */
  source?: 'user' | 'claude' | 'codex' | 'opencode'
}

export interface HubTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface HubServerState extends HubServerConfig {
  kind: 'upstream' | 'native'
  status: HubStatus
  error?: string
  tools: HubTool[]
}

export interface NativeTool {
  name: string
  description: string
  /** JSON Schema for the arguments. Default: no arguments. */
  inputSchema?: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<unknown> | unknown
}

export type HubEvent =
  | { type: 'status'; server: HubServerState }
  | { type: 'removed'; name: string }
  | { type: 'call'; server: string; tool: string; ok: boolean; ms: number; error?: string }

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/
const IN_PROCESS = '(in-process)'
const isPlaceholder = (c: HubServerConfig) => c.transport.type === 'stdio' && c.transport.command === IN_PROCESS
const CALL_TIMEOUT_MS = 120_000

// ------------------------------------------------------------------ upstream

class Upstream {
  config: HubServerConfig
  status: HubStatus = 'off'
  error: string | undefined
  tools: HubTool[] = []
  private client: Client | null = null
  private connecting: Promise<void> | null = null
  private closing = false
  private readonly onChange: () => void

  constructor(config: HubServerConfig, onChange: () => void) {
    this.config = config
    this.onChange = onChange
  }

  connect(): Promise<void> {
    if (this.status === 'connected' && this.client) return Promise.resolve()
    this.connecting ??= this.open().finally(() => (this.connecting = null))
    return this.connecting
  }

  private async open(): Promise<void> {
    this.closing = false
    this.set('starting')
    const stderr: string[] = []
    try {
      const client = new Client({ name: 'agentkit-hub', version: '0.2.0' })
      client.onclose = () => {
        if (this.closing || this.client !== client) return
        this.client = null
        this.set('failed', `disconnected${stderr.length ? `: ${stderr.join('').trim().split('\n').slice(-2).join(' ')}` : ''}`)
      }
      const t = this.config.transport
      if (t.type === 'stdio') {
        const transport = new StdioClientTransport({ command: t.command, args: t.args ?? [], env: { ...getDefaultEnvironment(), ...(t.env ?? {}) }, cwd: t.cwd, stderr: 'pipe' })
        transport.stderr?.on('data', (chunk: Buffer) => {
          stderr.push(chunk.toString())
          if (stderr.length > 20) stderr.shift()
        })
        await withTimeout(client.connect(transport), 30_000, 'start')
      } else {
        const url = new URL(t.url)
        const init = { requestInit: { headers: t.headers ?? {} } }
        try {
          await withTimeout(client.connect(new StreamableHTTPClientTransport(url, init)), 30_000, 'connect')
        } catch (error) {
          if (isAuthError(error)) throw error
          // Older servers only speak SSE.
          await withTimeout(client.connect(new SSEClientTransport(url, init)), 30_000, 'connect (sse)')
        }
      }
      this.client = client
      this.tools = await this.listAll(client)
      this.set('connected')
    } catch (error) {
      await this.client?.close().catch(() => undefined)
      this.client = null
      const tail = stderr.join('').trim().split('\n').slice(-2).join(' ')
      this.set(isAuthError(error) ? 'needs_auth' : 'failed', `${message(error)}${tail ? ` (${tail})` : ''}`)
    }
  }

  private async listAll(client: Client): Promise<HubTool[]> {
    const tools: HubTool[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      for (const tool of page.tools) tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Record<string, unknown> })
      cursor = page.nextCursor
    } while (cursor)
    return tools
  }

  async call(tool: string, args: Record<string, unknown>): Promise<any> {
    if (this.status !== 'connected') await this.connect()
    if (!this.client) throw new Error(`${this.config.name} is ${this.status}${this.error ? `: ${this.error}` : ''}`)
    return this.client.callTool({ name: tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })
  }

  async close(): Promise<void> {
    this.closing = true
    const client = this.client
    this.client = null
    await client?.close().catch(() => undefined)
    this.tools = []
    this.set('off')
  }

  private set(status: HubStatus, error?: string): void {
    this.status = status
    this.error = error
    this.onChange()
  }
}

// ------------------------------------------------------------------ hub

export class ToolHub {
  private readonly file: string | null
  private readonly configs = new Map<string, HubServerConfig>()
  private readonly upstreams = new Map<string, Upstream>()
  private readonly natives = new Map<string, NativeTool[]>()
  private readonly listeners = new Set<(event: HubEvent) => void>()
  private readonly secret = randomBytes(18).toString('base64url')
  private server: http.Server | null = null
  private starting: Promise<void> | null = null
  private port = 0

  constructor(options: { file?: string } = {}) {
    this.file = options.file ?? null
    for (const config of this.load()) this.configs.set(config.name, config)
  }

  // ---------------------------------------------------------------- lifecycle

  /** Bind the loopback endpoint and connect enabled upstreams (in the background). Idempotent. */
  start(): Promise<void> {
    this.starting ??= new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res))
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.server = server
        this.port = (server.address() as AddressInfo).port
        for (const config of this.configs.values()) if (config.enabled && !this.natives.has(config.name) && !isPlaceholder(config)) void this.upstream(config).connect()
        resolve()
      })
    })
    return this.starting
  }

  async close(): Promise<void> {
    await Promise.all([...this.upstreams.values()].map((u) => u.close()))
    const server = this.server
    // close() waits for idle keep-alive sockets from the CLIs; drop them.
    await new Promise<void>((resolve) => (server ? (server.close(() => resolve()), server.closeAllConnections()) : resolve()))
    this.server = null
    this.starting = null
  }

  on(listener: (event: HubEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ---------------------------------------------------------------- registry

  list(): HubServerState[] {
    return [...this.configs.values()].map((c) => this.state(c.name)!).sort((a, b) => a.name.localeCompare(b.name))
  }

  get(name: string): HubServerState | null {
    return this.state(name)
  }

  /** Add a command or remote server. Saved, then connected right away. */
  async add(input: { name: string; transport: HubTransport; enabled?: boolean; load?: HubLoad; source?: HubServerConfig['source'] }): Promise<HubServerState> {
    if (!NAME.test(input.name)) throw new Error('name: letters, digits, "-" and "_" only (max 63)')
    if (this.configs.has(input.name)) throw new Error(`a server named "${input.name}" already exists`)
    validateTransport(input.transport)
    const config: HubServerConfig = { name: input.name, transport: input.transport, enabled: input.enabled ?? true, load: input.load ?? 'on-demand', source: input.source ?? 'user' }
    this.configs.set(config.name, config)
    this.save()
    if (config.enabled && this.server) await this.upstream(config).connect()
    else this.emitState(config.name)
    return this.state(config.name)!
  }

  /** Turn on/off, switch On demand / Always, or replace the transport. Applies to threads started after this. */
  async update(name: string, patch: { enabled?: boolean; load?: HubLoad; transport?: HubTransport }): Promise<HubServerState> {
    const config = this.configs.get(name)
    if (!config) throw new Error(`no server named "${name}"`)
    if (patch.transport) validateTransport(patch.transport)
    const next: HubServerConfig = { ...config, ...patch }
    this.configs.set(name, next)
    this.save()
    if (!this.natives.has(name)) {
      const transportChanged = patch.transport !== undefined
      if (transportChanged || next.enabled === false) await this.upstreams.get(name)?.close()
      if (transportChanged) this.upstreams.delete(name)
      if (next.enabled && this.server) await this.upstream(next).connect()
    }
    this.emitState(name)
    return this.state(name)!
  }

  async remove(name: string): Promise<void> {
    if (this.natives.has(name)) throw new Error(`"${name}" is built into the app; turn it off instead`)
    if (!this.configs.has(name)) throw new Error(`no server named "${name}"`)
    await this.upstreams.get(name)?.close()
    this.upstreams.delete(name)
    this.configs.delete(name)
    this.save()
    this.emit({ type: 'removed', name })
  }

  /** Reconnect one server (or all enabled) and re-read its tools. */
  async refresh(name?: string): Promise<void> {
    const names = name ? [name] : [...this.configs.values()].filter((c) => c.enabled).map((c) => c.name)
    await Promise.all(
      names
        .filter((n) => !this.natives.has(n) && !isPlaceholder(this.configs.get(n)!))
        .map(async (n) => {
          const up = this.upstreams.get(n)
          await up?.close()
          await this.upstream(this.configs.get(n)!).connect()
        }),
    )
  }

  /**
   * Register in-process tools as a server named `name`. Not saved (they live in your code);
   * the on/off and load toggles you set for it are.
   */
  addTools(name: string, tools: NativeTool[], options: { load?: HubLoad } = {}): void {
    if (!NAME.test(name)) throw new Error('name: letters, digits, "-" and "_" only')
    const existing = this.configs.get(name)
    if (existing && !isPlaceholder(existing)) throw new Error(`"${name}" is already an external server`)
    this.natives.set(name, tools)
    const saved = this.configs.get(name)
    this.configs.set(name, { name, transport: { type: 'stdio', command: IN_PROCESS }, enabled: saved?.enabled ?? true, load: saved?.load ?? options.load ?? 'on-demand', source: 'user' })
    this.emitState(name)
  }

  /** MCP configs for a new session: every enabled server, as hub URLs. */
  mcpServers(): Record<string, McpServerConfig> {
    if (!this.server) throw new Error('hub not started; await kit.hub.start() (kit.session does it for you)')
    const out: Record<string, McpServerConfig> = {}
    for (const config of this.configs.values()) {
      if (!config.enabled || (isPlaceholder(config) && !this.natives.has(config.name))) continue
      out[config.name] = { type: 'http', url: this.url(config.name), ...(config.load === 'always' ? { alwaysLoad: true } : {}) }
    }
    return out
  }

  /** Loopback URL of one server (includes the per-process secret). */
  url(name: string): string {
    return `http://127.0.0.1:${this.port}/${this.secret}/${encodeURIComponent(name)}`
  }

  // ---------------------------------------------------------------- import

  /** Copy servers from the CLIs' own configs. Existing names are left alone. */
  importFrom(sources: Array<'claude' | 'codex' | 'opencode'> = ['claude', 'codex', 'opencode']): { added: string[]; skipped: string[] } {
    const added: string[] = []
    const skipped: string[] = []
    for (const source of sources) {
      for (const found of readCliServers(source)) {
        const name = found.name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 63)
        if (this.configs.has(name)) {
          skipped.push(name)
          continue
        }
        try {
          validateTransport(found.transport)
        } catch {
          skipped.push(name)
          continue
        }
        this.configs.set(name, { name, transport: found.transport, enabled: found.enabled, load: 'on-demand', source })
        added.push(name)
        if (found.enabled && this.server) void this.upstream(this.configs.get(name)!).connect()
        else this.emitState(name)
      }
    }
    if (added.length) this.save()
    return { added, skipped }
  }

  // ---------------------------------------------------------------- serving

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const [, secret, raw] = (req.url ?? '').split('?')[0].split('/')
    const name = raw ? decodeURIComponent(raw) : ''
    const config = this.configs.get(name)
    if (secret !== this.secret || !config) {
      res.writeHead(404).end()
      return
    }
    if (!config.enabled) {
      res.writeHead(410, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `${name} is turned off in the hub` }))
      return
    }
    try {
      let body: unknown
      if (req.method === 'POST') {
        let raw = ''
        for await (const chunk of req) raw += chunk
        body = raw ? JSON.parse(raw) : undefined
      }
      // Stateless: one MCP server object per request, so any number of sessions can share a URL.
      const server = new Server({ name, version: '0.2.0' }, { capabilities: { tools: {} } })
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.toolsOf(name) }))
      server.setRequestHandler(CallToolRequestSchema, async (request) => this.callTool(name, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>))
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      res.on('close', () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: message(error) }, id: null }))
    }
  }

  private async toolsOf(name: string): Promise<HubTool[]> {
    const native = this.natives.get(name)
    if (native) return native.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? { type: 'object', properties: {} } }))
    const up = this.upstream(this.configs.get(name)!)
    await up.connect()
    return up.tools
  }

  private async callTool(server: string, tool: string, args: Record<string, unknown>): Promise<any> {
    const t0 = Date.now()
    try {
      const native = this.natives.get(server)
      let result: any
      if (native) {
        const fn = native.find((t) => t.name === tool)
        if (!fn) throw new Error(`unknown tool ${tool}`)
        const value = await fn.run(args)
        result = isCallResult(value) ? value : { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }
      } else {
        result = await this.upstream(this.configs.get(server)!).call(tool, args)
      }
      this.emit({ type: 'call', server, tool, ok: !result?.isError, ms: Date.now() - t0 })
      return result
    } catch (error) {
      this.emit({ type: 'call', server, tool, ok: false, ms: Date.now() - t0, error: message(error) })
      return { content: [{ type: 'text', text: `Error: ${message(error)}` }], isError: true }
    }
  }

  // ---------------------------------------------------------------- internals

  private upstream(config: HubServerConfig): Upstream {
    let up = this.upstreams.get(config.name)
    if (!up) {
      up = new Upstream(config, () => this.emitState(config.name))
      this.upstreams.set(config.name, up)
    }
    up.config = config
    return up
  }

  private state(name: string): HubServerState | null {
    const config = this.configs.get(name)
    if (!config) return null
    const native = this.natives.get(name)
    if (native) {
      return { ...config, kind: 'native', status: config.enabled ? 'connected' : 'off', tools: native.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema ?? {} })) }
    }
    if (isPlaceholder(config)) return { ...config, kind: 'native', status: 'off', error: 'not registered by the app in this run', tools: [] }
    const up = this.upstreams.get(name)
    if (!config.enabled) return { ...config, kind: 'upstream', status: 'off', tools: [] }
    return { ...config, kind: 'upstream', status: up?.status ?? 'off', ...(up?.error ? { error: up.error } : {}), tools: up?.tools ?? [] }
  }

  private emitState(name: string): void {
    const server = this.state(name)
    if (server) this.emit({ type: 'status', server })
  }

  private emit(event: HubEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {}
    }
  }

  private load(): HubServerConfig[] {
    if (!this.file || !existsSync(this.file)) return []
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      return (raw.servers ?? []).filter((s: any) => s && NAME.test(s.name) && s.transport)
    } catch {
      return []
    }
  }

  private save(): void {
    if (!this.file) return
    mkdirSync(path.dirname(this.file), { recursive: true })
    // Native tool sets live in code; only their toggles are saved.
    const servers = [...this.configs.values()].map((c) => (this.natives.has(c.name) ? { ...c, transport: { type: 'stdio', command: IN_PROCESS } } : c))
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, servers }, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

// ------------------------------------------------------------------ helpers

function validateTransport(t: HubTransport): void {
  if (t.type === 'stdio') {
    if (!t.command?.trim()) throw new Error('command is required')
  } else if (t.type === 'http') {
    const url = new URL(t.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('url must be http(s)')
  } else throw new Error('transport must be stdio or http')
}

function isCallResult(value: unknown): boolean {
  return !!value && typeof value === 'object' && Array.isArray((value as any).content)
}

function isAuthError(error: unknown): boolean {
  const text = message(error)
  return /\b401\b|unauthori[sz]ed|invalid_token|oauth/i.test(text) || (error as any)?.code === 401
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms))])
}

/** Split a shell-ish command line ("npx -y pkg --flag 'a b'") into command + args. */
export function splitCommand(line: string): { command: string; args: string[] } {
  const parts = [...line.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g)].map((m) => m[1]?.replace(/\\(.)/g, '$1') ?? m[2] ?? m[3])
  return { command: parts[0] ?? '', args: parts.slice(1) }
}

// ------------------------------------------------------------------ CLI config import

interface CliServer {
  name: string
  transport: HubTransport
  enabled: boolean
}

export function readCliServers(source: 'claude' | 'codex' | 'opencode'): CliServer[] {
  const home = os.homedir()
  try {
    if (source === 'claude') {
      const raw = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8'))
      return Object.entries<any>(raw.mcpServers ?? {}).flatMap(([name, s]) => fromJsonEntry(name, s))
    }
    if (source === 'opencode') {
      const file = ['opencode.json', 'opencode.jsonc'].map((f) => path.join(home, '.config/opencode', f)).find(existsSync)
      if (!file) return []
      const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, ''))
      return Object.entries<any>(raw.mcp ?? {}).flatMap(([name, s]): CliServer[] => {
        const enabled = s.enabled !== false
        if (s.type === 'local' && Array.isArray(s.command)) return [{ name, enabled, transport: { type: 'stdio' as const, command: s.command[0], args: s.command.slice(1), env: s.environment } }]
        if (s.type === 'remote' && s.url) return [{ name, enabled, transport: { type: 'http' as const, url: s.url, headers: s.headers } }]
        return []
      })
    }
    return readCodexToml(readFileSync(path.join(home, '.codex/config.toml'), 'utf8'))
  } catch {
    return []
  }
}

function fromJsonEntry(name: string, s: any): CliServer[] {
  if (s?.command) return [{ name, enabled: s.disabled !== true, transport: { type: 'stdio', command: s.command, args: s.args ?? [], env: s.env } }]
  if (s?.url) return [{ name, enabled: s.disabled !== true, transport: { type: 'http', url: s.url, headers: s.headers } }]
  return []
}

/** Just enough TOML for `[mcp_servers.<name>]` tables (and their `.env` / `.http_headers`). */
export function readCodexToml(text: string): CliServer[] {
  const servers = new Map<string, Record<string, any>>()
  let target: Record<string, any> | null = null
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\s+/, '')
    if (!line || line.startsWith('#')) continue
    const header = line.match(/^\[\s*mcp_servers\.("?)([^\]."]+)\1(?:\.([A-Za-z_]+))?\s*\]\s*$/)
    if (header) {
      const entry = servers.get(header[2]) ?? {}
      servers.set(header[2], entry)
      target = header[3] ? (entry[header[3]] ??= {}) : entry
      continue
    }
    if (line.startsWith('[')) {
      target = null
      continue
    }
    if (!target) continue
    const kv = line.match(/^("?)([A-Za-z0-9_-]+)\1\s*=\s*(.*)$/)
    if (!kv) continue
    let value = kv[3]
    // Arrays may span lines.
    while (value.trim().startsWith('[') && !balanced(value) && i + 1 < lines.length) value += lines[++i]
    target[kv[2]] = parseTomlValue(value.trim())
  }
  return [...servers.entries()].flatMap(([name, s]): CliServer[] => {
    const enabled = s.enabled !== false
    if (s.command) return [{ name, enabled, transport: { type: 'stdio' as const, command: s.command, args: s.args ?? [], env: s.env } }]
    if (s.url) {
      const headers = { ...(s.http_headers ?? {}) }
      if (s.bearer_token_env_var && process.env[s.bearer_token_env_var]) headers.Authorization = `Bearer ${process.env[s.bearer_token_env_var]}`
      return [{ name, enabled, transport: { type: 'http' as const, url: s.url, headers } }]
    }
    return []
  })
}

function balanced(value: string): boolean {
  let depth = 0
  let quote: string | null = null
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[') depth++
    else if (ch === ']') depth--
  }
  return depth === 0
}

function parseTomlValue(value: string): any {
  value = value.replace(/\s+#.*$/, '')
  if (value.startsWith('"')) return JSON.parse(value.slice(0, value.lastIndexOf('"') + 1))
  if (value.startsWith("'")) return value.slice(1, value.indexOf("'", 1))
  if (value === 'true' || value === 'false') return value === 'true'
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if (value.startsWith('[')) {
    return [...value.slice(1, value.lastIndexOf(']')).matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'/g)].map((m) => (m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : m[2]))
  }
  if (value.startsWith('{')) {
    const out: Record<string, any> = {}
    for (const m of value.slice(1, value.lastIndexOf('}')).matchAll(/("?)([A-Za-z0-9_-]+)\1\s*=\s*("(?:\\.|[^"\\])*"|'[^']*'|true|false|-?\d+)/g)) out[m[2]] = parseTomlValue(m[3])
    return out
  }
  return value
}
