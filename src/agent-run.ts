import type { AgentEvent, AgentRun, AgentRunResult } from './agent-types.ts'
import { AsyncQueue, Deferred } from './utils.ts'

export function createAgentRun(options: {
  runId: string
  source: AsyncIterable<AgentEvent>
  interrupt: () => Promise<void>
  onSettled?: () => void
}): AgentRun {
  const events = new AsyncQueue<AgentEvent>()
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
      events.push(event)
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
