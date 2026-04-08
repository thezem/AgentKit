import { createAgent } from '../src/index.ts'

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

console.log('Provider runtime/account state:', await agent.getAccountState())
const session = await agent.openSession({ name: 'handlers-demo' })

const stream = await session.stream(
  'Inspect package.json scripts and summarize the example commands. If you need to run a tool, ask for approval.',
  {
    handlers: {
      onToolApproval: async (request) => {
        console.log(`\n[handler] tool approval requested: ${request.kind}`)
        return 'allow' as const
      },
      onUserInput: async (request) => {
        console.log(`\n[handler] user input requested: ${request.question}`)
        return ['Proceed with defaults.']
      },
    },
  },
)

for await (const event of stream) {
  if (event.type === 'message.delta') {
    process.stdout.write(event.text)
  }
  if (event.type === 'approval.tool') {
    console.log(`\n[event] approval.tool: ${event.request.kind}`)
  }
  if (event.type === 'user.input') {
    console.log(`\n[event] user.input: ${event.request.question}`)
  }
  if (event.type === 'turn.completed') {
    console.log(`\n\nStatus: ${event.result.status}`)
    console.log('Handle:', event.result.handle)
  }
}

await session.close()
await agent.close()
