import type { AgentEvent, Capabilities, PermissionResponse, ProviderCatalog } from '../../../../capsules/shared/contract.ts'
import type { Transcript } from '../../../../src/transcript.ts'

export type { AgentEvent, Capabilities, ProviderCatalog, Transcript }
export type { PermissionRequest, TimelineItem, ToolCallItem, ToolDetail } from '../../../../capsules/shared/contract.ts'

export type ProviderStatus = { provider: string; label: string; available: boolean; capabilities: Capabilities }
export type ConversationSummary = {
  id: string
  provider: string
  cwd: string
  title: string
  model?: string
  mode?: string
  thinking?: string
  status: Transcript['status']
  live: boolean
  createdAt: string
  updatedAt: string
}
export type ConversationDetail = ConversationSummary & { transcript: Transcript; capabilities?: Capabilities }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data as T
}

export const api = {
  providers: () => call<ProviderStatus[]>('GET', '/providers'),
  defaults: () => call<{ cwd: string; home: string }>('GET', '/defaults'),
  catalog: (provider: string, cwd?: string) => call<ProviderCatalog>('GET', `/catalog/${provider}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  conversations: () => call<ConversationSummary[]>('GET', '/conversations'),
  conversation: (id: string) => call<ConversationDetail>('GET', `/conversations/${id}`),
  create: (input: { provider: string; cwd: string; model?: string; mode?: string; thinking?: string }) => call<ConversationSummary>('POST', '/conversations', input),
  send: (id: string, text: string) => call<{ queued: number }>('POST', `/conversations/${id}/messages`, { text }),
  steer: (id: string, text: string) => call<{ steered: boolean }>('POST', `/conversations/${id}/steer`, { text }),
  interrupt: (id: string) => call('POST', `/conversations/${id}/interrupt`),
  respond: (id: string, requestId: string, response: PermissionResponse) => call('POST', `/conversations/${id}/permissions/${encodeURIComponent(requestId)}`, response),
  settings: (id: string, patch: { mode?: string; model?: string; thinking?: string }) => call<ConversationSummary>('POST', `/conversations/${id}/settings`, patch),
  rewind: (id: string, messageId: string) => call<ConversationDetail>('POST', `/conversations/${id}/rewind`, { messageId }),
  remove: (id: string) => call('DELETE', `/conversations/${id}`),
}
