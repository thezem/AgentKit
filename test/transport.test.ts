import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { CodexClient } from '../src/codex-client.ts'
import { TransportRequestTimeoutError } from '../src/errors.ts'
import { AppServerTransport } from '../src/transport.ts'
import { CodexThread } from '../src/thread.ts'
import { FakeTransport } from './helpers/fake-transport.ts'

type TransportLoggerEvent = {
  level: 'debug' | 'info' | 'warn' | 'error'
  code: string
  message: string
  data?: Record<string, unknown>
}

class FakeProcess extends EventEmitter {
  stdinWrites: string[] = []
  killCalls = 0
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = {
    write: (chunk: string) => {
      this.stdinWrites.push(chunk)
      return true
    },
  }
  pid = 12345

  kill(): void {
    this.killCalls += 1
  }
}

function createAppServerTransport(options?: {
  requestTimeoutMs?: number
  logger?: (event: TransportLoggerEvent) => void
}): { transport: AppServerTransport; process: FakeProcess } {
  const fakeProcess = new FakeProcess()
  const TransportCtor = AppServerTransport as unknown as {
    new (
      process: FakeProcess,
      options?: {
        requestTimeoutMs?: number
        logger?: (event: TransportLoggerEvent) => void
      },
    ): AppServerTransport
  }

  const transport = new TransportCtor(fakeProcess, options)
  return { transport, process: fakeProcess }
}

function emitJsonLine(process: FakeProcess, payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function createThreadData(id: string) {
  return {
    id,
    preview: '',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'idle',
    path: null,
    cwd: process.cwd(),
    cliVersion: 'test',
    source: 'test',
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  }
}

test('request/response matching resolves by id even out of order', async () => {
  const { transport, process } = createAppServerTransport()

  const first = transport.request<{ value: string }>('alpha', { n: 1 })
  const second = transport.request<{ value: string }>('beta', { n: 2 })

  const firstRequest = JSON.parse(process.stdinWrites[0]) as { id: number }
  const secondRequest = JSON.parse(process.stdinWrites[1]) as { id: number }

  emitJsonLine(process, { jsonrpc: '2.0', id: secondRequest.id, result: { value: 'second' } })
  emitJsonLine(process, { jsonrpc: '2.0', id: firstRequest.id, result: { value: 'first' } })

  assert.deepEqual(await second, { value: 'second' })
  assert.deepEqual(await first, { value: 'first' })
})

test('request timeout rejects with TransportRequestTimeoutError', async () => {
  const { transport } = createAppServerTransport({ requestTimeoutMs: 1 })

  await assert.rejects(transport.request('never-resolves', {}), (error) => {
    assert.ok(error instanceof TransportRequestTimeoutError)
    assert.equal(error.method, 'never-resolves')
    return true
  })
})

test('late response after timeout is ignored and logged', async () => {
  const logs: TransportLoggerEvent[] = []
  const { transport, process } = createAppServerTransport({
    requestTimeoutMs: 1,
    logger: (event) => logs.push(event),
  })

  const timedOut = transport.request('slow-op', {})
  const request = JSON.parse(process.stdinWrites[0]) as { id: number }

  await assert.rejects(timedOut, TransportRequestTimeoutError)

  emitJsonLine(process, { jsonrpc: '2.0', id: request.id, result: { ok: true } })

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(logs.some((entry) => entry.code === 'transport.response.unmatched'))
})

test('close rejects inflight requests', async () => {
  const { transport, process } = createAppServerTransport({ requestTimeoutMs: 10_000 })

  const pending = transport.request('inflight', {})
  transport.close()

  await assert.rejects(pending, /transport is closed/)
  assert.equal(process.killCalls, 1)
})

test('unmatched success response is logged, not thrown', async () => {
  const logs: TransportLoggerEvent[] = []
  const { process } = createAppServerTransport({
    logger: (event) => logs.push(event),
  })

  emitJsonLine(process, { jsonrpc: '2.0', id: 999, result: { ignored: true } })

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(logs.some((entry) => entry.code === 'transport.response.unmatched'))
})

test('malformed JSON line is logged, not thrown', async () => {
  const logs: TransportLoggerEvent[] = []
  const { process } = createAppServerTransport({
    logger: (event) => logs.push(event),
  })

  process.stdout.write('{ this is not json }\n')

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(logs.some((entry) => entry.code === 'transport.notification.malformed_json'))
})

test('mid-turn transport close rejects active stream', async () => {
  const fakeTransport = new FakeTransport()
  fakeTransport.respondWith('turn/start', { turn: { id: 'turn-1' } })

  const ClientCtor = CodexClient as unknown as {
    new (transport: FakeTransport, options: Record<string, unknown>): CodexClient
  }
  const client = new ClientCtor(fakeTransport, {})
  const thread = new CodexThread(client, createThreadData('thread-1'))

  const stream = await client.streamThread(thread, 'hello')
  const collect = (async () => {
    for await (const _event of stream) {
      // stream is expected to fail before yielding anything.
    }
  })()

  fakeTransport.simulateClose(new Error('transport crashed'))

  await assert.rejects(collect, /transport crashed/)
})

test('close on windows attempts taskkill and skips process.kill when taskkill succeeds', () => {
  const { transport, process } = createAppServerTransport()
  const TransportCtor = AppServerTransport as unknown as {
    platform: () => NodeJS.Platform
    taskkill: (pid: number) => void
  }

  const originalPlatform = TransportCtor.platform
  const originalTaskkill = TransportCtor.taskkill
  let killedPid: number | null = null

  TransportCtor.platform = () => 'win32'
  TransportCtor.taskkill = (pid: number) => {
    killedPid = pid
  }

  try {
    transport.close()
    assert.equal(killedPid, process.pid)
    assert.equal(process.killCalls, 0)
  } finally {
    TransportCtor.platform = originalPlatform
    TransportCtor.taskkill = originalTaskkill
  }
})

test('close on windows falls back to process.kill when taskkill fails', () => {
  const { transport, process } = createAppServerTransport()
  const TransportCtor = AppServerTransport as unknown as {
    platform: () => NodeJS.Platform
    taskkill: (pid: number) => void
  }

  const originalPlatform = TransportCtor.platform
  const originalTaskkill = TransportCtor.taskkill
  let taskkillAttempts = 0

  TransportCtor.platform = () => 'win32'
  TransportCtor.taskkill = () => {
    taskkillAttempts += 1
    throw new Error('taskkill failed')
  }

  try {
    transport.close()
    assert.equal(taskkillAttempts, 1)
    assert.equal(process.killCalls, 1)
  } finally {
    TransportCtor.platform = originalPlatform
    TransportCtor.taskkill = originalTaskkill
  }
})

test('close on non-windows skips taskkill and uses process.kill', () => {
  const { transport, process } = createAppServerTransport()
  const TransportCtor = AppServerTransport as unknown as {
    platform: () => NodeJS.Platform
    taskkill: (pid: number) => void
  }

  const originalPlatform = TransportCtor.platform
  const originalTaskkill = TransportCtor.taskkill
  let taskkillAttempts = 0

  TransportCtor.platform = () => 'linux'
  TransportCtor.taskkill = () => {
    taskkillAttempts += 1
  }

  try {
    transport.close()
    assert.equal(taskkillAttempts, 0)
    assert.equal(process.killCalls, 1)
  } finally {
    TransportCtor.platform = originalPlatform
    TransportCtor.taskkill = originalTaskkill
  }
})
