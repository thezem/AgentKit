/**
 * Tool hub E2E: one MCP registry reaching every provider. Rows #36–#43 in FAILURE_MODES.md.
 * Artifact: test/e2e/artifacts/hub.json
 *
 *   node test/e2e/hub.ts                 # claude codex opencode
 *   node test/e2e/hub.ts codex
 */
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createAgentKit, readCliServers, ToolHub, type ProviderId } from '../../src/index.ts'

const providers: ProviderId[] = process.argv.slice(2).length ? process.argv.slice(2) : ['claude', 'codex', 'opencode']
const CHEAP: Record<string, object> = { claude: { model: 'haiku' }, codex: { thinking: 'low' }, opencode: {} }
const dir = mkdtempSync(path.join(os.tmpdir(), 'agentkit-hub-'))
execSync('git init -q', { cwd: dir })
const hubFile = path.join(dir, 'mcp-servers.json')
const NONCE = `UP-${Math.random().toString(36).slice(2, 8)}`
const NATIVE = `NAT-${Math.random().toString(36).slice(2, 8)}`
const fixture = { type: 'stdio' as const, command: process.execPath, args: [path.join(import.meta.dirname, 'fixtures/nonce-mcp.ts')], env: { NONCE } }

const kit = createAgentKit({ hub: { file: hubFile } })
const hub = kit.hub!
const checks: Array<{ name: string; ok: boolean; note?: string }> = []
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await Promise.race([fn(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 240_000))])
    checks.push({ name, ok: true, ...(note ? { note } : {}) })
    console.log(`  ✓ ${name}${note ? ` (${note})` : ''}`)
  } catch (error: any) {
    checks.push({ name, ok: false, note: error?.message ?? String(error) })
    console.log(`  ✗ ${name}: ${error?.message ?? error}`)
  }
}
const mcpClient = async (url: string) => {
  const c = new Client({ name: 'hub-test', version: '0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(url)))
  return c
}

console.log(`dir=${dir}`)
await hub.start()
await hub.add({ name: 'probe', transport: fixture })
hub.addTools('native-probe', [{ name: 'token', description: 'Returns the native probe token.', run: () => NATIVE }])
await hub.add({ name: 'broken', transport: { type: 'stdio', command: '/nonexistent/mcp-binary' } })

// #40 a bad upstream doesn't take the others down; a killed one comes back
await check('status', async () => {
  const s = Object.fromEntries(hub.list().map((x) => [x.name, x.status]))
  if (s.probe !== 'connected' || s['native-probe'] !== 'connected' || s.broken !== 'failed') throw new Error(JSON.stringify(s))
  const c = await mcpClient(hub.url('probe'))
  await c.callTool({ name: 'die', arguments: {} })
  await c.close()
  await new Promise((r) => setTimeout(r, 800))
  const after = hub.get('probe')!.status
  const again: any = await (await mcpClient(hub.url('probe'))).callTool({ name: 'nonce', arguments: {} })
  if (again.content?.[0]?.text !== NONCE) throw new Error(`after kill: ${JSON.stringify(again)}`)
  await hub.remove('broken')
  return `broken=failed alone; killed upstream went ${after}, next call reconnected`
})

// #41
await check('auth', async () => {
  const wrong = hub.url('probe').replace(/\/[^/]+\/probe$/, '/not-the-secret/probe')
  const res = await fetch(wrong, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
  if (res.status !== 404) throw new Error(`status ${res.status}`)
  const off = await fetch(hub.url('nope'), { method: 'POST' })
  if (off.status !== 404) throw new Error(`unknown server status ${off.status}`)
  return 'wrong secret / unknown server → 404'
})

// #36 #37 #38 per provider
for (const provider of providers) {
  await check(`call:${provider}`, async () => {
    const session = await kit.session({ provider, cwd: dir, access: 'full-access', ...CHEAP[provider] })
    try {
      const r = await session.run('Call the `nonce` tool (probe server) and the `token` tool (native-probe server). Reply with exactly their two outputs separated by one space, nothing else.')
      if (r.status !== 'completed') throw new Error(`${r.status} ${r.error ?? ''}`)
      if (!r.finalText.includes(NONCE) || !r.finalText.includes(NATIVE)) throw new Error(`reply: ${JSON.stringify(r.finalText.slice(0, 200))}`)
      // #38: what the CLI itself sees
      const native: any = session.native
      let seen: string[] = []
      if (provider === 'claude') seen = (await native.q.mcpServerStatus()).map((s: any) => s.name)
      if (provider === 'codex') {
        const list = await native.rpc.request('mcpServerStatus/list', { threadId: native.threadId, detail: 'toolsAndAuthOnly' })
        seen = (list.data ?? []).filter((s: any) => s.runtimeStatus !== 'disabled').map((s: any) => s.name)
      }
      if (provider === 'opencode') seen = ((await native.client.mcp.list({ location: { directory: dir } })).data ?? []).filter((s: any) => s.status?.status !== 'disabled').map((s: any) => s.name)
      const hubNames = new Set(Object.keys(hub.mcpServers()))
      const builtIn = new Set(['codex_apps', 'cua_repl']) // Codex's own, not from config.toml
      const extra = seen.filter((n) => !hubNames.has(n) && !builtIn.has(n))
      if (extra.length) throw new Error(`CLI still loads its own servers: ${extra.join(', ')}`)
      return `both tokens back; CLI sees only hub servers [${seen.join(', ')}]`
    } finally {
      await session.close()
    }
  })
}

// #39
await check('toggle', async () => {
  await hub.update('probe', { enabled: false })
  if ('probe' in hub.mcpServers()) throw new Error('disabled server still offered to new sessions')
  const res = await fetch(hub.url('probe'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  if (res.status !== 410) throw new Error(`endpoint status ${res.status}`)
  await hub.update('probe', { enabled: true, load: 'always' })
  if ((hub.mcpServers().probe as any)?.alwaysLoad !== true) throw new Error('load: always not passed through')
  return 'off → not offered + 410; always → alwaysLoad'
})

// #42
await check('persist', async () => {
  const again = new ToolHub({ file: hubFile })
  const p = again.get('probe')
  if (!p || !p.enabled || p.load !== 'always' || p.transport.type !== 'stdio') throw new Error(JSON.stringify(p))
  if (again.get('broken')) throw new Error('removed server came back')
  const native = again.get('native-probe')
  return `probe + toggles survived; native set ${native ? 'remembered (toggles only)' : 'not saved until toggled'}`
})

// #43
await check('import', async () => {
  const scratch = new ToolHub({ file: path.join(dir, 'import-test.json') })
  const expected = new Set(['claude', 'codex', 'opencode'].flatMap((s) => readCliServers(s as any).map((x) => x.name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 63))))
  const first = scratch.importFrom()
  const second = scratch.importFrom()
  if (second.added.length) throw new Error(`second import added ${second.added.join(', ')}`)
  const names = scratch.list().map((s) => s.name)
  if (names.length !== expected.size) throw new Error(`${names.length} servers vs ${expected.size} unique names in CLI configs`)
  return `${first.added.length} imported (${expected.size} unique across CLIs), re-import adds 0`
})

mkdirSync(path.join(import.meta.dirname, 'artifacts'), { recursive: true })
writeFileSync(path.join(import.meta.dirname, 'artifacts', 'hub.json'), JSON.stringify({ providers, checks, servers: hub.list().map(({ name, status, tools, load, enabled }) => ({ name, status, tools: tools.length, load, enabled })) }, null, 2))
await kit.shutdown()
const failed = checks.filter((c) => !c.ok)
console.log(`\n${failed.length ? `${failed.length} failed` : 'all passed'}`)
process.exit(failed.length ? 1 : 0)
