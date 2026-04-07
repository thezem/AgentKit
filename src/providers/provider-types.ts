import type {
  AgentAccountState,
  AgentClient,
  AgentProviderInventory,
  AgentProviderId,
  AgentProviderAvailability,
  CreateAgentOptions,
  ProviderInventoryOptions,
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
  getInventory(options?: ProviderInventoryOptions): Promise<AgentProviderInventory>
  isAvailable(options?: ProviderInventoryOptions): Promise<boolean>
  getAvailability(options?: ProviderAvailabilityOptions): Promise<AgentAccountState>
  createClient(options: CreateAgentOptions): Promise<AgentClient>
}

export type ProviderRegistry = {
  get(provider: AgentProviderId): InternalAgentProvider
  getAll(): InternalAgentProvider[]
  getProviderInventory(options?: ProviderInventoryOptions): Promise<AgentProviderInventory[]>
  getAvailableProviders(options?: ProviderAvailabilityOptions): Promise<AgentProviderAvailability[]>
}
