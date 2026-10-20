/**
 * Host primitives E2E: attachments, plan usage, one-shot complete, paged snapshots. Failure modes #54–60.
 * Live runs use the cheapest model per provider.
 *
 *   node test/e2e/host.ts mock               # free
 *   node test/e2e/host.ts claude codex opencode
 */
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { createAgentKit, type ProviderId } from '../../src/index.ts'

const providers = (process.argv.slice(2).length ? process.argv.slice(2) : ['mock']) as ProviderId[]
const CHEAP: Record<string, object> = {
  claude: { model: 'haiku' },
  codex: { model: 'gpt-5.6-luna', thinking: 'low' },
  opencode: { model: 'opencode-go/minimax-m3.1-flash-free' },
  mock: {},
}
const COMPLETE_MODEL: Record<string, object> = {
  claude: { model: 'haiku' },
  codex: { model: 'gpt-5.6-luna', thinkingOptionId: 'low' },
  opencode: { model: 'opencode-go/minimax-m3.1-flash-free' },
  mock: {},
}

const root = mkdtempSync(path.join(os.tmpdir(), 'agentkit-host-'))
const storeFile = path.join(root, 'kit.db')
const kit = createAgentKit({ mock: providers.includes('mock') ? { tokenDelayMs: 1 } : false, store: storeFile, claude: { settingSources: ['project'] } })

const checks: Array<{ name: string; ok: boolean | 'skipped'; note?: string }> = []
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

/** A solid-colour PNG, built by hand (no image library). */
function solidPng(r: number, g: number, b: number, size = 64): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())])
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

for (const provider of providers) {
  console.log(`\n[${provider}]`)
  const cwd = mkdtempSync(path.join(os.tmpdir(), `agentkit-host-${provider}-`))
  execSync('git init -q', { cwd })

  // #54: an attached file is readable with zero permission prompts, even in `supervised`.
  await check(`attach-file:${provider}`, async () => {
    const nonce = `NONCE-${randomUUID().slice(0, 8)}`
    const session = await kit.session({ provider, cwd, access: 'supervised', ...CHEAP[provider] })
    const asked: string[] = []
    session.on((e) => {
      if (e.type === 'permission_requested') {
        asked.push(e.request.name)
        void session.respond(e.request.id, 'allow').catch(() => undefined)
      }
    })
    const typed = 'Read the attached file notes.txt and reply with its exact contents only.'
    const sub = await session.submit(provider === 'mock' ? `${typed} [tool]` : typed, { attachments: [{ name: 'notes.txt', data: Buffer.from(nonce).toString('base64') }] })
    const r = await sub.result
    if (r.status !== 'completed') throw new Error(`status ${r.status} ${r.error ?? ''}`)
    if (provider !== 'mock' && !r.finalText.includes(nonce)) throw new Error(`no nonce in ${JSON.stringify(r.finalText.slice(0, 120))}`)
    if (provider !== 'mock' && asked.length) throw new Error(`asked permission: ${asked.join(',')}`)

    // #56: typed text intact, attachments structured, survives restore.
    const user = session.transcript.items.find((i) => i.type === 'user_message') as any
    if (!user || !user.text.startsWith(typed) || user.text.includes('<attachments')) throw new Error(`user text changed: ${JSON.stringify(user?.text?.slice(0, 160))}`)
    if (user.attachments?.[0]?.name !== 'notes.txt' || !user.attachments[0].path.startsWith(kit.attachmentsDir)) throw new Error(`attachments: ${JSON.stringify(user.attachments)}`)
    if (sub.record().attachments?.length !== 1) throw new Error('submission record has no attachments')
    const key = session.key
    await session.close()
    const restored = await kit.restore(key)
    const again = restored.transcript.items.find((i) => i.type === 'user_message') as any
    if (again?.attachments?.[0]?.name !== 'notes.txt') throw new Error('attachments lost after restore')
    await restored.close()
    return provider === 'mock' ? 'mock: structure only' : `nonce read, 0 prompts`
  })

  // #55: images reach the model as images.
  await check(`attach-image:${provider}`, async () => {
    const session = await kit.session({ provider, cwd, access: 'supervised', ...CHEAP[provider] })
    if (!session.capabilities.images) throw Object.assign(new Error('no images'), { code: 'UNSUPPORTED_CAPABILITY' })
    session.on((e) => e.type === 'permission_requested' && void session.respond(e.request.id, 'deny').catch(() => undefined))
    const r = await session.send('What single colour fills the attached image? Answer with one lowercase word, without using any tools.', {
      attachments: [{ name: 'swatch.png', data: solidPng(220, 20, 20).toString('base64') }],
    })
    await session.close()
    if (r.status !== 'completed') throw new Error(`status ${r.status} ${r.error ?? ''}`)
    if (provider === 'mock') return 'mock: sent'
    if (!/red/i.test(r.finalText)) throw new Error(`answer: ${JSON.stringify(r.finalText.slice(0, 120))}`)
    return 'said red'
  })

  // #58: plan usage normalized, or an honest UNSUPPORTED.
  await check(`plan-usage:${provider}`, async () => {
    const usage = await kit.planUsage(provider, { force: true })
    if (usage.provider !== provider) throw new Error('wrong provider')
    for (const w of usage.windows) {
      if (w.usedPercent !== null && (w.usedPercent < 0 || w.usedPercent > 100)) throw new Error(`bad percent ${w.usedPercent}`)
      if (w.resetsAt !== null && Number.isNaN(Date.parse(w.resetsAt))) throw new Error(`bad reset ${w.resetsAt}`)
    }
    if (usage.available && !usage.windows.length) throw new Error('available but no windows')
    return `${usage.plan ?? '?'}: ${usage.windows.map((w) => `${w.label} ${w.usedPercent ?? '?'}%`).join(', ') || 'no windows'}`
  })

  // #59: one-shot leaves nothing behind.
  await check(`complete:${provider}`, async () => {
    const nonce = `PONG-${randomUUID().slice(0, 6)}`
    const before = (await kit.listSessions({ cwd }).catch(() => [])).length
    const storedBefore = kit.storedSessions().length
    const r = await kit.complete(provider, `Reply with exactly this token and nothing else: ${nonce}`, { cwd, ...COMPLETE_MODEL[provider] })
    if (!r.text.includes(nonce)) throw new Error(`text: ${JSON.stringify(r.text.slice(0, 120))}`)
    await new Promise((res) => setTimeout(res, 1500))
    const after = (await kit.listSessions({ cwd }).catch(() => [])).length
    if (after !== before) throw new Error(`sessions in cwd ${before} → ${after}`)
    if (kit.storedSessions().length !== storedBefore) throw new Error('complete() wrote to the store')
    return `${r.model ?? 'default model'}, sessions unchanged`
  })
}

