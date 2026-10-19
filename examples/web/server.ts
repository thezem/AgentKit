/**
 * Backend for the example UI. Everything provider-specific is AgentKit's job;
 * this file only does HTTP, SSE and persistence.
 *
 *   node examples/web/server.ts      # http://127.0.0.1:4417/api
 *
 * Conversations persist to ~/.agentkit-ui/conversations.json as
 * { handle, transcript }. After a restart the next message resumes the native
 * session from its handle, so memory survives too.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  createAgentKit,
  emptyTranscript,
  reduceTranscript,
  type AgentEvent,
  type AgentSession,
  type PersistenceHandle,
  type Transcript,
} from '../../src/index.ts'

type Conversation = {
  id: string
  provider: string
  cwd: string
  title: string
  model?: string
  mode?: string
  thinking?: string
  fast?: boolean
  handle: PersistenceHandle | null
  transcript: Transcript
  createdAt: string
  updatedAt: string
}

const dir = path.join(os.homedir(), '.agentkit-ui')
const file = path.join(dir, 'conversations.json')
mkdirSync(dir, { recursive: true })
const conversations = new Map<string, Conversation>(
  existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Conversation[]).map((c) => [c.id, { ...c, transcript: { ...c.transcript, status: 'idle', activeTurnId: null, pendingPermissions: [] } }]) : [],
)
let saveTimer: NodeJS.Timeout | null = null
function save() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    writeFileSync(file, JSON.stringify([...conversations.values()], null, 1))
  }, 300)
}

const kit = createAgentKit({ mock: true })
const live = new Map<string, AgentSession>()
const opening = new Map<string, Promise<AgentSession>>()
const streams = new Map<string, Set<http.ServerResponse>>()

function broadcast(id: string, payload: unknown) {
  for (const res of streams.get(id) ?? []) res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function wire(conv: Conversation, session: AgentSession) {
  live.set(conv.id, session)
  session.on((event: AgentEvent) => {
    conv.transcript = reduceTranscript(conv.transcript, event)
    if (event.type === 'session_started' || event.type === 'turn_completed') conv.handle = session.handle
    if (event.type === 'mode_changed') conv.mode = event.modeId ?? undefined
    if (event.type === 'model_changed') conv.model = event.model ?? undefined
    if (event.type === 'thinking_changed') conv.thinking = event.thinkingOptionId ?? undefined
    if (event.type === 'fast_changed') conv.fast = event.enabled
    conv.updatedAt = new Date().toISOString()
    broadcast(conv.id, { type: 'event', event })
    save()
  })
}

/** Live session for a conversation; resumes from the stored handle after a restart. */
async function sessionFor(conv: Conversation): Promise<AgentSession> {
  const existing = live.get(conv.id)
  if (existing) return existing
  let pending = opening.get(conv.id)
  if (!pending) {
    pending = (async () => {
      const session = conv.handle
        ? await kit.resume(conv.handle, { mode: conv.mode, model: conv.model, thinking: conv.thinking, fast: conv.fast })
        : await kit.session({ provider: conv.provider, cwd: conv.cwd, mode: conv.mode, model: conv.model, thinking: conv.thinking, fast: conv.fast })
      wire(conv, session)
      conv.handle = session.handle
      save()
      return session
    })().finally(() => opening.delete(conv.id))
    opening.set(conv.id, pending)
  }
  return pending
}

function summary(conv: Conversation) {
  const { transcript, ...rest } = conv
  return { ...rest, status: transcript.status, live: live.has(conv.id) }
}

async function detail(conv: Conversation) {
  const session = live.get(conv.id)
  return {
    ...summary(conv),
    transcript: conv.transcript,
    capabilities: session?.capabilities ?? (await kit.providers()).find((p) => p.provider === conv.provider)?.capabilities,
  }
}

function get(id: string): Conversation {
  const conv = conversations.get(id)
  if (!conv) throw Object.assign(new Error(`no conversation ${id}`), { status: 404 })
  return conv
}

function titleFrom(text: string) {
  const line = text.trim().split('\n')[0]
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}

