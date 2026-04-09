import type {
  AgentClient,
  AgentModelInfo,
  AgentModelListOptions,
  AgentOpenSessionOptions,
  AgentProviderInventory,
  AgentProviderAvailability,
  AgentProviderId,
  AgentSession,
  AgentSkillInfo,
  AgentSkillListOptions,
  CreateAgentOptions,
  CreateSessionOptions,
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
 * by {@link import('./agent-types.ts').AgentSessionHandle}. This API is a
 * runtime substrate, not an orchestration layer.
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
 * Create a private provider client, open one session, and bind client cleanup
 * to the returned session's `close()` lifecycle.
 */
export async function createSession(options: CreateSessionOptions): Promise<AgentSession> {
  const clientOptions = toCreateAgentOptions(options)
  const sessionOptions = toOpenSessionOptions(options)
  const client = await createAgent(clientOptions)

  let session: AgentSession
  try {
    session = await client.openSession(sessionOptions)
  } catch (error) {
    await closePrivatelyOwnedClient(client)
    throw error
  }

  return wrapSessionWithOwnedClient(session, client)
}

/**
 * List provider availability in compatibility form.
 *
 * This is a convenience projection over provider inventory. For richer
 * diagnostics (install path, probe strategy, degradation, capability metadata),
 * use {@link getProviderInventory}.
 */
export async function getAvailableProviders(options?: ProviderAvailabilityOptions): Promise<AgentProviderAvailability[]> {
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
 * authentication, capability, and probe diagnostics metadata. Use this instead
 * of availability helpers when you need contract-bearing discovery data.
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
 * details, degraded state, or capability support. The normalized fields are
 * the stable discovery contract; `raw` remains provider-native.
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
export async function listModels(provider?: AgentProviderId, options?: AgentModelListOptions): Promise<AgentModelInfo[]> {
  return providerRegistry.listModels(provider, options)
}

/**
 * List provider skills for one provider.
 *
 * Skills are currently Codex-backed. Unsupported providers may cause the
 * underlying provider registry to throw an error if skill listing is not
 * implemented for the selected provider.
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

function toCreateAgentOptions(options: CreateSessionOptions): CreateAgentOptions {
  if (options.provider === 'codex') {
    return {
      provider: 'codex',
      codex: options.codex,
      defaults: options.defaults,
    }
  }

  return {
    provider: 'claude',
    claude: options.claude,
    defaults: options.defaults,
  }
}

function toOpenSessionOptions(options: CreateSessionOptions): AgentOpenSessionOptions {
  const sessionOptions: AgentOpenSessionOptions = {}

  if (options.name !== undefined) sessionOptions.name = options.name
  if (options.cwd !== undefined) sessionOptions.cwd = options.cwd
  if (options.model !== undefined) sessionOptions.model = options.model
  if (options.env !== undefined) sessionOptions.env = options.env
  if (options.permissionMode !== undefined) sessionOptions.permissionMode = options.permissionMode
  if (options.additionalDirectories !== undefined) sessionOptions.additionalDirectories = options.additionalDirectories
  if (options.includePartialMessages !== undefined) {
    sessionOptions.includePartialMessages = options.includePartialMessages
  }

  return sessionOptions
}

function wrapSessionWithOwnedClient(session: AgentSession, client: AgentClient): AgentSession {
  const originalClose = session.close.bind(session)

  Object.defineProperty(session, 'close', {
    value: async () => {
      let sessionCloseError: unknown

      try {
        await originalClose()
      } catch (error) {
        sessionCloseError = error
      }

      try {
        await closePrivatelyOwnedClient(client)
      } catch (clientCloseError) {
        if (sessionCloseError) {
          throw sessionCloseError
        }
        throw clientCloseError
      }

      if (sessionCloseError) {
        throw sessionCloseError
      }
    },
  })
  return session
}

async function closePrivatelyOwnedClient(client: AgentClient): Promise<void> {
  await client.close()
}
