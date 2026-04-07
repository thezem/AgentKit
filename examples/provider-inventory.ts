import { getProviderInventory, getProviderInventoryEntry } from '../src/index.ts'

const inventory = await getProviderInventory({ probeMode: 'cheap' })
console.log('Provider inventory (cheap):')
for (const provider of inventory) {
  console.log(
    `- ${provider.provider}: status=${provider.status} runnable=${provider.runnable} accountState=${provider.authenticated ? 'present' : 'unknown'}`,
  )
  if (provider.executablePath) console.log(`  executable: ${provider.executablePath} (${provider.executableSource ?? 'unknown'})`)
  if (provider.version) console.log(`  version: ${provider.version}`)
  if (provider.diagnostics?.probeStrategy) console.log(`  probeStrategy: ${provider.diagnostics.probeStrategy}`)
  if (provider.diagnostics?.failureReason) console.log(`  failureReason: ${provider.diagnostics.failureReason}`)
}

const codex = await getProviderInventoryEntry('codex', { probeMode: 'deep' })
console.log('\nCodex deep inventory:')
console.dir(codex, { depth: null })

const claude = await getProviderInventoryEntry('claude', { probeMode: 'deep' })
console.log('\nClaude deep inventory:')
console.dir(claude, { depth: null })
