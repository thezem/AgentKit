/**
 * Claude tool calls show while the model is still writing their arguments: a running row the moment the call starts,
 * then updates while the JSON streams (size grows, long strings cut to their tail), then the complete call replaces it
 * under the same callId. Failure mode #71. Real `claude` CLI, cheapest model. Plus the partial-JSON parser on its own.
 *
 *   node test/e2e/claude-tool-drafts.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClaudeCodeClient } from '../../capsules/claude-code/index.ts'
import { parsePartialJson } from '../../capsules/claude-code/internals/mapping.ts'
import type { AgentEvent, ToolCallItem } from '../../capsules/shared/contract.ts'

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

await check('partial-json', async () => {
  const full = JSON.stringify({ file_path: '/tmp/a.html', content: '<p>"quoted" \\ back\nslash</p>', n: [1, { x: true }] })
  for (let i = 0; i <= full.length; i++) parsePartialJson(full.slice(0, i)) // never throws
  const at = (s: string) => JSON.stringify(parsePartialJson(s))
  if (at(full) !== full) throw new Error('whole document changed')
  if (at('{"file_path":"/tmp/a.ht') !== '{"file_path":"/tmp/a.ht"}') throw new Error(`open string: ${at('{"file_path":"/tmp/a.ht')}`)
  if (at('{"command":"ls","descr') !== '{"command":"ls"}') throw new Error(`dangling key: ${at('{"command":"ls","descr')}`)
  if (at('{"a":[{"b":"c"},{"d":') !== '{"a":[{"b":"c"}]}') throw new Error(`nested: ${at('{"a":[{"b":"c"},{"d":')}`)
  return `${full.length + 1} prefixes`
})

const cwd = mkdtempSync(path.join(os.tmpdir(), 'agentkit-drafts-'))
const client = createClaudeCodeClient()
const session: any = await client.createSession({ cwd, model: 'haiku', modeId: 'bypassPermissions' })
const events: Array<AgentEvent & { at: number }> = []
session.subscribe((e: AgentEvent) => events.push({ ...e, at: Date.now() }))

await check('tool-draft-streams', async () => {
  const { turnId } = await session.startTurn('Immediately, without planning, use the Write tool to create story.md in the current folder with a 900-word short story about a lighthouse keeper. Then reply: done.')
  const t0 = Date.now()
  while (!events.some((e) => (e.type === 'turn_completed' || e.type === 'turn_failed' || e.type === 'turn_canceled') && e.turnId === turnId)) {
    if (Date.now() - t0 > 240_000) throw new Error('turn did not end')
    await new Promise((r) => setTimeout(r, 200))
  }
  const rows = events.filter((e) => e.type === 'timeline' && e.item.type === 'tool_call' && e.item.name === 'Write') as Array<AgentEvent & { at: number; item: ToolCallItem }>
  const drafts = rows.filter((e) => typeof e.item.inputChars === 'number')
  const full = rows.find((e) => e.item.inputChars === undefined)
  if (!full) throw new Error('no complete Write call')
  if (drafts.length < 3) throw new Error(`only ${drafts.length} draft updates`)
  if (drafts.some((e) => e.item.callId !== full.item.callId || e.item.status !== 'running')) throw new Error('draft with another callId or status')
  const sizes = drafts.map((e) => e.item.inputChars!)
  if (sizes.some((n, i) => i > 0 && n < sizes[i - 1])) throw new Error(`sizes went down: ${sizes.join(',')}`)
  const lead = full.at - drafts[0].at
  if (lead < 2000) throw new Error(`first draft only ${lead}ms before the complete call`)
  const path_ = (drafts.at(-1)!.item.detail as any).filePath
  if (!String(path_).endsWith('story.md')) throw new Error(`draft path ${path_}`)
  if (drafts.some((e) => String((e.item.detail as any).content ?? '').length > 2001)) throw new Error('a draft carried more than the 2000-char tail')
  const content = String((full.item.detail as any).content ?? '')
  if (content.length < 2000 || readFileSync(path.join(cwd, 'story.md'), 'utf8') !== content) throw new Error('complete call and file differ')
  return `${drafts.length} drafts over ${(lead / 1000).toFixed(0)}s, ${sizes.at(-1)} chars before the complete call (${content.length})`
})

await session.close()
await client.shutdown()
const dir = path.join(import.meta.dirname, 'artifacts')
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'claude-tool-drafts.json'), JSON.stringify({ at: new Date().toISOString(), checks }, null, 2))
const failed = checks.filter((c) => !c.ok).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
