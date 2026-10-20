/**
 * #17: `opencode serve` must not outlive its host. Failure modes #50–53. Linux (/proc). No model calls.
 *
 *   node test/e2e/orphans.ts
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const host = path.join(import.meta.dirname, 'orphans-host.ts')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Processes whose environment carries this run's marker. */
function marked(mark: string): Array<{ pid: number; cmd: string }> {
  const out: Array<{ pid: number; cmd: string }> = []
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      if (!readFileSync(`/proc/${d}/environ`, 'latin1').includes(`AGENTKIT_ORPHAN_MARK=${mark}`)) continue
      out.push({ pid: Number(d), cmd: readFileSync(`/proc/${d}/cmdline`, 'latin1').replace(/\0/g, ' ').trim() })
    } catch {}
  }
  return out
}

async function startHost() {
  const mark = randomUUID()
  const child = spawn(process.execPath, ['--no-warnings', host], { env: { ...process.env, AGENTKIT_ORPHAN_MARK: mark }, stdio: ['pipe', 'pipe', 'inherit'] })
  let out = ''
  child.stdout.on('data', (c) => (out += c))
  const t0 = Date.now()
  while (!out.includes('READY')) {
    if (child.exitCode !== null || Date.now() - t0 > 60_000) throw new Error(`host never got READY (exit ${child.exitCode})`)
    await sleep(200)
  }
  return { mark, child, out: () => out }
}

/** Wait up to `ms` for the predicate set to empty; returns survivors. */
async function survivors(mark: string, ms: number, keep = (_: { pid: number; cmd: string }) => true) {
  const until = Date.now() + ms
  let left = marked(mark).filter(keep)
  while (left.length && Date.now() < until) {
    await sleep(250)
    left = marked(mark).filter(keep)
  }
  return left
}

const checks: Array<{ name: string; ok: boolean; note: string }> = []
const check = async (name: string, fn: () => Promise<string>) => {
  try {
    const note = await fn()
    checks.push({ name, ok: true, note })
    console.log(`  ✓ ${name} (${note})`)
  } catch (e: any) {
    checks.push({ name, ok: false, note: e.message })
    console.log(`  ✗ ${name}: ${e.message}`)
  }
}

await check('sigkill-host', async () => {
  const h = await startHost()
  const before = marked(h.mark).filter((p) => p.pid !== h.child.pid)
  if (!before.some((p) => p.cmd.includes('serve'))) throw new Error(`no opencode serve under the host: ${JSON.stringify(before)}`)
  h.child.kill('SIGKILL')
  const left = await survivors(h.mark, 10_000)
  if (left.length) throw new Error(`survived: ${JSON.stringify(left)}`)
  return `${before.length} processes gone after kill -9`
})

await check('graceful-shutdown', async () => {
  const h = await startHost()
  h.child.stdin.write('shutdown\n')
  const left = await survivors(h.mark, 10_000)
  if (left.length) throw new Error(`survived: ${JSON.stringify(left)}`)
  if (!h.out().includes('SHUTDOWN')) throw new Error('host did not report SHUTDOWN')
  return 'nothing left'
})

await check('server-dies-alone', async () => {
  const h = await startHost()
  const server = marked(h.mark).find((p) => p.pid !== h.child.pid && p.cmd.includes('serve') && !p.cmd.startsWith('/bin/sh'))
  if (!server) throw new Error('server process not found')
  process.kill(server.pid, 'SIGKILL')
  const left = await survivors(h.mark, 5_000, (p) => p.pid !== h.child.pid)
  h.child.kill('SIGKILL')
  if (left.length) throw new Error(`watchdog leftovers: ${JSON.stringify(left)}`)
  return 'watchdog exited with the server'
})

const dir = path.join(import.meta.dirname, 'artifacts')
mkdirSync(dir, { recursive: true })
writeFileSync(path.join(dir, 'orphans.json'), JSON.stringify({ at: new Date().toISOString(), checks }, null, 2))
const failed = checks.filter((c) => !c.ok).length
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
