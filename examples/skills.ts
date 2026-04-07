import { listSkills } from '../src/index.ts'

try {
  const codexSkills = await listSkills('codex', {
    cwd: process.cwd(),
    forceReload: false,
  })

  console.log('CODEX SKILLS')
  for (const skill of codexSkills) {
    const enabled = skill.enabled === undefined ? 'unknown' : skill.enabled ? 'enabled' : 'disabled'
    console.log(`- ${skill.name} (${enabled})${skill.path ? ` @ ${skill.path}` : ''}`)
  }
} catch (error) {
  console.error('Failed to list Codex skills:', error)
}

try {
  await listSkills('claude')
} catch (error) {
  console.log('\nClaude skill listing unsupported (expected in Phase 2):')
  console.log(error instanceof Error ? error.message : String(error))
}
