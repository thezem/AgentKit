import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NativeSkill, PromptBlock, PromptInput, ProviderId } from '../capsules/shared/contract.ts'
import { findSkillTokens, replaceSkillTokens, skillTag } from './skill-tags.ts'

/**
 * Skill discovery across every agent's folders, deduped into one list.
 *
 * Where each CLI looks (checked on a real machine against `commands()` / `skills/list`):
 *   claude    ~/.claude/skills, <project>/.claude/skills (top level only), installed plugins
 *   opencode  .claude/skills, .agents/skills, .codex/skills (incl. .system), .opencode/skill(s), ~/.config/opencode/skill(s); nested too
 *   codex     authoritative: its own `skills/list` (adds nested, system, plugin; drops disabled)
 */
export type SkillSource = 'agents' | 'claude' | 'codex' | 'opencode' | 'plugin' | 'system'

export interface Skill {
  name: string
  description: string
  /** The SKILL.md that wins (project beats user beats plugin). */
  path: string
  /** Its folder: scripts and references live here. */
  dir: string
  scope: 'project' | 'user' | 'plugin' | 'system'
  /** Every folder family a copy was found in. */
  sources: SkillSource[]
  /** Providers whose CLI loads it natively. AgentKit can still invoke it on the others (by path). */
  visibleTo: ProviderId[]
  /** The exact file each native-listing provider reported (Codex), for its native skill item. */
  nativePaths?: Partial<Record<ProviderId, string>>
  /** Other copies of the same name. `sameContent: false` = drifted. */
  variants?: Array<{ path: string; source: SkillSource; scope: Skill['scope']; sameContent: boolean }>
}

interface Root {
  dir: string
  source: SkillSource
  scope: Skill['scope']
  visibleTo: ProviderId[]
  /** Claude only loads `<root>/<name>/SKILL.md`; the others also find nested skills. */
  depth: number
}

interface Found {
  name: string
  description: string
  path: string
  source: SkillSource
  scope: Skill['scope']
  visibleTo: ProviderId[]
  hash: string
  nativeFor?: ProviderId
}

const SCOPE_RANK: Record<Skill['scope'], number> = { project: 0, user: 1, plugin: 2, system: 3 }
const SOURCE_RANK: Record<SkillSource, number> = { agents: 0, claude: 1, codex: 2, opencode: 3, plugin: 4, system: 5 }

/** Folders between cwd and the git root (or home), nearest first. */
function projectDirs(cwd: string): string[] {
  const dirs: string[] = []
  const home = os.homedir()
  let current = path.resolve(cwd)
  while (current !== home) {
    dirs.push(current)
    if (existsSync(path.join(current, '.git'))) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return dirs
}

function roots(cwd: string | undefined): Root[] {
  const home = os.homedir()
  const list: Root[] = []
  for (const dir of cwd ? projectDirs(cwd) : []) {
    list.push(
      { dir: path.join(dir, '.agents/skills'), source: 'agents', scope: 'project', visibleTo: ['codex', 'opencode'], depth: 5 },
      { dir: path.join(dir, '.claude/skills'), source: 'claude', scope: 'project', visibleTo: ['claude', 'opencode'], depth: 1 },
      { dir: path.join(dir, '.codex/skills'), source: 'codex', scope: 'project', visibleTo: ['codex', 'opencode'], depth: 5 },
      { dir: path.join(dir, '.opencode/skill'), source: 'opencode', scope: 'project', visibleTo: ['opencode'], depth: 5 },
      { dir: path.join(dir, '.opencode/skills'), source: 'opencode', scope: 'project', visibleTo: ['opencode'], depth: 5 },
    )
  }
  list.push(
    { dir: path.join(home, '.agents/skills'), source: 'agents', scope: 'user', visibleTo: ['codex', 'opencode'], depth: 5 },
    { dir: path.join(home, '.claude/skills'), source: 'claude', scope: 'user', visibleTo: ['claude', 'opencode'], depth: 1 },
    { dir: path.join(home, '.codex/skills'), source: 'codex', scope: 'user', visibleTo: ['codex', 'opencode'], depth: 5 },
    { dir: path.join(home, '.config/opencode/skill'), source: 'opencode', scope: 'user', visibleTo: ['opencode'], depth: 5 },
    { dir: path.join(home, '.config/opencode/skills'), source: 'opencode', scope: 'user', visibleTo: ['opencode'], depth: 5 },
  )
  // Claude plugins count only when installed (the marketplace folder is just a catalog).
  for (const dir of installedClaudePluginDirs(home)) list.push({ dir: path.join(dir, 'skills'), source: 'plugin', scope: 'plugin', visibleTo: ['claude'], depth: 1 })
  return list
}

function installedClaudePluginDirs(home: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(path.join(home, '.claude/plugins/installed_plugins.json'), 'utf8'))
    const entries: any[] = Object.values(raw.plugins ?? raw).flat()
    return entries.map((e) => e?.installPath).filter((p): p is string => typeof p === 'string')
  } catch {
    return []
  }
}

