/**
 * Speech to text on the Claude sign-in: the websocket Claude Code's own voice mode uses
 * (`/api/ws/speech_to_text/voice_stream`). 16 kHz mono PCM16 in as binary frames, JSON out. With `forward_interims`
 * every `TranscriptText` is the whole text so far (it grows word by word, across pauses); after `CloseStream` one
 * cleaned-up final arrives, then `TranscriptEndpoint`. An endpoint mid-stream closes an utterance. `TranscriptError`
 * fails the stream. Client frames: `{"type":"KeepAlive"}` while open, `{"type":"CloseStream"}` to finish.
 *
 * Undocumented and internal to Claude Code: every failure becomes a typed error (`SIGNED_OUT`, `TRANSCRIBE_FAILED`,
 * `ABORTED`, `INVALID_INPUT`) so a host can hide its mic instead of crashing.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { TranscribeAudio, TranscribeOptions, TranscribeResult, TranscribeStreamOptions, TranscriptionEvent, TranscriptionStream } from '../../shared/contract.ts'
import { Emitter, runCapture } from '../../shared/runtime.ts'

export interface VoiceConfig {
  /** Default `VOICE_STREAM_BASE_URL` or `wss://api.anthropic.com` (what Claude Code uses). */
  baseUrl?: string
  /** Where the Claude sign-in lives. Default `$CLAUDE_CONFIG_DIR/.credentials.json` or `~/.claude/.credentials.json` (macOS: Keychain). */
  credentialsFile?: string
}

const RATE = 16_000
const PATH = '/api/ws/speech_to_text/voice_stream'
const KEEPALIVE_MS = 5_000
/** After CloseStream: the last words arrive, then an endpoint. Wait this long after it for stragglers. */
const ENDPOINT_GRACE_MS = 300
/** After CloseStream: give up waiting for the server and return what we have. */
const FINALIZE_TIMEOUT_MS = 8_000
const CHUNK_SAMPLES = RATE / 10

type VoiceError = Error & { code: string; status?: number }
const voiceError = (code: string, message: string, status?: number): VoiceError => Object.assign(new Error(message), { code, ...(status ? { status } : {}) })
const SIGNED_OUT_HINT = 'open Claude Code once (run `claude`) to sign in or refresh it'

// ------------------------------------------------------------------ sign-in

async function readCredentials(file: string | undefined): Promise<{ accessToken: string; expiresAt: number | null } | null> {
  const fromJson = (text: string) => {
    const oauth = JSON.parse(text)?.claudeAiOauth
    return typeof oauth?.accessToken === 'string' ? { accessToken: oauth.accessToken as string, expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null } : null
  }
  const target = file ?? path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), '.credentials.json')
  try {
    return fromJson(await readFile(target, 'utf8'))
  } catch {
    if (file || process.platform !== 'darwin') return null
  }
  // macOS keeps the sign-in in the Keychain.
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5_000 }, (error, stdout) => {
      try {
        resolve(error ? null : fromJson(stdout))
      } catch {
        resolve(null)
      }
    })
  })
}

/**
 * The access token, fresh. When it has expired, `claude auth status` runs once so the CLI can refresh it with its own
 * code (AgentKit never rotates the refresh token itself: a second writer could sign the CLI out).
 */
export async function claudeVoiceToken(config: VoiceConfig, binary: () => Promise<string | null>): Promise<string> {
  const fresh = (c: { expiresAt: number | null } | null) => !!c && (c.expiresAt === null || c.expiresAt - 60_000 > Date.now())
  let credentials = await readCredentials(config.credentialsFile)
  if (!credentials) throw voiceError('SIGNED_OUT', `Claude is not signed in; ${SIGNED_OUT_HINT}`)
  const bin = fresh(credentials) ? null : await binary().catch(() => null)
  if (bin) {
    await runCapture(bin, ['auth', 'status', '--json'], 20_000).catch(() => undefined)
    credentials = await readCredentials(config.credentialsFile)
  }
  if (!credentials || !fresh(credentials)) throw voiceError('SIGNED_OUT', `The Claude sign-in has expired; ${SIGNED_OUT_HINT}`)
  return credentials.accessToken
}

