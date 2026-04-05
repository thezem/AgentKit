import type { WorkflowActionDefinition } from './types.ts'

export function defineAction<Input = unknown, Output = unknown>(
  action: WorkflowActionDefinition<Input, Output>,
): WorkflowActionDefinition<Input, Output> {
  return action
}