function scan(root: Root, out: Found[]): void {
  const walk = (dir: string, level: number) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.startsWith('.') && entry !== '.system') continue
      const child = path.join(dir, entry)
      try {
        if (!statSync(child).isDirectory()) continue
      } catch {
        continue
      }
      const file = path.join(child, 'SKILL.md')
      if (existsSync(file)) {
        const parsed = readSkill(file, entry)
        if (parsed) out.push({ ...parsed, path: file, source: root.source, scope: root.scope, visibleTo: [...root.visibleTo] })
      }
      // Codex/OpenCode also find skills nested inside another skill's folder (microsoft-foundry/models/deploy-model).
      if (level < root.depth) walk(child, level + 1)
    }
  }
  walk(root.dir, 1)
}

function readSkill(file: string, fallbackName: string): { name: string; description: string; hash: string } | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const front = parseFrontmatter(raw)
  return {
    name: (front.name || fallbackName).trim(),
    description: (front.description ?? '').trim(),
    hash: createHash('sha1').update(raw.replace(/\r\n/g, '\n').trim()).digest('hex'),
  }
}

/** Just enough YAML for `name` / `description`: plain, quoted, and `>` / `|` block scalars. */
export function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const out: Record<string, string> = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!kv) continue
    let value = kv[2].trim()
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim())
      value = value.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ') : block.join('\n')
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'")
    }
    out[kv[1]] = value.trim()
  }
  return out
}

/**
 * Merge a filesystem scan with providers' native lists (Codex `skills/list`).
 * Native lists are authoritative for their provider's `visibleTo`.
 */
export function discoverSkills(options: { cwd?: string; native?: Partial<Record<ProviderId, NativeSkill[]>> } = {}): Skill[] {
  const found: Found[] = []
  for (const root of roots(options.cwd)) scan(root, found)

  for (const [provider, list] of Object.entries(options.native ?? {})) {
    if (!list) continue
    const enabled = new Set(list.filter((s) => s.enabled !== false).map((s) => s.name))
    // The native list replaces our guess for this provider.
    for (const f of found) {
      f.visibleTo = f.visibleTo.filter((p) => p !== provider)
      if (enabled.has(f.name)) f.visibleTo.push(provider)
    }
    for (const skill of list) {
      if (skill.enabled === false) continue
      const same = found.find((f) => f.path === skill.path)
      if (same) {
        same.nativeFor = provider as ProviderId
        continue
      }
      const source: SkillSource = skill.scope === 'system' ? 'system' : skill.scope === 'plugin' ? 'plugin' : (provider as SkillSource)
      const scope: Skill['scope'] = skill.scope === 'system' ? 'system' : skill.scope === 'plugin' ? 'plugin' : skill.scope === 'project' ? 'project' : 'user'
      const fileHash = readSkill(skill.path, skill.name)?.hash ?? skill.path
      found.push({ name: skill.name, description: skill.description, path: skill.path, source, scope, visibleTo: [provider], hash: fileHash, nativeFor: provider as ProviderId })
    }
  }

  const byName = new Map<string, Found[]>()
  for (const f of found) byName.set(f.name, [...(byName.get(f.name) ?? []), f])
  const skills: Skill[] = []
  for (const [name, copies] of byName) {
    copies.sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] || SOURCE_RANK[a.source] - SOURCE_RANK[b.source])
    const [winner, ...rest] = copies
    const visibleTo = [...new Set(copies.flatMap((c) => c.visibleTo))].sort() as ProviderId[]
    skills.push({
      name,
      description: winner.description || rest.find((c) => c.description)?.description || '',
      path: winner.path,
      dir: path.dirname(winner.path),
      scope: winner.scope,
      sources: [...new Set(copies.map((c) => c.source))],
      visibleTo,
      ...(copies.some((c) => c.nativeFor) ? { nativePaths: Object.fromEntries(copies.filter((c) => c.nativeFor).map((c) => [c.nativeFor!, c.path])) } : {}),
      ...(rest.length ? { variants: rest.map((c) => ({ path: c.path, source: c.source, scope: c.scope, sameContent: c.hash === winner.hash })) } : {}),
    })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Rank: exact name, name prefix, word-boundary in name, substring in name,
 * fuzzy name, then description hits. Lower is better; null = no match.
 */
