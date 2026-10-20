/**
 * Images in tool results reach the transcript as files: a hub tool returns a PNG, the agent calls it, and the tool
 * call's output holds { type: 'image', path, mimeType } pointing at a real PNG under the attachments folder, with no
 * base64 in the store. Failure mode #69. Real CLIs, cheapest models.
 *
 *   node test/e2e/tool-images.ts [claude codex …]
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { createAgentKit, toolResult, type ProviderId } from '../../src/index.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const MODELS: Record<string, string> = { claude: 'haiku', codex: 'gpt-6-luna', opencode: 'opencode-go/deepseek-v4.1-flash' }
const providers = (process.argv.slice(2).length ? process.argv.slice(2) : ['claude', 'codex']) as ProviderId[]

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

const root = mkdtempSync(path.join(os.tmpdir(), 'agentkit-tool-images-'))
const db = path.join(root, 'agentkit.db')
const kit = createAgentKit({ store: db, hub: { file: path.join(root, 'hub.json') } })
kit.hub.addTools('pics', [{ name: 'red_pixel', description: 'Returns a picture of a red pixel.', run: () => toolResult.parts(toolResult.text('here it is:'), toolResult.image(Buffer.from(PNG, 'base64'), 'image/png')) }], { load: 'always' })
await kit.hub.start()

for (const provider of providers) {
  await check(`tool-image-file:${provider}`, async () => {
    const session = await kit.session({ provider, cwd: root, model: MODELS[provider], access: 'full-access', key: `img-${provider}` })
    await session.run('Call the red_pixel tool from the pics MCP server once, then reply DONE.')
    const call = session.transcript.items.find((i: any) => i.type === 'tool_call' && /red_pixel/.test(i.name ?? '') ) as any
    if (!call) throw new Error(`no red_pixel call (${session.transcript.items.map((i: any) => i.name ?? i.type).join(', ')})`)
    const parts = Array.isArray(call.detail?.output) ? call.detail.output : []
    const image = parts.find((p: any) => p?.type === 'image')
    if (!image?.path) throw new Error(`output has no image path: ${JSON.stringify(call.detail?.output).slice(0, 160)}`)
    if (!image.path.startsWith(kit.attachmentsDir)) throw new Error(`image outside attachments: ${image.path}`)
    const bytes = readFileSync(image.path)
    if (bytes.toString('base64') !== PNG) throw new Error('file is not the PNG the tool returned')
    await session.close()
    return `${path.relative(kit.attachmentsDir, image.path)}, ${bytes.length} bytes`
  })
}

await check('no-base64-in-store', async () => {
  // Events and the per-session checkpoints (finished turns are folded into the session row).
  const store = new DatabaseSync(db, { readOnly: true })
  const rows = [
    ...(store.prepare('select event as text from events').all() as { text: string }[]),
    ...(store.prepare('select * from sessions').all() as Record<string, unknown>[]).map((r) => ({ text: JSON.stringify(r) })),
  ]
  const hits = rows.filter((r) => r.text.includes(PNG.slice(0, 40))).length
  if (hits) throw new Error(`${hits} stored rows carry the image data`)
  if (!rows.some((r) => r.text.includes('/tools/'))) throw new Error('no stored row mentions the saved image')
  return `${rows.length} rows, image stored as a path, no image data`
})

await kit.shutdown()
const dir = path.join(import.meta.dirname, 'artifacts')
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'tool-images.json'), JSON.stringify({ at: new Date().toISOString(), providers, checks }, null, 2))
const failed = checks.filter((c) => !c.ok).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