// #57 + #60 run on the mock only (no tokens).
if (providers.includes('mock')) {
  console.log('\n[layer]')
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'agentkit-host-layer-'))
  await check('attach-names', async () => {
    const session = await kit.session({ provider: 'mock', cwd })
    const sub = await session.submit('hi', { attachments: [{ name: '../../etc/passwd', data: 'eA==' }, { name: '/abs/x.txt', data: 'eA==' }, { name: 'x.txt', data: 'eQ==' }] })
    await sub.result
    const refs = sub.record().attachments ?? []
    const base = path.join(kit.attachmentsDir, session.key)
    if (refs.length !== 3 || refs.some((ref) => !ref.path.startsWith(base + path.sep))) throw new Error(JSON.stringify(refs))
    if (new Set(refs.map((r) => r.path)).size !== 3) throw new Error('name collision overwrote a file')
    await session.close()
    return refs.map((r) => r.name).join(', ')
  })

  await check('page', async () => {
    const session = await kit.session({ provider: 'mock', cwd })
    for (let i = 0; i < 7; i++) await session.run(`message ${i}`)
    const full = session.transcript.items
    const pages: unknown[][] = []
    let page = kit.transcriptPage(session.key, { limit: 3 })
    pages.unshift(page.items)
    while (page.itemsOffset > 0) {
      page = kit.transcriptPage(session.key, { limit: 3, before: page.itemsOffset })
      pages.unshift(page.items)
    }
    if (JSON.stringify(pages.flat()) !== JSON.stringify(full)) throw new Error(`pages ${pages.flat().length} vs full ${full.length}`)
    const key = session.key
    const live = kit.transcriptPage(key, { limit: 3 })
    await session.close()
    const other = createAgentKit({ mock: true, store: storeFile, claude: false, codex: false, opencode: false })
    const stored = other.transcriptPage(key, { limit: 3 })
    await other.shutdown()
    if (JSON.stringify(stored.items) !== JSON.stringify(live.items) || stored.itemsOffset !== live.itemsOffset) throw new Error('stored page differs from live page')
    return `${full.length} items in ${pages.length} pages, stored = live`
  })
}

await kit.shutdown()
const dir = path.join(import.meta.dirname, 'artifacts')
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, `host-${providers.join('-')}.json`), JSON.stringify({ at: new Date().toISOString(), providers, checks }, null, 2))
const failed = checks.filter((c) => c.ok === false).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
