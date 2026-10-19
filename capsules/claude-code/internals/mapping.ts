import type { TimelineItem, ToolCallItem, Usage } from '../../shared/contract.ts'
import { deriveToolDetail, safeJson } from '../../shared/runtime.ts'

type Block = { type: string; [key: string]: any }

export function contentBlocks(message: unknown): Block[] {
  const content = (message as { content?: unknown })?.content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? (content as Block[]) : []
}

export function toolResultText(block: Block): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part: any) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n')
  return content === undefined ? '' : safeJson(content)
}

export function toolStarted(block: Block): ToolCallItem {
  return { type: 'tool_call', callId: block.id, name: block.name, status: 'running', detail: deriveToolDetail(block.name, block.input) }
}

export function toolFinished(started: ToolCallItem | undefined, block: Block, input: unknown): ToolCallItem {
  const name = started?.name ?? 'tool'
  const output = toolResultText(block)
  const failed = block.is_error === true
  return {
    type: 'tool_call',
    callId: block.tool_use_id,
    name,
    status: failed ? 'failed' : 'completed',
    detail: deriveToolDetail(name, input, output),
    ...(failed ? { error: output } : {}),
  }
}

export function usageFromResult(result: any): Usage {
  const usage = result?.usage ?? {}
  return {
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    cachedInputTokens: usage.cache_read_input_tokens,
    outputTokens: usage.output_tokens,
    totalCostUsd: result?.total_cost_usd,
  }
}

/** Replay a persisted Claude transcript (getSessionMessages) as timeline items. */
export function* replayMessages(messages: Array<{ type: string; uuid: string; message: unknown; parent_tool_use_id: string | null }>): Generator<TimelineItem> {
  const tools = new Map<string, { item: ToolCallItem; input: unknown }>()
  for (const entry of messages) {
    if (entry.parent_tool_use_id) continue
    const blocks = contentBlocks(entry.message)
    if (entry.type === 'user') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      if (text && !blocks.some((b) => b.type === 'tool_result')) yield { type: 'user_message', text, messageId: entry.uuid }
      for (const block of blocks.filter((b) => b.type === 'tool_result')) {
        const started = tools.get(block.tool_use_id)
        yield toolFinished(started?.item, block, started?.input)
      }
    } else if (entry.type === 'assistant') {
      for (const block of blocks) {
        if (block.type === 'text' && block.text) yield { type: 'assistant_message', text: block.text, messageId: entry.uuid }
        else if (block.type === 'thinking' && block.thinking) yield { type: 'reasoning', text: block.thinking }
        else if (block.type === 'tool_use') {
          const item = toolStarted(block)
          tools.set(block.id, { item, input: block.input })
          yield item
        }
      }
    }
  }
}
