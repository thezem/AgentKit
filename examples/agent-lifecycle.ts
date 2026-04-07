import { createAgent } from '../src/index.ts'

const agent = await createAgent({
  provider: 'codex',
  defaults: {
    cwd: process.cwd(),
  },
})

const opened = await agent.openSession({ name: 'lifecycle-demo' })
const first = await opened.run('Say hello in one line')
console.log('First turn:', first.text)

if (!first.handle) {
  throw new Error('Expected a handle after the first run')
}

const serialized = JSON.stringify(first.handle)
console.log('Persistable handle:', serialized)

await opened.close()

const restored = await agent.resumeSession(JSON.parse(serialized))
const second = await restored.run('Now reply with one short follow-up')
console.log('Second turn:', second.text)

await restored.close()
await agent.close()
