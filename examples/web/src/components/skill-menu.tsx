import { SquareSlash } from 'lucide-react'
import type { SkillSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

/** The `/` picker. Keyboard lives in the composer; this only renders and takes clicks. */
export function SkillMenu({ items, active, query, onPick, onHover }: { items: SkillSummary[]; active: number; query: string; onPick: (skill: SkillSummary) => void; onHover: (index: number) => void }) {
  return (
    <div role="listbox" className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-2xl border bg-popover p-1.5 text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-1 duration-150">
      {items.length === 0 ? (
        <p className="px-3 py-2.5 text-sm text-muted-foreground">No skill matches “{query}”</p>
      ) : (
        items.map((skill, index) => (
          <div
            key={skill.name}
            role="option"
            aria-selected={index === active}
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(skill)
            }}
            onMouseEnter={() => onHover(index)}
            className={cn('flex cursor-default items-start gap-2.5 rounded-xl px-3 py-2 transition-colors duration-100', index === active && 'bg-accent text-accent-foreground')}
          >
            <SquareSlash className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium">{skill.name}</span>
                {skill.scope !== 'user' && <span className="text-xs text-muted-foreground">{skill.scope}</span>}
              </div>
              <p className="line-clamp-1 text-[13px] text-muted-foreground">{skill.description}</p>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
