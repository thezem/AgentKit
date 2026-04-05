export class Deferred<T> {
  promise: Promise<T>
  resolve!: (value: T | PromiseLike<T>) => void
  reject!: (reason?: unknown) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private readonly waiters: Array<Deferred<IteratorResult<T>>> = []
  private ended = false

  push(item: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ value: item, done: false })
      return
    }
    this.items.push(item)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.items.length > 0) {
          return { value: this.items.shift() as T, done: false }
        }
        if (this.ended) {
          return { value: undefined, done: true }
        }
        const deferred = new Deferred<IteratorResult<T>>()
        this.waiters.push(deferred)
        return deferred.promise
      },
    }
  }
}

export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

export function assertObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${context} to be an object`)
  }
  return value as Record<string, unknown>
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
