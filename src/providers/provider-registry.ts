import type { AgentModelListOptions, AgentProviderId, AgentSkillListOptions, ProviderInventoryOptions } from '../agent-types.ts'
import { InputValidationError } from '../errors.ts'
import { claudeProviderFactory } from './claude-adapter.ts'
import { codexProviderFactory } from './codex-adapter.ts'
import type {
  InternalAgentProvider,
  ProviderAdapterFactory,
  ProviderAvailabilityOptions,
  ProviderRegistry,
} from './provider-types.ts'

class InMemoryProviderRegistry implements ProviderRegistry {
  private readonly factories = new Map<AgentProviderId, ProviderAdapterFactory>()
  private readonly providers = new Map<AgentProviderId, InternalAgentProvider>()

  register(factory: ProviderAdapterFactory): void {
    this.factories.set(factory.id, factory)
    this.providers.delete(factory.id)
  }

  reset(factories: ProviderAdapterFactory[] = [codexProviderFactory, claudeProviderFactory]): void {
    this.factories.clear()
    this.providers.clear()
    for (const factory of factories) {
      this.register(factory)
    }
  }

  getFactories(): ProviderAdapterFactory[] {
    return [...this.factories.values()]
  }

  get(provider: AgentProviderId): InternalAgentProvider {
    const factory = this.factories.get(provider)
    if (!factory) {
      throw new InputValidationError(`Unknown provider: ${provider}`, 'provider', { code: 'INVALID_PROVIDER' })
    }

    const existing = this.providers.get(provider)
    if (existing) return existing

    const created = factory.create()
    this.providers.set(provider, created)
    return created
  }

  getAll(): InternalAgentProvider[] {
    return this.getFactories().map((factory) => this.get(factory.id))
  }

  async getProviderInventory(options?: ProviderInventoryOptions) {
    return Promise.all(this.getAll().map((provider) => provider.getInventory(options)))
  }

  async getAvailableProviders(options?: ProviderAvailabilityOptions) {
    return Promise.all(this.getAll().map((provider) => provider.getAvailability(options)))
  }

  async listModels(provider?: AgentProviderId, options?: AgentModelListOptions) {
    if (provider) {
      const selected = this.get(provider)
      if (!selected.listModels) {
        throw new Error(`Provider "${provider}" does not support model listing`)
      }
      return selected.listModels(options)
    }

    const settled = await Promise.allSettled(
      this.getAll()
        .filter((candidate) => typeof candidate.listModels === 'function')
        .map((candidate) => candidate.listModels!(options)),
    )
    return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  }

  async listSkills(provider: AgentProviderId, options?: AgentSkillListOptions) {
    const selected = this.get(provider)
    if (!selected.listSkills) {
      throw new Error(`Provider "${provider}" does not support skill listing`)
    }
    return selected.listSkills(options)
  }
}

export const providerRegistry: ProviderRegistry = new InMemoryProviderRegistry()
providerRegistry.reset()
