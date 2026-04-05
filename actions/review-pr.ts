import { defineAction } from '../server/action-runtime.ts'

export default defineAction({
  name: 'review-pr',
  description: 'Review a pull request or change set and summarize the most important risks.',
  async run(ctx, input) {
    await ctx.log('Running review-pr workflow')

    const payload = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
    const repo = typeof payload.repo === 'string' ? payload.repo : 'the current repository'
    const prNumber = typeof payload.prNumber === 'number' ? payload.prNumber : null
    const extra = typeof payload.instructions === 'string' ? payload.instructions : null

    const prompt = [
      `Review ${prNumber ? `PR #${prNumber}` : 'the current changes'} in ${repo}.`,
      'Focus on bugs, regressions, unsafe assumptions, and missing tests.',
      'Return findings first, ordered by severity, then give a short summary.',
      extra ? `Additional instructions: ${extra}` : null,
    ]
      .filter(Boolean)
      .join('\n')

    return ctx.runPrompt(prompt)
  },
})