// ------------------------------------------------------------------ audio

/** WAV (PCM 16-bit) or raw PCM16 → 16 kHz mono PCM16. */
export async function toVoicePcm(audio: TranscribeAudio): Promise<Int16Array> {
  let bytes: Uint8Array
  if ('path' in audio) bytes = new Uint8Array(await readFile(audio.path))
  else bytes = typeof audio.data === 'string' ? new Uint8Array(Buffer.from(audio.data, 'base64')) : audio.data
  const riff = bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE'
  if (riff || audio.mimeType?.includes('wav')) {
    const wav = parseWav(bytes)
    return resample(downmix(wav.samples, wav.channels), wav.sampleRate)
  }
  if (bytes.length % 2) throw voiceError('INVALID_INPUT', 'raw PCM16 needs an even number of bytes')
  const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))
  return resample(downmix(samples, audio.channels ?? 1), audio.sampleRate ?? RATE)
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length))
}

function parseWav(bytes: Uint8Array): { samples: Int16Array; sampleRate: number; channels: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let format: { code: number; channels: number; sampleRate: number; bits: number } | null = null
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = ascii(bytes, at, 4)
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ') {
      format = { code: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) }
    } else if (id === 'data') {
      if (!format) break
      // 1 = PCM, 0xFFFE = extensible (PCM sub-format for 16-bit audio).
      if ((format.code !== 1 && format.code !== 0xfffe) || format.bits !== 16) throw voiceError('INVALID_INPUT', `WAV must be PCM 16-bit (got format ${format.code}, ${format.bits}-bit)`)
      const end = Math.min(bytes.length, body + size) & ~1
      const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset + body, bytes.byteOffset + end))
      return { samples, sampleRate: format.sampleRate, channels: Math.max(1, format.channels) }
    }
    at = body + size + (size % 2)
  }
  throw voiceError('INVALID_INPUT', 'not a readable WAV file (no fmt/data chunk)')
}

function downmix(samples: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return samples
  const out = new Int16Array(Math.floor(samples.length / channels))
  for (let i = 0; i < out.length; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c]
    out[i] = sum / channels
  }
  return out
}

function resample(samples: Int16Array, rate: number): Int16Array {
  if (rate === RATE) return samples
  return new Resampler(rate).push(samples)
}

/** Linear resampler to 16 kHz that keeps its position across chunks (for streamed writes). */
class Resampler {
  private readonly step: number
  private position = 0
  private last = 0
  constructor(rate: number) {
    this.step = rate / RATE
  }
  push(input: Int16Array): Int16Array {
    const out: number[] = []
    // `position` is relative to the previous chunk's last sample (index -1 here).
    while (this.position < input.length - 1 + 1e-9) {
      const i = Math.floor(this.position)
      const frac = this.position - i
      const a = i < 0 ? this.last : input[i]
      const b = input[Math.min(i + 1, input.length - 1)]
      out.push(Math.round(a + (b - a) * frac))
      this.position += this.step
    }
    if (input.length) this.last = input[input.length - 1]
    this.position -= input.length
    return Int16Array.from(out)
  }
}

// ------------------------------------------------------------------ stream

export function openVoiceStream(config: VoiceConfig, binary: () => Promise<string | null>, options: TranscribeStreamOptions = {}): TranscriptionStream {
  return new VoiceStream(config, binary, options)
}

export async function transcribeOnce(config: VoiceConfig, binary: () => Promise<string | null>, audio: TranscribeAudio, options: TranscribeOptions = {}): Promise<TranscribeResult> {
  const pcm = await toVoicePcm(audio)
  if (!pcm.length) throw voiceError('INVALID_INPUT', 'the recording is empty')
  const stream = new VoiceStream(config, binary, options)
  for (let at = 0; at < pcm.length; at += CHUNK_SAMPLES) stream.write(bytesOf(pcm.subarray(at, at + CHUNK_SAMPLES)))
  return stream.end()
}

const bytesOf = (pcm: Int16Array) => new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)

