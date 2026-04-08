export const T3CODE_AGENT_NAME = 't3code-repo-scout'
export const T3CODE_TARGET_REPO = 'G:\\t3code'
export const T3CODE_MODEL = 'gpt-5.4-mini'

export const DEFAULT_INTERVIEW_PROMPT = [
  'You are the owner of the t3code repository.',
  `You already use direct Codex and Claude SDK integrations inside ${T3CODE_TARGET_REPO}.`,
  '',
  'I am evaluating whether @ouim/agentkit actually solves a real problem for your codebase.',
  'Based on the architecture and workflows you saw in t3code, would you replace your current direct Codex and Claude SDK integrations with @ouim/agentkit?',
  '',
  'Answer in this structure:',
  '1. Verdict: yes, no, or partially.',
  '2. Why: the strongest reasons for that verdict.',
  '3. Missing pieces: what @ouim/agentkit would still need before you would trust it.',
  '4. Migration shape: what the first realistic adoption path would be, if any.',
  '',
  'If no, explain why not and what is missing.',
  'If yes, explain why and what is still missing.',
  'Be direct and critical. Ground your answer in the needs of t3code, not generic SDK opinions.',
].join('\n')

export type T3codeAgentCliConfig = {
  agentName: string
  cwd: string
  model: string
  handleJson: string
  prompt: string
}

export function buildScoutPrompt(targetRepo = T3CODE_TARGET_REPO): string {
  return `
Explore the repository at ${targetRepo}.

Build a working mental model of:
- the product purpose
- the main app/runtime entrypoints
- the important packages, folders, and architecture seams
- the current areas that look active or important

Do not make code changes. End with a concise "ready for follow-up questions" note.
`.trim()
}

export function resolveT3codeAgentCliConfig(options: {
  args: string[]
  stdinText?: string
  env?: Record<string, string | undefined>
}): T3codeAgentCliConfig {
  const env = options.env ?? {}
  let handleJson = env.CODEXKIT_AGENT_HANDLE?.trim() ?? ''
  let prompt = ''
  let useDefaultInterviewPrompt = false

  for (let index = 0; index < options.args.length; index += 1) {
    const token = options.args[index]
    if (token === '--handle') {
      const value = options.args[index + 1]
      if (!value) throw new Error('Expected a value after --handle')
      handleJson = value.trim()
      index += 1
      continue
    }

    if (token === '--prompt') {
      const value = options.args[index + 1]
      if (!value) throw new Error('Expected a value after --prompt')
      prompt = value
      index += 1
      continue
    }

    if (token === '--interview') {
      useDefaultInterviewPrompt = true
      continue
    }

    if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`)
    }

    prompt = prompt.length > 0 ? `${prompt} ${token}` : token
  }

  if (handleJson.length === 0) {
    throw new Error(
      'Missing agent handle. Pass --handle \'<json>\' or set CODEXKIT_AGENT_HANDLE.',
    )
  }

  const stdinPrompt = (options.stdinText ?? '').trim()
  const finalPrompt =
    prompt.trim() ||
    stdinPrompt ||
    (useDefaultInterviewPrompt ? DEFAULT_INTERVIEW_PROMPT : DEFAULT_INTERVIEW_PROMPT)

  return {
    agentName: T3CODE_AGENT_NAME,
    cwd: T3CODE_TARGET_REPO,
    model: T3CODE_MODEL,
    handleJson,
    prompt: finalPrompt,
  }
}
