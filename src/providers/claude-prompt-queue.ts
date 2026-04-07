import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

type PromptQueueItem = SDKUserMessage

export class ClaudePromptQueue implements AsyncIterable<PromptQueueItem> {
  private readonly items: PromptQueueItem[] = []
  private readonly waiters: Array<(result: IteratorResult<PromptQueueItem>) => void> = []
  private closed = false

  push(message: PromptQueueItem): void {
    if (this.closed) {
      throw new Error('Claude prompt queue is closed')
    }

    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ value: message, done: false })
      return
    }
    this.items.push(message)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      waiter?.({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<PromptQueueItem> {
    return {
      next: async () => {
        if (this.items.length > 0) {
          return { value: this.items.shift() as PromptQueueItem, done: false }
        }

        if (this.closed) {
          return { value: undefined, done: true }
        }

        return new Promise<IteratorResult<PromptQueueItem>>((resolve) => {
          this.waiters.push(resolve)
        })
      },
    }
  }
}
