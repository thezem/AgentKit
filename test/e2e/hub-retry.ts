/**
 * Hub HTTP upstreams: honest connect errors, SSE fallback only on a 4xx, reconnect with backoff. Failure modes #65–67.
 * Real MCP servers on loopback, no models, no mocks.
 *
 *   node test/e2e/hub-retry.ts
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ToolHub } from '../../src/index.ts'

const checks: Array<{ name: string; ok: boolean; note?: string }> = []
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn()
    checks.push({ name, ok: true, ...(note ? { note } : {}) })
    console.log(`  ✓ ${name}${note ? ` (${note})` : ''}`)
  } catch (error: any) {
    checks.push({ name, ok: false, note: error.message })
    console.log(`  ✗ ${name}: ${error.message}`)
  }
}

function mcp(): McpServer {
  const server = new McpServer({ name: 'retry-e2e', version: '1.0.0' })
  server.tool('ping', 'pong', async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }))
  return server
}

function listen(handler: http.RequestListener, port = 0): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}
const portOf = (server: http.Server) => (server.address() as AddressInfo).port
const stop = (server: http.Server) => new Promise<void>((resolve) => (server.close(() => resolve()), server.closeAllConnections()))

async function until<T>(fn: () => T | undefined | false, ms: number): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = fn()
    if (value) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), 'agentkit-hub-retry-'))
const hub = new ToolHub({ file: path.join(root, 'hub.json') })
await hub.start()

// #65 + #66: nothing listening → the real error, no SSE detour; once a server appears, it connects on its own.
await check('retry-after-failure', async () => {
  const probe = await listen(() => undefined)
  const port = portOf(probe)
  await stop(probe)
  const state = await hub.add({ name: 'late', transport: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } })
  if (state.status !== 'failed') throw new Error(`status ${state.status}`)
  if (/sse/i.test(state.error ?? '')) throw new Error(`error mentions SSE: ${state.error}`)
  const failedAt = Date.now()
  const server = await listen(async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => void transport.close())
    await mcp().connect(transport)
    await transport.handleRequest(req, res)
  }, port)
  try {
    const live = await until(() => {
      const s = hub.get('late')
      return s?.status === 'connected' && s
    }, 20_000)
    if (live.tools.length !== 1) throw new Error(`${live.tools.length} tools`)
    return `failed with "${state.error}", connected ${((Date.now() - failedAt) / 1000).toFixed(1)}s later without refresh`
  } finally {
    await hub.remove('late')
    await stop(server)
  }
})

// #67a: a 5xx is a server problem, not "this server only speaks SSE".
await check('no-sse-on-5xx', async () => {
  const server = await listen((_req, res) => res.writeHead(503).end('down'))
  try {
    const state = await hub.add({ name: 'down', transport: { type: 'http', url: `http://127.0.0.1:${portOf(server)}/mcp` } })
    if (state.status !== 'failed') throw new Error(`status ${state.status}`)
    if (/sse/i.test(state.error ?? '')) throw new Error(`error mentions SSE: ${state.error}`)
    await hub.remove('down')
    return state.error
  } finally {
    await stop(server)
  }
})

// #67b: a legacy server that refuses the initialize POST with 405 still gets the SSE fallback.
await check('sse-fallback-on-405', async () => {
  const sessions = new Map<string, SSEServerTransport>()
  const server = await listen(async (req, res) => {
    const url = new URL(req.url!, 'http://x')
    if (url.pathname === '/mcp' && req.method === 'GET') {
      const transport = new SSEServerTransport('/messages', res)
      sessions.set(transport.sessionId, transport)
      await mcp().connect(transport)
    } else if (url.pathname === '/messages' && req.method === 'POST') {
      await sessions.get(url.searchParams.get('sessionId') ?? '')?.handlePostMessage(req, res)
    } else res.writeHead(405).end()
  })
  try {
    const state = await hub.add({ name: 'legacy', transport: { type: 'http', url: `http://127.0.0.1:${portOf(server)}/mcp` } })
    if (state.status !== 'connected' || state.tools.length !== 1) throw new Error(`status ${state.status} ${state.error ?? ''}`)
    await hub.remove('legacy')
    return 'connected over SSE, 1 tool'
  } finally {
    await stop(server)
  }
})

await hub.close()
const dir = path.join(import.meta.dirname, 'artifacts')
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'hub-retry.json'), JSON.stringify({ at: new Date().toISOString(), checks }, null, 2))
const failed = checks.filter((c) => !c.ok).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
