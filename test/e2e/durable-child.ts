/**
 * Child for the crash check. Opens a stored session, starts a long turn, and prints
 * every assistant delta it SHOWS as a JSON line. The parent SIGKILLs it mid-turn.
 *
 *   node test/e2e/durable-child.ts <store> <provider> <key> <requestId> <cwd> <optsJson>
 */
import { createAgentKit } from '../../src/index.ts'

const [storeFile, provider, key, requestId, cwd, optsJson] = process.argv.slice(2)
const kit = createAgentKit({ store: storeFile, mock: provider === 'mock' ? { tokenDelayMs: 5 } : false })
const session = await kit.session({ provider, cwd, key, access: 'full-access', ...JSON.parse(optsJson) })
session.on((event) => {
  if (event.type === 'timeline' && event.item.type === 'assistant_message') process.stdout.write(JSON.stringify({ shown: event.item.text }) + '\n')
  if (event.type === 'turn_started') process.stdout.write(JSON.stringify({ turnStarted: event.turnId }) + '\n')
})
const prompt =
  provider === 'mock'
    ? Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ') + ' [slow]'
    : 'Write the numbers from 1 to 300 as English words, one per line, nothing else.'
await session.submit(prompt, { requestId })
process.stdout.write(JSON.stringify({ submitted: requestId }) + '\n')
setInterval(() => {}, 1000)
