/** Child host for orphans.ts: opens an OpenCode session (starts `opencode serve`), prints READY, then waits. */
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAgentKit } from '../../src/index.ts'

const kit = createAgentKit()
const cwd = mkdtempSync(path.join(os.tmpdir(), 'agentkit-orphan-'))
await kit.session({ provider: 'opencode', cwd })
console.log('READY')
process.stdin.on('data', async (d) => {
  if (String(d).trim() === 'shutdown') {
    await kit.shutdown()
    console.log('SHUTDOWN')
    process.exit(0)
  }
})
