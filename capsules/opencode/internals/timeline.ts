import type { TimelineItem, ToolCallItem } from '../../shared/contract.ts'
import { deriveToolDetail } from '../../shared/runtime.ts'

/**
 * OpenCode v2 streams text/reasoning as ephemeral deltas and everything else as
 * durable message snapshots. This class turns both into append-only timeline
 * items without duplicates: it remembers what it already emitted per part and
 * only emits the new suffix (text) or the changed state (tools).
 * Adapted from paseo opencode/v2/timeline.ts.
 */
export class OpenCodeTimeline {
  private readonly emitted = new Map<string, string>()
  private readonly streams = new Map<string, string>()

  resetStreams(): void {
    this.streams.clear()
  }

  startPart(messageId: string, kind: 'text' | 'reasoning', ordinal: number): void {
    this.streams.set(key(messageId, kind, ordinal), '')
  }

  delta(messageId: string, kind: 'text' | 'reasoning', ordinal: number, delta: string): TimelineItem | null {
    const k = key(messageId, kind, ordinal)
    const streamed = this.streams.get(k)
    if (streamed === undefined || !delta) return null
    const text = streamed + delta
    this.streams.set(k, text)
    return this.suffix(k, text, messageId, kind)
  }

  /** Diff a full message snapshot list against what was already emitted. */
  messages(messages: any[]): TimelineItem[] {
    const out: TimelineItem[] = []
    for (const message of messages) {
      if (message.type === 'user') {
        if (this.emitted.has(message.id)) continue
        this.emitted.set(message.id, message.text ?? '')
        const clientMessageId = message.metadata?.agentkitClientMessageId
        out.push({ type: 'user_message', text: message.text ?? '', messageId: message.id, ...(typeof clientMessageId === 'string' ? { clientMessageId } : {}) })
      } else if (message.type === 'assistant') {
        let textOrdinal = 0
        let reasoningOrdinal = 0
        ;(message.content ?? []).forEach((part: any, index: number) => {
          if (part.type === 'text' || part.type === 'reasoning') {
            const ordinal = part.type === 'text' ? textOrdinal++ : reasoningOrdinal++
            const item = this.suffix(key(message.id, part.type, ordinal), part.text ?? '', message.id, part.type)
            if (item) out.push(item)
          } else if (part.type === 'tool') {
            const k = `${message.id}:${index}`
            const serialized = JSON.stringify(part.state)
            if (this.emitted.get(k) === serialized) return
            this.emitted.set(k, serialized)
            out.push(toolItem(part))
          }
        })
      } else if (message.type === 'compaction') {
        const status = message.status === 'running' ? 'running' : 'completed'
        if (this.emitted.get(message.id) === status) continue
        this.emitted.set(message.id, status)
        out.push({ type: 'compaction', status })
      }
    }
    return out
  }

  private suffix(k: string, text: string, messageId: string, kind: 'text' | 'reasoning'): TimelineItem | null {
    const previous = this.emitted.get(k) ?? ''
    if (text.length <= previous.length || !text.startsWith(previous)) return null
    this.emitted.set(k, text)
    const piece = text.slice(previous.length)
    return kind === 'text' ? { type: 'assistant_message', text: piece, messageId } : { type: 'reasoning', text: piece }
  }
}

function key(messageId: string, kind: string, ordinal: number): string {
  return `${messageId}:${kind}:${ordinal}`
}

function toolItem(part: any): ToolCallItem {
  const state = part.state ?? {}
  const output = Array.isArray(state.content)
    ? state.content.map((c: any) => (c.type === 'text' ? c.text : c.uri?.startsWith('data:') ? '[image]' : c.uri)).join('\n')
    : undefined
  const status = state.status === 'completed' ? 'completed' : state.status === 'error' ? 'failed' : 'running'
  const error = state.status === 'error' ? (typeof state.error === 'string' ? state.error : state.error?.message ?? 'tool failed') : undefined
  return {
    type: 'tool_call',
    callId: part.id,
    name: part.name,
    status,
    detail: deriveToolDetail(part.name, state.input, output),
    ...(error ? { error } : {}),
    ...(state.metadata ? { metadata: state.metadata } : {}),
  }
}
