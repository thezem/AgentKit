import { useEffect, useState } from 'react'
import { emptyTranscript, reduceTranscript } from '../../../../src/transcript.ts'
import { api, type AgentEvent, type ConversationDetail, type Transcript } from './api'

/**
 * Live transcript for one conversation: snapshot over SSE, then AgentKit's own
 * `reduceTranscript` applied in the browser to every event. Same reducer as the server.
 */
export function useConversation(id: string | null) {
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDetail(null)
    setTranscript(emptyTranscript())
    setError(null)
    if (!id) return
    let alive = true
    api.conversation(id).then((d) => alive && setDetail(d), (e) => alive && setError(e.message))
    const source = new EventSource(`/api/conversations/${id}/events`)
    source.onmessage = (message) => {
      const payload = JSON.parse(message.data) as { type: 'snapshot'; transcript: Transcript } | { type: 'event'; event: AgentEvent } | { type: 'error'; message: string }
      if (payload.type === 'snapshot') setTranscript(payload.transcript)
      else if (payload.type === 'event') {
        setTranscript((state) => reduceTranscript(state, payload.event))
        const e = payload.event
        if (e.type === 'mode_changed') setDetail((d) => d && { ...d, mode: e.modeId ?? undefined })
        if (e.type === 'model_changed') setDetail((d) => d && { ...d, model: e.model ?? undefined })
        if (e.type === 'thinking_changed') setDetail((d) => d && { ...d, thinking: e.thinkingOptionId ?? undefined })
        if (e.type === 'fast_changed') setDetail((d) => d && { ...d, fast: e.enabled })
      } else setError(payload.message)
    }
    return () => {
      alive = false
      source.close()
    }
  }, [id])

  return { detail, setDetail, transcript, error, setError }
}
