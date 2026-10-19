import { useEffect, useMemo, useRef, useState } from 'react'
import { SkillMenu } from '@/components/skill-menu'
import { api, type SkillSummary } from '@/lib/api'
import { findSkillTokens } from '../../../../src/skill-tags.ts'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * Enter sends, Shift+Enter is a newline. While a turn runs, sending steers the
 * live turn when the provider can (AgentKit falls back to queueing).
 *
 * `/` at the start of a word opens the skill picker. Picking writes `$name` —
 * that's AgentKit's contract; a hand-typed `/name` stays plain text.
 */
export function Composer({
  running,
  canSteer,
  disabled,
  placeholder,
  footer,
  onSend,
  onStop,
  autoFocus,
  skills = [],
  cwd,
}: {
  running: boolean
  canSteer: boolean
  disabled?: boolean
  placeholder?: string
  footer?: React.ReactNode
  onSend: (text: string) => void
  onStop: () => void
  autoFocus?: boolean
  /** Installed skills (for chips) and the folder to search them in. */
  skills?: SkillSummary[]
  cwd?: string
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const [slash, setSlash] = useState<{ start: number; query: string } | null>(null)
  const [results, setResults] = useState<SkillSummary[]>([])
  const [active, setActive] = useState(0)
  const known = useMemo(() => new Set(skills.map((s) => s.name)), [skills])

  /** `/query` right before the caret, at a word start. */
  const detectSlash = (value: string, caret: number) => {
    const match = value.slice(0, caret).match(/(^|\s)\/([\w:.-]*)$/)
    setSlash(match && cwd ? { start: caret - match[2].length - 1, query: match[2] } : null)
  }
  useEffect(() => {
    if (!slash || !cwd) return
    let stale = false
    api.skills(cwd, slash.query).then((list) => {
      if (stale) return
      setResults(list)
      setActive(0)
    }, () => undefined)
    return () => {
      stale = true
    }
  }, [slash?.query, cwd]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (skill: SkillSummary) => {
    if (!slash) return
    const caret = slash.start + 1 + slash.query.length
    const insert = `$${skill.name} `
    const next = text.slice(0, slash.start) + insert + text.slice(caret).replace(/^ /, '')
    setText(next)
    setSlash(null)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.setSelectionRange(slash.start + insert.length, slash.start + insert.length)
    })
  }

  /** Same text as the textarea, with picked skills painted as chips underneath. */
  const highlighted = useMemo(() => {
    const out: React.ReactNode[] = []
    let last = 0
    for (const token of findSkillTokens(text, (name) => known.has(name))) {
      out.push(text.slice(last, token.start))
      out.push(
        <mark key={token.start} className="rounded-md bg-foreground/12 text-transparent ring-1 ring-foreground/10">
          {text.slice(token.start, token.end)}
        </mark>,
      )
      last = token.end
    }
    out.push(text.slice(last) + '\u200b')
    return out
  }, [text, known])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])
  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const send = () => {
    const value = text.trim()
    if (!value || disabled) return
    onSend(value)
    setText('')
    setSlash(null)
  }
  const menuOpen = slash !== null
  const hasText = text.trim().length > 0

  return (
    <div className="relative rounded-2xl border bg-card transition-colors duration-150 focus-within:border-foreground/20">
      {menuOpen && <SkillMenu items={results} active={active} query={slash.query} onPick={pick} onHover={setActive} />}
      <div className="relative">
      <div
        ref={mirror}
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden px-4 pt-3.5 pb-1 text-[15px] leading-6 break-words whitespace-pre-wrap text-transparent"
      >
        {highlighted}
      </div>
      <Textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={running ? (canSteer ? 'Steer the running turn…' : 'Queue a follow-up…') : (placeholder ?? 'Ask anything, / for skills')}
        onChange={(e) => {
          setText(e.target.value)
          detectSlash(e.target.value, e.target.selectionStart)
        }}
        onSelect={(e) => detectSlash(e.currentTarget.value, e.currentTarget.selectionStart)}
        onBlur={() => setSlash(null)}
        onScroll={(e) => mirror.current && (mirror.current.scrollTop = e.currentTarget.scrollTop)}
        onKeyDown={(e) => {
          if (menuOpen && results.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length)
              return
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) {
              e.preventDefault()
              pick(results[active])
              return
            }
          }
          if (menuOpen && e.key === 'Escape') {
            e.preventDefault()
            setSlash(null)
            return
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
        className="relative max-h-60 min-h-[52px] resize-none border-0 bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-6 shadow-none dark:bg-transparent"
      />
      </div>
      <div className="flex items-center gap-2 px-2.5 pb-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1">{footer}</div>
        {running && !hasText ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon" variant="secondary" className="size-8 rounded-full" onClick={onStop}>
                <Square className="size-3 fill-current" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Interrupt</TooltipContent>
          </Tooltip>
        ) : (
          <Button size="icon" className={cn('size-8 rounded-full transition-opacity duration-150', !hasText && 'opacity-40')} disabled={!hasText || disabled} onClick={send}>
            <ArrowUp className="size-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
