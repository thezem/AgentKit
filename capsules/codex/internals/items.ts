import type { PlanUsage, TimelineItem, ToolCallItem, ToolStatus, Usage, UsageWindow } from '../../shared/contract.ts'
import { safeJson } from '../../shared/runtime.ts'

/** Codex `ThreadItem` (v2 app-server protocol), kept loose on purpose: the schema moves fast. */
export type CodexItem = { type: string; id: string; [key: string]: any }

function status(raw: unknown): ToolStatus {
  if (raw === 'completed') return 'completed'
  if (raw === 'failed') return 'failed'
  if (raw === 'declined' || raw === 'interrupted') return 'canceled'
  return 'running'
}

/**
 * Map a Codex item to a timeline item. Text items (agentMessage / reasoning) are
 * returned whole; the session decides whether they were already streamed as deltas.
 */
export function mapCodexItem(item: CodexItem): TimelineItem | null {
  switch (item.type) {
    case 'userMessage': {
      const text = (item.content ?? [])
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text)
        .join('\n')
      return { type: 'user_message', text, messageId: item.id, clientMessageId: item.clientId ?? undefined }
    }
    case 'agentMessage':
      return { type: 'assistant_message', text: item.text ?? '', messageId: item.id }
    case 'reasoning': {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].join('\n')
      return text ? { type: 'reasoning', text } : null
    }
    case 'plan':
      return tool(item, 'plan', 'completed', { type: 'plan', text: item.text ?? '' })
    case 'commandExecution':
      return tool(item, 'shell', status(item.status), {
        type: 'shell',
        command: item.command ?? '',
        cwd: item.cwd ?? undefined,
        output: item.aggregatedOutput ?? undefined,
        exitCode: item.exitCode ?? null,
      })
    case 'fileChange': {
      const changes: Array<{ path: string; kind: { type: string }; diff: string }> = item.changes ?? []
      const first = changes[0]
      if (first && changes.length === 1 && first.kind?.type === 'add') {
        return tool(item, 'apply_patch', status(item.status), { type: 'write', filePath: first.path, content: stripAddDiff(first.diff) })
      }
      return tool(item, 'apply_patch', status(item.status), {
        type: 'edit',
        filePath: changes.map((change) => change.path).join(', '),
        unifiedDiff: changes.map((change) => change.diff).join('\n'),
      })
    }
    case 'mcpToolCall':
      return tool(
        item,
        `mcp__${item.server}__${item.tool}`,
        status(item.status),
        { type: 'mcp', server: item.server, tool: item.tool, input: item.arguments, output: item.result?.structuredContent ?? item.result?.content },
        item.error?.message,
      )
    case 'dynamicToolCall':
      return tool(item, item.tool ?? 'tool', status(item.status), { type: 'unknown', input: item.arguments, output: item.contentItems })
    case 'webSearch':
      return tool(item, 'web_search', 'completed', { type: 'search', query: item.query ?? item.action?.query ?? '', kind: 'web' })
    case 'collabAgentToolCall':
      return tool(item, `collab:${item.tool}`, status(item.status), {
        type: 'sub_agent',
        description: item.prompt ?? undefined,
        childSessionId: item.receiverThreadIds?.[0],
      })
    case 'imageView':
      return tool(item, 'view_image', 'completed', { type: 'read', filePath: item.path ?? '' })
    case 'contextCompaction':
      return { type: 'compaction', status: 'completed' }
    case 'extension':
    case 'Extension': {
      // Built-in extension tools (kind "clock.sleep" etc.) arrive completed, with no status field.
      const { type: _type, id: _id, kind, status: raw, ...input } = item
      return tool(item, String(kind ?? 'extension'), raw ? status(raw) : 'completed', { type: 'unknown', input })
    }
    case 'enteredReviewMode':
    case 'exitedReviewMode':
    case 'hookPrompt':
    case 'functionCallOutput':
      return null
    default: {
      // Unknown kinds become a generic tool row so the next new Codex item type doesn't vanish silently.
      if (/message$|^reasoning$|^plan$/i.test(item.type)) return null
      const { type, id: _id, status: raw, ...input } = item
      return tool(item, String(item.kind ?? item.tool ?? item.name ?? type), raw ? status(raw) : 'completed', { type: 'unknown', input })
    }
  }
}

function tool(item: CodexItem, name: string, toolStatus: ToolStatus, detail: ToolCallItem['detail'], error?: string): ToolCallItem {
  return { type: 'tool_call', callId: item.id, name, status: toolStatus, detail, ...(error ? { error } : {}) }
}

function stripAddDiff(diff: string): string {
  if (!diff.includes('\n+')) return diff
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n')
}

export function usageFromCodex(tokenUsage: any): Usage {
  const total = tokenUsage?.total ?? {}
  const last = tokenUsage?.last ?? {}
  return {
    inputTokens: total.inputTokens,
    cachedInputTokens: total.cachedInputTokens,
    outputTokens: total.outputTokens,
    contextWindowMaxTokens: tokenUsage?.modelContextWindow ?? undefined,
    contextWindowUsedTokens: last.totalTokens ?? undefined,
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return safeJson(error)
}

/** Codex `account/rateLimits/read` (or the `account/rateLimits/updated` push) → PlanUsage. */
export function codexPlanUsage(raw: any): PlanUsage {
  const snapshots: any[] = raw?.rateLimitsByLimitId ? Object.values(raw.rateLimitsByLimitId).filter(Boolean) : raw?.rateLimits ? [raw.rateLimits] : []
  const windows: UsageWindow[] = []
  let plan: string | null = null
  for (const snap of snapshots) {
    plan ??= snap.planType ?? null
    const prefix = snapshots.length > 1 && snap.limitId ? `${snap.limitId}:` : ''
    for (const key of ['primary', 'secondary'] as const) {
      const w = snap[key]
      if (!w) continue
      const minutes: number | null = w.windowDurationMins ?? null
      windows.push({
        id: `${prefix}${key}`,
        label: `${snap.limitName && snapshots.length > 1 ? `${snap.limitName} ` : ''}${windowLabel(minutes, key)}`,
        usedPercent: typeof w.usedPercent === 'number' ? w.usedPercent : null,
        resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null,
        windowMinutes: minutes,
      })
    }
  }
  return { provider: 'codex', plan, available: windows.length > 0, windows, raw }
}

function windowLabel(minutes: number | null, fallback: string): string {
  if (minutes === 300) return '5-hour'
  if (minutes === 7 * 24 * 60) return 'Weekly'
  if (minutes && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day`
  if (minutes && minutes % 60 === 0) return `${minutes / 60}-hour`
  return fallback
}
