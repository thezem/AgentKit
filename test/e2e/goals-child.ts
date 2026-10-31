import { createAgentKit } from '../../src/index.ts'
const [file, provider, key, cwd] = process.argv.slice(2)
const kit = createAgentKit({ store: file, mock: provider === 'mock' ? { tokenDelayMs: 5 } : false, hub: false })
const session = await kit.session({ provider, cwd, key, access: 'full-access' })
session.on((event) => {
  if (event.type === 'timeline' && event.item.type === 'assistant_message') process.stdout.write(JSON.stringify({ shown: event.item.text }) + '\n')
})
await session.setGoal('crash test goal [goal-stall]')
setInterval(() => {}, 1000)
