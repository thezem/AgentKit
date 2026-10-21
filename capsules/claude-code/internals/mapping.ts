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

/** Tool arguments still streaming in: a row at once, then updates as the JSON grows (strings cut to their last 2000
 * characters, so frequent updates stay small). The complete call replaces it (same callId). */
export function toolDraft(id: string, name: string, json: string): ToolCallItem {
  return { type: 'tool_call', callId: id, name, status: 'running', detail: deriveToolDetail(name, tail(parsePartialJson(json))), inputChars: json.length }
}

const TAIL = 2000
function tail(value: unknown): unknown {
  if (typeof value === 'string') return value.length > TAIL ? '…' + value.slice(-TAIL) : value
  if (Array.isArray(value)) return value.map(tail)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tail(v)]))
  return value
}

/** Best-effort parse of a JSON prefix: close the open string / arrays / objects; if that isn't valid (a dangling key,
 * colon or comma), walk back to the last complete value and close from there. */
export function parsePartialJson(text: string): Record<string, unknown> {
  const tryParse = (candidate: string) => {
    try {
      const parsed = JSON.parse(candidate)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const { inString, escaped, closers } = scan(text)
  const closedString = inString ? (escaped ? text.slice(0, -1) : text) + '"' : text
  const direct = tryParse(closedString + closers)
  if (direct) return direct
  // Walk back (bounded) to a point right after a complete value and close from there.
  for (let end = closedString.length, steps = 0; end > 0 && steps < 400; end--, steps++) {
    const prefix = closedString.slice(0, end).replace(/[\s,:]+$/, '')
    if (!/["\]}\deul]$/.test(prefix)) continue
    const s = scan(prefix)
    if (s.inString) continue
    const parsed = tryParse(prefix + s.closers)
    if (parsed) return parsed
  }
  return {}
}

/** Where a JSON prefix stands: inside a string? which brackets are still open (as their closers)? */
function scan(text: string): { inString: boolean; escaped: boolean; closers: string } {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
    else if (ch === '}' || ch === ']') stack.pop()
  }
  return { inString, escaped, closers: stack.reverse().join('') }
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
