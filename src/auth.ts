import { spawn } from 'node:child_process'
import type { CodexClient } from './codex-client.ts'
import type { AccountState, CodexAccount, LoginInfo, LoginStartResult, LoginStrategy } from './types.ts'

export class CodexAuth {
  private readonly client: CodexClient

  constructor(client: CodexClient) {
    this.client = client
  }

  async getAccount(refreshToken = false): Promise<AccountState> {
    return this.client.raw.request<AccountState>('account/read', { refreshToken })
  }

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

    const refreshed = await this.getAccount(true)
    if (!refreshed.account) {
      throw new Error('Device auth completed but app-server still reports no account')
    }

    await this.client.options.auth?.onLoginComplete?.(refreshed.account)
    return refreshed.account
  }

  async logout(): Promise<void> {
    await this.client.raw.request('account/logout')
  }

  async getRateLimits(): Promise<unknown> {
    return this.client.raw.request('account/rateLimits/read')
  }
}
