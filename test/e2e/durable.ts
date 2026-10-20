/**
 * Durable-layer E2E: crash mid-turn, idempotency, inbox, fork, compact.
 * Every check maps to a row in FAILURE_MODES.md (#16–#26).
 * Artifacts: test/e2e/artifacts/durable-<provider>.json (+ the sqlite file path).
 *
 *   node test/e2e/durable.ts mock
 *   node test/e2e/durable.ts claude codex opencode
 */
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentKit, type AgentKit, type AgentSession, type ProviderId, type TimelineItem } from '../../src/index.ts'

const providers: ProviderId[] = process.argv.slice(2).length ? process.argv.slice(2) : ['claude', 'codex', 'opencode']
const CHEAP: Record<string, object> = { claude: { model: 'haiku' }, codex: { model: 'gpt-5.6-luna', thinking: 'low' }, opencode: { model: 'opencode-go/minimax-m3.1-flash-free' }, mock: {} }
const artifacts = path.join(import.meta.dirname, 'artifacts')
mkdirSync(artifacts, { recursive: true })
const out: Record<string, unknown> = {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const assistantText = (items: TimelineItem[]) => items.filter((i) => i.type === 'assistant_message').map((i: any) => i.text).join('')
const userTexts = (items: TimelineItem[]) => items.filter((i) => i.type === 'user_message').map((i: any) => i.text as string)
const mockOpts = (p: string) => (p === 'mock' ? { mock: { tokenDelayMs: 5 } } : { mock: false as const })

for (const provider of providers) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `agentkit-durable-${provider}-`))
  execSync('git init -q', { cwd: dir })
  const storeFile = path.join(dir, 'agentkit.db')
  const checks: Array<{ name: string; ok: boolean | 'skipped'; note?: string }> = []
  const check = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const note = await Promise.race([fn(), sleep(240_000).then(() => Promise.reject(new Error('timeout')))])
      checks.push({ name, ok: true, ...(note ? { note } : {}) })
      console.log(`  ✓ ${name}${note ? ` (${note})` : ''}`)
    } catch (error: any) {
      const skipped = error?.code === 'UNSUPPORTED_CAPABILITY'
      checks.push({ name, ok: skipped ? 'skipped' : false, note: error?.message ?? String(error) })
      console.log(`  ${skipped ? '-' : '✗'} ${name}: ${error?.message ?? error}`)
    }
  }
  console.log(`\n[${provider}] store=${storeFile}`)
  let kit: AgentKit | null = null

  // #16 #17 #18 #20 — kill -9 mid-turn, reopen, nothing shown is lost, nothing re-sent.
  await check('crash', async () => {
    const key = `crash-${provider}`
    const requestId = `req-crash-${provider}`
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'durable-child.ts'), storeFile, provider, key, requestId, dir, JSON.stringify(CHEAP[provider])], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let shown = ''
    let buffer = ''
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c))
    const enough = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = JSON.parse(buffer.slice(0, nl))
          buffer = buffer.slice(nl + 1)
          if (line.shown) shown += line.shown
          if (shown.length > 60) resolve()
        }
      })
      child.on('exit', (code) => reject(new Error(`child exited early (${code}): ${stderr.slice(-400)}`)))
    })
    await Promise.race([enough, sleep(120_000).then(() => Promise.reject(new Error(`no streamed text in 120s: ${stderr.slice(-300)}`)))])
    child.kill('SIGKILL')
    await new Promise((r) => child.once('exit', r))

    kit = createAgentKit({ store: storeFile, ...mockOpts(provider) })
    const recovered = kit.recovered.find((r) => r.id === requestId)
    if (!recovered || recovered.status !== 'interrupted') throw new Error(`recovered: ${JSON.stringify(kit.recovered.map((r) => [r.id, r.status]))}`)
    const ref = kit.submission(requestId)
    if (ref?.status !== 'interrupted') throw new Error(`kit.submission() after restart: ${ref?.status}`)

    const session = await kit.restore(key, CHEAP[provider])
    const t = session.transcript
    const saved = assistantText(t.items)
    if (!saved.startsWith(shown)) throw new Error(`lost shown text.\n shown=${JSON.stringify(shown.slice(0, 120))}\n saved=${JSON.stringify(saved.slice(0, 120))}`)
    if (t.status !== 'idle' || t.activeTurnId) throw new Error(`restored status=${t.status} active=${t.activeTurnId}`)
    if (!t.items.some((i) => i.type === 'notice' && /Interrupted/.test(i.message))) throw new Error('no interrupted notice in transcript')

    // #18: idle for a while, and re-submitting the same requestId must NOT re-run it.
    const before = userTexts(t.items).length
    await sleep(3000)
    const again = await session.submit('this must not run', { requestId })
    if (again.status !== 'interrupted') throw new Error(`resubmit same requestId -> ${again.status}`)
    if (session.isRunning || userTexts(session.transcript.items).length !== before) throw new Error('crashed turn was re-sent')

    const next = await session.run('Reply with exactly: back')
    if (next.status !== 'completed') throw new Error(`turn after restore: ${next.status} ${next.error ?? ''}`)
    await session.close()
    return `showed ${shown.length} chars before kill -9, store kept ${saved.length}; status=interrupted, not re-sent, next turn ok`
  })

  kit ??= createAgentKit({ store: storeFile, ...mockOpts(provider) })
  const k = kit as AgentKit
  let session: AgentSession | null = null

  // #19 — same requestId twice = one turn.
  await check('idempotency', async () => {
    session = await k.session({ provider, cwd: dir, access: 'full-access', key: `main-${provider}`, ...CHEAP[provider] })
    const [a, b] = await Promise.all([session.submit('Reply with exactly the single word: marmalade', { requestId: 'req-once' }), session.submit('Reply with exactly the single word: marmalade', { requestId: 'req-once' })])
    if (a !== b) throw new Error('two different submissions for one requestId')
    const r = await a.result
    if (r.status !== 'completed') throw new Error(`status=${r.status} ${r.error ?? ''}`)
    const c = await session.submit('Reply with exactly the single word: marmalade', { requestId: 'req-once' })
    if (c !== a) throw new Error('third submit made a new submission')
    const users = userTexts(session.transcript.items).filter((t) => /marmalade/.test(t))
    if (users.length !== 1) throw new Error(`${users.length} marmalade turns ran`)
    const viaKit = await k.submission('req-once')!.wait()
    if (viaKit.status !== 'completed') throw new Error(`kit.submission wait: ${viaKit.status}`)
    return '3 submits, 1 turn, kit.submission() reattached'
  })

  // #21 #22 #23 — visible inbox, withdraw, reject, steer fallback.
  await check('inbox', async () => {
    const s = session!
    const long = provider === 'mock' ? 'a b c d e f g h i j k l m n o [slow]' : 'Run the shell command `sleep 6` and then reply with exactly: slept'
    const first = await s.submit(long)
    await sleep(provider === 'mock' ? 300 : 1500)
    const queued = await s.submit('Reply with exactly: second', { whenBusy: 'queue' })
    const withdrawn = await s.submit('Reply with exactly: WITHDRAWN-PROMPT', { whenBusy: 'queue' })
    const inboxIds = s.transcript.inbox.map((e) => e.id)
    if (!inboxIds.includes(queued.id) || !inboxIds.includes(withdrawn.id)) throw new Error(`inbox=${JSON.stringify(s.transcript.inbox)}`)
    if (!withdrawn.withdraw()) throw new Error('withdraw returned false')
    if (s.transcript.inbox.some((e) => e.id === withdrawn.id)) throw new Error('withdrawn entry still in inbox')
    let rejected = false
    try {
      await s.submit('nope', { whenBusy: 'reject' })
    } catch (e: any) {
      rejected = e.code === 'SESSION_BUSY'
    }
    if (!rejected) throw new Error('whenBusy reject did not throw SESSION_BUSY')
    const steered = await s.submit('Also, end your reply with the word KIWI.', { whenBusy: 'steer' })
    const steerOutcome = steered.status
    const [r1, r2, r3] = await Promise.all([first.result, queued.result, steered.result])
    if (r1.status !== 'completed' || r2.status !== 'completed' || r3.status !== 'completed') throw new Error(`statuses ${r1.status}/${r2.status}/${r3.status}`)
    if ((await withdrawn.wait()).status !== 'withdrawn') throw new Error('withdrawn record status wrong')
    while (s.busy) await sleep(200)
    if (userTexts(s.transcript.items).some((t) => t.includes('WITHDRAWN-PROMPT'))) throw new Error('withdrawn prompt ran anyway')
    if (s.transcript.inbox.length) throw new Error('inbox not empty at the end')
    return `inbox showed 2, withdrew 1, reject threw, steer=${steerOutcome === 'steered' ? 'steered into the live turn' : 'fell back to inbox'}`
  })

  // #24 #25 — fork leaves the original alone and is resumable.
  await check('fork', async () => {
    const s = session!
    if (!s.capabilities.fork) throw Object.assign(new Error('no fork'), { code: 'UNSUPPORTED_CAPABILITY' })
    while (s.busy) await sleep(200)
    await s.run('Reply with exactly: LATER-MESSAGE')
    const history = await s.history()
    const target = history.filter((i) => i.type === 'user_message' && /LATER-MESSAGE/.test(i.text)).at(-1) as any
    if (!target?.messageId) throw new Error('no id for the later message')
    const forked = await s.fork({ beforeMessageId: target.messageId })
    try {
      if (forked.id === s.id) throw new Error('fork returned the same native session')
      const original = userTexts(await s.history())
      if (!original.some((t) => /LATER-MESSAGE/.test(t))) throw new Error('fork mutated the original')
      const branch = userTexts(await forked.history())
      if (branch.some((t) => /LATER-MESSAGE/.test(t))) throw new Error('fork still has the later message')
      if (!forked.transcript.items.length) throw new Error('fork transcript not hydrated')
      if (provider === 'mock') return `branch ${branch.length} user msgs, original ${original.length}`
      const r = await forked.run('Earlier in this conversation I asked you to reply with one specific single word. What was it? Reply with just that word.')
      if (!/marmalade/i.test(r.finalText)) throw new Error(`fork forgot: ${JSON.stringify(r.finalText)}`)
      return `branch ${branch.length} user msgs vs original ${original.length}; fork remembered "marmalade"`
    } finally {
      await forked.close()
    }
  })

  // #26 — compact keeps the session usable and keeps what matters.
  await check('compact', async () => {
    const s = session!
    if (!s.capabilities.compact) throw Object.assign(new Error('no compact'), { code: 'UNSUPPORTED_CAPABILITY' })
    while (s.busy) await sleep(200)
    const t0 = Date.now()
    await s.compact('Keep the exact single word I first asked you to reply with.')
    const ms = Date.now() - t0
    if (provider === 'mock') {
      const r = await s.run('ok')
      if (r.status !== 'completed') throw new Error(r.status)
      return `${ms}ms`
    }
    const r = await s.run('Earlier in this conversation I asked you to reply with one specific single word. What was it? Reply with just that word.')
    if (r.status !== 'completed') throw new Error(`after compact: ${r.status} ${r.error ?? ''}`)
    if (!/marmalade/i.test(r.finalText)) throw new Error(`forgot after compact: ${JSON.stringify(r.finalText)}`)
    return `compacted in ${ms}ms, still remembers "marmalade"`
  })

  await (session as AgentSession | null)?.close()
  await k.shutdown()
  out[provider] = { storeFile, checks }
}

writeFileSync(path.join(artifacts, `durable-${providers.join('-')}.json`), JSON.stringify(out, null, 2))
const failed = Object.values(out).flatMap((p: any) => p.checks).filter((c: any) => c.ok === false)
console.log(`\n${failed.length ? `${failed.length} failed` : 'all passed'}`)
process.exit(failed.length ? 1 : 0)
