import { Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PROVIDER_LABEL, ProviderLogo } from '@/components/provider-logo'
import type { ProviderCatalog, ProviderStatus } from '@/lib/api'

const trigger = 'h-8 gap-1.5 border-0 bg-transparent px-2 text-[13px] text-muted-foreground shadow-none hover:bg-accent hover:text-foreground dark:bg-transparent dark:hover:bg-accent'

export function ProviderPicker({ value, providers, onChange }: { value: string; providers: ProviderStatus[]; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={trigger}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {providers.map((p) => (
          <SelectItem key={p.provider} value={p.provider} disabled={!p.available}>
            <span className="flex items-center gap-2">
              <ProviderLogo provider={p.provider} />
              {PROVIDER_LABEL[p.provider] ?? p.label}
              {!p.available && <span className="text-xs text-muted-foreground">not installed</span>}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** OpenCode exposes hundreds of `provider/model` ids, so group them by upstream provider. */
export function ModelPicker({ value, catalog, onChange, disabled }: { value?: string; catalog?: ProviderCatalog; onChange: (v: string) => void; disabled?: boolean }) {
  const models = catalog?.models ?? []
  const fallback = models.find((m) => m.isDefault)?.id ?? models[0]?.id
  const current = value ?? fallback
  const groups = new Map<string, typeof models>()
  for (const model of models) {
    const slash = model.id.indexOf('/')
    const group = slash > 0 ? model.id.slice(0, slash) : ''
    groups.set(group, [...(groups.get(group) ?? []), model])
  }
  return (
    <Select value={current} onValueChange={onChange} disabled={disabled || !models.length}>
      <SelectTrigger className={trigger}>
        <SelectValue placeholder={catalog ? 'Model' : 'Loading models…'}>{models.find((m) => m.id === current)?.label ?? current}</SelectValue>
      </SelectTrigger>
      <SelectContent className="max-h-80">
        {[...groups.entries()].map(([group, items]) => (
          <SelectGroup key={group || 'all'}>
            {group && <SelectLabel>{group}</SelectLabel>}
            {items.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ModePicker({ value, catalog, onChange, disabled }: { value?: string; catalog?: ProviderCatalog; onChange: (v: string) => void; disabled?: boolean }) {
  const modes = catalog?.modes ?? []
  const current = value ?? catalog?.defaultModeId ?? modes[0]?.id
  if (!modes.length) return null
  return (
    <Select value={current ?? undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={trigger}>
        <SelectValue>{modes.find((m) => m.id === current)?.label ?? current}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {modes.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            <span className="flex flex-col">
              <span>{m.label}</span>
              {m.description && <span className="text-xs text-muted-foreground">{m.description}</span>}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ThinkingPicker({ value, model, catalog, onChange, disabled }: { value?: string; model?: string; catalog?: ProviderCatalog; onChange: (v: string) => void; disabled?: boolean }) {
  const models = catalog?.models ?? []
  const entry = models.find((m) => m.id === model) ?? models.find((m) => m.isDefault) ?? models[0]
  const options = entry?.thinkingOptions ?? []
  if (!options.length) return null
  const current = value ?? entry?.defaultThinkingOptionId ?? options.find((o) => o.isDefault)?.id
  return (
    <Select value={current ?? undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={trigger}>
        <SelectValue placeholder="Effort" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Shown only when the selected model has a fast tier. Tooltip uses the provider's own wording. */
export function FastToggle({ value, model, catalog, onChange, disabled }: { value?: boolean; model?: string; catalog?: ProviderCatalog; onChange: (v: boolean) => void; disabled?: boolean }) {
  const models = catalog?.models ?? []
  const entry = models.find((m) => m.id === model) ?? models.find((m) => m.isDefault) ?? models[0]
  if (!entry?.supportsFastMode) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-pressed={Boolean(value)}
          onClick={() => onChange(!value)}
          className={cn('h-8 gap-1 px-2 text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground', value && 'bg-accent text-foreground')}
        >
          <Zap className={cn('size-3.5', value && 'fill-current')} />
          Fast
        </Button>
      </TooltipTrigger>
      <TooltipContent>{value ? 'Fast mode on' : 'Fast mode'}{entry.fastModeDescription ? ` · ${entry.fastModeDescription}` : ''}</TooltipContent>
    </Tooltip>
  )
}
