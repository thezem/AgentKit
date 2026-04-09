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

console.log('Preparing runtime account state if needed...')
await agent.asCodex()?.auth.ensureLoggedIn()

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
