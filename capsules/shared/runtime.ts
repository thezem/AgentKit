import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import path from 'node:path'
import {
  isTerminalEvent,
  type AgentEvent,
  type CompleteOptions,
  type CompleteResult,
  type PromptInput,
  type ProviderSession,
  type SessionConfig,
  type ProviderId,
  type RunResult,
  type TimelineItem,
  type ToolDetail,
  type TurnOptions,
} from './contract.ts'
import { appendTimeline } from './timeline.ts'

export { appendTimeline }

export const nowIso = () => new Date().toISOString()

/** Tiny typed fan-out. Listener errors never break the provider loop. */
export class Emitter<T> {
  private listeners = new Set<(event: T) => void>()
  on(listener: (event: T) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        queueMicrotask(() => {
          throw error
        })
      }
    }
  }
  clear(): void {
    this.listeners.clear()
  }
}

/**
 * Generic `run()` built from `startTurn()` + `subscribe()`.
 * Subscribes before starting so no event is lost; resolves on the first terminal event for the turn.
 */
export async function collectRun(input: {
  provider: ProviderId
  prompt: PromptInput
  options?: TurnOptions
  startTurn: (prompt: PromptInput, options?: TurnOptions) => Promise<{ turnId: string }>
  subscribe: (listener: (event: AgentEvent) => void) => () => void
  interrupt: () => Promise<void>
  sessionId: () => string | null
}): Promise<RunResult> {
  const timeline: TimelineItem[] = []
  const early: AgentEvent[] = []
  let turnId: string | null = null
  let finish!: (result: RunResult) => void
  const done = new Promise<RunResult>((resolve) => (finish = resolve))

  const handle = (event: AgentEvent) => {
    if ('turnId' in event && event.turnId && event.turnId !== turnId) return
    if (event.type === 'timeline') appendTimeline(timeline, event.item)
    if (!isTerminalEvent(event)) return
    const finalText = lastAssistantText(timeline)
    finish({
      sessionId: input.sessionId(),
      turnId: event.turnId,
      status: event.type === 'turn_completed' ? 'completed' : event.type === 'turn_failed' ? 'failed' : 'canceled',
      finalText,
      error: event.type === 'turn_failed' ? event.error : undefined,
      usage: event.type === 'turn_completed' ? event.usage : undefined,
      timeline,
    })
  }
  const unsubscribe = input.subscribe((event) => {
    if (turnId === null) early.push(event)
    else handle(event)
  })
  const onAbort = () => void input.interrupt()
  input.options?.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const started = await input.startTurn(input.prompt, input.options)
    turnId = started.turnId
    for (const event of early.splice(0)) handle(event)
    return await done
  } finally {
    unsubscribe()
    input.options?.signal?.removeEventListener('abort', onAbort)
  }
}

function lastAssistantText(timeline: TimelineItem[]): string {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i]
    if (item.type === 'assistant_message') return item.text
    if (item.type === 'user_message') break
  }
  return ''
}

export function promptToText(prompt: PromptInput): string {
  if (typeof prompt === 'string') return prompt
  return prompt
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** Resolve a binary on PATH (or an explicit path). Returns null when missing. */
export async function findBinary(name: string, explicit?: string): Promise<string | null> {
  const candidates = explicit
    ? [explicit]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, name))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

/** Run a short command and capture stdout. Used for `--version` probes. */
export function runCapture(command: string, args: string[], timeoutMs = 10_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** Kill a detached child and its process group, escalating to SIGKILL. */
export async function killTree(child: { pid?: number; exitCode: number | null; once(event: 'exit', cb: () => void): unknown }, graceMs = 3000): Promise<void> {
  if (!child.pid || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, sig)
    } catch {
      try {
        process.kill(child.pid!, sig)
      } catch {}
    }
  }
  signal('SIGTERM')
  const timer = setTimeout(() => signal('SIGKILL'), graceMs)
  await Promise.race([exited, new Promise((r) => setTimeout(r, graceMs + 1000))])
  clearTimeout(timer)
}

// ---------------------------------------------------------------- tool detail

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/**
 * Best-effort mapping from (tool name, input, output) to a typed ToolDetail.
 * Covers the common names used by Claude Code, OpenCode and MCP-style tools.
 * Providers with richer native items (Codex) build ToolDetail directly.
 */