class VoiceStream implements TranscriptionStream {
  private readonly events = new Emitter<TranscriptionEvent>()
  private readonly config: VoiceConfig
  private readonly options: TranscribeStreamOptions
  private readonly resampler: Resampler | null
  private ws: WebSocket | null = null
  private pending: Uint8Array[] = []
  private segments: string[] = []
  /** Text of the utterance in progress (replaced by every TranscriptText, committed on an endpoint). */
  private current = ''
  private failure: VoiceError | null = null
  private state: 'connecting' | 'open' | 'ending' | 'done' = 'connecting'
  private opened = false
  private keepAlive: NodeJS.Timeout | null = null
  private finalizeTimer: NodeJS.Timeout | null = null
  private graceTimer: NodeJS.Timeout | null = null
  private settle: { resolve: (result: TranscribeResult) => void; reject: (error: Error) => void } | null = null
  private result: Promise<TranscribeResult> | null = null

  constructor(config: VoiceConfig, binary: () => Promise<string | null>, options: TranscribeStreamOptions) {
    this.config = config
    this.options = options
    const rate = options.sampleRate ?? RATE
    this.resampler = rate === RATE ? null : new Resampler(rate)
    options.signal?.addEventListener('abort', () => this.abort(), { once: true })
    void this.connect(binary)
  }

  on<T extends TranscriptionEvent['type']>(type: T, listener: (event: Extract<TranscriptionEvent, { type: T }>) => void): () => void {
    return this.events.on((event) => event.type === type && listener(event as Extract<TranscriptionEvent, { type: T }>))
  }

  write(pcm16: Uint8Array): void {
    if (this.state === 'ending' || this.state === 'done' || !pcm16.length) return
    let chunk = pcm16
    if (this.resampler) {
      const even = pcm16.byteLength & ~1
      const copy = new Int16Array(pcm16.buffer.slice(pcm16.byteOffset, pcm16.byteOffset + even))
      chunk = bytesOf(this.resampler.push(copy))
    }
    if (this.state === 'open' && this.ws) this.ws.send(chunk as BufferSource)
    else this.pending.push(chunk.slice())
  }

  end(): Promise<TranscribeResult> {
    if (this.result) return this.result
    this.result = new Promise<TranscribeResult>((resolve, reject) => (this.settle = { resolve, reject }))
    if (this.failure) this.finish()
    else if (this.state === 'open') this.closeStream()
    else if (this.state === 'connecting') this.state = 'ending' // sent on open
    return this.result
  }

  abort(): void {
    if (this.state === 'done') return
    this.fail(voiceError('ABORTED', 'dictation aborted'), false)
  }

