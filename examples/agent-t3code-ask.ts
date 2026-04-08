import { readFileSync } from 'node:fs'

import { createAgent } from '../src/index.ts'
import type { AgentSessionHandle } from '../src/index.ts'
import {
  DEFAULT_INTERVIEW_PROMPT,
  resolveT3codeAgentCliConfig,
} from './lib/t3code-agent-cli.ts'

if (process.argv.includes('--help')) {
  console.log(`
Usage:
  npm run example:agent:t3code:ask -- --handle '<json>' --interview
  npm run example:agent:t3code:ask -- --handle '<json>' --prompt "your question"
  npm run example:agent:t3code:ask -- --handle-file .\\handle.json --interview
  @'
What is the strongest reason you would not adopt @ouim/agentkit yet?
'@ | node --experimental-strip-types examples/agent-t3code-ask.ts --handle-file .\\handle.json

If no prompt is provided, the prepared interview prompt is used:

${DEFAULT_INTERVIEW_PROMPT}
`.trim())
  process.exit(0)
}

const stdinText = await readStdin()
const { handleJson, prompt, cwd, model, agentName } = resolveCliConfig(process.argv.slice(2), stdinText)

const handle = JSON.parse(handleJson) as AgentSessionHandle

const agent = await createAgent({
  provider: 'codex',
  defaults: {
    cwd,
    model,
  },
  codex: {
    defaults: {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    },
  },
})

const session = await agent.resumeSession(handle, { name: agentName })
const result = await session.run(prompt)

console.log(result.text)
console.log('\nSession name:', agentName)
console.log('Resume handle:', JSON.stringify(result.handle))

await session.close()
await agent.close()

function resolveCliConfig(args: string[], stdinPrompt: string) {
  const handleFileIndex = args.indexOf('--handle-file')
  if (handleFileIndex === -1) {
    return resolveT3codeAgentCliConfig({
      args,
      stdinText: stdinPrompt,
      env: process.env,
    })
  }

  const filePath = args[handleFileIndex + 1]
  if (!filePath) {
    throw new Error('Expected a value after --handle-file')
  }

  const fileHandleJson = readFileSync(filePath, 'utf8').trim()
  const filteredArgs = args.slice(0, handleFileIndex).concat(args.slice(handleFileIndex + 2))

  return resolveT3codeAgentCliConfig({
    args: ['--handle', fileHandleJson, ...filteredArgs],
    stdinText: stdinPrompt,
    env: {
      ...process.env,
      CODEXKIT_AGENT_HANDLE: undefined,
    },
  })
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return ''
  }

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}
