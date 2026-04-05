import { createCodex } from '../src/index.ts'

const codex = await createCodex({
  auth: {
    autoLogin: false,
  },
  defaults: {
    cwd: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
  },
})

const thread = await codex.threads.create()
const result = await thread.run(
  'Investigate the current repository state, identify the highest-signal issue, and summarize the next fix.',
)

console.log(result.text)
await codex.close()
