import { useState } from 'react'
import { Hand, MessageCircleQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { PermissionRequest } from '@/lib/api'
import { cn } from '@/lib/utils'

type Respond = (response: { behavior: 'allow'; actionId?: string; answers?: Record<string, string | string[]> } | { behavior: 'deny'; actionId?: string; message?: string }) => Promise<void>

/** Short question; the preview block below carries the full command/diff. */
function headline(request: PermissionRequest): string {
  if (request.kind === 'plan') return 'Approve this plan?'
  const d = request.detail
  const file = (p: string) => p.split('/').pop() || p
  switch (d?.type) {
    case 'shell':
      return 'Run this command?'
    case 'edit':
      return `Edit ${file(d.filePath)}?`
    case 'write':
      return `Create ${file(d.filePath)}?`
    case 'read':
      return `Read ${file(d.filePath)}?`
    case 'fetch':
      return 'Fetch this URL?'
    default:
      return `Allow ${request.name}?`
  }
}

function preview(request: PermissionRequest): string | null {
  const d = request.detail
  if (!d) return request.description ?? null
  if (d.type === 'shell') return `$ ${d.command}`
  if (d.type === 'edit') return d.unifiedDiff ?? `${d.filePath}\n- ${d.oldString ?? ''}\n+ ${d.newString ?? ''}`
  if (d.type === 'write') return `${d.filePath}\n\n${d.content ?? ''}`
  if (d.type === 'read') return d.filePath
  if (d.type === 'fetch') return d.url
  if (d.type === 'plan') return d.text
  return request.description ?? null
}

/** The one accented surface in the app: the agent is blocked until you answer. */
export function PermissionCard({ request, onRespond }: { request: PermissionRequest; onRespond: Respond }) {
  const [busy, setBusy] = useState<string | null>(null)
  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }

  if (request.kind === 'question') return <QuestionCard request={request} onRespond={onRespond} />

  const text = preview(request)
  const actions = request.actions ?? [
    { id: 'once', label: 'Allow', behavior: 'allow' as const },
    { id: 'deny', label: 'Deny', behavior: 'deny' as const },
  ]
  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 rounded-xl border border-waiting/40 bg-waiting-soft p-4 duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)]">
      <div className="flex items-center gap-2 text-sm">
        <Hand className="size-4 shrink-0 text-waiting" />
        <span className="font-medium">{headline(request)}</span>
        <span className="ml-auto text-xs text-muted-foreground">{request.name}</span>
      </div>
      {request.description && request.detail && <p className="mt-1 text-sm text-muted-foreground">{request.description}</p>}
      {text && <pre className="mt-3 max-h-56 overflow-auto rounded-lg border bg-background/60 px-3 py-2 font-mono text-[12.5px] leading-5 whitespace-pre-wrap">{text}</pre>}
      <div className="mt-3 flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action.id}
            size="sm"
            variant={action.behavior === 'deny' ? 'ghost' : action.id === 'once' ? 'default' : 'secondary'}
            disabled={busy !== null}
            onClick={() => act(action.id, () => onRespond(action.behavior === 'allow' ? { behavior: 'allow', actionId: action.id } : { behavior: 'deny', actionId: action.id }))}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  )
}

function QuestionCard({ request, onRespond }: { request: PermissionRequest; onRespond: Respond }) {
  const questions = request.questions ?? []
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const toggle = (id: string, label: string, multi?: boolean) =>
    setAnswers((prev) => {
      const current = prev[id] ?? []
      if (!multi) return { ...prev, [id]: [label] }
      return { ...prev, [id]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label] }
    })
  const submit = async () => {
    setBusy(true)
    const out: Record<string, string | string[]> = {}
    for (const q of questions) {
      const picked = [...(answers[q.id] ?? []), ...(other[q.id]?.trim() ? [other[q.id].trim()] : [])]
      out[q.id] = q.multiSelect ? picked : (picked[0] ?? '')
    }
    try {
      await onRespond({ behavior: 'allow', answers: out })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 space-y-4 rounded-xl border border-waiting/40 bg-waiting-soft p-4 duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)]">
      <div className="flex items-center gap-2 text-sm font-medium">
        <MessageCircleQuestion className="size-4 shrink-0 text-waiting" />
        {request.title ?? 'The agent has a question'}
      </div>
      {questions.map((q) => (
        <div key={q.id} className="space-y-2">
          <p className="text-sm">{q.question}</p>
          {q.options && (
            <div className="flex flex-wrap gap-2">
              {q.options.map((option) => {
                const on = (answers[q.id] ?? []).includes(option.label)
                return (
                  <Button key={option.label} size="sm" variant={on ? 'default' : 'outline'} className={cn(!on && 'bg-transparent')} onClick={() => toggle(q.id, option.label, q.multiSelect)} title={option.description}>
                    {option.label}
                  </Button>
                )
              })}
            </div>
          )}
          {(q.allowOther || !q.options) && (
            <Textarea rows={1} placeholder={q.options ? 'Or type your own answer' : 'Your answer'} value={other[q.id] ?? ''} onChange={(e) => setOther((p) => ({ ...p, [q.id]: e.target.value }))} className="min-h-9 bg-background/60" />
          )}
        </div>
      ))}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={submit}>
          Answer
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRespond({ behavior: 'deny' })}>
          Skip
        </Button>
      </div>
    </div>
  )
}
