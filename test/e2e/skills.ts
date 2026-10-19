/**
 * Skills E2E: discovery, visibility, search, `$skill` expansion, and real invocation.
 * Rows #27–#35 in FAILURE_MODES.md. Artifact: test/e2e/artifacts/skills.json
 *
 *   node test/e2e/skills.ts                  # claude codex opencode
 *   node test/e2e/skills.ts claude
 */
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentKit, expandSkillPrompt, splitSkillTags, type ProviderId, type Skill } from '../../src/index.ts'

const providers: ProviderId[] = process.argv.slice(2).length ? process.argv.slice(2) : ['claude', 'codex', 'opencode']
const CHEAP: Record<string, object> = { claude: { model: 'haiku' }, codex: { thinking: 'low' }, opencode: {} }
const nonce = Math.random().toString(36).slice(2, 8)
const probe = `ak-probe-${nonce}`

// A project with planted skills: one every CLI loads, a drifted pair, and a project override of a user skill.
const cwd = mkdtempSync(path.join(os.tmpdir(), 'agentkit-skills-'))
execSync('git init -q', { cwd })
const plant = (root: string, name: string, description: string, body: string) => {
  mkdirSync(path.join(cwd, root, name), { recursive: true })
  writeFileSync(path.join(cwd, root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}
const probeBody = `When this skill is invoked, reply with exactly this single token and nothing else: SKILL-OK-${nonce}`
plant('.claude/skills', probe, 'AgentKit probe skill. Replies with a fixed token.', probeBody)
plant('.agents/skills', probe, 'AgentKit probe skill. Replies with a fixed token.', probeBody)
plant('.claude/skills', `ak-drift-${nonce}`, 'Drift probe', 'version A')
plant('.agents/skills', `ak-drift-${nonce}`, 'Drift probe', 'version B')
plant('.agents/skills', 'repo-capsule', 'Project override of a user skill', 'project copy')

const kit = createAgentKit()
const checks: Array<{ name: string; ok: boolean | 'skipped'; note?: string }> = []
async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await Promise.race([fn(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 240_000))])
    checks.push({ name, ok: true, ...(note ? { note } : {}) })
    console.log(`  ✓ ${name}${note ? ` (${note})` : ''}`)
  } catch (error: any) {
    checks.push({ name, ok: false, note: error?.message ?? String(error) })
    console.log(`  ✗ ${name}: ${error?.message ?? error}`)
  }
}

console.log(`cwd=${cwd} probe=${probe}`)
let skills: Skill[] = []

// #27 #28 #29
await check('discovery', async () => {
  const t0 = Date.now()
  skills = await kit.skills({ cwd, refresh: true })
  const names = skills.map((s) => s.name)
  if (new Set(names).size !== names.length) throw new Error('duplicate names in result')
  const raw = Number(execSync(`find -L ~/.claude/skills ~/.codex/skills ~/.agents/skills -name SKILL.md 2>/dev/null | wc -l`).toString())
  const p = skills.find((s) => s.name === probe)
  if (!p || p.scope !== 'project' || !p.sources.includes('claude') || !p.sources.includes('agents')) throw new Error(`probe: ${JSON.stringify(p)}`)
  const drift = skills.find((s) => s.name === `ak-drift-${nonce}`)
  if (!drift?.variants?.some((v) => !v.sameContent)) throw new Error(`drift not surfaced: ${JSON.stringify(drift)}`)
  const override = skills.find((s) => s.name === 'repo-capsule')
  if (!override?.path.startsWith(cwd)) throw new Error(`project copy did not win: ${override?.path}`)
  const drifted = skills.filter((s) => s.variants?.some((v) => !v.sameContent)).length
  return `${skills.length} unique from ${raw}+ files in ${Date.now() - t0}ms; ${drifted} drifted; project override + drift + dedupe ok`
})

