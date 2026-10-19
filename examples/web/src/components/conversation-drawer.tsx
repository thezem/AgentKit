import { PanelLeft, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { ProviderLogo } from '@/components/provider-logo'
import type { ConversationSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

function when(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function ConversationDrawer({
  open,
  onOpenChange,
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversations: ConversationSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8">
          <PanelLeft className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-80 gap-0 p-0 sm:max-w-80">
        <SheetHeader className="flex-row items-center justify-between border-b px-4 py-3">
          <div>
            <SheetTitle className="text-sm">Conversations</SheetTitle>
            <SheetDescription className="sr-only">Your saved agent conversations</SheetDescription>
          </div>
          <Button variant="ghost" size="sm" className="mr-8 h-7 gap-1.5 text-xs" onClick={onNew}>
            <Plus className="size-3.5" /> New
          </Button>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-2">
          {conversations.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing yet. Start one from the composer.</p>}
          {conversations.map((c) => (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(c.id)}
              onKeyDown={(e) => e.key === 'Enter' && onSelect(c.id)}
              className={cn('group/row flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-150 hover:bg-accent', c.id === activeId && 'bg-accent')}
            >
              <ProviderLogo provider={c.provider} className="size-3.5 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{c.title}</p>
                <p className="truncate text-xs text-muted-foreground">{c.cwd.replace(/^\/home\/[^/]+/, '~')}</p>
              </div>
              {(c.status === 'running' || c.status === 'waiting_permission') && <span className={cn('size-1.5 shrink-0 rounded-full', c.status === 'waiting_permission' ? 'bg-waiting' : 'animate-pulse bg-muted-foreground')} />}
              <span className="shrink-0 text-xs text-muted-foreground group-hover/row:hidden">{when(c.updatedAt)}</span>
              <Button
                variant="ghost"
                size="icon"
                className="hidden size-6 group-hover/row:inline-flex"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(c.id)
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}
