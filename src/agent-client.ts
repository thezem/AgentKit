import type {
  AgentClient,
  AgentProviderAvailability,
  AgentProviderId,
  CreateAgentOptions,
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
  return providerRegistry.getAvailableProviders(options)
}

export async function getProviderAvailability(
  provider: AgentProviderId,
  options?: ProviderAvailabilityOptions,
): Promise<AgentProviderAvailability> {
  const selected = providerRegistry.get(provider)
  return selected.getAvailability(options)
}
