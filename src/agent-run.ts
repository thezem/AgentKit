import type { AgentEvent, AgentRun, AgentRunResult } from './agent-types.ts'
import { AsyncQueue, Deferred } from './utils.ts'

export function createAgentRun(options: {
  runId: string
  source: AsyncIterable<AgentEvent>
  interrupt: () => Promise<void>
  onSettled?: () => void
  maxBufferedEvents?: number
}): AgentRun {
  const events = new AsyncQueue<AgentEvent>({
    // Bound buffered events so `run().result` callers do not accumulate an
    // unbounded in-memory copy of verbose streams they never consume.
    maxSize: options.maxBufferedEvents ?? 256,
  })
  const result = new Deferred<AgentRunResult>()

  void pumpAgentRun(options.source, events, result, options.onSettled)

  return {
    runId: options.runId,
    events,
    result: result.promise,
    interrupt: options.interrupt,
  }
}

async function pumpAgentRun(
  source: AsyncIterable<AgentEvent>,
  events: AsyncQueue<AgentEvent>,
  result: Deferred<AgentRunResult>,
  onSettled?: () => void,
): Promise<void> {
  let sawTerminalResult = false
  let settled = false

  const settle = () => {
    if (settled) return
    settled = true
    onSettled?.()
  }

  try {
    for await (const event of source) {
      void events.push(event)
      if (event.type === 'run.completed') {
        sawTerminalResult = true
        result.resolve(event.result)
        settle()
      }
    }

    if (!sawTerminalResult) {
      result.reject(new Error('Agent run ended without a terminal result'))
    }
    events.end()
  } catch (error) {
    result.reject(error)
    events.fail(error)
  } finally {
    settle()
  }
}
