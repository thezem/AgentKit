import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { EventEmitter } from 'node:events'
import type {
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccess,
} from './types.ts'
import { TransportRequestTimeoutError } from './errors.ts'

type TransportLogger = (event: {
  level: 'debug' | 'info' | 'warn' | 'error'
  code: string
  message: string
  data?: Record<string, unknown>
}) => void

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timer: NodeJS.Timeout | null
}

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message
}

function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message)
}

function isSuccess(message: JsonRpcMessage): message is JsonRpcSuccess {
  return 'id' in message && 'result' in message
}

function isFailure(message: JsonRpcMessage): message is JsonRpcFailure {
  return 'error' in message
}

export class AppServerTransport {
  private readonly process: ChildProcessWithoutNullStreams
  private readonly lines: readline.Interface
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly events = new EventEmitter()
  private nextId = 1
  private closed = false
  private readonly requestTimeoutMs: number
  private readonly logger?: TransportLogger

  private constructor(
    process: ChildProcessWithoutNullStreams,
    options?: {
      requestTimeoutMs?: number
      logger?: TransportLogger
    },
  ) {
    this.process = process
    this.lines = readline.createInterface({ input: process.stdout })
    this.requestTimeoutMs = Math.max(1, options?.requestTimeoutMs ?? 30_000)
    this.logger = options?.logger

    this.lines.on('line', (line) => {
      this.handleLine(line)
    })

    this.process.on('exit', (code, signal) => {
      const reason = new Error(`codex app-server exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`)
      this.rejectPending(reason)
      this.closed = true
      this.events.emit('closed', reason)
    })
  }

  static async start(options: {
    codexPath?: string
    clientInfo?: { name?: string; title?: string; version?: string }
    env?: Record<string, string>
    requestTimeoutMs?: number
    logger?: TransportLogger
  }): Promise<AppServerTransport> {
    const command = resolveCodexCommand(options.codexPath)
    const child = spawn(command, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ? options.env : (process.env as Record<string, string>),
      shell: process.platform === 'win32',
    })

    child.stderr.on('data', () => {
      // stderr is intentionally ignored here; callers get structured errors over JSON-RPC.
    })

    const transport = await new Promise<AppServerTransport>((resolve, reject) => {
      child.once('error', reject)
      child.once('spawn', () => {
        child.removeListener('error', reject)
        resolve(
          new AppServerTransport(child, {
            requestTimeoutMs: options.requestTimeoutMs,
            logger: options.logger,
          }),
        )
      })
    })
    await transport.request('initialize', {
      clientInfo: {
        name: options.clientInfo?.name ?? 'agentkit',
        title: options.clientInfo?.title ?? 'Codex Client',
        version: options.clientInfo?.version ?? '0.2.0',
      },
    })
    transport.notify('initialized', {})
    return transport
  }

  onNotification(listener: (message: JsonRpcNotification) => void): void {
    this.events.on('notification', listener)
  }

  onServerRequest(listener: (message: JsonRpcRequest) => void): void {
    this.events.on('request', listener)
  }

  onClosed(listener: (error: Error) => void): void {
    this.events.on('closed', listener)
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      throw new Error('codex app-server transport is closed')
    }

    const id = this.nextId++
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        const timeoutError = new TransportRequestTimeoutError(method, id, this.requestTimeoutMs)
        pending.reject(timeoutError)
        this.log('warn', 'transport.request.timeout', timeoutError.message, {
          method,
          requestId: id,
          requestTimeoutMs: this.requestTimeoutMs,
        })
      }, this.requestTimeoutMs)

      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
    })

    this.send({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.send({ jsonrpc: '2.0', method, params })
  }

  respond(id: JsonRpcId, result: unknown): void {
    if (this.closed) return
    this.send({ jsonrpc: '2.0', id, result })
  }

  respondError(id: JsonRpcId, message: string, data?: unknown): void {
    if (this.closed) return
    this.send({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message,
        ...(data !== undefined ? { data } : {}),
      },
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.rejectPending(new Error('codex app-server transport is closed'))
    this.lines.close()
    if (process.platform === 'win32' && this.process.pid) {
      try {
        execFileSync('taskkill', ['/pid', String(this.process.pid), '/t', '/f'], { stdio: 'ignore' })
        return
      } catch {
        // Fall back to a normal kill below.
      }
    }
    this.process.kill()
  }

  private send(message: Record<string, unknown>): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    if (!line.trim()) return

    let message: JsonRpcMessage
    try {
      message = JSON.parse(line) as JsonRpcMessage
    } catch (error) {
      this.log('error', 'transport.notification.malformed_json', 'Failed to parse JSON-RPC message', {
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    if (isSuccess(message)) {
      const pending = this.pending.get(message.id)
      if (!pending) {
        this.log('warn', 'transport.response.unmatched', 'Received unmatched JSON-RPC success response', {
          requestId: message.id,
        })
        return
      }
      this.pending.delete(message.id)
      if (pending.timer) {
        clearTimeout(pending.timer)
      }
      pending.resolve(message.result)
      return
    }

    if (isFailure(message)) {
      if (message.id === null) return
      const pending = this.pending.get(message.id)
      if (!pending) {
        this.log('warn', 'transport.response.unmatched', 'Received unmatched JSON-RPC error response', {
          requestId: message.id,
          errorCode: message.error.code,
        })
        return
      }
      this.pending.delete(message.id)
      if (pending.timer) {
        clearTimeout(pending.timer)
      }
      pending.reject(new Error(message.error.message))
      return
    }

    if (isRequest(message)) {
      this.events.emit('request', message)
      return
    }

    if (isNotification(message)) {
      this.events.emit('notification', message)
    }
  }

  private rejectPending(reason: Error): void {
    for (const [id, request] of this.pending.entries()) {
      if (request.timer) {
        clearTimeout(request.timer)
      }
      request.reject(reason)
      this.pending.delete(id)
    }
  }

  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    code: string,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.logger?.({ level, code, message, ...(data ? { data } : {}) })
  }
}

function resolveCodexCommand(override?: string): string {
  if (override) return override
  return process.platform === 'win32' ? 'codex.cmd' : 'codex'
}
