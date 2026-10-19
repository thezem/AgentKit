import { CornerDownRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Transcript } from '@/lib/api'

/** Prompts waiting behind the running turn. Visible and withdrawable, never silent. */
export function Inbox({ inbox, onWithdraw }: { inbox: Transcript['inbox']; onWithdraw: (id: string) => void }) {
  if (!inbox.length) return null
  return (
    <ul className="mb-2 space-y-1">
      {inbox.map((entry) => (
        <li key={entry.id} className="group/inbox flex items-center gap-2 rounded-xl bg-secondary/60 py-1 pr-1 pl-3 text-[13.5px] text-muted-foreground">
          <CornerDownRight className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{entry.text}</span>
          <span className="shrink-0 text-xs">{entry.whenBusy === 'steer' ? 'steer queued' : 'queued'}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={() => onWithdraw(entry.id)}>
                <X className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Withdraw</TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ul>
  )
}
