import { listModels } from '../src/index.ts'

let models: Awaited<ReturnType<typeof listModels>> = []

try {
  models = await listModels(undefined, { includeHidden: false })
} catch (error) {
  console.error('Failed to list models:', error)
}

const grouped = new Map<string, typeof models>()
for (const model of models) {
  const list = grouped.get(model.provider) ?? []
  list.push(model)
  grouped.set(model.provider, list)
}

for (const [provider, entries] of grouped.entries()) {
  console.log(`\n${provider.toUpperCase()} MODELS`)
  for (const model of entries) {
    const tags = [
      model.default ? 'default' : null,
      model.recommended ? 'recommended' : null,
      model.hidden ? 'hidden' : null,
      model.discovery.mode,
    ]
      .filter(Boolean)
      .join(', ')

    console.log(`- ${model.id} (${model.label})${tags ? ` [${tags}]` : ''}`)
  }
}
