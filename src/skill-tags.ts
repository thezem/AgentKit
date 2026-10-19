/**
 * Pure, browser-safe: the `$skill` token and the `<skill-invoked>` tag.
 *
 * Contract with the consumer app: when the user picks a skill from your `/` menu,
 * put `$name` in the message text. AgentKit replaces each `$name` that matches a
 * known skill in place and leaves every other character exactly as typed.
 */

/** `$name` at the start or after whitespace; name has a letter; not `$5`, `$1.5k`, `a$b`. Ends at whitespace, end, or closing punctuation. */
const TOKEN = /(^|\s)\$(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:[\s.,;:!?)\]]|$))(?=[a-zA-Z0-9:_.-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*(?:\.[a-zA-Z0-9:_-]+)*)(?=[\s.,;:!?)\]]|$)/g

export interface SkillToken {
  name: string
  /** Offsets of `$name` in the original text. */
  start: number
  end: number
}

/** Every `$name` whose name passes `isKnown`. */
export function findSkillTokens(text: string, isKnown: (name: string) => boolean): SkillToken[] {
  const tokens: SkillToken[] = []
  for (const match of text.matchAll(TOKEN)) {
    const name = match[2]
    if (!isKnown(name)) continue
    const start = (match.index ?? 0) + match[1].length
    tokens.push({ name, start, end: start + 1 + name.length })
  }
  return tokens
}

/** Replace tokens right-to-left so offsets stay valid. Text outside tokens is untouched. */
export function replaceSkillTokens(text: string, tokens: SkillToken[], render: (token: SkillToken) => string): string {
  let out = text
  for (const token of [...tokens].sort((a, b) => b.start - a.start)) out = out.slice(0, token.start) + render(token) + out.slice(token.end)
  return out
}

const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** Reference form: the model reads the file itself (and anything next to it). */
export function skillTag(name: string, path: string, body?: string): string {
  const open = `<skill-invoked name="${attr(name)}" path="${attr(path)}">`
  if (body !== undefined) return `${open}\n${body.trim()}\n</skill-invoked>`
  return `${open}The user invoked the "${name}" skill here. Before acting, read the SKILL.md at the path above (and any files it points to in its folder), then follow it.</skill-invoked>`
}

export type SkillTextSegment = { type: 'text'; text: string } | { type: 'skill'; name: string; path: string }

/** Turn a sent message back into text + skill chips (for rendering history). */
export function splitSkillTags(text: string): SkillTextSegment[] {
  const segments: SkillTextSegment[] = []
  const re = /<skill-invoked name="([^"]*)" path="([^"]*)">[\s\S]*?<\/skill-invoked>/g
  let last = 0
  for (const match of text.matchAll(re)) {
    if (match.index! > last) segments.push({ type: 'text', text: text.slice(last, match.index) })
    const un = (v: string) => v.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    segments.push({ type: 'skill', name: un(match[1]), path: un(match[2]) })
    last = match.index! + match[0].length
  }
  if (last < text.length) segments.push({ type: 'text', text: text.slice(last) })
  return segments
}
