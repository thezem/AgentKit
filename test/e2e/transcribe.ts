/**
 * Dictation on the Claude sign-in: batch and streaming speech to text, pauses, typed failures. Failure modes #72–78.
 * Speech is generated locally with the `phonon` TTS CLI (two random nonce words per clip), so the check is exact.
 * Uses Claude's dictation endpoint (no model tokens).
 *
 *   node test/e2e/transcribe.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { AgentKitError, createAgentKit, type TranscriptionStream } from '../../src/index.ts'

const checks: Array<{ name: string; ok: boolean; note?: string }> = []
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await Promise.race([fn(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 90_000))])
    checks.push({ name, ok: true, ...(note ? { note } : {}) })
    console.log(`  ✓ ${name}${note ? ` (${note})` : ''}`)
  } catch (error: any) {
    checks.push({ name, ok: false, note: error.message })
    console.log(`  ✗ ${name}: ${error.message}`)
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const WORDS = ['walrus', 'tangerine', 'saxophone', 'volcano', 'pelican', 'marmalade', 'hammock', 'lighthouse', 'cactus', 'avalanche', 'pineapple', 'kangaroo']
const pick = () => {
  const pool = [...WORDS].sort(() => Math.random() - 0.5)
  return [pool[0], pool[1]] as const
}
const has = (text: string, words: readonly string[]) => words.every((w) => text.toLowerCase().includes(w))

const root = mkdtempSync(path.join(os.tmpdir(), 'agentkit-transcribe-'))
/** A WAV of `text` from phonon (24 kHz mono PCM16). */
function speak(text: string, name: string): string {
  const out = path.join(root, `${name}.wav`)
  execFileSync('phonon', ['speak', '--text', text, '-o', out, '--overwrite'], { stdio: 'ignore' })
  return out
}
/** The PCM16 samples of a WAV and its rate (test-side, independent of the kit's parser). */
function pcmOf(file: string): { pcm: Uint8Array; rate: number } {
  const bytes = readFileSync(file)
  let at = 12
  let rate = 0
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4)
    const size = bytes.readUInt32LE(at + 4)
    if (id === 'fmt ') rate = bytes.readUInt32LE(at + 12)
    if (id === 'data') return { pcm: new Uint8Array(bytes.subarray(at + 8, at + 8 + size)), rate }
    at += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}
/** Write PCM in 100 ms chunks at real-time pace, like a mic. */
async function feed(stream: TranscriptionStream, pcm: Uint8Array, rate: number) {
  const chunk = (rate / 10) * 2
  for (let at = 0; at < pcm.length; at += chunk) {
    stream.write(pcm.subarray(at, at + chunk))
    await sleep(100)
  }
}
const codeOf = (error: unknown) => (error instanceof AgentKitError ? error.code : `not an AgentKitError: ${(error as Error)?.message}`)

const kit = createAgentKit({ codex: false, opencode: false, mock: false })

// #72: batch, from a WAV (24 kHz, resampled) and from raw PCM16.
const [a1, a2] = pick()
const batchWav = speak(`Please write the word ${a1} and then the word ${a2}.`, 'batch')
await check('transcribe-batch', async () => {
  const t0 = Date.now()
  const wav = await kit.transcribe('claude', { path: batchWav })
  if (!has(wav.text, [a1, a2])) throw new Error(`wav text: ${JSON.stringify(wav.text)}`)
  const ms = Date.now() - t0
  const { pcm, rate } = pcmOf(batchWav)
  const raw = await kit.transcribe('claude', { data: pcm, mimeType: 'audio/pcm', sampleRate: rate })
  if (!has(raw.text, [a1, a2])) throw new Error(`raw text: ${JSON.stringify(raw.text)}`)
  return `"${wav.text}" in ${ms}ms; raw PCM same words`
})

// #73: streaming at mic pace: interim text while speaking, final text with the last word.
const [b1, b2] = pick()
const streamWav = speak(`The first word is ${b1}, and the last word is ${b2}.`, 'stream')
await check('transcribe-stream', async () => {
  const { pcm, rate } = pcmOf(streamWav)
  const stream = kit.transcribeStream('claude', { sampleRate: rate, language: 'en' })
  const interims: string[] = []
  const texts: string[] = []
  stream.on('interim', (e) => interims.push(e.text))
  stream.on('text', (e) => texts.push(e.text))
  await feed(stream, pcm, rate)
  const before = interims.length
  const t0 = Date.now()
  const { text } = await stream.end()
  if (!before) throw new Error(`no interim text while speaking (texts: ${texts.length})`)
  if (!has(text, [b1, b2])) throw new Error(`final text: ${JSON.stringify(text)}`)
  return `${before} interims while speaking, final in ${Date.now() - t0}ms after end(): "${text}"`
})

