import type { AgentEvent, Capabilities, PermissionResponse, ProviderCatalog } from '../../../../capsules/shared/contract.ts'
import type { Transcript } from '../../../../src/transcript.ts'

export type { AgentEvent, Capabilities, ProviderCatalog, Transcript }
export type { PermissionRequest, TimelineItem, ToolCallItem, ToolDetail } from '../../../../capsules/shared/contract.ts'

export type SkillSummary = { name: string; description: string; scope: string; visibleTo: string[] }
export type ProviderStatus = { provider: string; label: string; available: boolean; capabilities: Capabilities }
export type ConversationSummary = {
  id: string
  provider: string
  cwd: string
  title: string
  model?: string
  mode?: string
  thinking?: string
  fast?: boolean
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
  skills: (cwd: string, q = '') => call<SkillSummary[]>('GET', `/skills?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`),
  providers: () => call<ProviderStatus[]>('GET', '/providers'),
  defaults: () => call<{ cwd: string; home: string }>('GET', '/defaults'),
  catalog: (provider: string, cwd?: string) => call<ProviderCatalog>('GET', `/catalog/${provider}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`),
  conversations: () => call<ConversationSummary[]>('GET', '/conversations'),
  conversation: (id: string) => call<ConversationDetail>('GET', `/conversations/${id}`),
  create: (input: { provider: string; cwd: string; model?: string; mode?: string; thinking?: string; fast?: boolean }) => call<ConversationSummary>('POST', '/conversations', input),
  /** requestId makes a retried send (double click, flaky network) run once. */
  send: (id: string, text: string, requestId = crypto.randomUUID()) => call<{ id: string; status: string }>('POST', `/conversations/${id}/messages`, { text, requestId, whenBusy: 'queue' }),
  steer: (id: string, text: string, requestId = crypto.randomUUID()) => call<{ id: string; steered: boolean }>('POST', `/conversations/${id}/steer`, { text, requestId }),
  withdraw: (id: string, submissionId: string) => call<{ ok: boolean }>('POST', `/conversations/${id}/inbox/${encodeURIComponent(submissionId)}/withdraw`),
  fork: (id: string, beforeMessageId?: string) => call<ConversationSummary>('POST', `/conversations/${id}/fork`, { beforeMessageId }),
  compact: (id: string, instructions?: string) => call<{ ok: boolean }>('POST', `/conversations/${id}/compact`, { instructions }),
  interrupt: (id: string) => call('POST', `/conversations/${id}/interrupt`),
  respond: (id: string, requestId: string, response: PermissionResponse) => call('POST', `/conversations/${id}/permissions/${encodeURIComponent(requestId)}`, response),
  settings: (id: string, patch: { mode?: string; model?: string; thinking?: string; fast?: boolean }) => call<ConversationSummary>('POST', `/conversations/${id}/settings`, patch),
  rewind: (id: string, messageId: string) => call<ConversationDetail>('POST', `/conversations/${id}/rewind`, { messageId }),
  remove: (id: string) => call('DELETE', `/conversations/${id}`),
}

export type HubServer = {
  name: string
  kind: 'upstream' | 'native'
  status: 'off' | 'starting' | 'connected' | 'failed' | 'needs_auth'
  error?: string
  enabled: boolean
  load: 'on-demand' | 'always'
  source?: string
  toolCount: number
  tools: Array<{ name: string; description?: string }>
  transport: { type: 'stdio'; command: string; env?: Record<string, string> } | { type: 'http'; url: string; headers?: Record<string, string> }
}
export type NewHubServer = { name: string; type: 'stdio' | 'http'; command?: string; env?: string; url?: string; headers?: string }

export const hubApi = {
  list: () => call<HubServer[]>('GET', '/hub/servers'),
  add: (input: NewHubServer) => call<HubServer>('POST', '/hub/servers', input),
  update: (name: string, patch: { enabled?: boolean; load?: HubServer['load'] }) => call<HubServer>('PATCH', `/hub/servers/${name}`, patch),
  remove: (name: string) => call<{ ok: true }>('DELETE', `/hub/servers/${name}`),
  refresh: () => call<HubServer[]>('POST', '/hub/refresh', {}),
  importAll: () => call<{ added: string[]; skipped: string[] }>('POST', '/hub/import', {}),
}
