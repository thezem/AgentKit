import type {
  AgentClient,
  AgentProviderInventory,
  AgentProviderAvailability,
  AgentProviderId,
  CreateAgentOptions,
  ProviderInventoryOptions,
} from './agent-types.ts'
import { providerRegistry } from './providers/provider-registry.ts'
import type { ProviderAvailabilityOptions } from './providers/provider-types.ts'

export async function createAgent(options: CreateAgentOptions): Promise<AgentClient> {
  const provider = providerRegistry.get(options.provider)
  return provider.createClient(options)
}

export async function getAvailableProviders(
  options?: ProviderAvailabilityOptions,
): Promise<AgentProviderAvailability[]> {
  const inventory = await providerRegistry.getProviderInventory(toInventoryOptions(options))
  return inventory.map(inventoryToAvailability)
}

export async function getProviderAvailability(
  provider: AgentProviderId,
  options?: ProviderAvailabilityOptions,
): Promise<AgentProviderAvailability> {
  const inventory = await getProviderInventoryEntry(provider, toInventoryOptions(options))
  return inventoryToAvailability(inventory)
}

export async function getProviderInventory(options?: ProviderInventoryOptions): Promise<AgentProviderInventory[]> {
  return providerRegistry.getProviderInventory(options)
}

export async function getProviderInventoryEntry(
  provider: AgentProviderId,
  options?: ProviderInventoryOptions,
): Promise<AgentProviderInventory> {
  const selected = providerRegistry.get(provider)
  return selected.getInventory(options)
}

function inventoryToAvailability(inventory: AgentProviderInventory): AgentProviderAvailability {
  return {
    provider: inventory.provider,
    available: inventory.runnable,
    authenticated: inventory.authenticated,
    account: inventory.account,
    raw: inventory.raw,
  }
}

function toInventoryOptions(options?: ProviderAvailabilityOptions): ProviderInventoryOptions | undefined {
  if (!options) return undefined
  return {
    codexPath: options.codexPath,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    cwd: options.cwd,
    env: options.env,
    probeMode: options.probeRuntime === true ? 'deep' : 'cheap',
  }
}
