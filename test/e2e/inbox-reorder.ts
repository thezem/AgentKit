/**
 * Reordering the inbox: prompts queued behind a running turn run in the order the host sets, the inbox shows that
 * order, and unknown ids or left-out entries don't break it. Failure mode #70. Mock provider (no models).
 *
 *   node test/e2e/inbox-reorder.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createAgentKit, type AgentEvent } from '../../src/index.ts'

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

const kit = createAgentKit({ mock: { tokenDelayMs: 5 }, claude: false, codex: false, opencode: false })
const session = await kit.session({ provider: 'mock', cwd: process.cwd() })
const started: string[] = []
session.on((e: AgentEvent) => {
  if (e.type === 'timeline' && e.item.type === 'user_message') started.push(e.item.text)
})
const inboxTexts = () => session.transcript.inbox.map((entry) => entry.text)

await check('reorder-runs-in-new-order', async () => {
  const first = await session.submit('first [slow] '.repeat(8)) // keeps the session busy while the rest queue
  const a = await session.submit('A')
  const b = await session.submit('B')
  const c = await session.submit('C')
  if (inboxTexts().join() !== 'A,B,C') throw new Error(`inbox before: ${inboxTexts().join()}`)
  if (!session.reorderInbox([c.id, a.id, b.id])) throw new Error('reorderInbox returned false')
  if (inboxTexts().join() !== 'C,A,B') throw new Error(`inbox after: ${inboxTexts().join()}`)
  await Promise.all([first.result, a.result, b.result, c.result])
  const order = started.slice(1).join()
  if (order !== 'C,A,B') throw new Error(`ran as ${order}`)
  return 'inbox and run order C, A, B'
})

await check('reorder-partial-and-unknown', async () => {
  started.length = 0
  const first = await session.submit('first [slow] '.repeat(8))
  const a = await session.submit('A')
  const b = await session.submit('B')
  const c = await session.submit('C')
  // Unknown id ignored; B and C (left out) keep their order after the listed one.
  session.reorderInbox(['nope', c.id])
  if (inboxTexts().join() !== 'C,A,B') throw new Error(`inbox: ${inboxTexts().join()}`)
  if (session.reorderInbox([c.id, a.id, b.id])) throw new Error('same order reported a change')
  await Promise.all([first.result, a.result, b.result, c.result])
  return `ran ${started.slice(1).join()}`
})

await session.close()
await kit.shutdown()
const dir = path.join(import.meta.dirname, 'artifacts')
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'inbox-reorder.json'), JSON.stringify({ at: new Date().toISOString(), checks }, null, 2))
const failed = checks.filter((c) => !c.ok).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
