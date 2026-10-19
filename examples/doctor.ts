// node examples/doctor.ts [--json]   — which providers are installed, signed in, and what they can do.
import { createAgentKit } from '../src/index.ts'

const kit = createAgentKit()
const report = []
for (const status of await kit.providers()) {
  let catalog: { models: number; modes: string[]; error?: string } = { models: 0, modes: [] }
  if (status.available) {
    try {
      const c = await kit.catalog(status.provider)
      catalog = { models: c.models.length, modes: c.modes.map((m) => m.id) }
    } catch (error) {
      catalog.error = error instanceof Error ? error.message : String(error)
    }
  }
  const unsupported = Object.entries(status.capabilities).filter(([, on]) => !on).map(([name]) => name)
  report.push({ provider: status.provider, installed: status.available, signedIn: status.available && !catalog.error && catalog.models > 0, ...catalog, unsupported })
}
await kit.shutdown()
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
else for (const r of report) console.log(`${r.signedIn ? '✓' : '✗'} ${r.provider.padEnd(9)} installed=${r.installed} models=${r.models} modes=${r.modes.join('/') || '-'}${r.error ? ` error=${r.error}` : ''}\n  missing: ${r.unsupported.join(', ') || 'nothing'}`)
process.exit(report.some((r) => r.signedIn) ? 0 : 1)
