import { createAgent } from '../src/index.ts'

console.log('Starting agentkit basic example...')

const agent = await createAgent({
  provider: 'codex',
  defaults: {
    cwd: process.cwd(),
  },
  codex: {
    defaults: {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    },
  },
})

const account = await agent.getAccountState()
console.log('Provider runtime/account state:', account)
if (!account.authenticated) {
  console.log('Codex is not authenticated yet. Complete login first, then rerun this example.')
}

const session = agent.session('basic-demo')
console.log('Starting session...')
const stream = await session.stream('tell me another joke about programmers')
console.log('Waiting for Codex response...')
for await (const event of stream) {
  if (event.type === 'message.delta') {
    process.stdout.write(event.text)
  }
}

console.log()
console.log('Done.')
await session.close()
await agent.close()
