import { createCodex } from '../src/index.ts'

const loginStrategy = process.env.CODEXKIT_LOGIN === 'device-code' ? 'device-code' : 'browser'

console.log(`Starting agentkit example with ${loginStrategy} auth...`)

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

console.log('Checking login state...')
if (loginStrategy === 'device-code') {
  console.log('Launching native Codex device auth flow...')
}
await codex.auth.ensureLoggedIn()
console.log('Login ready.')

const session = codex.session('basic-demo')
console.log('Starting session...')
// const result = await session.run('Briefly explain what files are in this package and what it does.')

// console.log('Result:')
// console.log(result.text)
const stream = await session.stream('tell me another joke about programmers')
console.log('Waiting for Codex response...')
for await (const event of stream) {
  if (event.type === 'message.delta') {
    process.stdout.write(event.text)
  }
}

console.log()
console.log('Done.')
await codex.close()
