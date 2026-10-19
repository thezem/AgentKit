import { useState } from 'react'
import { Check, ChevronRight, CircleDashed, FilePen, FilePlus, FileText, Globe, ListChecks, LoaderCircle, Map as MapIcon, Plug, Search, SquareTerminal, Users, Wrench, X } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { ToolCallItem, ToolDetail } from '@/lib/api'
import { cn } from '@/lib/utils'

const ICONS: Record<ToolDetail['type'], typeof Wrench> = {
  shell: SquareTerminal,
  read: FileText,
  edit: FilePen,
  write: FilePlus,
  search: Search,
  fetch: Globe,
  mcp: Plug,
  sub_agent: Users,
  plan: MapIcon,
  todo: ListChecks,
  unknown: Wrench,
}

function shortPath(path: string) {
  const parts = path.split('/')
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path
}

/** One-line summary per typed detail: this is what AgentKit's typed tool calls buy a UI. */
function summarize(detail: ToolDetail, name: string): { verb: string; target: string } {
  switch (detail.type) {
    case 'shell':
      return { verb: 'Ran', target: detail.command }
    case 'read':
      return { verb: 'Read', target: shortPath(detail.filePath) }
    case 'edit':
      return { verb: 'Edited', target: shortPath(detail.filePath) }
    case 'write':
      return { verb: 'Wrote', target: shortPath(detail.filePath) }
    case 'search':
      return { verb: detail.kind === 'web' ? 'Searched the web' : 'Searched', target: detail.query }
    case 'fetch':
      return { verb: 'Fetched', target: detail.url }
    case 'mcp':
      return { verb: detail.server, target: detail.tool }
    case 'sub_agent':
      return { verb: 'Delegated', target: detail.description ?? detail.subAgentType ?? 'subagent' }
    case 'plan':
      return { verb: 'Proposed a plan', target: '' }
    case 'todo':
      return { verb: 'Updated todos', target: `${detail.items.filter((i) => i.status === 'completed').length}/${detail.items.length} done` }
    default:
      return { verb: name, target: '' }
  }
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto font-mono text-[12.5px] leading-5">
      {text.split('\n').map((line, i) => (
        <div
          key={i}
          className={cn(
            'px-3',
            line.startsWith('+') && !line.startsWith('+++') && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
            line.startsWith('-') && !line.startsWith('---') && 'bg-red-500/10 text-red-700 dark:text-red-300',
            line.startsWith('@@') && 'text-muted-foreground',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

function Body({ item }: { item: ToolCallItem }) {
  const d = item.detail
  const block = (text?: string) =>
    text ? <pre className="max-h-80 overflow-auto px-3 py-2 font-mono text-[12.5px] leading-5 whitespace-pre-wrap text-muted-foreground">{text}</pre> : null
  switch (d.type) {
    case 'shell':
      return (
        <>
          <pre className="overflow-x-auto px-3 pt-2 font-mono text-[12.5px] leading-5">
            <span className="text-muted-foreground select-none">$ </span>
            {d.command}
          </pre>
          {block(d.output)}
          {d.exitCode != null && d.exitCode !== 0 && <p className="px-3 pb-2 text-xs text-destructive">exit {d.exitCode}</p>}
        </>
      )
    case 'edit':
      if (d.unifiedDiff) return <Diff text={d.unifiedDiff} />
      return <Diff text={[...(d.oldString ?? '').split('\n').map((l) => `-${l}`), ...(d.newString ?? '').split('\n').map((l) => `+${l}`)].join('\n')} />
    case 'write':
      return block(d.content)
    case 'read':
      return block(d.content)
    case 'search':
    case 'fetch':
      return block(d.output)
    case 'plan':
      return block(d.text)
    case 'todo':
      return (
        <ul className="space-y-1 px-3 py-2 text-sm">
          {d.items.map((todo, i) => (
            <li key={i} className={cn('flex items-start gap-2', todo.status === 'completed' && 'text-muted-foreground line-through')}>
              {todo.status === 'completed' ? <Check className="mt-0.5 size-3.5" /> : todo.status === 'in_progress' ? <LoaderCircle className="mt-0.5 size-3.5 animate-spin" /> : <CircleDashed className="mt-0.5 size-3.5" />}
              {todo.text}
            </li>
          ))}
        </ul>
      )
    case 'mcp':
      return block(JSON.stringify({ input: d.input, output: d.output }, null, 2))
    case 'sub_agent':
      return block(d.output)
    default:
      return block(JSON.stringify((d as { input?: unknown }).input ?? d, null, 2))
  }
}

export function ToolCall({ item }: { item: ToolCallItem }) {
  const [open, setOpen] = useState(item.detail.type === 'todo' || item.detail.type === 'edit')
  const Icon = ICONS[item.detail.type] ?? Wrench
  const { verb, target } = summarize(item.detail, item.name)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="group/tool">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left text-[13.5px] text-muted-foreground transition-colors duration-150 hover:text-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span className="shrink-0 text-foreground/80">{verb}</span>
        {target && <span className="truncate font-mono text-[12.5px]">{target}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {item.status === 'running' && <LoaderCircle className="size-3.5 animate-spin" />}
          {item.status === 'failed' && <X className="size-3.5 text-destructive" />}
          {item.status === 'canceled' && <X className="size-3.5" />}
          <ChevronRight className={cn('size-3.5 transition-transform duration-[250ms] ease-[cubic-bezier(0.22,1,0.36,1)]', open && 'rotate-90')} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div className="mt-1 mb-2 overflow-hidden rounded-lg border bg-code">
          <Body item={item} />
          {item.error && item.status === 'failed' && <p className="border-t px-3 py-2 text-xs text-destructive">{item.error}</p>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
