/**
 * Conformance E2E: the same scenario against every provider, through AgentKit only.
 * Uses your real local sign-ins. Writes test/e2e/artifacts/<provider>.json.
 *
 *   node test/e2e/conformance.ts                 # all providers
 *   node test/e2e/conformance.ts claude codex    # subset
 *   node test/e2e/conformance.ts mock            # free, no CLI needed
 */
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentKit, type AgentEvent, type PersistenceHandle, type AgentSession, type OpenSessionOptions, type ProviderId } from '../../src/index.ts'

type Check = { name: string; ok: boolean; ms: number; note?: string }

const CHEAP: Record<string, Partial<OpenSessionOptions>> = {
  claude: { model: 'haiku' },
  codex: { thinking: 'low' },
  opencode: {},
  mock: {},
}
/** OpenCode allows edits by default; force a prompt so the permission path is exercised. */
const ASK_FOR_WRITES: Record<string, Partial<OpenSessionOptions>> = {
  opencode: { providerOptions: { permissions: [{ action: 'edit', resource: '*', effect: 'ask' }, { action: 'shell', resource: '*', effect: 'ask' }] } },
}

const requested = process.argv.slice(2)
const providers: ProviderId[] = requested.length ? requested : ['claude', 'codex', 'opencode']
const kit = createAgentKit({ mock: providers.includes('mock') ? { tokenDelayMs: 5 } : false })
const artifactsDir = path.join(import.meta.dirname, 'artifacts')
mkdirSync(artifactsDir, { recursive: true })

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))])
}

function childCount(): number {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid)]).toString().trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

