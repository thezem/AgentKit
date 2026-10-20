/**
 * Proof for issue #15's leftovers. Failure modes #61–64. Cheapest models.
 *
 *   node test/e2e/proof.ts claude codex opencode
 */
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentKit, type AgentSession, type ProviderId } from '../../src/index.ts'

const providers = (process.argv.slice(2).length ? process.argv.slice(2) : ['claude', 'codex', 'opencode']) as ProviderId[]
const CHEAP: Record<string, object> = {
  claude: { model: 'haiku' },
  codex: { model: 'gpt-5.6-luna', thinking: 'low' },
  opencode: { model: 'opencode-go/minimax-m3.1-flash-free' },
}
const kitOptions = { claude: { settingSources: ['project'] as any } }
const kit = createAgentKit(kitOptions)
const checks: Array<{ name: string; ok: boolean | 'skipped'; note?: string }> = []
const unsupported = (what: string) => Object.assign(new Error(`no ${what}`), { code: 'UNSUPPORTED_CAPABILITY' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await Promise.race([fn(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 240_000))])
    checks.push({ name, ok: true, ...(note ? { note } : {}) })
    console.log(`  ✓ ${name}${note ? ` (${note})` : ''}`)
  } catch (error: any) {
    const skipped = error?.code === 'UNSUPPORTED_CAPABILITY'
    checks.push({ name, ok: skipped ? 'skipped' : false, note: error.message })
    console.log(`  ${skipped ? '-' : '✗'} ${name}: ${error.message}`)
  }
}

const tmpRepo = (tag: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `agentkit-proof-${tag}-`))
  execSync('git init -q', { cwd: dir })
  return dir
}

if (providers.includes('claude')) {
  console.log('\n[claude options]')
  await check('claude-settings-merge', async () => {
    const k = createAgentKit({ codex: false, opencode: false, claude: { settingSources: ['project'], flagSettings: () => ({ hostFlag: 1 }), sdkOptions: { settings: { kitSetting: 2 } as any } } })
    const s = await k.session({ provider: 'claude', cwd: tmpRepo('merge'), model: 'opus', fast: true, providerOptions: { settings: { sessionSetting: 3 }, env: { AGENTKIT_PROOF: 'yes' } } })
    const options = (s.native as any).buildOptions(undefined)
    await k.shutdown()
    const st = options.settings ?? {}
    const missing = ['hostFlag', 'kitSetting', 'sessionSetting', 'fastMode'].filter((key) => !(key in st))
    if (missing.length) throw new Error(`settings missing ${missing.join(', ')}: ${JSON.stringify(st)}`)
    if (options.env?.AGENTKIT_PROOF !== 'yes' || !options.env?.PATH) throw new Error('env not merged with process env')
    return 'fast + flagSettings + sdkOptions + per-session settings/env all kept'
  })
}

for (const provider of providers) {
  console.log(`\n[${provider}]`)

  await check(`steer-replay:${provider}`, async () => {
    const nonce = `KIWI-${randomUUID().slice(0, 6)}`
    const s = await kit.session({ provider, cwd: tmpRepo('steer'), access: 'full-access', ...CHEAP[provider] })
    const done = s.send('Run exactly this shell command: `sleep 8` and then reply with the word "done".')
    while (!s.transcript.items.some((i) => i.type === 'tool_call')) await sleep(200)
    const { steered } = await s.steer(`Also include the word ${nonce} in your final reply.`)
    await done
    if (!steered) throw new Error('steer fell back to the queue')
    while (s.isRunning) await sleep(300)
    const handle = s.handle!
    await s.close()
    const fresh = createAgentKit(kitOptions)
    try {
      const resumed = await fresh.resume(handle)
      const history = await resumed.history()
      const hit = history.find((i) => i.type === 'user_message' && i.text.includes(nonce))
      if (!hit) throw new Error(`steered message missing from replay (${history.filter((i) => i.type === 'user_message').length} user messages)`)
      return 'steered message replayed as user_message'
    } finally {
      await fresh.shutdown()
    }
  })

  await check(`question:${provider}`, async () => {
    // Codex offers its question tool only in plan mode.
    const s = await kit.session({ provider, cwd: tmpRepo('q'), access: provider === 'codex' ? 'plan' : 'supervised', ...CHEAP[provider] })
    if (!s.capabilities.questions) throw unsupported('questions')
    let asked: string | null = null
    s.on((e) => {
      if (e.type !== 'permission_requested') return
      const r = e.request
      if (r.kind === 'question' && r.questions?.length) {
        asked = r.questions.map((q) => `${q.question} [${(q.options ?? []).map((o) => o.label).join('/')}]`).join('; ')
        const answers = Object.fromEntries(r.questions.map((q) => [q.id, q.options?.find((o) => /coffee/i.test(o.label))?.label ?? 'coffee']))
        void s.respond(r.id, { behavior: 'allow', answers }).catch(() => undefined)
      } else void s.respond(r.id, 'deny').catch(() => undefined)
    })
    const r = await s.run(
      'Use your tool for asking the user a structured multiple-choice question (do not just write the question in your reply). Ask me whether I prefer tea or coffee, with exactly the options "tea" and "coffee". After I answer, reply with only my choice.',
    )
    await s.close()
    if (!asked) throw new Error(`no question request; reply: ${JSON.stringify(r.finalText.slice(0, 120))}`)
    if (!/coffee/i.test(r.finalText)) throw new Error(`answer not used; reply: ${JSON.stringify(r.finalText.slice(0, 120))}`)
    return `asked "${asked}", reply used the answer`
  })

  await check(`rewind-files:${provider}`, async () => {
    const cwd = tmpRepo('rw')
    const s = await kit.session({ provider, cwd, access: 'full-access', ...CHEAP[provider] })
    if (!s.capabilities.rewindFiles) throw unsupported('rewindFiles')
    const file = path.join(cwd, 'state.txt')
    await s.run('Using your file-writing tool (not a shell command), create a file named state.txt in the current directory containing exactly: one')
    if (!existsSync(file) || readFileSync(file, 'utf8').trim() !== 'one') throw new Error(`turn 1 wrote ${existsSync(file) ? readFileSync(file, 'utf8') : 'nothing'}`)
    await s.run('Using your file-editing tool (not a shell command), change state.txt so it contains exactly: two')
    if (readFileSync(file, 'utf8').trim() !== 'two') throw new Error(`turn 2 wrote ${readFileSync(file, 'utf8')}`)
    const users = s.transcript.items.filter((i) => i.type === 'user_message' && i.messageId) as Array<{ messageId: string }>
    const target = users[users.length - 1]?.messageId
    if (!target) throw new Error('no messageId on the second user message')
    const scope = s.capabilities.rewindConversation && provider === 'opencode' ? 'both' : 'files'
    await (s as AgentSession).rewind(target, scope)
    await s.close()
    const now = existsSync(file) ? readFileSync(file, 'utf8').trim() : '(deleted)'
    if (now !== 'one') throw new Error(`after rewind: ${now}`)
    return `state.txt back to "one" (scope ${scope})`
  })
}

await kit.shutdown()
const dir = path.join(import.meta.dirname, 'artifacts')
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, `proof-${providers.join('-')}.json`), JSON.stringify({ at: new Date().toISOString(), providers, checks }, null, 2))
const failed = checks.filter((c) => c.ok === false).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
