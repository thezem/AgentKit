import { createCodex } from '../src/compat/codex.ts'

const codex = await createCodex({
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
