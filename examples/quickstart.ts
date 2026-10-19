// node examples/quickstart.ts [claude|codex|opencode|mock]
import { createAgentKit, policies } from '../src/index.ts'

const provider = process.argv[2] ?? 'claude'
const kit = createAgentKit({ mock: true })

console.table((await kit.providers()).map((p) => ({ provider: p.provider, available: p.available, steer: p.capabilities.steer, rewind: p.capabilities.rewindConversation })))

const session = await kit.session({
  provider,
  cwd: process.cwd(),
  access: 'supervised',
  onPermission: policies.readOnly(), // auto-allow reads, deny the rest
})

session.on((event) => {
  if (event.type === 'timeline' && event.item.type === 'assistant_message') process.stdout.write(event.item.text)
  if (event.type === 'timeline' && event.item.type === 'tool_call' && event.item.status !== 'running') console.log(`\n  [${event.item.detail.type}] ${event.item.name} → ${event.item.status}`)
})

const result = await session.run('List the top-level files here and describe this project in one sentence.')
console.log(`\n\n${result.status}, ${result.usage?.outputTokens ?? '?'} output tokens`)
console.log('resume later with:', JSON.stringify(session.handle))
await kit.shutdown()