export function scoreSkill(skill: Pick<Skill, 'name' | 'description'>, rawQuery: string): number | null {
  const q = rawQuery.trim().toLowerCase().replace(/^[/$]/, '')
  if (!q) return 50
  const name = skill.name.toLowerCase()
  const desc = skill.description.toLowerCase()
  if (name === q) return 0
  if (name.startsWith(q)) return 1 + name.length / 1000
  const boundary = name.split(/[-_:./]/).findIndex((part) => part.startsWith(q))
  if (boundary > 0) return 2 + boundary / 100
  if (name.includes(q)) return 3 + name.indexOf(q) / 100
  const words = q.split(/\s+/).filter(Boolean)
  if (words.length > 1 && words.every((w) => name.includes(w) || desc.includes(w))) return 10 + words.filter((w) => !name.includes(w)).length
  if (fuzzy(name, q)) return 20 + name.length / 1000
  const at = desc.search(new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  if (at >= 0) return 30 + at / 10_000
  if (desc.includes(q)) return 40
  return null
}

function fuzzy(text: string, q: string): boolean {
  let i = 0
  for (const ch of text) if (ch === q[i] && ++i === q.length) return true
  return false
}

/** Every skill can be invoked on every provider (by path), so nothing is hidden unless you ask with `nativeTo`. */
export function searchSkills(skills: Skill[], query: string, options: { nativeTo?: ProviderId; limit?: number } = {}): Skill[] {
  return skills
    .filter((s) => !options.nativeTo || s.visibleTo.includes(options.nativeTo))
    .map((skill) => ({ skill, score: scoreSkill(skill, query) }))
    .filter((r): r is { skill: Skill; score: number } => r.score !== null)
    .sort((a, b) => a.score - b.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, options.limit ?? 20)
    .map((r) => r.skill)
}

/** SKILL.md body without frontmatter, for inline mode. */
export function readSkillBody(file: string): string {
  return readFileSync(file, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

/**
 * Replace each `$name` that is a known skill, in place. Everything else is left byte-for-byte.
 * Codex loads its skills natively, so for Codex the text keeps `$name` and a native skill
 * block rides along; everyone else gets a `<skill-invoked>` tag where the token was.
 */
export function expandSkillPrompt(
  prompt: PromptInput,
  options: { provider: ProviderId; skills: Skill[]; mode?: 'reference' | 'inline' },
): { prompt: PromptInput; invoked: Skill[] } {
  const byName = new Map(options.skills.map((s) => [s.name, s]))
  const invoked: Skill[] = []
  const native: PromptBlock[] = []
  const expandText = (text: string): string => {
    if (!text.includes('$')) return text
    const tokens = findSkillTokens(text, (name) => byName.has(name))
    if (!tokens.length) return text
    for (const token of tokens) {
      const skill = byName.get(token.name)!
      if (!invoked.includes(skill)) invoked.push(skill)
    }
    const keepNative = (name: string) => options.provider === 'codex' && byName.get(name)!.visibleTo.includes('codex')
    for (const token of tokens) {
      const skill = byName.get(token.name)!
      if (keepNative(token.name) && !native.some((b) => b.type === 'skill' && b.name === skill.name)) native.push({ type: 'skill', name: skill.name, path: skill.nativePaths?.codex ?? skill.path })
    }
    return replaceSkillTokens(
      text,
      tokens.filter((t) => !keepNative(t.name)),
      (token) => {
        const skill = byName.get(token.name)!
        return skillTag(skill.name, skill.path, options.mode === 'inline' ? readSkillBody(skill.path) : undefined)
      },
    )
  }
  const blocks: PromptBlock[] = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt
  const expanded = blocks.map((b) => (b.type === 'text' ? { ...b, text: expandText(b.text) } : b))
  if (!invoked.length) return { prompt, invoked }
  if (!native.length && typeof prompt === 'string') return { prompt: (expanded[0] as { text: string }).text, invoked }
  return { prompt: [...expanded, ...native], invoked }
}
