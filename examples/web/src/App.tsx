import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, Moon, Plus, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Composer } from '@/components/composer'
import { ConversationDrawer } from '@/components/conversation-drawer'
import { ModelPicker, ModePicker, ProviderPicker, ThinkingPicker } from '@/components/pickers'
import { PROVIDER_LABEL, ProviderLogo } from '@/components/provider-logo'
import { Thread } from '@/components/thread'
import { api, type ConversationSummary, type ProviderCatalog, type ProviderStatus } from '@/lib/api'
import { useConversation } from '@/lib/use-conversation'

function useHashRoute(): [string | null, (id: string | null) => void] {
  const read = () => window.location.hash.match(/^#\/c\/([\w-]+)/)?.[1] ?? null
  const [id, setId] = useState(read)
  useEffect(() => {
    const on = () => setId(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return [id, (next) => (window.location.hash = next ? `/c/${next}` : '/')]
}

function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem('theme') !== 'light')
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  }, [dark])
  return [dark, () => setDark((d) => !d)] as const
}

function formatUsage(usage: { inputTokens?: number; outputTokens?: number; totalCostUsd?: number; contextWindowUsedTokens?: number; contextWindowMaxTokens?: number } | null) {
  if (!usage) return null
  const k = (n?: number) => (n == null ? '–' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
  const parts = []
  if (usage.contextWindowUsedTokens && usage.contextWindowMaxTokens) parts.push(`${Math.round((usage.contextWindowUsedTokens / usage.contextWindowMaxTokens) * 100)}% context`)
  else parts.push(`${k(usage.inputTokens)} in · ${k(usage.outputTokens)} out`)
  if (usage.totalCostUsd) parts.push(`$${usage.totalCostUsd.toFixed(3)}`)
  return parts.join(' · ')
}

export default function App() {
  const [activeId, navigate] = useHashRoute()
  const [dark, toggleTheme] = useTheme()
  const [drawer, setDrawer] = useState(false)
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [catalogs, setCatalogs] = useState<Record<string, ProviderCatalog>>({})
  const [catalogError, setCatalogError] = useState<string | null>(null)

  // New-conversation draft (persisted so a refresh keeps your choice).
  const [draft, setDraft] = useState(() => JSON.parse(localStorage.getItem('draft') ?? 'null') ?? { provider: 'claude', cwd: '', model: undefined, mode: undefined, thinking: undefined })
  useEffect(() => localStorage.setItem('draft', JSON.stringify(draft)), [draft])

  const { detail, setDetail, transcript, error, setError } = useConversation(activeId)

  const refreshList = useCallback(() => api.conversations().then(setConversations).catch(() => undefined), [])
  useEffect(() => {
    api.providers().then((list) => {
      setProviders(list)
      if (!list.find((p) => p.provider === draft.provider)?.available) {
        const first = list.find((p) => p.available && p.provider !== 'mock') ?? list.find((p) => p.available)
        if (first) setDraft((d: typeof draft) => ({ ...d, provider: first.provider, model: undefined, mode: undefined, thinking: undefined }))
      }
    })
    api.defaults().then(({ cwd }) => setDraft((d: typeof draft) => (d.cwd ? d : { ...d, cwd })))
    refreshList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    refreshList()
  }, [transcript.status, activeId, refreshList])

  const provider = detail?.provider ?? draft.provider
  useEffect(() => {
    if (!provider || catalogs[provider]) return
    setCatalogError(null)
    api.catalog(provider).then(
      (catalog) => setCatalogs((c) => ({ ...c, [provider]: catalog })),
      (e) => setCatalogError(e.message),
    )
  }, [provider, catalogs])
  const catalog = catalogs[provider]
  const capabilities = detail?.capabilities ?? providers.find((p) => p.provider === provider)?.capabilities
  const running = transcript.status === 'running' || transcript.status === 'waiting_permission'

  const settings = activeId ? { model: detail?.model, mode: detail?.mode, thinking: detail?.thinking } : { model: draft.model, mode: draft.mode, thinking: draft.thinking }
  const change = async (patch: { model?: string; mode?: string; thinking?: string }) => {
    if (!activeId) return setDraft((d: typeof draft) => ({ ...d, ...patch, ...(patch.model ? { thinking: undefined } : {}) }))
    setDetail((d) => d && { ...d, ...patch })
    try {
      await api.settings(activeId, patch)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const send = async (text: string) => {
    setError(null)
    try {
      if (!activeId) {
        const conv = await api.create({ provider: draft.provider, cwd: draft.cwd, model: draft.model, mode: draft.mode, thinking: draft.thinking })
        navigate(conv.id)
        await api.send(conv.id, text)
        refreshList()
        return
      }
      if (running && capabilities?.steer) await api.steer(activeId, text)
      else await api.send(activeId, text)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const footer = (
    <>
      {!activeId && <ProviderPicker value={draft.provider} providers={providers} onChange={(p) => setDraft((d: typeof draft) => ({ ...d, provider: p, model: undefined, mode: undefined, thinking: undefined }))} />}
      <ModelPicker value={settings.model} catalog={catalog} onChange={(model) => change({ model })} disabled={activeId ? !capabilities?.modelSwitch : false} />
      <ThinkingPicker value={settings.thinking} model={settings.model} catalog={catalog} onChange={(thinking) => change({ thinking })} disabled={activeId ? !capabilities?.thinkingSwitch : false} />
      <ModePicker value={settings.mode} catalog={catalog} onChange={(mode) => change({ mode })} disabled={activeId ? !capabilities?.modeSwitch : false} />
    </>
  )
  const usage = useMemo(() => formatUsage(transcript.usage), [transcript.usage])

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3">
          <ConversationDrawer
            open={drawer}
            onOpenChange={setDrawer}
            conversations={conversations}
            activeId={activeId}
            onSelect={(id) => {
              navigate(id)
              setDrawer(false)
            }}
            onNew={() => {
              navigate(null)
              setDrawer(false)
            }}
            onDelete={async (id) => {
              await api.remove(id)
              if (id === activeId) navigate(null)
              refreshList()
            }}
          />
          {detail && (
            <div className="flex min-w-0 items-center gap-2">
              <ProviderLogo provider={detail.provider} />
              <span className="truncate text-sm font-medium">{detail.title}</span>
              <span className="hidden max-w-64 truncate text-xs text-muted-foreground md:inline">{detail.cwd.replace(/^\/home\/[^/]+/, '~')}</span>
            </div>
          )}
          <div className="ml-auto flex items-center gap-1">
            {usage && <span className="mr-2 hidden text-xs whitespace-nowrap text-muted-foreground tabular-nums lg:inline">{usage}</span>}
            {activeId && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8" onClick={() => navigate(null)}>
                    <Plus className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New conversation</TooltipContent>
              </Tooltip>
            )}
            <Button variant="ghost" size="icon" className="size-8" onClick={toggleTheme}>
              {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
          </div>
        </header>

        {activeId ? (
          <>
            <Thread
              transcript={transcript}
              canRewind={Boolean(capabilities?.rewindConversation)}
              onRewind={async (messageId) => {
                try {
                  const next = await api.rewind(activeId, messageId)
                  setDetail(next)
                } catch (e) {
                  setError((e as Error).message)
                }
              }}
              onRespond={async (request, response) => {
                await api.respond(activeId, request.id, response).catch((e) => setError(e.message))
              }}
            />
            <div className="mx-auto w-full max-w-[46rem] shrink-0 px-5 pb-5">
              {error && <p className="mb-2 text-sm text-destructive">{error}</p>}
              <Composer running={running} canSteer={Boolean(capabilities?.steer)} onSend={send} onStop={() => api.interrupt(activeId)} footer={footer} autoFocus />
            </div>
          </>
        ) : (
          <main className="flex flex-1 flex-col items-center justify-center px-5 pb-[12vh]">
            <div className="w-full max-w-[42rem]">
              <h1 className="mb-1 text-[26px] font-semibold tracking-tight">What should {PROVIDER_LABEL[draft.provider] ?? draft.provider} work on?</h1>
              <p className="mb-6 text-sm text-muted-foreground">Runs on your local sign-in. Same controls for every agent.</p>
              <Composer running={false} canSteer={false} onSend={send} onStop={() => undefined} footer={footer} autoFocus placeholder="Describe a task, ask about the code…" />
              <div className="mt-3 flex items-center gap-2 text-muted-foreground">
                <FolderOpen className="size-4 shrink-0" />
                <Input value={draft.cwd} onChange={(e) => setDraft((d: typeof draft) => ({ ...d, cwd: e.target.value }))} className="h-8 border-0 bg-transparent px-1 text-[13px] shadow-none dark:bg-transparent" placeholder="/path/to/project" />
              </div>
              {(catalogError || error) && <p className="mt-3 text-sm text-destructive">{catalogError ?? error}</p>}
            </div>
          </main>
        )}
      </div>
    </TooltipProvider>
  )
}
