import { createAgent } from '../src/index.ts'

const agent = await createAgent({
  provider: 'claude',
  defaults: {
    cwd: process.cwd(),
    model: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
    permissionMode: 'default',
    includePartialMessages: true,
  },
  claude: {
    options: {
      persistSession: true,
      maxTurns: 8,
    },
  },
})

console.log('Provider account state:', await agent.getAccountState())

const session = await agent.openSession({ name: 'agent-claude-demo' })
const first = await session.stream('Give me a one-paragraph summary of this repository.')

for await (const event of first) {
  if (event.type === 'message.delta') process.stdout.write(event.text)
  if (event.type === 'turn.completed') {
    console.log(`\n\nFirst turn status: ${event.result.status}`)
  }
}

const second = await session.run('Now list 3 practical next improvements.')
console.log('\nSecond turn status:', second.status)
console.log(second.text)
console.log('Resume handle:', second.handle)

await session.interrupt().catch(() => {
  // interrupt is meaningful only during an active turn
})

await session.close()
await agent.close()
