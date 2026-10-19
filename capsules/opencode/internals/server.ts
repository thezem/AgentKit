import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { OpenCode } from '@opencode/client'
import { killTree } from '../../shared/runtime.ts'

export type OpenCodeApi = ReturnType<typeof OpenCode.make>

export interface OpenCodeServer {
  client: OpenCodeApi
  url: string
  exited: Promise<Error>
  stop(): Promise<void>
}

/**
 * Spawn `opencode serve` bound to loopback with a random password, wait for the
 * "server listening on" line, then hand back an authenticated client.
 * Mirrors paseo's V2Runtime.start (opencode/v2/runtime.ts), minus paseo plugins.
 */
export async function startOpenCodeServer(input: { binary: string; args?: string[]; env?: Record<string, string>; cwd?: string; timeoutMs?: number }): Promise<OpenCodeServer> {
  const password = randomBytes(32).toString('base64url')
  const child = spawn(input.binary, [...(input.args ?? []), 'serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd: input.cwd,
    env: { ...process.env, ...input.env, OPENCODE_PASSWORD: password },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const dead = new AbortController()
  let stderr = ''
  child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)))
  const exited = new Promise<Error>((resolve) =>
    child.once('exit', (code) => {
      const error = new Error(`opencode server exited (${code})${stderr ? `: ${stderr.trim().slice(-400)}` : ''}`)
      dead.abort(error)
      resolve(error)
    }),
  )
  const stop = () => killTree(child, 4000)

  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timeoutMs = input.timeoutMs ?? 30_000
      const timer = setTimeout(() => reject(new Error(`opencode serve did not start within ${timeoutMs}ms`)), timeoutMs)
      let buffer = ''
      child.stdout.on('data', (chunk) => {
        buffer = (buffer + chunk).slice(-8192)
        const match = buffer.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
      })
      child.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      void exited.then((error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    const client = OpenCode.make({
      baseUrl: url,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
      fetch: async (request: any, init?: any) => {
        const signal = init?.signal ? AbortSignal.any([init.signal, dead.signal]) : dead.signal
        const response = await fetch(request, { ...init, signal })
        if (!response.ok) {
          const path = new URL(request instanceof Request ? request.url : String(request)).pathname
          const body = await response.clone().text().catch(() => '')
          throw new Error(`opencode ${path} -> HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`)
        }
        return response
      },
    } as any)
    await client.server.info({ signal: AbortSignal.timeout(10_000) } as any)
    return { client, url, exited, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
