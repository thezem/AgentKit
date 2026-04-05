import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { readdir, readFile } from 'node:fs/promises'
import type { ActionDefinition, PromptActionDefinition, WorkflowActionDefinition } from './types.ts'

const ACTION_EXTENSIONS = new Set(['.md', '.ts', '.js', '.mjs'])

export async function listActions(actionsDir: string): Promise<ActionDefinition[]> {
  const entries = await readdir(actionsDir, { withFileTypes: true })
  const actions: ActionDefinition[] = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name)
    if (!ACTION_EXTENSIONS.has(ext)) continue

    const fullPath = path.join(actionsDir, entry.name)
    if (ext === '.md') {
      actions.push(await loadPromptAction(fullPath))
      continue
    }

    actions.push(await loadWorkflowAction(fullPath))
  }

  actions.sort((a, b) => a.name.localeCompare(b.name))
  return actions
}

export async function loadActionByName(actionsDir: string, name: string): Promise<ActionDefinition | null> {
  const actions = await listActions(actionsDir)
  return actions.find(action => action.name === name) ?? null
}

async function loadPromptAction(fullPath: string): Promise<PromptActionDefinition> {
  const raw = await readFile(fullPath, 'utf8')
  const name = path.basename(fullPath, path.extname(fullPath))
  const { description, prompt } = splitPromptHeader(raw)

  return {
    kind: 'prompt',
    name,
    path: fullPath,
    description,
    prompt,
  }
}

async function loadWorkflowAction(fullPath: string): Promise<WorkflowActionDefinition> {
  const moduleUrl = `${pathToFileURL(fullPath).href}?t=${Date.now()}`
  const loaded = (await import(moduleUrl)) as { default?: unknown }
  const candidate = loaded.default

  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`Action ${fullPath} must export a default object`)
  }

  const action = candidate as Partial<WorkflowActionDefinition>
  if (typeof action.name !== 'string' || typeof action.run !== 'function') {
    throw new Error(`Action ${fullPath} must export { name, run }`)
  }

  return {
    kind: 'workflow',
    name: action.name,
    description: typeof action.description === 'string' ? action.description : undefined,
    inputSchema: action.inputSchema,
    run: action.run,
  }
}

function splitPromptHeader(raw: string): { description: string | null; prompt: string } {
  const trimmed = raw.trim()
  const lines = trimmed.split(/\r?\n/)
  if (lines.length === 0) {
    return { description: null, prompt: '' }
  }

  const first = lines[0].trim()
  if (!first.startsWith('# ')) {
    return { description: null, prompt: trimmed }
  }

  const description = first.slice(2).trim() || null
  return {
    description,
    prompt: lines.slice(1).join('\n').trim(),
  }
}
