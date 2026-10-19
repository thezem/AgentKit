/**
 * Backend for the example UI. Everything provider-specific is AgentKit's job;
 * this file only does HTTP and SSE.
 *
 *   node examples/web/server.ts      # http://127.0.0.1:4417/api
 *
 * Persistence is AgentKit's durable store (~/.agentkit-ui/agentkit.db): every
 * event is written before it is streamed, so kill -9 mid-reply loses nothing
 * you saw, and the cut-off turn comes back marked "interrupted" (never re-sent).
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createAgentKit, type AgentEvent, type AgentSession, type Transcript } from '../../src/index.ts'

/** App data kept in the store's `meta` next to each session. */
type Meta = { cwd: string; title: string; model?: string; mode?: string; thinking?: string; fast?: boolean; parent?: string }

const dir = path.join(os.homedir(), '.agentkit-ui')
mkdirSync(dir, { recursive: true })
const dbFile = path.join(dir, 'agentkit.db')
const kit = createAgentKit({ mock: true, store: dbFile })
const store = kit.store!
if (kit.recovered.length) console.log(`recovered ${kit.recovered.length} interrupted submission(s): ${kit.recovered.map((r) => `${r.id}=${r.status}`).join(', ')}`)
migrateLegacyJson()

const live = new Map<string, AgentSession>()
const opening = new Map<string, Promise<AgentSession>>()
const streams = new Map<string, Set<http.ServerResponse>>()

