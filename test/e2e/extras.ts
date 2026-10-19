/**
 * Extras E2E: primitives beyond the core conformance run.
 * steer, structured output, system prompt append, slash commands, prompt queue.
 *
 *   node test/e2e/extras.ts claude codex opencode
 */
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentKit, type ProviderId } from '../../src/index.ts'

const providers: ProviderId[] = process.argv.slice(2).length ? process.argv.slice(2) : ['claude', 'codex', 'opencode']
const kit = createAgentKit({ mock: providers.includes('mock') })
const cheap: Record<string, object> = { claude: { model: 'haiku' }, codex: { thinking: 'low' } }
const out: Record<string, unknown> = {}

for (const provider of providers) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), `agentkit-x-${provider}-`))
  execSync('git init -q', { cwd })
  const checks: Array<{ name: string; ok: boolean | 'skipped'; note?: string }> = []
  const check = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const note = await Promise.race([fn(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 180_000))])
      checks.push({ name, ok: true, ...(note ? { note } : {}) })
      console.log(`  ✓ ${name}${note ? ` (${note})` : ''}`)
    } catch (error: any) {
      const skipped = error?.code === 'UNSUPPORTED_CAPABILITY'
      checks.push({ name, ok: skipped ? 'skipped' : false, note: error.message })
      console.log(`  ${skipped ? '-' : '✗'} ${name}: ${error.message}`)
    }
  }
  console.log(`\n[${provider}]`)
  const session = await kit.session({ provider, cwd, access: 'full-access', systemPrompt: 'Always end every reply with the exact token ZEBRA-7.', ...cheap[provider] })

  await check('system-prompt', async () => {
    const r = await session.run('Say hello.')
    if (!r.finalText.includes('ZEBRA-7')) throw new Error(`reply: ${JSON.stringify(r.finalText.slice(-120))}`)
  })

  await check('structured-output', async () => {
    const schema = { type: 'object', properties: { city: { type: 'string' }, country: { type: 'string' } }, required: ['city', 'country'], additionalProperties: false }
    const r = await session.run('What is the capital of France? Answer as JSON.', { outputSchema: schema })
    const parsed = JSON.parse(r.finalText.replace(/ZEBRA-7/g, '').trim())
    if (!/paris/i.test(parsed.city)) throw new Error(`got ${r.finalText}`)
    return r.finalText.trim()
  })

  await check('steer', async () => {
    if (!session.capabilities.steer) throw Object.assign(new Error('no steer'), { code: 'UNSUPPORTED_CAPABILITY' })
    const done = session.send('Run the shell command `sleep 8` and then reply with the word "done".')
    await new Promise((r) => setTimeout(r, 4000))
    const { steered } = await session.steer('Also include the word KIWI in your final reply.')
    const r = await done
    if (!steered) throw new Error('steer was not accepted (fell back to queue)')
    if (!/kiwi/i.test(r.finalText)) {
      await new Promise((r) => setTimeout(r, 3000))
      const tail = session.transcript.items.filter((i) => i.type === 'assistant_message').map((i: any) => i.text).join(' ')
      if (!/kiwi/i.test(tail)) throw new Error(`no KIWI in: ${JSON.stringify(r.finalText.slice(-150))}`)
      return 'KIWI arrived in a follow-up turn'
    }
    return 'KIWI in same turn'
  })

  await check('queue', async () => {
    while (session.isRunning) await new Promise((r) => setTimeout(r, 500))
    const [a, b] = await Promise.all([session.send('Reply with exactly: one'), session.send('Reply with exactly: two')])
    if (!/one/i.test(a.finalText) || !/two/i.test(b.finalText)) throw new Error(`${a.finalText} / ${b.finalText}`)
    return 'two queued turns ran in order'
  })

  await check('slash-commands', async () => {
    const commands = await session.commands()
    if (session.capabilities.slashCommands && !commands.length) throw new Error('capability on but no commands')
    return `${commands.length} commands`
  })

  await check('context-window', async () => {
    const before = await session.contextWindow()
    await session.run('Reply with exactly: ok')
    const after = await session.contextWindow()
    const live = session.transcript.usage
    if (!after.maxTokens || after.maxTokens < 8_000) throw new Error(`max=${after.maxTokens}`)
    if (!after.usedTokens || after.usedTokens <= 0 || after.usedTokens >= after.maxTokens) throw new Error(`used=${after.usedTokens} max=${after.maxTokens}`)
    if (live?.contextWindowMaxTokens !== after.maxTokens) throw new Error(`usage event max=${live?.contextWindowMaxTokens} vs contextWindow() max=${after.maxTokens}`)
    const model = (await session.info()).model
    const listed = (await kit.catalog(provider, { cwd, force: true })).models.find((m) => m.id === model)?.contextWindowMaxTokens
    return `${model}: ${after.usedTokens}/${after.maxTokens} used; before first turn max=${before.maxTokens ?? 'unknown'}; catalog=${listed ?? 'n/a'}`
  })

  await check('fast-mode', async () => {
    if (!session.capabilities.fastMode) throw Object.assign(new Error('no native fast tier'), { code: 'UNSUPPORTED_CAPABILITY' })
    const model = (await kit.catalog(provider, { cwd })).models.find((m) => m.supportsFastMode)
    if (!model) throw new Error('capability on but no model supports fast mode')
    const fast = await kit.session({ provider, cwd, access: 'full-access', model: model.id, fast: true, ...(provider === 'codex' ? { thinking: 'low' } : {}) })
    try {
      const warnings: string[] = []
      fast.on((e) => e.type === 'timeline' && e.item.type === 'notice' && warnings.push(e.item.message))
      const t0 = Date.now()
      const a = await fast.run('Reply with exactly: fast')
      if (a.status !== 'completed') throw new Error(`fast turn: ${a.status} ${a.error ?? ''}`)
      if (!(await fast.info()).fast) throw new Error('info().fast is false after opening with fast: true')
      await fast.setFast(false)
      if ((await fast.info()).fast || fast.transcript.fast) throw new Error('setFast(false) not reflected')
      const b = await fast.run('Reply with exactly: standard')
      if (b.status !== 'completed') throw new Error(`standard turn: ${b.status}`)
      if (warnings.length) throw new Error(warnings.join('; '))
      return `${model.id}: fast turn ${Date.now() - t0}ms incl. toggle, no warnings`
    } finally {
      await fast.close()
    }
  })

  await session.close()
  out[provider] = checks
}

mkdirSync(path.join(import.meta.dirname, 'artifacts'), { recursive: true })
writeFileSync(path.join(import.meta.dirname, 'artifacts', `extras-${providers.join('-')}.json`), JSON.stringify(out, null, 2))
await kit.shutdown()
const failed = Object.values(out).flat().filter((c: any) => c.ok === false)
console.log(`\n${failed.length ? `${failed.length} failed` : 'all passed'}`)
process.exit(failed.length ? 1 : 0)
