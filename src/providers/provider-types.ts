import type {
  AgentAccountState,
  AgentClient,
  AgentProviderId,
  AgentProviderAvailability,
  CreateAgentOptions,
} from '../agent-types.ts'

export type ProviderAvailabilityOptions = {
  codexPath?: string
  pathToClaudeCodeExecutable?: string
  cwd?: string
  env?: Record<string, string>
  probeRuntime?: boolean
}

export interface InternalAgentProvider {
  id: AgentProviderId
  isAvailable(options?: ProviderAvailabilityOptions): Promise<boolean>
  getAvailability(options?: ProviderAvailabilityOptions): Promise<AgentAccountState>
  createClient(options: CreateAgentOptions): Promise<AgentClient>
}

export type ProviderRegistry = {
  get(provider: AgentProviderId): InternalAgentProvider
  getAll(): InternalAgentProvider[]
  getAvailableProviders(options?: ProviderAvailabilityOptions): Promise<AgentProviderAvailability[]>
}
