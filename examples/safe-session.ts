import { createSession, safety } from '../src/index.ts'

console.log('Starting safe session example...')

const session = await createSession({
  provider: 'codex',
  defaults: {
    cwd: process.cwd(),
  },
  name: 'safe-session-demo',
})

console.log('Starting session with conservative approval presets...')
const result = await session.run(
  'Inspect package.json and summarize the scripts you find. Do not execute any commands unless explicitly approved.',
  {
    handlers: safety.confirmDangerous({
      allowReadOnly: true,
      allowFileEdits: true,
      allowCommands: false,
    }),
  },
)

console.log('Status:', result.status)
console.log('Handle:', result.handle)
console.log('Text:', result.text)

await session.close()
