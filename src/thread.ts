import type { CodexClient } from './codex-client.ts'
import type { CodexStreamEvent, CodexThreadData, RunOptions, RunResult, UserInput } from './types.ts'

export class CodexThread {
  readonly id: string
  readonly data: CodexThreadData
  private readonly client: CodexClient
  private activeTurnId: string | null = null

  constructor(client: CodexClient, data: CodexThreadData) {
    this.client = client
    this.id = data.id
    this.data = data
  }

  async run(input: UserInput, options?: RunOptions): Promise<RunResult> {
    return this.client.runThread(this, input, options)
  }

  async stream(input: UserInput, options?: RunOptions): Promise<AsyncIterable<CodexStreamEvent>> {
    return this.client.streamThread(this, input, options)
  }

  async steer(input: UserInput): Promise<void> {
    if (!this.activeTurnId) {
      throw new Error('No active turn to steer')
    }

    await this.client.raw.request('turn/steer', {
      threadId: this.id,
      turnId: this.activeTurnId,
      input: this.client.toUserInput(input),
    })
  }

  async interrupt(): Promise<void> {
    if (!this.activeTurnId) {
      throw new Error('No active turn to interrupt')
    }

    await this.client.raw.request('turn/interrupt', {
      threadId: this.id,
      turnId: this.activeTurnId,
    })
  }

  async fork(options?: RunOptions): Promise<CodexThread> {
    return this.client.threads.fork(this.id, options)
  }

  setActiveTurnId(turnId: string | null): void {
    this.activeTurnId = turnId
  }
}

export class CodexSession {
  readonly name: string
  private readonly client: CodexClient
  private readonly options?: RunOptions
  private threadId: string | null = null

  constructor(client: CodexClient, name: string, options?: RunOptions) {
    this.client = client
    this.name = name
    this.options = options
  }

  get id(): string | null {
    return this.threadId
  }

  async thread(): Promise<CodexThread> {
    if (this.threadId) {
      return this.client.threads.resume(this.threadId)
    }

    const thread = await this.client.threads.create(this.options)
    this.threadId = thread.id
    return thread
  }

  async run(input: UserInput, options?: RunOptions): Promise<RunResult> {
    const thread = await this.thread()
    return thread.run(input, mergeRunOptions(this.options, options))
  }

  async stream(input: UserInput, options?: RunOptions): Promise<AsyncIterable<CodexStreamEvent>> {
    const thread = await this.thread()
    return thread.stream(input, mergeRunOptions(this.options, options))
  }

  async steer(input: UserInput): Promise<void> {
    const thread = await this.thread()
    return thread.steer(input)
  }

  async interrupt(): Promise<void> {
    const thread = await this.thread()
    return thread.interrupt()
  }
}

function mergeRunOptions(base?: RunOptions, next?: RunOptions): RunOptions | undefined {
  if (!base && !next) return undefined
  return {
    ...base,
    ...next,
    handlers: {
      ...(base?.handlers ?? {}),
      ...(next?.handlers ?? {}),
    },
  }
}
