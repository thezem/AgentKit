import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * Enter sends, Shift+Enter is a newline. While a turn runs, sending steers the
 * live turn when the provider can (AgentKit falls back to queueing).
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
}: {
  running: boolean
  canSteer: boolean
  disabled?: boolean
  placeholder?: string
  footer?: React.ReactNode
  onSend: (text: string) => void
  onStop: () => void
  autoFocus?: boolean
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

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
  }
  const hasText = text.trim().length > 0

  return (
    <div className="rounded-2xl border bg-card transition-colors duration-150 focus-within:border-foreground/20">
      <Textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={running ? (canSteer ? 'Steer the running turn…' : 'Queue a follow-up…') : (placeholder ?? 'Ask anything…')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
        className="max-h-60 min-h-[52px] border-0 bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-6 shadow-none dark:bg-transparent"
      />
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
