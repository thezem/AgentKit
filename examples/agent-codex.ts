import { createAgent } from '../src/index.ts'

const agent = await createAgent({
  provider: 'codex',
  defaults: {
    cwd: process.cwd(),
    model: 'gpt-5.4',
  },
  codex: {
    auth: {
      autoLogin: false,
      strategy: process.env.CODEXKIT_LOGIN === 'device-code' ? 'device-code' : 'browser',
      onLoginRequired(info) {
        if (info.url) {
          console.log('Open this URL to sign in with ChatGPT:')
          console.log(info.url)
          console.log('Waiting for login completion...')
        }
      },
    },
    defaults: {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    },
  },
})

console.log('Provider account state:', await agent.getAccountState())
const session = await agent.openSession({ name: 'agent-codex-demo' })
const stream = await session.stream('Summarize this repository in 4 bullets')
for await (const event of stream) {
  if (event.type === 'message.delta') process.stdout.write(event.text)
  if (event.type === 'turn.completed') {
    console.log(`\n\nStatus: ${event.result.status}`)
    console.log('Handle:', event.result.handle)
  }
}

await session.close()
await agent.close()