async function conformance(provider: ProviderId) {
  const checks: Check[] = []
  const events: AgentEvent[] = []
  const cwd = mkdtempSync(path.join(os.tmpdir(), `agentkit-${provider}-`))
  execSync('git init -q', { cwd })
  const base = { provider, cwd, ...CHEAP[provider] }
  const record = (session: AgentSession) => session.on((event) => events.push(event))

  async function check(name: string, fn: () => Promise<string | void>, timeoutMs = 180_000) {
    const started = Date.now()
    try {
      const note = await withTimeout(fn(), timeoutMs, name)
      checks.push({ name, ok: true, ms: Date.now() - started, ...(note ? { note } : {}) })
      console.log(`  ✓ ${name}${note ? ` (${note})` : ''}`)
    } catch (error) {
      checks.push({ name, ok: false, ms: Date.now() - started, note: error instanceof Error ? error.message : String(error) })
      console.log(`  ✗ ${name}: ${error instanceof Error ? error.message : error}`)
    }
  }

  console.log(`\n[${provider}] cwd=${cwd}`)
  const childrenBefore = childCount()
  let session: AgentSession | null = null
  let firstHandle: AgentSession['handle'] = null

  await check('available', async () => {
    const status = (await kit.providers()).find((p) => p.provider === provider)
    if (!status?.available) throw new Error('provider not available')
  })
  await check('catalog', async () => {
    const catalog = await kit.catalog(provider, { cwd })
    if (!catalog.models.length || !catalog.modes.length) throw new Error(`models=${catalog.models.length} modes=${catalog.modes.length}`)
    return `${catalog.models.length} models, modes=${catalog.modes.map((m) => m.id).join('/')}`
  })

  await check('basic-turn', async () => {
    session = await kit.session({ ...base, access: 'supervised', ...ASK_FOR_WRITES[provider] })
    record(session)
    const result = await session.run('Reply with exactly the single word: marmalade')
    if (result.status !== 'completed') throw new Error(`status=${result.status} ${result.error ?? ''}`)
    if (provider !== 'mock' && result.finalText.trim().toLowerCase().replace(/[^a-z]/g, '') !== 'marmalade') throw new Error(`finalText=${JSON.stringify(result.finalText)}`)
    firstHandle = session.handle
    return `"${result.finalText.trim()}" in=${result.usage?.inputTokens ?? '?'} out=${result.usage?.outputTokens ?? '?'}`
  })

  await check('transcript', async () => {
    const items = session!.transcript.items
    const last = [...items].reverse().find((item) => item.type === 'assistant_message')
    if (!last || last.type !== 'assistant_message' || !/marmalade/i.test(last.text)) throw new Error(`last assistant item: ${JSON.stringify(last)}`)
    if (!items.some((item) => item.type === 'user_message')) throw new Error('no user_message in transcript')
  })

  await check('permission', async () => {
    const asked: string[] = []
    const off = session!.on((event) => {
      if (event.type === 'permission_requested') {
        asked.push(`${event.request.kind}:${event.request.name}`)
        void session!.respond(event.request.id, { behavior: 'allow', actionId: 'once' }).catch((error) => asked.push(`respond-error:${error.message}`))
      }
    })
    const prompt =
      provider === 'mock' ? 'make the file [tool]' : 'Create a file named hello.txt in the current directory containing exactly the text: hi. Use your file-writing tool, then reply "done".'
    const result = await session!.run(prompt)
    off()
    if (result.status !== 'completed') throw new Error(`status=${result.status} ${result.error ?? ''}`)
    if (!asked.length) throw new Error('no permission_requested event')
    if (asked.some((entry) => entry.startsWith('respond-error'))) throw new Error(`respond failed: ${asked.join(', ')}`)
    const tool = result.timeline.find((item) => item.type === 'tool_call' && item.detail.type !== 'unknown')
    if (!tool || tool.type !== 'tool_call') throw new Error('no typed tool_call in timeline')
    if (provider !== 'mock' && !existsSync(path.join(cwd, 'hello.txt'))) throw new Error('hello.txt was not created')
    return `asked=[${asked.join(', ')}] tool=${tool.name}:${tool.detail.type}`
  })

  await check('mode-switch', async () => {
    await session!.setAccess('auto-edit')
    const info = await session!.info()
    const expected = { claude: 'acceptEdits', codex: 'auto', opencode: 'build', mock: 'ask' }[provider as string]
    if (info.modeId !== expected) throw new Error(`modeId=${info.modeId}, expected ${expected}`)
    return `modeId=${info.modeId}`
  })

  await check('history', async () => {
    const history = await session!.history()
    const users = history.filter((item) => item.type === 'user_message')
    if (!users.some((item) => item.type === 'user_message' && /marmalade/.test(item.text))) throw new Error(`history users: ${users.length}`)
    return `${history.length} items, ${users.length} user messages`
  })

  await check('rewind', async () => {
    const before = await session!.history()
    const target = before.filter((item) => item.type === 'user_message').at(-1)
    if (!target || target.type !== 'user_message' || !target.messageId) throw new Error('no user message id to rewind to')
    const idBefore = session!.id
    await session!.rewind(target.messageId, 'conversation')
    const after = await session!.history()
    const users = after.filter((item) => item.type === 'user_message')
    if (users.some((item) => item.type === 'user_message' && item.text === target.text)) throw new Error('rewound message still in history')
    if (!users.some((item) => item.type === 'user_message' && /marmalade/.test(item.text))) throw new Error('rewind dropped too much')
    const followUp = await session!.run('Reply with exactly: ok')
    if (followUp.status !== 'completed') throw new Error(`turn after rewind: ${followUp.status} ${followUp.error ?? ''}`)
    firstHandle = session!.handle
    return `history ${before.length}→${after.length}${session!.id !== idBefore ? ', new native id' : ''}`
  })

  await check('interrupt', async () => {
    const fast = await kit.session({ ...base, access: 'full-access' })
    record(fast)
    try {
      const prompt = provider === 'mock' ? 'a b c d e f g h i j k l m n o p q r s t u v w x y z [slow]' : 'Run the shell command `sleep 60` and then reply "finished".'
      const done = fast.run(prompt)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 15_000)
        const off = fast.on((event) => {
          if (event.type === 'timeline' && (event.item.type === 'tool_call' || event.item.type === 'assistant_message')) {
            clearTimeout(timer)
            off()
            setTimeout(resolve, 1500)
          }
        })
      })
      const t0 = Date.now()
      await fast.interrupt()
      const result = await withTimeout(done, 30_000, 'interrupted run')
      if (result.status !== 'canceled') throw new Error(`status=${result.status}`)
      const after = await fast.run('Reply with exactly: ok')
      if (after.status !== 'completed') throw new Error(`after-interrupt status=${after.status} ${after.error ?? ''}`)
      return `stopped in ${Date.now() - t0}ms, next turn ok`
    } finally {
      await fast.close()
    }
  })

  await check('resume', async () => {
    await session!.close()
    session = null
    if (!firstHandle) throw new Error('no handle')
    const resumed = await kit.resume(JSON.parse(JSON.stringify(firstHandle)))
    record(resumed)
    try {
      if (provider === 'mock') return 'mock: handle resumes'
      const result = await resumed.run('In my very first message of this conversation I asked you to reply with one specific word. What was that word? Reply with just that word.')
      if (!/marmalade/i.test(result.finalText)) throw new Error(`answer=${JSON.stringify(result.finalText)}`)
      return `remembered "${result.finalText.trim()}"`
    } finally {
      await resumed.close()
    }
  })

  await check('list-sessions', async () => {
    const sessions = await kit.listSessions({ provider, cwd })
    const id = firstHandle?.sessionId
    if (!sessions.some((s) => s.sessionId === id)) throw new Error(`${sessions.length} sessions, none match ${id}`)
    return `${sessions.length} sessions in cwd`
  })

  const summary = { provider, cwd, passed: checks.filter((c) => c.ok).length, total: checks.length, checks, eventCounts: countBy(events), events: events.slice(0, 400) }
  writeFileSync(path.join(artifactsDir, `${provider}.json`), JSON.stringify(summary, null, 2))
  return { summary, childrenBefore }
}

function countBy(events: AgentEvent[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const event of events) {
    const key = event.type === 'timeline' ? `timeline:${event.item.type}` : event.type
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

const results = []
for (const provider of providers) results.push(await conformance(provider))
await kit.shutdown()
await new Promise((r) => setTimeout(r, 1500))
const leaked = childCount()
console.log(`\ncleanup: ${leaked} child processes left after shutdown`)
console.log('\n' + results.map(({ summary }) => `${summary.provider.padEnd(9)} ${summary.passed}/${summary.total}`).join('\n'))
writeFileSync(path.join(artifactsDir, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), leakedChildren: leaked, results: results.map((r) => ({ provider: r.summary.provider, passed: r.summary.passed, total: r.summary.total, failed: r.summary.checks.filter((c) => !c.ok) })) }, null, 2))
process.exit(results.every((r) => r.summary.passed === r.summary.total) && leaked === 0 ? 0 : 1)