function broadcast(id: string, payload: unknown) {
  for (const res of streams.get(id) ?? []) res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function meta(id: string): Meta {
  return store.getSession(id)!.meta as Meta
}
function setMeta(id: string, patch: Partial<Meta>) {
  store.updateSession(id, { meta: patch })
}

function wire(id: string, session: AgentSession) {
  live.set(id, session)
  session.on((event: AgentEvent) => {
    if (event.type === 'mode_changed') setMeta(id, { mode: event.modeId ?? undefined })
    if (event.type === 'model_changed') setMeta(id, { model: event.model ?? undefined })
    if (event.type === 'thinking_changed') setMeta(id, { thinking: event.thinkingOptionId ?? undefined })
    if (event.type === 'fast_changed') setMeta(id, { fast: event.enabled })
    broadcast(id, { type: 'event', event })
  })
}

/** Live session for a conversation: restores from the store (handle + saved transcript) after a restart. */
async function sessionFor(id: string): Promise<AgentSession> {
  const existing = live.get(id)
  if (existing) return existing
  let pending = opening.get(id)
  if (!pending) {
    pending = (async () => {
      const saved = get(id)
      const m = saved.meta as Meta
      const opts = { mode: m.mode, model: m.model, thinking: m.thinking, fast: m.fast }
      const session = saved.handle ? await kit.restore(id, opts) : await kit.session({ provider: saved.provider, cwd: m.cwd, key: id, meta: m, ...opts })
      wire(id, session)
      return session
    })().finally(() => opening.delete(id))
    opening.set(id, pending)
  }
  return pending
}

function transcriptOf(id: string): Transcript {
  return live.get(id)?.transcript ?? store.loadTranscript(id)
}

function summary(id: string) {
  const saved = get(id)
  const m = saved.meta as Meta
  return { id, provider: saved.provider, ...m, handle: saved.handle, createdAt: saved.createdAt, updatedAt: saved.updatedAt, status: transcriptOf(id).status, live: live.has(id) }
}

async function detail(id: string) {
  const session = live.get(id)
  return {
    ...summary(id),
    transcript: transcriptOf(id),
    capabilities: session?.capabilities ?? (await kit.providers()).find((p) => p.provider === get(id).provider)?.capabilities,
  }
}

function get(id: string) {
  const saved = store.getSession(id)
  if (!saved) throw Object.assign(new Error(`no conversation ${id}`), { status: 404 })
  return saved
}

function titleFrom(text: string) {
  const line = text.trim().split('\n')[0]
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}

/** One-time import of the old conversations.json so nobody loses history on upgrade. */
function migrateLegacyJson() {
  const legacy = path.join(dir, 'conversations.json')
  if (!existsSync(legacy)) return
  for (const c of JSON.parse(readFileSync(legacy, 'utf8')) as any[]) {
    if (store.getSession(c.id)) continue
    store.putSession(c.id, { provider: c.provider, handle: c.handle, meta: { cwd: c.cwd, title: c.title, model: c.model, mode: c.mode, thinking: c.thinking, fast: c.fast } })
    store.checkpoint(c.id, { ...c.transcript, status: 'idle', activeTurnId: null, pendingPermissions: [], inbox: [] })
  }
  renameSync(legacy, `${legacy}.migrated`)
}

type Handler = (body: any, params: string[], req: http.IncomingMessage, res: http.ServerResponse) => Promise<unknown>
const routes: Array<[string, RegExp, Handler]> = [
  ['GET', /^\/api\/providers$/, async () => kit.providers()],
  ['GET', /^\/api\/catalog\/([\w-]+)$/, async (_b, [provider], req) => kit.catalog(provider, { cwd: new URL(req.url!, 'http://x').searchParams.get('cwd') ?? undefined })],
  ['GET', /^\/api\/defaults$/, async () => ({ cwd: process.env.AGENTKIT_CWD ?? process.cwd(), home: os.homedir() })],
  ['GET', /^\/api\/conversations$/, async () => store.listSessions().map((s) => summary(s.key))],
  [
    'POST',
    /^\/api\/conversations$/,
    async (body) => {
      const id = randomUUID()
      const m: Meta = { cwd: body.cwd || process.cwd(), title: 'New conversation', model: body.model || undefined, mode: body.mode || undefined, thinking: body.thinking || undefined, fast: body.fast === true || undefined }
      store.putSession(id, { provider: body.provider, handle: null, meta: m })
      return summary(id)
    },
  ],
  ['GET', /^\/api\/conversations\/([\w-]+)$/, async (_b, [id]) => detail(id)],
  [
    'POST',
    /^\/api\/conversations\/([\w-]+)\/messages$/,
    async (body, [id]) => {
      if (meta(id).title === 'New conversation') setMeta(id, { title: titleFrom(body.text) })
      const session = await sessionFor(id)
      // requestId from the client makes retries (double click, flaky network) idempotent.
      const submission = await session.submit(body.text, { requestId: body.requestId, whenBusy: body.whenBusy ?? 'queue' })
      submission.result.catch((error) => broadcast(id, { type: 'error', message: error.message }))
      return { id: submission.id, status: submission.status }
    },
  ],
  [
    'POST',
    /^\/api\/conversations\/([\w-]+)\/steer$/,
    async (body, [id]) => {
      const submission = await (await sessionFor(id)).submit(body.text, { requestId: body.requestId, whenBusy: 'steer' })
      submission.result.catch(() => undefined)
      return { id: submission.id, steered: submission.status === 'steered' }
    },
  ],
  ['POST', /^\/api\/conversations\/([\w-]+)\/inbox\/(.+)\/withdraw$/, async (_b, [id, sid]) => ({ ok: live.get(id)?.withdraw(decodeURIComponent(sid)) ?? false })],
  ['GET', /^\/api\/submissions\/(.+)$/, async (_b, [sid]) => kit.submission(decodeURIComponent(sid))?.record() ?? null],
  ['POST', /^\/api\/conversations\/([\w-]+)\/interrupt$/, async (_b, [id]) => (await live.get(id)?.interrupt(), { ok: true })],
  [
    'POST',
    /^\/api\/conversations\/([\w-]+)\/permissions\/(.+)$/,
    async (body, [id, requestId]) => (await (await sessionFor(id)).respond(decodeURIComponent(requestId), body), { ok: true }),
  ],
  [
    'POST',
    /^\/api\/conversations\/([\w-]+)\/settings$/,
    async (body, [id]) => {
      const saved = get(id)
      // Not started yet: just store, applied when the session opens.
      if (!live.has(id) && !saved.handle) {
        const m = saved.meta as Meta
        setMeta(id, { mode: body.mode ?? m.mode, model: body.model ?? m.model, thinking: body.thinking ?? m.thinking, fast: body.fast ?? m.fast })
        return summary(id)
      }
      const session = await sessionFor(id)
      if (body.mode !== undefined) await session.setMode(body.mode)
      if (body.model !== undefined) await session.setModel(body.model)
      if (body.thinking !== undefined) await session.setThinking(body.thinking)
      if (body.fast !== undefined) await session.setFast(body.fast)
      return summary(id)
    },
  ],
  [
    'POST',
    /^\/api\/conversations\/([\w-]+)\/rewind$/,
    async (body, [id]) => {
      const session = await sessionFor(id)
      await session.rewind(body.messageId, body.scope ?? 'conversation')
      broadcast(id, { type: 'snapshot', transcript: session.transcript })
      return detail(id)
    },
  ],
  [
    'POST',
    /^\/api\/conversations\/([\w-]+)\/fork$/,
    async (body, [id]) => {
      const session = await sessionFor(id)
      const forkId = randomUUID()
      const forked = await session.fork({ beforeMessageId: body.beforeMessageId || undefined, key: forkId })
      const m = meta(id)
      setMeta(forkId, { ...m, title: `${m.title} (fork)`, parent: id })
      wire(forkId, forked)
      return summary(forkId)
    },
  ],
  [
    'POST',
    /^\/api\/conversations\/([\w-]+)\/compact$/,
    async (body, [id]) => {
      const session = await sessionFor(id)
      await session.compact(body.instructions || undefined)
      return { ok: true }
    },
  ],
  [
    'DELETE',
    /^\/api\/conversations\/([\w-]+)$/,
    async (_b, [id]) => {
      await live.get(id)?.close()
      live.delete(id)
      store.deleteSession(id)
      return { ok: true }
    },
  ],
  [
    'GET',
    /^\/api\/conversations\/([\w-]+)\/events$/,
    async (_b, [id], req, res) => {
      get(id)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify({ type: 'snapshot', transcript: transcriptOf(id) })}\n\n`)
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
server.listen(port, '127.0.0.1', () => console.log(`agentkit ui api on http://127.0.0.1:${port}/api  (store: ${dbFile})`))
const stop = async () => {
  await kit.shutdown()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
