/**
 * A whole multi-provider agent harness backend in ~100 lines: the paseo/t3code
 * shape (sessions, streaming, approvals, interrupt, model/mode switching) for
 * Claude Code, Codex and OpenCode at once. Point any UI at it.
 *
 *   node examples/harness-server.ts          # http://127.0.0.1:4317
 *
 *   curl -s localhost:4317/providers
 *   curl -s -XPOST localhost:4317/sessions -d '{"provider":"codex","cwd":"/tmp","access":"auto-edit"}'
 *   curl -N localhost:4317/sessions/<id>/events                          # SSE stream
 *   curl -s -XPOST localhost:4317/sessions/<id>/messages -d '{"text":"hi"}'
 *   curl -s -XPOST localhost:4317/sessions/<id>/permissions/<reqId> -d '{"behavior":"allow"}'
 *   curl -s -XPOST localhost:4317/sessions/<id>/interrupt
 */
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { createAgentKit, type AgentSession } from '../src/index.ts'

const kit = createAgentKit({ mock: true })
const sessions = new Map<string, AgentSession>()

type Route = (req: http.IncomingMessage, body: any, params: string[], res: http.ServerResponse) => Promise<unknown>
const routes: Array<[string, RegExp, Route]> = [
  ['GET', /^\/providers$/, async () => kit.providers()],
  ['GET', /^\/providers\/([\w-]+)\/catalog$/, async (_q, _b, [p]) => kit.catalog(p)],
  ['GET', /^\/sessions$/, async () => kit.listSessions({ limit: 50 })],
  [
    'POST',
    /^\/sessions$/,
    async (_q, body) => {
      const session = body.handle ? await kit.resume(body.handle, body) : await kit.session(body)
      const id = randomUUID()
      sessions.set(id, session)
      return { id, provider: session.provider, capabilities: session.capabilities, handle: session.handle }
    },
  ],
  ['GET', /^\/sessions\/([\w-]+)$/, async (_q, _b, [id]) => get(id).transcript],
  ['POST', /^\/sessions\/([\w-]+)\/messages$/, async (_q, body, [id]) => (void get(id).send(body.text).catch(() => undefined), { queued: get(id).queued })],
  ['POST', /^\/sessions\/([\w-]+)\/steer$/, async (_q, body, [id]) => get(id).steer(body.text)],
  ['POST', /^\/sessions\/([\w-]+)\/interrupt$/, async (_q, _b, [id]) => (await get(id).interrupt(), { ok: true })],
  ['POST', /^\/sessions\/([\w-]+)\/permissions\/([^/]+)$/, async (_q, body, [id, req]) => (await get(id).respond(decodeURIComponent(req), body), { ok: true })],
  ['POST', /^\/sessions\/([\w-]+)\/mode$/, async (_q, body, [id]) => (await (body.access ? get(id).setAccess(body.access) : get(id).setMode(body.mode)), get(id).info())],
  ['POST', /^\/sessions\/([\w-]+)\/model$/, async (_q, body, [id]) => (await get(id).setModel(body.model), get(id).info())],
  ['POST', /^\/sessions\/([\w-]+)\/thinking$/, async (_q, body, [id]) => (await get(id).setThinking(body.thinking), get(id).info())],
  ['POST', /^\/sessions\/([\w-]+)\/rewind$/, async (_q, body, [id]) => (await get(id).rewind(body.messageId, body.scope), get(id).transcript)],
  ['GET', /^\/sessions\/([\w-]+)\/commands$/, async (_q, _b, [id]) => get(id).commands()],
  ['DELETE', /^\/sessions\/([\w-]+)$/, async (_q, _b, [id]) => (await get(id).close(), sessions.delete(id), { ok: true })],
  [
    'GET',
    /^\/sessions\/([\w-]+)\/events$/,
    async (req, _b, [id], res) => {
      const session = get(id)
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`event: snapshot\ndata: ${JSON.stringify(session.transcript)}\n\n`)
      const off = session.on((event) => res.write(`data: ${JSON.stringify(event)}\n\n`))
      req.on('close', off)
      return new Promise(() => {}) // keep the stream open
    },
  ],
]

function get(id: string): AgentSession {
  const session = sessions.get(id)
  if (!session) throw Object.assign(new Error(`no session ${id}`), { status: 404 })
  return session
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  for (const [method, pattern, handler] of routes) {
    const match = req.method === method && url.pathname.match(pattern)
    if (!match) continue
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const result = await handler(req, raw ? JSON.parse(raw) : {}, match.slice(1), res)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
    } catch (error: any) {
      if (!res.headersSent) res.writeHead(error.status ?? (error.code === 'UNSUPPORTED_CAPABILITY' ? 400 : 500), { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: error.message, code: error.code }))
    }
    return
  }
  res.writeHead(404).end()
})

const port = Number(process.env.PORT ?? 4317)
server.listen(port, '127.0.0.1', () => console.log(`agentkit harness on http://127.0.0.1:${port}`))
process.on('SIGINT', async () => {
  await kit.shutdown()
  process.exit(0)
})
