import type { AgentEvent, InboxEntry, PermissionRequest, TimelineItem, Usage } from '../capsules/shared/contract.ts'
import { appendTimeline } from '../capsules/shared/timeline.ts'

/**
 * A UI-ready projection of a session: the thing a chat view renders.
 * Pure reducer, so it works the same in a server, a worker, or a React store.
 *
 *   let state = emptyTranscript()
 *   session.on((event) => { state = reduceTranscript(state, event); render(state) })
 */
export interface Transcript {
  sessionId: string | null
  status: 'idle' | 'running' | 'waiting_permission' | 'failed'
  activeTurnId: string | null
  items: TimelineItem[]
  pendingPermissions: PermissionRequest[]
  usage: Usage | null
  lastError: string | null
  modeId: string | null
  model: string | null
  thinkingOptionId: string | null
  fast: boolean
  /** Prompts waiting behind the current turn. Withdraw with `session.withdraw(id)`. */
  inbox: InboxEntry[]
}

export function emptyTranscript(): Transcript {
  return {
    sessionId: null,
    status: 'idle',
    activeTurnId: null,
    items: [],
    pendingPermissions: [],
    usage: null,
    lastError: null,
    modeId: null,
    model: null,
    thinkingOptionId: null,
    fast: false,
    inbox: [],
  }
}

export function reduceTranscript(state: Transcript, event: AgentEvent): Transcript {
  switch (event.type) {
    case 'session_started':
      return { ...state, sessionId: event.sessionId }
    case 'turn_started':
      return { ...state, status: 'running', activeTurnId: event.turnId, lastError: null }
    case 'turn_completed':
      return { ...state, status: 'idle', activeTurnId: null, pendingPermissions: [], usage: event.usage ?? state.usage }
    case 'turn_canceled':
      return { ...state, status: 'idle', activeTurnId: null, pendingPermissions: [] }
    case 'turn_failed':
      return { ...state, status: 'failed', activeTurnId: null, pendingPermissions: [], lastError: event.error }
    case 'timeline': {
      const items = state.items.slice()
      appendTimeline(items, event.item)
      return { ...state, items }
    }
    case 'usage':
      return { ...state, usage: { ...state.usage, ...event.usage } }
    case 'permission_requested':
      return { ...state, status: 'waiting_permission', pendingPermissions: [...state.pendingPermissions, event.request] }
    case 'permission_resolved': {
      const pendingPermissions = state.pendingPermissions.filter((request) => request.id !== event.requestId)
      return { ...state, pendingPermissions, status: pendingPermissions.length === 0 && state.activeTurnId ? 'running' : state.status }
    }
    case 'mode_changed':
      return { ...state, modeId: event.modeId }
    case 'model_changed':
      return { ...state, model: event.model }
    case 'thinking_changed':
      return { ...state, thinkingOptionId: event.thinkingOptionId }
    case 'fast_changed':
      return { ...state, fast: event.enabled }
    case 'inbox_changed':
      return { ...state, inbox: event.inbox }
    case 'turn_interrupted': {
      const items = state.items.slice()
      appendTimeline(items, { type: 'notice', level: 'warning', message: 'Interrupted: the process exited mid-turn. Everything above was saved; nothing was re-sent.' })
      return { ...state, items, status: 'idle', activeTurnId: null, pendingPermissions: [] }
    }
  }
}
