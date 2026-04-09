import { createAgent } from '../src/index.ts'

const agent = await createAgent({
  provider: 'codex',
  defaults: {
    cwd: process.cwd(),
    model: 'gpt-5.4',
    interactionMode: 'plan',
    accessMode: 'supervised',
  },
})

console.log('Provider runtime/account state:', await agent.getAccountState())
const session = await agent.openSession({ name: 'agent-codex-demo', accessMode: 'auto-edit' })
const stream = await session.stream('Summarize this repository in 4 bullets', {
  reasoningEffort: 'high',
})
for await (const event of stream) {
  if (event.type === 'message.delta') process.stdout.write(event.text)
  if (event.type === 'plan.delta') console.log(`\n[plan] ${event.item.text}`)
  if (event.type === 'item.started') console.log(`\n[item started] ${event.item.kind}`)
  if (event.type === 'item.completed') console.log(`\n[item completed] ${event.item.kind}`)
  if (event.type === 'run.completed') {
    console.log(`\n\nStatus: ${event.result.status}`)
    console.log('Handle:', event.result.handle)
  }
}

await session.close()
await agent.close()
