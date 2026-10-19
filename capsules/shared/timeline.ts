import type { TimelineItem } from './contract.ts'

/** Pure, browser-safe. */
/** Merge streamed assistant/reasoning deltas into whole items so run results read naturally. */
export function appendTimeline(timeline: TimelineItem[], item: TimelineItem): void {
  const last = timeline.at(-1)
  if (
    last &&
    (item.type === 'assistant_message' || item.type === 'reasoning') &&
    last.type === item.type &&
    (item.type !== 'assistant_message' || last.type !== 'assistant_message' || last.messageId === item.messageId)
  ) {
    timeline[timeline.length - 1] = { ...last, text: last.text + item.text } as TimelineItem
    return
  }
  if (item.type === 'tool_call') {
    const index = timeline.findIndex((entry) => entry.type === 'tool_call' && entry.callId === item.callId)
    if (index >= 0) {
      timeline[index] = item
      return
    }
  }
  timeline.push(item)
}
