/**
 * Claude interrupt when the CLI doesn't stop: the turn ends, the process is stopped (host and CLI never disagree),
 * and the next turn resumes the same conversation. Failure mode #68. Real `claude` CLI, cheapest model.
 * The CLI ignoring an interrupt can't be triggered on demand, so the test makes `query.interrupt()` a no-op.
 *
 *   node test/e2e/claude-interrupt.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClaudeCodeClient } from '../../capsules/claude-code/index.ts'
import type { AgentEvent } from '../../capsules/shared/contract.ts'

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
const until = async (what: string, ok: () => boolean, ms: number) => {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

const cwd = mkdtempSync(path.join(os.tmpdir(), 'agentkit-interrupt-'))
const client = createClaudeCodeClient()
const session: any = await client.createSession({ cwd, model: 'haiku', modeId: 'bypassPermissions' })
const events: AgentEvent[] = []
session.subscribe((e: AgentEvent) => events.push(e))
const ended = (turnId: string) => events.find((e) => (e.type === 'turn_completed' || e.type === 'turn_failed' || e.type === 'turn_canceled') && e.turnId === turnId)

const NONCE = `kiwi-${Math.random().toString(36).slice(2, 7)}`
let first = ''

await check('stuck-interrupt-cancels', async () => {
  ;({ turnId: first } = await session.startTurn(`Remember the word ${NONCE}. Now run exactly one Bash command: timeout 90 tail -f /dev/null; echo DONE. Then reply DONE.`))
  await until('the Bash call to start', () => events.some((e) => e.type === 'timeline' && (e.item as any).type === 'tool_call' && (e.item as any).status === 'running'), 60_000)
  session.q.interrupt = async () => undefined // the CLI "ignores" the interrupt
  const t0 = Date.now()
  await session.interrupt()
  const end = ended(first)
  if (end?.type !== 'turn_canceled') throw new Error(`turn ended as ${end?.type ?? 'nothing'}`)
  return `canceled after ${((Date.now() - t0) / 1000).toFixed(1)}s`
})

await check('stuck-interrupt-stops-process', async () => {
  if (session.q !== null) throw new Error('query still attached')
  const before = events.length
  await new Promise((r) => setTimeout(r, 3000))
  const late = events.slice(before).filter((e) => e.type === 'timeline' || e.type.startsWith('turn_'))
  if (late.length) throw new Error(`${late.length} events after the cancel (${late.map((e) => e.type).join(', ')})`)
  return 'no events after the cancel'
})

await check('next-turn-resumes', async () => {
  const { turnId } = await session.startTurn('What word did I ask you to remember? Reply with just the word.')
  await until('the reply', () => !!ended(turnId), 90_000)
  if (ended(turnId)!.type !== 'turn_completed') throw new Error(`ended as ${ended(turnId)!.type}`)
  const reply = events.filter((e) => e.type === 'timeline' && e.turnId === turnId && (e.item as any).type === 'assistant_message').map((e: any) => e.item.text).join('')
  if (!reply.includes(NONCE)) throw new Error(`reply was "${reply.slice(0, 120)}"`)
  return `said ${NONCE}`
})

await session.close()
await client.shutdown()
const dir = path.join(import.meta.dirname, 'artifacts')
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'claude-interrupt.json'), JSON.stringify({ at: new Date().toISOString(), checks }, null, 2))
const failed = checks.filter((c) => !c.ok).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