  private async connect(binary: () => Promise<string | null>): Promise<void> {
    let token: string
    try {
      token = await claudeVoiceToken(this.config, binary)
    } catch (error) {
      return this.fail(error as VoiceError)
    }
    if (this.state === 'done') return
    const url = this.url()
    let ws: WebSocket
    try {
      // Node's WebSocket (undici) takes headers as a non-standard option.
      ws = new (WebSocket as any)(url, { headers: { Authorization: `Bearer ${token}`, 'x-app': 'cli', 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-cli (external, agentkit)' } })
    } catch (error) {
      return this.fail(voiceError('TRANSCRIBE_FAILED', `voice connection failed: ${(error as Error).message}`))
    }
    this.ws = ws
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      if (this.state === 'done') return void ws.close()
      const ending = this.state === 'ending'
      this.opened = true
      this.state = 'open'
      ws.send(JSON.stringify({ type: 'KeepAlive' }))
      for (const chunk of this.pending) ws.send(chunk as BufferSource)
      this.pending = []
      this.keepAlive = setInterval(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'KeepAlive' })), KEEPALIVE_MS)
      this.keepAlive.unref?.()
      if (ending) this.closeStream()
    }
    ws.onmessage = (event) => this.onMessage(event.data)
    ws.onerror = () => undefined // `close` follows with the code; the cause is diagnosed there.
    ws.onclose = (event) => {
      if (this.state === 'done') return
      // A socket that never opened is a failure even if end() was already called.
      if (this.opened && this.state === 'ending') return this.finish()
      void this.diagnose(url, token, event.code).then((error) => this.fail(error))
    }
  }

  private url(): string {
    const base = (this.config.baseUrl ?? process.env.VOICE_STREAM_BASE_URL ?? 'wss://api.anthropic.com').replace(/\/+$/, '')
    const query = new URLSearchParams({ encoding: 'linear16', sample_rate: String(RATE), channels: '1', endpointing_ms: '300', utterance_end_ms: '1000', forward_interims: 'true' })
    if (this.options.language) query.set('language', this.options.language)
    for (const term of this.options.keyterms ?? []) query.append('keyterms', term)
    return `${base}${PATH}?${query}`
  }

  /** The WebSocket API hides why an upgrade failed; ask the same URL over HTTP for a status to report. */
  private async diagnose(url: string, token: string, code: number): Promise<VoiceError> {
    try {
      const res = await fetch(url.replace(/^ws/, 'http'), { headers: { Authorization: `Bearer ${token}`, 'x-app': 'cli' }, signal: AbortSignal.timeout(5_000) })
      const blocked = res.headers.get('cf-mitigated')
      if (res.status === 401) return voiceError('SIGNED_OUT', `Claude rejected the sign-in for dictation (401); ${SIGNED_OUT_HINT}`, 401)
      return voiceError('TRANSCRIBE_FAILED', `Claude dictation endpoint unavailable (HTTP ${res.status}${blocked ? `, Cloudflare ${blocked}` : ''})`, res.status)
    } catch (error) {
      return voiceError('TRANSCRIBE_FAILED', `Claude dictation endpoint unreachable (ws close ${code}: ${(error as Error).message})`)
    }
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string' || this.state === 'done') return
    let message: { type?: string; data?: unknown; description?: string; error?: string }
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    if ((message.type === 'TranscriptText' || message.type === 'TranscriptInterim') && typeof message.data === 'string') {
      const done = this.segments.join(' ')
      let text = message.data.trim()
      // Cumulative texts repeat what an earlier endpoint already committed.
      if (done && text.toLowerCase().startsWith(done.toLowerCase())) text = text.slice(done.length).trim()
      this.current = text
      this.events.emit({ type: 'interim', text: [done, text].filter(Boolean).join(' ') })
      if (this.graceTimer) this.armGrace()
    } else if (message.type === 'TranscriptEndpoint') {
      this.commit()
      if (this.state === 'ending') this.armGrace()
    } else if (message.type === 'TranscriptError') {
      this.fail(voiceError('TRANSCRIBE_FAILED', `Claude dictation error: ${message.description ?? message.error ?? 'unknown'}`))
    }
  }

  /** The utterance in progress is final: keep it and tell the host. */
  private commit(): void {
    if (!this.current) return
    this.segments.push(this.current)
    this.events.emit({ type: 'text', text: this.current })
    this.current = ''
  }

  private closeStream(): void {
    this.state = 'ending'
    this.ws?.send(JSON.stringify({ type: 'CloseStream' }))
    this.finalizeTimer = setTimeout(() => this.finish(), FINALIZE_TIMEOUT_MS)
  }

  private armGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = setTimeout(() => this.finish(), ENDPOINT_GRACE_MS)
  }

  private finish(): void {
    if (this.failure) {
      this.cleanup()
      this.settle?.reject(this.failure)
      return
    }
    if (!this.settle) return
    this.commit()
    this.cleanup()
    this.settle.resolve({ text: this.segments.join(' ') })
  }

  private fail(error: VoiceError, emit = true): void {
    if (this.state === 'done') return
    this.failure = error
    if (emit) this.events.emit({ type: 'error', error })
    this.cleanup()
    this.settle?.reject(error)
  }

  private cleanup(): void {
    this.state = 'done'
    for (const timer of [this.keepAlive, this.finalizeTimer, this.graceTimer]) if (timer) clearTimeout(timer)
    this.pending = []
    const ws = this.ws
    this.ws = null
    if (ws && ws.readyState <= ws.OPEN) ws.close()
    this.events.clear()
  }
}
