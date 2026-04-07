import type { AgentProviderId } from '../agent-types.ts'
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

  async getAvailableProviders(options?: ProviderAvailabilityOptions) {
    return Promise.all(providers.map((provider) => provider.getAvailability(options)))
  },
}