export function deriveToolDetail(name: string, rawInput: unknown, output?: unknown): ToolDetail {
  const input = asRecord(rawInput)
  const lower = name.toLowerCase()
  const outputText = typeof output === 'string' ? output : output === undefined ? undefined : safeJson(output)
  const filePath = asString(input.file_path) ?? asString(input.filePath) ?? asString(input.path) ?? asString(input.notebook_path)

  if (lower.startsWith('mcp__')) {
    const [, server = '', ...rest] = name.split('__')
    return { type: 'mcp', server, tool: rest.join('__'), input: rawInput, output }
  }
  if (['bash', 'shell', 'exec', 'command'].some((n) => lower === n || lower.endsWith(`_${n}`))) {
    const command = asString(input.command) ?? (Array.isArray(input.command) ? input.command.join(' ') : '')
    return { type: 'shell', command, cwd: asString(input.cwd) ?? asString(input.workdir), output: outputText }
  }
  if (lower === 'read' || lower === 'view' || lower === 'notebookread') {
    return { type: 'read', filePath: filePath ?? '', content: outputText, offset: num(input.offset), limit: num(input.limit) }
  }
  if (lower === 'edit' || lower === 'multiedit' || lower === 'notebookedit' || lower === 'patch' || lower === 'apply_patch') {
    return {
      type: 'edit',
      filePath: filePath ?? '',
      oldString: asString(input.old_string) ?? asString(input.oldString),
      newString: asString(input.new_string) ?? asString(input.newString),
      unifiedDiff: asString(input.patch) ?? asString(input.diff),
    }
  }
  if (lower === 'write') return { type: 'write', filePath: filePath ?? '', content: asString(input.content) }
  if (lower === 'grep' || lower === 'glob' || lower === 'list' || lower === 'ls') {
    return { type: 'search', query: asString(input.pattern) ?? asString(input.path) ?? '', kind: lower === 'glob' || lower === 'list' || lower === 'ls' ? 'glob' : 'grep', output: outputText }
  }
  if (lower === 'websearch' || lower === 'web_search') return { type: 'search', query: asString(input.query) ?? '', kind: 'web', output: outputText }
  if (lower === 'webfetch' || lower === 'fetch') return { type: 'fetch', url: asString(input.url) ?? '', prompt: asString(input.prompt), output: outputText }
  if (lower === 'task' || lower === 'agent' || lower === 'subagent') {
    return { type: 'sub_agent', description: asString(input.description), subAgentType: asString(input.subagent_type) ?? asString(input.agent), output: outputText }
  }
  if (lower === 'exitplanmode') return { type: 'plan', text: asString(input.plan) ?? '' }
  if (lower === 'todowrite' || lower === 'todo') {
    const todos = Array.isArray(input.todos) ? input.todos : []
    return {
      type: 'todo',
      items: todos.map((todo) => {
        const t = asRecord(todo)
        const status = asString(t.status)
        return { text: asString(t.content) ?? asString(t.text) ?? '', status: status === 'completed' || status === 'in_progress' ? status : 'pending' }
      }),
    }
  }
  return { type: 'unknown', input: rawInput, output }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Deferred promise helper. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---------------------------------------------------------------- one-shot

/**
 * `complete()` for capsules without a native one-shot API: a throwaway, non-persisted session in a
 * read-only mode that denies every permission ask, one turn, then close. `extra` = capsule-specific config.
 */
export async function completeViaSession(
  create: (config: SessionConfig) => Promise<ProviderSession>,
  prompt: string,
  options: CompleteOptions,
  extra: Partial<SessionConfig>,
  cleanup?: (session: ProviderSession) => Promise<void>,
): Promise<CompleteResult> {
  const session = await create({
    cwd: options.cwd ?? process.cwd(),
    persist: false,
    ...(options.model ? { model: options.model } : {}),
    ...(options.thinkingOptionId ? { thinkingOptionId: options.thinkingOptionId } : {}),
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    ...extra,
  })
  let denied: string | null = null
  const off = session.subscribe((event) => {
    if (event.type === 'permission_requested') denied ??= event.request.name
    if (event.type === 'permission_requested') void session.respondToPermission(event.request.id, { behavior: 'deny', message: 'one-shot completion: tools are not available' }).catch(() => undefined)
  })
  const onAbort = () => void session.interrupt().catch(() => undefined)
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await session.run(prompt)
    if (result.status !== 'completed') {
      const why = denied ? `the model tried to use a tool (${denied}), which complete() does not allow` : (result.error ?? result.status)
      throw new Error(`${session.provider} complete ${result.status}: ${why}`)
    }
    const info = await session.getRuntimeInfo().catch(() => null)
    return { text: result.finalText, usage: result.usage, model: info?.model ?? options.model }
  } finally {
    off()
    options.signal?.removeEventListener('abort', onAbort)
    await cleanup?.(session).catch(() => undefined)
    await session.close().catch(() => undefined)
  }
}
