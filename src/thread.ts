import type { CodexClient } from './codex-client.ts'
import type { CodexStreamEvent, CodexThreadData, RunOptions, RunResult, UserInput } from './types.ts'

/**
 * Codex thread wrapper around provider-native thread identity.
 */
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

  /**
   * Run one turn to completion on this thread.
   */
  async run(input: UserInput, options?: RunOptions): Promise<RunResult> {
    return this.client.runThread(this, input, options)
  }

  /**
   * Start one turn and stream Codex events.
   */
  async stream(input: UserInput, options?: RunOptions): Promise<AsyncIterable<CodexStreamEvent>> {
    return this.client.streamThread(this, input, options)
  }

  /**
   * Send steering input to the active turn.
   */
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

  /**
   * Interrupt the active turn.
   */
  async interrupt(): Promise<void> {
    if (!this.activeTurnId) {
      throw new Error('No active turn to interrupt')
    }

    await this.client.raw.request('turn/interrupt', {
      threadId: this.id,
      turnId: this.activeTurnId,
    })
  }

  /**
   * Fork this thread into a new thread.
   */
  async fork(options?: RunOptions): Promise<CodexThread> {
    return this.client.threads.fork(this.id, options)
  }

  setActiveTurnId(turnId: string | null): void {
    this.activeTurnId = turnId
  }
}

/**
 * Locally cached session wrapper that lazily creates/resumes one Codex thread.
 */
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

  /**
   * Backing Codex thread id once created/resumed.
   */
  get id(): string | null {
    return this.threadId
  }

  /**
   * Open or resume the underlying Codex thread for this session.
   */
  async thread(): Promise<CodexThread> {
    if (this.threadId) {
      return this.client.threads.resume(this.threadId)
    }

    const thread = await this.client.threads.create(this.options)
    this.threadId = thread.id
    return thread
  }

  /**
   * Run one turn using this session's default options merged with call options.
   */
  async run(input: UserInput, options?: RunOptions): Promise<RunResult> {
    const thread = await this.thread()
    return thread.run(input, mergeRunOptions(this.options, options))
  }

  /**
   * Stream one turn using this session's default options merged with call options.
   */
  async stream(input: UserInput, options?: RunOptions): Promise<AsyncIterable<CodexStreamEvent>> {
    const thread = await this.thread()
    return thread.stream(input, mergeRunOptions(this.options, options))
  }

  /**
   * Forward steering input to the underlying thread.
   */
  async steer(input: UserInput): Promise<void> {
    const thread = await this.thread()
    return thread.steer(input)
  }

  /**
   * Interrupt the active turn on the underlying thread.
   */
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
