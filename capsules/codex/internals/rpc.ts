import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { killTree } from '../../shared/runtime.ts'

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; method: string }

export type ServerRequestHandler = (method: string, params: any) => Promise<unknown>
export type NotificationHandler = (method: string, params: any) => void

export class CodexRpcError extends Error {
  readonly code: number | undefined
  readonly method: string
  constructor(method: string, message: string, code?: number) {
    super(`codex ${method}: ${message}`)
    this.name = 'CodexRpcError'
    this.method = method
    this.code = code
  }
}

/**
 * One `codex app-server` child speaking newline-delimited JSON-RPC 2.0 over stdio.
 * Client→server requests, server→client notifications, and server→client requests
 * (approvals / user input) all share the pipe.
 */
export class CodexRpc {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buffer = ''
  private stderrTail = ''
  private readonly child: ChildProcessWithoutNullStreams
  private closed = false
  readonly exited: Promise<number | null>
  onNotification: NotificationHandler = () => {}
  onServerRequest: ServerRequestHandler = async () => {
    throw new Error('unhandled server request')
  }

  constructor(binary: string, args: string[], options: { cwd?: string; env?: Record<string, string> }) {
    this.child = spawn(binary, [...args, 'app-server'], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code) => {
        this.closed = true
        const reason = new Error(`codex app-server exited (${code})${this.stderrTail ? `: ${this.stderrTail.trim().slice(-500)}` : ''}`)
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer)
          entry.reject(reason)
        }
        this.pending.clear()
        resolve(code)
      })
      this.child.once('error', (error) => {
        this.closed = true
        for (const entry of this.pending.values()) entry.reject(error)
        this.pending.clear()
        resolve(-1)
      })
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000)
    })
  }

  get stderr(): string {
    return this.stderrTail
  }

  request<T = any>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.closed) return Promise.reject(new CodexRpcError(method, 'app-server is not running'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CodexRpcError(method, `timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.write({ jsonrpc: '2.0', method, params })
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.child.stdin.end()
    await killTree(this.child, 2000)
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: any): void {
    const hasId = message.id !== undefined && message.id !== null
    if (hasId && message.method === undefined) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new CodexRpcError(entry.method, message.error.message ?? 'error', message.error.code))
      else entry.resolve(message.result)
      return
    }
    if (hasId && message.method) {
      this.onServerRequest(message.method, message.params).then(
        (result) => this.write({ jsonrpc: '2.0', id: message.id, result }),
        (error: unknown) =>
          this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }),
      )
      return
    }
    if (message.method) this.onNotification(message.method, message.params)
  }
}
