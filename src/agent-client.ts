import type {
  AgentClient,
  AgentModelInfo,
  AgentModelListOptions,
  AgentProviderInventory,
  AgentProviderAvailability,
  AgentProviderId,
  AgentSkillInfo,
  AgentSkillListOptions,
  CreateAgentOptions,
  ProviderInventoryOptions,
} from './agent-types.ts'
import { InputValidationError } from './errors.ts'
import { providerRegistry } from './providers/provider-registry.ts'
import type { ProviderAvailabilityOptions } from './providers/provider-types.ts'

/**
 * Create a provider-backed shared Agent client.
 * @throws {import('./errors.ts').InputValidationError} If `options.provider` is unknown.
 */
export async function createAgent(options: CreateAgentOptions): Promise<AgentClient> {
  const providerId = (options as { provider?: unknown }).provider
  if (typeof providerId !== 'string' || providerId.trim().length === 0) {
    throw new InputValidationError('Provider id must be a non-empty string', 'provider')
  }
  const provider = providerRegistry.get(providerId as AgentProviderId)
  return provider.createClient(options)
}

export async function getAvailableProviders(
  options?: ProviderAvailabilityOptions,
): Promise<AgentProviderAvailability[]> {
  const inventory = await providerRegistry.getProviderInventory(toInventoryOptions(options))
  return inventory.map(inventoryToAvailability)
}

/**
 * Read availability for one provider.
 * @throws {import('./errors.ts').InputValidationError} If `provider` is unknown.
 * @throws {import('./errors.ts').ProviderProbeTimeoutError} When a deep runtime probe exceeds timeout.
 */
export async function getProviderAvailability(
  provider: AgentProviderId,
  options?: ProviderAvailabilityOptions,
): Promise<AgentProviderAvailability> {
  const inventory = await getProviderInventoryEntry(provider, toInventoryOptions(options))
  return inventoryToAvailability(inventory)
}

/**
 * Read detailed inventory for all providers.
 * @throws {import('./errors.ts').ProviderProbeTimeoutError} When a deep runtime probe exceeds timeout.
 */
export async function getProviderInventory(options?: ProviderInventoryOptions): Promise<AgentProviderInventory[]> {
  return providerRegistry.getProviderInventory(options)
}

/**
 * Read detailed inventory for one provider.
 * @throws {import('./errors.ts').InputValidationError} If `provider` is unknown.
 * @throws {import('./errors.ts').ProviderProbeTimeoutError} When a deep runtime probe exceeds timeout.
 */
export async function getProviderInventoryEntry(
  provider: AgentProviderId,
  options?: ProviderInventoryOptions,
): Promise<AgentProviderInventory> {
  const selected = providerRegistry.get(provider)
  return selected.getInventory(options)
}

export async function listModels(
  provider?: AgentProviderId,
  options?: AgentModelListOptions,
): Promise<AgentModelInfo[]> {
  return providerRegistry.listModels(provider, options)
}

export async function listSkills(provider: AgentProviderId, options?: AgentSkillListOptions): Promise<AgentSkillInfo[]> {
  return providerRegistry.listSkills(provider, options)
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
    probeTimeoutMs: options.probeTimeoutMs,
  }
}
