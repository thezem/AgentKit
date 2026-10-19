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

  await session.close()
  out[provider] = checks
}

mkdirSync(path.join(import.meta.dirname, 'artifacts'), { recursive: true })
writeFileSync(path.join(import.meta.dirname, 'artifacts', `extras-${providers.join('-')}.json`), JSON.stringify(out, null, 2))
await kit.shutdown()
const failed = Object.values(out).flat().filter((c: any) => c.ok === false)
console.log(`\n${failed.length ? `${failed.length} failed` : 'all passed'}`)
process.exit(failed.length ? 1 : 0)
