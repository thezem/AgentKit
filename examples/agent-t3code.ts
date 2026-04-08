import { createAgent } from '../src/index.ts'
import { T3CODE_AGENT_NAME, T3CODE_MODEL, T3CODE_TARGET_REPO, buildScoutPrompt } from './lib/t3code-agent-cli.ts'

const agent = await createAgent({
  provider: 'codex',
  defaults: {
    cwd: T3CODE_TARGET_REPO,
    model: T3CODE_MODEL,
  },
  codex: {
    defaults: {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    },
  },
})

console.log('Provider runtime/account state:', await agent.getAccountState())

const session = await agent.openSession({ name: T3CODE_AGENT_NAME })
const result = await session.run(buildScoutPrompt())

console.log(result.text)
console.log('\nSession name:', T3CODE_AGENT_NAME)
console.log('Resume handle:', JSON.stringify(result.handle))

await session.close()
await agent.close()
