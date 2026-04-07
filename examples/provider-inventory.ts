import { getProviderInventory, getProviderInventoryEntry } from '../src/index.ts'

const inventory = await getProviderInventory({ probeMode: 'cheap' })
console.log('Provider inventory (cheap):')
console.dir(inventory, { depth: null })

const codex = await getProviderInventoryEntry('codex', { probeMode: 'deep' })
console.log('\nCodex deep inventory:')
console.dir(codex, { depth: null })
