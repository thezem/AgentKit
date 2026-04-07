import type { AgentModelListOptions, AgentProviderId, AgentSkillListOptions, ProviderInventoryOptions } from '../agent-types.ts'
import { claudeProvider } from './claude-adapter.ts'
import { codexProvider } from './codex-adapter.ts'
import type { InternalAgentProvider, ProviderAvailabilityOptions, ProviderRegistry } from './provider-types.ts'

const providers: InternalAgentProvider[] = [codexProvider, claudeProvider]

export const providerRegistry: ProviderRegistry = {
  get(provider: AgentProviderId): InternalAgentProvider {
    const match = providers.find((item) => item.id === provider)
    if (!match) {
      throw new Error(`Unknown provider: ${provider}`)
    }
    return match
  },

  getAll(): InternalAgentProvider[] {
    return [...providers]
  },

  async getProviderInventory(options?: ProviderInventoryOptions) {
    return Promise.all(providers.map((provider) => provider.getInventory(options)))
  },

  async getAvailableProviders(options?: ProviderAvailabilityOptions) {
    return Promise.all(providers.map((provider) => provider.getAvailability(options)))
  },

  async listModels(provider?: AgentProviderId, options?: AgentModelListOptions) {
    if (provider) {
      const selected = this.get(provider)
      if (!selected.listModels) {
        throw new Error(`Provider "${provider}" does not support model listing`)
      }
      return selected.listModels(options)
    }

    const listed = await Promise.all(
      providers
        .filter((candidate) => typeof candidate.listModels === 'function')
        .map((candidate) => candidate.listModels!(options)),
    )
    return listed.flat()
  },

  async listSkills(provider: AgentProviderId, options?: AgentSkillListOptions) {
    const selected = this.get(provider)
    if (!selected.listSkills) {
      throw new Error(`Provider "${provider}" does not support skill listing`)
    }
    return selected.listSkills(options)
  },
}
