import { useCallback, useEffect, useState } from 'react'
import { Download, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { hubApi, type HubServer, type NewHubServer } from '@/lib/api'

const STATUS: Record<HubServer['status'], { label: string; className: string }> = {
  connected: { label: 'Connected', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  starting: { label: 'Starting', className: 'bg-muted text-muted-foreground' },
  off: { label: 'Off', className: 'bg-muted text-muted-foreground' },
  failed: { label: 'Failed', className: 'bg-red-500/15 text-red-600 dark:text-red-400' },
  needs_auth: { label: 'Needs auth', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
}

/** One hub, every provider: servers added here are exposed to Claude, Codex and OpenCode threads. */
export function McpSettings({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [servers, setServers] = useState<HubServer[]>([])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<'refresh' | 'import' | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(() => hubApi.list().then(setServers).catch(() => {}), [])

  useEffect(() => {
    if (!open) return
    load()
    const source = new EventSource('/api/hub/events')
    source.onmessage = (e) => {
      const event = JSON.parse(e.data)
      if (event.type === 'server') setServers((list) => (list.some((s) => s.name === event.server.name) ? list.map((s) => (s.name === event.server.name ? event.server : s)) : [...list, event.server]))
      if (event.type === 'removed') setServers((list) => list.filter((s) => s.name !== event.name))
    }
    return () => source.close()
  }, [open, load])

  const patch = async (name: string, change: { enabled?: boolean; load?: HubServer['load'] }) => {
    setServers((list) => list.map((s) => (s.name === name ? { ...s, ...change } : s)))
    await hubApi.update(name, change).catch(load)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="gap-1 px-5 pt-5 pb-3">
          <SheetTitle>MCP servers</SheetTitle>
          <SheetDescription>One list for every provider. New threads on Claude, Codex and OpenCode get exactly these servers.</SheetDescription>
        </SheetHeader>

        <div className="flex items-center gap-1 px-5 pb-3">
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add server
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy('import')
                  try {
                    const r = await hubApi.importAll()
                    setNote(r.added.length ? `Imported ${r.added.join(', ')}` : 'Nothing new to import')
                    load()
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                {busy === 'import' ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Import
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy servers from your Claude Code, Codex and OpenCode configs</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="ml-auto size-8"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy('refresh')
                  try {
                    setServers(await hubApi.refresh())
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                <RefreshCw className={busy === 'refresh' ? 'size-4 animate-spin' : 'size-4'} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reconnect and reload tools</TooltipContent>
          </Tooltip>
        </div>
        {note && <p className="px-5 pb-2 text-xs text-muted-foreground">{note}</p>}

        <div className="flex-1 overflow-y-auto px-3 pb-5">
          {servers.length === 0 && <p className="px-2 py-10 text-center text-sm text-muted-foreground">No servers yet. Add one, or import what your CLIs already use.</p>}
          {servers.map((s) => (
            <ServerRow key={s.name} server={s} onPatch={(c) => patch(s.name, c)} onRemove={async () => (await hubApi.remove(s.name), load())} />
          ))}
        </div>

        <AddServerDialog open={adding} onOpenChange={setAdding} onAdded={load} />
      </SheetContent>
    </Sheet>
  )
}

function ServerRow({ server: s, onPatch, onRemove }: { server: HubServer; onPatch: (c: { enabled?: boolean; load?: HubServer['load'] }) => void; onRemove: () => void }) {
  const status = STATUS[s.enabled ? s.status : 'off']
  const target = s.transport.type === 'stdio' ? s.transport.command : s.transport.url
  return (
    <div className="flex items-start gap-3 rounded-lg px-2 py-3 hover:bg-muted/40">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{s.name}</span>
          <Badge variant="secondary" className={`border-0 font-normal ${status.className}`}>
            {status.label}
          </Badge>
          {s.source && <span className="text-xs text-muted-foreground">{s.source === 'user' ? 'You' : `from ${s.source}`}</span>}
          {s.status === 'connected' && s.enabled && (
            <Tooltip>
              <TooltipTrigger className="text-xs text-muted-foreground tabular-nums">{s.toolCount} tools</TooltipTrigger>
              <TooltipContent className="max-w-72">{s.tools.map((t) => t.name).join(', ') || 'No tools'}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{s.kind === 'native' ? 'in-process tools' : target}</p>
        {s.error && s.enabled && <p className="mt-1 line-clamp-2 text-xs text-red-600 dark:text-red-400">{s.error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <ToggleGroup type="single" size="sm" variant="outline" value={s.load} onValueChange={(v) => v && onPatch({ load: v as HubServer['load'] })}>
                <ToggleGroupItem value="on-demand" className="px-2 text-xs">
                  On demand
                </ToggleGroupItem>
                <ToggleGroupItem value="always" className="px-2 text-xs">
                  Always
                </ToggleGroupItem>
              </ToggleGroup>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">Always loads the tool schemas up front (Claude). On demand lets the model search for them.</TooltipContent>
        </Tooltip>
        {s.kind === 'upstream' && (
          <Button size="icon" variant="ghost" className="size-8 text-muted-foreground" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        )}
        <Switch checked={s.enabled} onCheckedChange={(enabled) => onPatch({ enabled })} />
      </div>
    </div>
  )
}

function AddServerDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  const empty: NewHubServer = { name: '', type: 'stdio', command: '', env: '', url: '', headers: '' }
  const [form, setForm] = useState<NewHubServer>(empty)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = (change: Partial<NewHubServer>) => setForm((f) => ({ ...f, ...change }))
  const ready = form.name.trim() && (form.type === 'stdio' ? form.command?.trim() : form.url?.trim())

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      await hubApi.add(form)
      setForm(empty)
      onOpenChange(false)
      onAdded()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add an MCP server</DialogTitle>
          <DialogDescription>Saved to the AgentKit hub and shared with every provider.</DialogDescription>
        </DialogHeader>
        <Tabs value={form.type} onValueChange={(v) => set({ type: v as NewHubServer['type'] })}>
          <TabsList>
            <TabsTrigger value="stdio">Command (stdio)</TabsTrigger>
            <TabsTrigger value="http">Remote (HTTP)</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="mcp-name">Name</Label>
            <Input id="mcp-name" placeholder="my-server" value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </div>
          {form.type === 'stdio' ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="mcp-command">Command</Label>
                <Input id="mcp-command" className="font-mono" placeholder="npx -y @modelcontextprotocol/server-everything" value={form.command} onChange={(e) => set({ command: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mcp-env">Environment (optional, one KEY=value per line)</Label>
                <Textarea id="mcp-env" className="min-h-20 font-mono" placeholder="API_KEY=..." value={form.env} onChange={(e) => set({ env: e.target.value })} />
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="mcp-url">URL</Label>
                <Input id="mcp-url" className="font-mono" placeholder="https://example.com/mcp" value={form.url} onChange={(e) => set({ url: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mcp-headers">Headers (optional, one Name: value per line)</Label>
                <Textarea id="mcp-headers" className="min-h-20 font-mono" placeholder="Authorization: Bearer ..." value={form.headers} onChange={(e) => set({ headers: e.target.value })} />
              </div>
            </>
          )}
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!ready || saving} onClick={submit}>
            {saving && <Loader2 className="size-4 animate-spin" />} Add server
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