// #74: an 8 s pause (nothing written) in the middle doesn't lose the rest.
const [c1, c2] = pick()
const firstHalf = speak(`Remember ${c1}.`, 'pause-a')
const secondHalf = speak(`Also remember ${c2}.`, 'pause-b')
await check('transcribe-pause', async () => {
  const a = pcmOf(firstHalf)
  const b = pcmOf(secondHalf)
  const stream = kit.transcribeStream('claude', { sampleRate: a.rate })
  const errors: unknown[] = []
  stream.on('error', (e) => errors.push(e.error))
  await feed(stream, a.pcm, a.rate)
  await sleep(8_000)
  await feed(stream, b.pcm, b.rate)
  const { text } = await stream.end()
  if (errors.length) throw new Error(`error during pause: ${(errors[0] as Error).message}`)
  if (!has(text, [c1, c2])) throw new Error(`text: ${JSON.stringify(text)}`)
  return `"${text}"`
})

// #75: signed out / expired → SIGNED_OUT, typed, no crash.
await check('transcribe-signed-out', async () => {
  const expired = path.join(root, 'expired.json')
  writeFileSync(expired, JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-expired', expiresAt: Date.now() - 3_600_000 } }))
  const missing = path.join(root, 'nope.json')
  const notes: string[] = []
  for (const credentialsFile of [expired, missing]) {
    const k = createAgentKit({ codex: false, opencode: false, mock: false, claude: { voice: { credentialsFile } } })
    const batch = await k.transcribe('claude', { path: batchWav }).then(() => 'resolved', codeOf)
    if (batch !== 'SIGNED_OUT') throw new Error(`batch → ${batch}`)
    const stream = k.transcribeStream('claude')
    const errors: string[] = []
    stream.on('error', (e) => errors.push(codeOf(e.error)))
    stream.write(new Uint8Array(3200))
    const end = await stream.end().then(() => 'resolved', codeOf)
    if (end !== 'SIGNED_OUT' || errors.join() !== 'SIGNED_OUT') throw new Error(`stream end → ${end}, errors ${errors.join()}`)
    notes.push(path.basename(credentialsFile))
    await k.shutdown()
  }
  return `${notes.join(' + ')} → SIGNED_OUT (batch, stream error event once, end())`
})

// #76: endpoint gone / blocked → TRANSCRIBE_FAILED with the status, once.
await check('transcribe-unreachable', async () => {
  const server = http.createServer((_req, res) => res.writeHead(404).end('gone'))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const k = createAgentKit({ codex: false, opencode: false, mock: false, claude: { voice: { baseUrl: `ws://127.0.0.1:${port}` } } })
  try {
    const batch = await k.transcribe('claude', { path: batchWav }).then(() => null, (e) => e)
    if (codeOf(batch) !== 'TRANSCRIBE_FAILED' || !/404/.test(batch.message)) throw new Error(`batch → ${codeOf(batch)} ${batch?.message}`)
    const stream = k.transcribeStream('claude')
    let errors = 0
    stream.on('error', () => errors++)
    const end = await stream.end().then(() => 'resolved', codeOf)
    if (end !== 'TRANSCRIBE_FAILED' || errors !== 1) throw new Error(`stream end → ${end}, ${errors} error events`)
    return `"${batch.message}"`
  } finally {
    await k.shutdown()
    server.close()
  }
})

// #77: abort mid-stream.
await check('transcribe-abort', async () => {
  const { pcm, rate } = pcmOf(streamWav)
  const stream = kit.transcribeStream('claude', { sampleRate: rate })
  let after = 0
  let aborted = false
  stream.on('interim', () => aborted && after++)
  stream.on('text', () => aborted && after++)
  await feed(stream, pcm.subarray(0, pcm.length / 2), rate)
  stream.abort()
  aborted = true
  const end = await stream.end().then(() => 'resolved', codeOf)
  await sleep(2_000)
  if (end !== 'ABORTED') throw new Error(`end → ${end}`)
  if (after) throw new Error(`${after} events after abort`)
  return 'end() → ABORTED, no events after'
})

// #78: only where it works; bad input is typed.
await check('transcribe-guards', async () => {
  const k = createAgentKit({ mock: true, claude: false, codex: false, opencode: false })
  const caps = kit.capabilities('claude').transcribe
  if (!caps) throw new Error('claude capability false')
  if (k.capabilities('mock').transcribe) throw new Error('mock claims transcribe')
  const unsupported = await k.transcribe('mock', { path: batchWav }).then(() => 'resolved', codeOf)
  if (unsupported !== 'UNSUPPORTED_CAPABILITY') throw new Error(`mock → ${unsupported}`)
  await k.shutdown()
  // An 8-bit WAV.
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + 800, 4); header.write('WAVE', 8); header.write('fmt ', 12)
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(8000, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34); header.write('data', 36); header.writeUInt32LE(800, 40)
  const bad = await kit.transcribe('claude', { data: Buffer.concat([header, Buffer.alloc(800, 128)]) }).then(() => 'resolved', codeOf)
  if (bad !== 'INVALID_INPUT') throw new Error(`8-bit wav → ${bad}`)
  return 'claude only; mock → UNSUPPORTED_CAPABILITY; 8-bit WAV → INVALID_INPUT'
})

await kit.shutdown()
const dir = path.join(import.meta.dirname, 'artifacts')
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'transcribe.json'), JSON.stringify({ at: new Date().toISOString(), checks }, null, 2))
const failed = checks.filter((c) => !c.ok).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
