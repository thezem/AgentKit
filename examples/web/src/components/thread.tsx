import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertTriangle, Brain, ChevronRight, GitBranch, History, Info, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Markdown } from '@/components/markdown'
import { PermissionCard } from '@/components/permission-card'
import { ToolCall } from '@/components/tool-call'
import { SkillText } from '@/components/skill-chip'
import type { PermissionRequest, SkillSummary, TimelineItem, Transcript } from '@/lib/api'
import { cn } from '@/lib/utils'

type Block = { kind: 'item'; item: TimelineItem; index: number } | { kind: 'tools'; items: Extract<TimelineItem, { type: 'tool_call' }>[]; index: number }

/** Consecutive tool calls collapse into one quiet run so prose stays readable. */
function toBlocks(items: TimelineItem[]): Block[] {
  const blocks: Block[] = []
  items.forEach((item, index) => {
    if (item.type === 'tool_call') {
      const last = blocks.at(-1)
      if (last?.kind === 'tools') last.items.push(item)
      else blocks.push({ kind: 'tools', items: [item], index })
    } else if (item.type !== 'todo') blocks.push({ kind: 'item', item, index })
  })
  return blocks
}

function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-[13.5px] text-muted-foreground transition-colors duration-150 hover:text-foreground">
        <Brain className={cn('size-3.5', live && 'animate-pulse')} />
        {live ? 'Thinking' : 'Thought'}
        <ChevronRight className={cn('size-3.5 transition-transform duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)]', open && 'rotate-90')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <p className="mt-2 text-sm leading-6 whitespace-pre-wrap text-muted-foreground">{text}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

function UserMessage({ text, skills, canRewind, onRewind, canFork, onFork }: { text: string; skills: Map<string, SkillSummary>; canRewind: boolean; onRewind?: () => void; canFork: boolean; onFork?: () => void }) {
  return (
    <div className="group/user flex items-start justify-end gap-1">
      {canFork && onFork && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100" onClick={onFork}>
              <GitBranch className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Fork from before this message</TooltipContent>
        </Tooltip>
      )}
      {canRewind && onRewind && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100" onClick={onRewind}>
              <History className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Rewind to before this message</TooltipContent>
        </Tooltip>
      )}
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-[15px] leading-7 whitespace-pre-wrap">
        <SkillText text={text} skills={skills} />
      </div>
    </div>
  )
}

export function Thread({
  transcript,
  canRewind,
  onRewind,
  canFork,
  onFork,
  onRespond,
  skills,
}: {
  skills: Map<string, SkillSummary>
  transcript: Transcript
  canRewind: boolean
  onRewind: (messageId: string, text: string) => void
  canFork: boolean
  onFork: (messageId: string) => void
  onRespond: (request: PermissionRequest, response: Parameters<React.ComponentProps<typeof PermissionCard>['onRespond']>[0]) => Promise<void>
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const blocks = toBlocks(transcript.items)
  const firstUser = transcript.items.findIndex((item) => item.type === 'user_message')
  const running = transcript.status === 'running' || transcript.status === 'waiting_permission'
  const last = transcript.items.at(-1)
  const latestTodo = [...transcript.items].reverse().find((item) => item.type === 'todo')

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = () => (pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80)
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !pinned.current) return
    el.scrollTop = el.scrollHeight
    // Markdown/code can grow after the first paint; settle once more on the next frame.
    const frame = requestAnimationFrame(() => pinned.current && (el.scrollTop = el.scrollHeight))
    return () => cancelAnimationFrame(frame)
  })

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[46rem] space-y-6 px-5 pt-8 pb-10">
        {blocks.map((block) => {
          if (block.kind === 'tools')
            return (
              <div key={`t${block.index}`} className="space-y-0.5">
                {block.items.map((item) => (
                  <ToolCall key={item.callId} item={item} />
                ))}
              </div>
            )
          const item = block.item
          const key = `i${block.index}`
          switch (item.type) {
            case 'user_message':
              return <UserMessage key={key} text={item.text} skills={skills} canRewind={canRewind && !running && Boolean(item.messageId)} onRewind={() => item.messageId && onRewind(item.messageId, item.text)} canFork={canFork && !running && Boolean(item.messageId) && block.index !== firstUser} onFork={() => item.messageId && onFork(item.messageId)} />
            case 'assistant_message':
              return <Markdown key={key} text={item.text} />
            case 'reasoning':
              return <Reasoning key={key} text={item.text} live={running && item === last} />
            case 'compaction':
              return (
                <p key={key} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Layers className="size-3.5" /> {item.status === 'running' ? 'Compacting context…' : 'Context compacted'}
                </p>
              )
            case 'error':
              return (
                <p key={key} className="flex items-start gap-2 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {item.message}
                </p>
              )
            case 'notice':
              return (
                <p key={key} className="flex items-start gap-2 text-sm text-muted-foreground">
                  {item.level === 'info' ? <Info className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />} {item.message}
                </p>
              )
            default:
              return null
          }
        })}

        {latestTodo?.type === 'todo' && running && (
          <div className="rounded-lg border bg-card px-4 py-3 text-sm">
            {latestTodo.items.map((todo, i) => (
              <div key={i} className={cn('py-0.5', todo.status === 'completed' && 'text-muted-foreground line-through', todo.status === 'in_progress' && 'font-medium')}>
                {todo.text}
              </div>
            ))}
          </div>
        )}

        {transcript.pendingPermissions.map((request) => (
          <PermissionCard key={request.id} request={request} onRespond={(response) => onRespond(request, response)} />
        ))}

        {running && transcript.pendingPermissions.length === 0 && last?.type !== 'assistant_message' && (
          <div className="flex items-center gap-1.5 pt-1" aria-label="Working">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60" style={{ animationDelay: `${i * 160}ms` }} />
            ))}
          </div>
        )}

        {transcript.status === 'failed' && transcript.lastError && (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {transcript.lastError}
          </p>
        )}
      </div>
    </div>
  )
}