type Handler = (body: any, params: string[], req: http.IncomingMessage, res: http.ServerResponse) => Promise<unknown>
const routes: Array<[string, RegExp, Handler]> = [
  ['GET', /^\/api\/providers$/, async () => kit.providers()],
  ['GET', /^\/api\/catalog\/([\w-]+)$/, async (_b, [provider], req) => kit.catalog(provider, { cwd: new URL(req.url!, 'http://x').searchParams.get('cwd') ?? undefined })],
  ['GET', /^\/api\/defaults$/, async () => ({ cwd: process.env.AGENTKIT_CWD ?? process.cwd(), home: os.homedir() })],
  ['GET', /^\/api\/conversations$/, async () => [...conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary)],
  [
    'POST',
    /^\/api\/conversations$/,
    async (body) => {
      const now = new Date().toISOString()
      const conv: Conversation = {
        id: randomUUID(),
        provider: body.provider,
        cwd: body.cwd || process.cwd(),
        title: 'New conversation',
        model: body.model || undefined,
        mode: body.mode || undefined,
        thinking: body.thinking || undefined,
        fast: body.fast === true || undefined,
        handle: null,
        transcript: emptyTranscript(),
        createdAt: now,
        updatedAt: now,
      }
      conversations.set(conv.id, conv)
      save()
      return summary(conv)
    },
  ],
  ['GET', /^\/api\/conversations\/([\w-]+)$/, async (_b, [id]) => detail(get(id))],
  [
    'POST',
    /^\/api\/conversations\/([\w-]+)\/messages$/,
    async (body, [id]) => {
      const conv = get(id)
      if (conv.title === 'New conversation') conv.title = titleFrom(body.text)
      const session = await sessionFor(conv)
      void session.send(body.text).catch((error) => broadcast(id, { type: 'error', message: error.message }))
      return { queued: session.queued }
    },
  ],
  [
    'POST',
    /^\/api\/conversations\/([\w-]+)\/steer$/,
    async (body, [id]) => (await sessionFor(get(id))).steer(body.text),
  ],
  ['POST', /^\/api\/conversations\/([\w-]+)\/interrupt$/, async (_b, [id]) => (await live.get(id)?.interrupt(), { ok: true })],
  [
    'POST',
    /^\/api\/conversations\/([\w-]+)\/permissions\/(.+)$/,
    async (body, [id, requestId]) => (await (await sessionFor(get(id))).respond(decodeURIComponent(requestId), body), { ok: true }),
  ],
  [
    'POST',
    /^\/api\/conversations\/([\w-]+)\/settings$/,
    async (body, [id]) => {
      const conv = get(id)
      // Not started yet: just store, applied when the session opens.
      if (!live.has(id) && !conv.handle) {
        Object.assign(conv, { mode: body.mode ?? conv.mode, model: body.model ?? conv.model, thinking: body.thinking ?? conv.thinking, fast: body.fast ?? conv.fast })
        save()
        return summary(conv)
      }
      const session = await sessionFor(conv)
      if (body.mode !== undefined) await session.setMode(body.mode)
      if (body.model !== undefined) await session.setModel(body.model)
      if (body.thinking !== undefined) await session.setThinking(body.thinking)
      if (body.fast !== undefined) await session.setFast(body.fast)
      return summary(conv)
    },
  ],
  [
    'POST',
    /^\/api\/conversations\/([\w-]+)\/rewind$/,
    async (body, [id]) => {
      const conv = get(id)
      const session = await sessionFor(conv)
      await session.rewind(body.messageId, body.scope ?? 'conversation')
      const index = conv.transcript.items.findIndex((item) => item.type === 'user_message' && item.messageId === body.messageId)
      if (index >= 0) conv.transcript = { ...conv.transcript, items: conv.transcript.items.slice(0, index) }
      conv.handle = session.handle
      save()
      broadcast(id, { type: 'snapshot', transcript: conv.transcript })
      return detail(conv)
    },
  ],
  [
    'DELETE',
    /^\/api\/conversations\/([\w-]+)$/,
    async (_b, [id]) => {
      await live.get(id)?.close()
      live.delete(id)
      conversations.delete(id)
      save()
      return { ok: true }
    },
  ],
  [
    'GET',
    /^\/api\/conversations\/([\w-]+)\/events$/,
    async (_b, [id], req, res) => {
      const conv = get(id)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify({ type: 'snapshot', transcript: conv.transcript })}\n\n`)
      const set = streams.get(id) ?? new Set()
      set.add(res)
      streams.set(id, set)
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
      req.on('close', () => {
        clearInterval(ping)
        set.delete(res)
      })
      return new Promise(() => {})
    },
  ],
]

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  for (const [method, pattern, handler] of routes) {
    const match = req.method === method && url.pathname.match(pattern)
    if (!match) continue
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const result = await handler(raw ? JSON.parse(raw) : {}, match.slice(1), req, res)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
    } catch (error: any) {
      if (!res.headersSent) res.writeHead(error.status ?? (error.code === 'UNSUPPORTED_CAPABILITY' ? 400 : 500), { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: error.message, code: error.code }))
    }
    return
  }
  res.writeHead(404).end()
})

const port = Number(process.env.PORT ?? 4417)
server.listen(port, '127.0.0.1', () => console.log(`agentkit ui api on http://127.0.0.1:${port}/api  (data: ${file})`))
const stop = async () => {
  if (saveTimer) writeFileSync(file, JSON.stringify([...conversations.values()], null, 1))
  await kit.shutdown()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
