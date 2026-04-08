import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_INTERVIEW_PROMPT,
  T3CODE_AGENT_NAME,
  T3CODE_MODEL,
  T3CODE_TARGET_REPO,
  buildScoutPrompt,
  resolveT3codeAgentCliConfig,
} from '../examples/lib/t3code-agent-cli.ts'

test('buildScoutPrompt targets the t3code repo and asks for exploration only', () => {
  const prompt = buildScoutPrompt()

  assert.match(prompt, /Explore the repository at G:\\t3code\./)
  assert.match(prompt, /Do not make code changes\./)
  assert.match(prompt, /ready for follow-up questions/i)
})

test('default interview prompt asks whether agentkit replaces direct sdk integrations', () => {
  assert.match(DEFAULT_INTERVIEW_PROMPT, /@ouim\/agentkit/)
  assert.match(DEFAULT_INTERVIEW_PROMPT, /would you replace your current direct Codex and Claude SDK integrations/i)
  assert.match(DEFAULT_INTERVIEW_PROMPT, /If no, explain why not and what is missing/i)
  assert.match(DEFAULT_INTERVIEW_PROMPT, /If yes, explain why and what is still missing/i)
})

test('resolveT3codeAgentCliConfig prefers explicit handle and explicit prompt', () => {
  const config = resolveT3codeAgentCliConfig({
    args: ['--handle', '{"provider":"codex","sessionId":"thread-1"}', '--prompt', 'Ask the owner what hurts.'],
    stdinText: '',
    env: {},
  })

  assert.equal(config.agentName, T3CODE_AGENT_NAME)
  assert.equal(config.cwd, T3CODE_TARGET_REPO)
  assert.equal(config.model, T3CODE_MODEL)
  assert.equal(config.handleJson, '{"provider":"codex","sessionId":"thread-1"}')
  assert.equal(config.prompt, 'Ask the owner what hurts.')
})

test('resolveT3codeAgentCliConfig uses stdin prompt and env handle when args omit them', () => {
  const config = resolveT3codeAgentCliConfig({
    args: [],
    stdinText: 'What would make you switch?',
    env: {
      CODEXKIT_AGENT_HANDLE: '{"provider":"codex","sessionId":"thread-2"}',
    },
  })

  assert.equal(config.handleJson, '{"provider":"codex","sessionId":"thread-2"}')
  assert.equal(config.prompt, 'What would make you switch?')
})

test('resolveT3codeAgentCliConfig falls back to the prepared interview prompt', () => {
  const config = resolveT3codeAgentCliConfig({
    args: ['--handle', '{"provider":"codex","sessionId":"thread-3"}'],
    stdinText: '',
    env: {},
  })

  assert.equal(config.prompt, DEFAULT_INTERVIEW_PROMPT)
})

test('resolveT3codeAgentCliConfig reports missing handle clearly', () => {
  assert.throws(
    () =>
      resolveT3codeAgentCliConfig({
        args: ['--prompt', 'hello'],
        stdinText: '',
        env: {},
      }),
    /Missing agent handle/,
  )
})

test('resolveT3codeAgentCliConfig reports missing handle flag values clearly', () => {
  assert.throws(
    () =>
      resolveT3codeAgentCliConfig({
        args: ['--handle'],
        stdinText: '',
        env: {},
      }),
    /Expected a value after --handle/,
  )
})
