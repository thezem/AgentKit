import type { AgentModelInfo } from '../agent-types.ts'

const CLAUDE_CURATED_MODELS: Array<Omit<AgentModelInfo, 'provider' | 'discovery' | 'available'>> = [
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    family: 'sonnet',
    description: 'Balanced model for most coding and agent workflows.',
    recommended: true,
    default: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    supportsPersonality: true,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    family: 'opus',
    description: 'Higher-capability model for complex tasks.',
    reasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    supportsPersonality: true,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    family: 'haiku',
    description: 'Faster, lower-latency model for lighter tasks.',
    reasoningEfforts: ['low', 'medium'],
    defaultReasoningEffort: 'low',
    inputModalities: ['text', 'image'],
    supportsPersonality: true,
  },
]

export function listClaudeModels(): AgentModelInfo[] {
  return CLAUDE_CURATED_MODELS.map((model) => ({
    provider: 'claude',
    ...model,
    available: true,
    discovery: {
      mode: 'static',
      source: 'curated-catalog',
      stale: true,
    },
  }))
}