// #30: what we claim each CLI loads vs what the CLI itself lists.
for (const provider of providers.filter((p) => p !== 'codex')) {
  await check(`visibility:${provider}`, async () => {
    const session = await kit.session({ provider, cwd, ...CHEAP[provider] })
    try {
      const listed = new Set((await session.commands()).map((c) => c.name))
      const claimed = skills.filter((s) => s.visibleTo.includes(provider)).map((s) => s.name)
      const missing = claimed.filter((n) => !listed.has(n))
      // Precision: of the CLI's entries that are skills we know about, how many did we attribute to it?
      const known = new Set(skills.map((s) => s.name))
      const unclaimed = [...listed].filter((n) => known.has(n) && !claimed.includes(n))
      if (missing.length > Math.max(2, claimed.length * 0.02)) throw new Error(`claimed but not listed (${missing.length}): ${missing.slice(0, 8).join(', ')}`)
      if (unclaimed.length > Math.max(2, claimed.length * 0.02)) throw new Error(`listed but not claimed (${unclaimed.length}): ${unclaimed.slice(0, 8).join(', ')}`)
      return `claimed ${claimed.length}; CLI lists ${listed.size} entries; missing=[${missing.join(', ')}] unclaimed=[${unclaimed.join(', ')}]`
    } finally {
      await session.close()
    }
  })
}
if (providers.includes('codex')) {
  await check('visibility:codex', async () => {
    const native = await kit.client('codex').listSkills!({ cwd })
    const enabled = new Set(native.filter((s) => s.enabled !== false).map((s) => s.name))
    const claimed = new Set(skills.filter((s) => s.visibleTo.includes('codex')).map((s) => s.name))
    const diff = [...enabled].filter((n) => !claimed.has(n)).concat([...claimed].filter((n) => !enabled.has(n)))
    if (diff.length) throw new Error(`mismatch: ${diff.slice(0, 8).join(', ')}`)
    if (!claimed.has(probe)) throw new Error('codex did not pick up the project .agents skill')
    return `${claimed.size} = codex skills/list (enabled), ${native.length - enabled.size} disabled excluded`
  })
}

// #31
await check('search', async () => {
  const top = async (q: string) => (await kit.searchSkills(q, { cwd, limit: 5 })).map((s) => s.name)
  for (const name of ['repo-capsule', probe, 'no-visual-slop']) if ((await top(name))[0] !== name) throw new Error(`"${name}" → ${(await top(name)).join(', ')}`)
  if ((await top('$repo-capsule'))[0] !== 'repo-capsule') throw new Error('leading $ not ignored')
  const capsule = await top('capsule')
  if (!capsule.every((n) => n.includes('capsule'))) throw new Error(`name hits not first: ${capsule.join(', ')}`)
  return `capsule → ${capsule.join(', ')}`
})

// #32 #33 #35
await check('expand', async () => {
  const text = `Look at $${probe} and pull out auth.\nKeep $PATH, $5, $1.5k, a$b, $nope-not-a-skill, and \`$HOME\` as typed. Again: $${probe}!`
  const out = expandSkillPrompt(text, { provider: 'claude', skills })
  if (typeof out.prompt !== 'string') throw new Error('claude: expected a string')
  const tags = splitSkillTags(out.prompt)
  const rebuilt = tags.map((s) => (s.type === 'text' ? s.text : `$${s.name}`)).join('')
  if (rebuilt !== text) throw new Error(`text outside tokens changed:\n${rebuilt}`)
  if (tags.filter((s) => s.type === 'skill').length !== 2) throw new Error('expected two tags')
  const codex = expandSkillPrompt(text, { provider: 'codex', skills })
  if (typeof codex.prompt === 'string') throw new Error('codex: expected blocks')
  const [first, ...rest] = codex.prompt
  if (first.type !== 'text' || first.text !== text) throw new Error('codex text must stay as typed')
  if (rest.length !== 1 || rest[0].type !== 'skill' || rest[0].name !== probe) throw new Error(`codex blocks: ${JSON.stringify(rest)}`)
  const off = expandSkillPrompt('no tokens here $PATH', { provider: 'claude', skills })
  if (off.prompt !== 'no tokens here $PATH' || off.invoked.length) throw new Error('untouched text changed')
  return 'round-trips byte-for-byte; $PATH $5 $1.5k a$b $unknown untouched; codex keeps $name + native item'
})

// #34: the model actually reads and follows the skill.
for (const provider of providers) {
  await check(`invoke:${provider}`, async () => {
    const session = await kit.session({ provider, cwd, access: 'full-access', ...CHEAP[provider] })
    try {
      const r = await session.run(`$${probe}`)
      if (r.status !== 'completed') throw new Error(`${r.status} ${r.error ?? ''}`)
      if (!r.finalText.includes(`SKILL-OK-${nonce}`)) throw new Error(`reply: ${JSON.stringify(r.finalText.slice(0, 200))}`)
      const user = session.transcript.items.find((i) => i.type === 'user_message')
      return `replied SKILL-OK-${nonce}; model saw: ${JSON.stringify((user as any)?.text?.slice(0, 70))}`
    } finally {
      await session.close()
    }
  })
}

mkdirSync(path.join(import.meta.dirname, 'artifacts'), { recursive: true })
writeFileSync(path.join(import.meta.dirname, 'artifacts', 'skills.json'), JSON.stringify({ cwd, probe, providers, checks, sample: skills.slice(0, 5) }, null, 2))
await kit.shutdown()
const failed = checks.filter((c) => c.ok === false)
console.log(`\n${failed.length ? `${failed.length} failed` : 'all passed'}`)
process.exit(failed.length ? 1 : 0)
