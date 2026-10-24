/**
 * Small lifecycle faults from the audit: stream() ending on close, stored submissions that poll forever, TOML values
 * containing " #". Failure modes #79–80, #83–84. Mock provider, no models.
 *
 *   node test/e2e/lifecycle.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentKit, sqliteStore, type SubmissionRecord } from '../../src/index.ts'
import { readCodexToml } from '../../src/hub.ts'

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
const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: still pending after ${ms}ms`)), ms)))
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}
const timers = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length

// #80
await check('stream-ends-on-close', async () => {
  const kit = createAgentKit({ mock: true, claude: false, codex: false, opencode: false })
  const session = await kit.session({ provider: 'mock', cwd: process.cwd() })
  const waiting = (async () => {
    let seen = 0
    for await (const _ of session.stream()) seen++
    return seen
  })()
  const idle = (async () => {
    for await (const _ of session.stream()) void _
  })()
  await new Promise((r) => setTimeout(r, 100))
  await session.close()
  await within(Promise.all([waiting, idle]), 1000, 'stream() after close()')
  await kit.shutdown()
  return 'two readers waiting for the next event both ended'
})

// #83
const root = mkdtempSync(path.join(os.tmpdir(), 'agentkit-lifecycle-'))
const record = (id: string, sessionKey: string): SubmissionRecord => ({
  id,
  sessionKey,
  provider: 'mock',
  status: 'running',
  prompt: 'hi',
  whenBusy: 'queue',
  turnId: null,
  handle: null,
  result: null,
  error: null,
  createdAt: new Date().toISOString(),
  finishedAt: null,
})
await check('stored-wait-lazy', async () => {
  const store = sqliteStore(path.join(root, 'lazy.db'))
  const kit = createAgentKit({ mock: true, claude: false, codex: false, opencode: false, store })
  store.putSubmission(record('lazy-1', 'lazy-session')) // after the kit started: startup recovery must not touch it
  const before = timers()
  const submission = kit.submission('lazy-1')
  if (!submission) throw new Error('kit.submission returned null')
  const after = timers()
  void submission.status
  if (after !== before) throw new Error(`${after - before} timer(s) started before anyone waited`)
  store.deleteSession('lazy-session')
  await within(submission.wait(), 3000, 'wait() after delete') // let the poll end so the process can exit
  await kit.shutdown()
  return 'no polling until wait()/result'
})
await check('stored-wait-deleted', async () => {
  const store = sqliteStore(path.join(root, 'deleted.db'))
  const kit = createAgentKit({ mock: true, claude: false, codex: false, opencode: false, store })
  store.putSubmission(record('gone-1', 'gone-session'))
  const submission = kit.submission('gone-1')
  if (!submission) throw new Error('kit.submission returned null')
  const waiting = submission.wait()
  setTimeout(() => store.deleteSession('gone-session'), 700)
  const settled = await within(waiting, 3000, 'wait() after the row was deleted')
  if (settled.status !== 'canceled') throw new Error(`status ${settled.status}`)
  const result = await within(submission.result, 1000, 'result')
  if (result.status !== 'canceled') throw new Error(`result.status ${result.status}`)
  await kit.shutdown()
  return `settled ${settled.status}: ${settled.error}`
})

// #84
await check('toml-hash-in-string', async () => {
  const servers = readCodexToml(
    [
      '# top comment',
      '[mcp_servers.demo]',
      'command = "node" # trailing comment',
      'args = [',
      '  "--label", # don\'t let this apostrophe open a string',
      '  "a #b", \'c #d\',',
      '] # comment after the array',
      'startup_timeout_sec = 20 # number with comment',
      '[mcp_servers.demo.env]',
      'TOKEN = "pass #1"',
      "OTHER = 'lit #2'",
      '[mcp_servers.web]',
      'url = "https://example.com/mcp#frag" # remote',
    ].join('\n'),
  )
  const demo = servers.find((s) => s.name === 'demo')
  const web = servers.find((s) => s.name === 'web')
  if (!demo || demo.transport.type !== 'stdio') throw new Error(`demo: ${JSON.stringify(demo)}`)
  const t: any = demo.transport
  if (t.command !== 'node') throw new Error(`command ${JSON.stringify(t.command)}`)
  if (JSON.stringify(t.args) !== JSON.stringify(['--label', 'a #b', 'c #d'])) throw new Error(`args ${JSON.stringify(t.args)}`)
  if (t.env?.TOKEN !== 'pass #1' || t.env?.OTHER !== 'lit #2') throw new Error(`env ${JSON.stringify(t.env)}`)
  if ((web?.transport as any)?.url !== 'https://example.com/mcp#frag') throw new Error(`url ${JSON.stringify(web?.transport)}`)
  return 'quoted " #" kept, trailing comments dropped'
})

const dir = path.join(import.meta.dirname, 'artifacts')
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'lifecycle.json'), JSON.stringify({ at: new Date().toISOString(), checks }, null, 2))
const failed = checks.filter((c) => !c.ok).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
