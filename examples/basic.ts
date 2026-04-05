import { createCodex } from '../src/index.ts'

const loginStrategy = process.env.CODEXKIT_LOGIN === 'device-code' ? 'device-code' : 'browser'

const codex = await createCodex({
  auth: {
    autoLogin: false,
    strategy: loginStrategy,
    onLoginRequired(info) {
      if (info.url) {
        console.log('Log in with ChatGPT:')
        console.log(info.url)
        console.log('Waiting for browser login to complete...')
      } else if (info.verificationUri && info.userCode) {
        console.log('Open:', info.verificationUri)
        console.log('Code:', info.userCode)
        console.log('Waiting for device-code login to complete...')
      }
    },
    onLoginComplete(account) {
      if (account.type === 'chatgpt') {
        console.log(`Signed in as ${account.email} (${account.planType})`)
        return
      }

      console.log('Signed in with API key')
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
