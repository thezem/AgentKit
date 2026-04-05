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

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
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

  private constructor(process: ChildProcessWithoutNullStreams) {
    this.process = process
    this.lines = readline.createInterface({ input: process.stdout })

    this.lines.on('line', (line) => {
      this.handleLine(line)
    })

    this.process.on('exit', (code, signal) => {
      const reason = new Error(`codex app-server exited with code ${code ?? 'null'} and signal ${signal ?? 'null'}`)
      for (const request of this.pending.values()) {
        request.reject(reason)
      }
      this.pending.clear()
      this.closed = true
      this.events.emit('closed', reason)
    })
  }

  static async start(options: {
    codexPath?: string
    clientInfo?: { name?: string; title?: string; version?: string }
    env?: Record<string, string>
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
        resolve(new AppServerTransport(child))
      })
    })
    await transport.request('initialize', {
      clientInfo: {
        name: options.clientInfo?.name ?? 'codex-client',
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
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
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
    const message = JSON.parse(line) as JsonRpcMessage

    if (isSuccess(message)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      pending.resolve(message.result)
      return
    }

    if (isFailure(message)) {
      if (message.id === null) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
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
}

function resolveCodexCommand(override?: string): string {
  if (override) return override
  return process.platform === 'win32' ? 'codex.cmd' : 'codex'
}
