import { SquareSlash } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { findSkillTokens, splitSkillTags } from '../../../../src/skill-tags.ts'
import type { SkillSummary } from '@/lib/api'
import { cn } from '@/lib/utils'

/** One invoked skill, inline with the text around it. */
export function SkillChip({ name, description, className }: { name: string; description?: string; className?: string }) {
  const chip = (
    <span className={cn('mx-px inline-flex items-baseline gap-1 rounded-md bg-foreground/10 px-1.5 font-medium text-foreground', className)}>
      <SquareSlash className="size-3.5 shrink-0 translate-y-[2px] opacity-70" />
      {name}
    </span>
  )
  if (!description) return chip
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent className="max-w-80">{description}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A sent user message with its skills as chips. Claude/OpenCode messages carry
 * `<skill-invoked>` tags; Codex keeps `$name` in the text.
 */
export function SkillText({ text, skills }: { text: string; skills: Map<string, SkillSummary> }) {
  const parts: React.ReactNode[] = []
  splitSkillTags(text).forEach((segment, i) => {
    if (segment.type === 'skill') {
      parts.push(<SkillChip key={`t${i}`} name={segment.name} description={skills.get(segment.name)?.description} />)
      return
    }
    let last = 0
    for (const token of findSkillTokens(segment.text, (name) => skills.has(name))) {
      if (token.start > last) parts.push(segment.text.slice(last, token.start))
      parts.push(<SkillChip key={`d${i}-${token.start}`} name={token.name} description={skills.get(token.name)?.description} />)
      last = token.end
    }
    if (last < segment.text.length) parts.push(segment.text.slice(last))
  })
  return <>{parts}</>
}
