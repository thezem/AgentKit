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
 * Create a provider-backed shared agent client.
 *
 * This is the primary provider-neutral entrypoint. The returned client
 * manages only local process/cache state; remote resumability is represented
 * by {@link import('./agent-types.ts').AgentSessionHandle}.
 *
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

/**
 * List provider availability in compatibility form.
 *
 * This is a convenience projection over provider inventory. For richer
 * diagnostics (install path, probe strategy, degradation) use
 * {@link getProviderInventory}.
 */
export async function getAvailableProviders(
  options?: ProviderAvailabilityOptions,
): Promise<AgentProviderAvailability[]> {
  const inventory = await providerRegistry.getProviderInventory(toInventoryOptions(options))
  return inventory.map(inventoryToAvailability)
}

/**
 * Read availability for one provider.
 *
 * This is a compatibility surface over inventory and intentionally returns a
 * smaller shape. Prefer {@link getProviderInventoryEntry} for diagnostics.
 *
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
 *
 * Inventory is the canonical discovery API and includes installation, runtime,
 * authentication, capability, and probe diagnostics metadata.
 *
 * @throws {import('./errors.ts').ProviderProbeTimeoutError} When a deep runtime probe exceeds timeout.
 */
export async function getProviderInventory(options?: ProviderInventoryOptions): Promise<AgentProviderInventory[]> {
  return providerRegistry.getProviderInventory(options)
}

/**
 * Read detailed inventory for one provider.
 *
 * Use this when you need one provider's executable metadata, version/probe
 * details, degraded state, or capability support.
 *
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

/**
 * List discoverable models across providers or for one provider.
 */
export async function listModels(
  provider?: AgentProviderId,
  options?: AgentModelListOptions,
): Promise<AgentModelInfo[]> {
  return providerRegistry.listModels(provider, options)
}

/**
 * List provider skills for one provider.
 *
 * Skills are currently Codex-backed. Unsupported providers throw a typed
 * unsupported capability error.
 */
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
