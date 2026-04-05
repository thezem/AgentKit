import { createCodex } from '../src/index.ts'

const codex = await createCodex({
  auth: {
    autoLogin: false,
    strategy: 'browser',
    onLoginRequired(info) {
      if (info.url) {
        console.log('Log in with ChatGPT:')
        console.log(info.url)
      } else if (info.verificationUri && info.userCode) {
        console.log('Open:', info.verificationUri)
        console.log('Code:', info.userCode)
      }
    },
  },
  defaults: {
    cwd: process.cwd(),
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-request',
  },
})

await codex.auth.ensureLoggedIn()

const session = codex.session('basic-demo')
const result = await session.run('Briefly explain what files are in this package and what it does.')

console.log('Result:')
console.log(result.text)

const stream = await session.stream('Now summarize the architecture in one short paragraph.')
for await (const event of stream) {
  if (event.type === 'message.delta') {
    process.stdout.write(event.text)
  }
}

console.log()
await codex.close()
