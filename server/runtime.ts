import type { AccountState, CodexClient, RunResult, ThreadOptions } from '../src/index.ts'
import { createCodex } from '../src/index.ts'
import type { ServerConfig } from './types.ts'

export class CodexRuntime {
  private readonly config: ServerConfig
  private client: CodexClient | null = null

  constructor(config: ServerConfig) {
    this.config = config
  }

  async getClient(): Promise<CodexClient> {
    if (this.client) {
      return this.client
    }

    this.client = await createCodex({
      codexPath: this.config.codexPath,
      auth: {
        autoLogin: false,
      },
      defaults: {
        cwd: this.config.defaultCwd,
        model: this.config.defaultModel,
        sandboxMode: this.config.sandboxMode,
        approvalPolicy: this.config.approvalPolicy,
      },
    })

    return this.client
  }

  async getAccount(): Promise<AccountState> {
    const client = await this.getClient()
    return client.auth.getAccount(false)
  }

  async runPrompt(prompt: string, cwd?: string | null, options?: ThreadOptions): Promise<RunResult> {
    const client = await this.getClient()
    const thread = await client.threads.create({
      cwd: cwd ?? this.config.defaultCwd,
      model: options?.model ?? this.config.defaultModel,
      sandboxMode: options?.sandboxMode ?? this.config.sandboxMode,
      approvalPolicy: options?.approvalPolicy ?? this.config.approvalPolicy,
      reasoningEffort: options?.reasoningEffort,
      reasoningSummary: options?.reasoningSummary,
      personality: options?.personality,
      config: options?.config,
      baseInstructions: options?.baseInstructions,
      developerInstructions: options?.developerInstructions,
      ephemeral: options?.ephemeral,
      persistExtendedHistory: options?.persistExtendedHistory,
    })

    return thread.run(prompt, options)
  }

  async close(): Promise<void> {
    if (!this.client) return
    await this.client.close()
    this.client = null
  }
}
