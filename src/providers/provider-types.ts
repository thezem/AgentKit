import type {
  AgentAccountState,
  AgentClient,
  AgentModelInfo,
  AgentModelListOptions,
  AgentProviderInventory,
  AgentProviderId,
  AgentProviderAvailability,
  AgentSkillInfo,
  AgentSkillListOptions,
  CreateAgentOptions,
  ProviderInventoryOptions,
} from '../agent-types.ts'

export type ProviderAvailabilityOptions = {
  codexPath?: string
  pathToClaudeCodeExecutable?: string
  cwd?: string
  env?: Record<string, string>
  probeRuntime?: boolean
  probeTimeoutMs?: number
}

export interface InternalAgentProvider {
  id: AgentProviderId
  getInventory(options?: ProviderInventoryOptions): Promise<AgentProviderInventory>
  isAvailable(options?: ProviderInventoryOptions): Promise<boolean>
  getAvailability(options?: ProviderAvailabilityOptions): Promise<AgentAccountState>
  listModels?(options?: AgentModelListOptions): Promise<AgentModelInfo[]>
  listSkills?(options?: AgentSkillListOptions): Promise<AgentSkillInfo[]>
  createClient(options: CreateAgentOptions): Promise<AgentClient>
}

export type ProviderRegistry = {
  get(provider: AgentProviderId): InternalAgentProvider
  getAll(): InternalAgentProvider[]
  getProviderInventory(options?: ProviderInventoryOptions): Promise<AgentProviderInventory[]>
  getAvailableProviders(options?: ProviderAvailabilityOptions): Promise<AgentProviderAvailability[]>
  listModels(provider?: AgentProviderId, options?: AgentModelListOptions): Promise<AgentModelInfo[]>
  listSkills(provider: AgentProviderId, options?: AgentSkillListOptions): Promise<AgentSkillInfo[]>
}
