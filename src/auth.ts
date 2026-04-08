import { spawn } from 'node:child_process'
import type { CodexClient } from './codex-client.ts'
import type { AccountState, CodexAccount, LoginInfo, LoginStartResult, LoginStrategy } from './types.ts'
import { sleep } from './utils.ts'

/**
 * Codex account/auth helper for browser and device-code login flows.
 */
export class CodexAuth {
  private readonly client: CodexClient

  constructor(client: CodexClient) {
    this.client = client
  }

  /**
   * Read current account state from app-server.
   */
  async getAccount(refreshToken = false): Promise<AccountState> {
    return this.client.raw.request<AccountState>('account/read', { refreshToken })
  }

  /**
   * Ensure an authenticated account exists, triggering login when needed.
   */
  async ensureLoggedIn(strategy?: LoginStrategy): Promise<CodexAccount> {
    const current = await this.getAccount(false)
    if (current.account) {
      return current.account
    }

    const selected = strategy ?? this.client.options.auth?.strategy ?? 'browser'
    if (selected === 'device-code') {
      return this.loginWithDeviceCode()
    }

    return this.loginWithChatGPT()
  }

  /**
   * Start and complete the ChatGPT browser login flow.
   */
  async loginWithChatGPT(): Promise<CodexAccount> {
    const result = await this.client.raw.request<LoginStartResult>('account/login/start', { type: 'chatgpt' })

    if (result.type !== 'chatgpt') {
      throw new Error(`Expected chatgpt login flow, got ${result.type}`)
    }

    const info: LoginInfo = {
      strategy: 'browser',
      url: result.authUrl,
      loginId: result.loginId,
    }

    await this.client.options.auth?.onLoginRequired?.(info)

    const timeoutMs = this.client.options.auth?.timeoutMs ?? 5 * 60 * 1000
    const account = await this.client.waitForLogin(result.loginId, timeoutMs)
    await this.client.options.auth?.onLoginComplete?.(account)
    return account
  }

  /**
   * Run the native `codex login --device-auth` flow and refresh transport state.
   */
  async loginWithDeviceCode(): Promise<CodexAccount> {
    const command = this.client.options.codexPath ?? (process.platform === 'win32' ? 'codex.cmd' : 'codex')
    const child = spawn(command, ['login', '--device-auth'], {
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    })

    await new Promise<void>((resolve, reject) => {
      child.once('exit', (code) => {
        if (code === 0) {
          resolve()
          return
        }
        reject(new Error(`codex login --device-auth exited with code ${code}`))
      })
      child.once('error', reject)
    })

    await this.client.restartTransport()

    const refreshed = await this.waitForExternalLogin()
    if (!refreshed) {
      throw new Error('Device auth completed but app-server still reports no account')
    }

    await this.client.options.auth?.onLoginComplete?.(refreshed)
    return refreshed
  }

  /**
   * Log out the current account in app-server.
   */
  async logout(): Promise<void> {
    await this.client.raw.request('account/logout')
  }

  /**
   * Read provider rate-limit metadata when exposed by app-server.
   */
  async getRateLimits(): Promise<unknown> {
    return this.client.raw.request('account/rateLimits/read')
  }

  private async waitForExternalLogin(): Promise<CodexAccount | null> {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const refreshed = await this.getAccount(true)
      if (refreshed.account) {
        return refreshed.account
      }

      await sleep(1000)
    }

    return null
  }
}
