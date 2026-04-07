import { InputValidationError } from './errors.ts'
import type { UserInput } from './types.ts'

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
  private failure: unknown | null = null
  private readonly maxSize?: number

  constructor(options?: { maxSize?: number }) {
    this.maxSize = options?.maxSize
  }

  push(item: T): boolean {
    if (this.ended) return false
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ value: item, done: false })
      return true
    }
    if (this.maxSize !== undefined && this.items.length >= this.maxSize) {
      return false
    }
    this.items.push(item)
    return true
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ value: undefined, done: true })
    }
  }

  fail(error: unknown): void {
    if (this.ended) return
    this.ended = true
    this.failure = error
    this.items.length = 0
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error)
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.failure) {
          return Promise.reject(this.failure)
        }
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

export function validateUserInput(input: UserInput): void {
  if (typeof input === 'string') return

  if (!Array.isArray(input) || input.length === 0) {
    throw new InputValidationError('User input array must be non-empty', 'items[0]')
  }

  for (let index = 0; index < input.length; index += 1) {
    const field = `items[${index}]`
    const item = input[index]
    const unknownItem = item as { type?: unknown }
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new InputValidationError('User input item must be an object', field)
    }

    switch (item.type) {
      case 'text':
        if (typeof item.text !== 'string' || item.text.trim().length === 0) {
          throw new InputValidationError('Text input requires a non-empty text value', field)
        }
        break
      case 'image':
        validateUrl(item.url, field)
        break
      case 'localImage':
        validateLocalPath(item.path, field)
        break
      case 'skill':
      case 'mention':
        if (typeof item.name !== 'string' || item.name.trim().length === 0) {
          throw new InputValidationError(`${item.type} input requires a non-empty name`, field)
        }
        if (typeof item.path !== 'string' || item.path.trim().length === 0) {
          throw new InputValidationError(`${item.type} input requires a non-empty path`, field)
        }
        break
      default:
        throw new InputValidationError(`Unsupported user input item type: ${String(unknownItem.type)}`, field)
    }
  }
}

function validateUrl(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InputValidationError('Image input requires a non-empty url', field)
  }
  try {
    new URL(value)
  } catch {
    throw new InputValidationError(`Image url is invalid: ${value}`, field)
  }
}

function validateLocalPath(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InputValidationError('Local image input requires a non-empty path', field)
  }
  if (value.includes('\u0000')) {
    throw new InputValidationError('Local image path must not contain null bytes', field)
  }
}
