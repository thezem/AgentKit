import type { CodexClient, CodexThread, RunResult, ThreadOptions } from '../src/index.ts'

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed'

export type JobRecord = {
  id: string
  kind: 'prompt' | 'action'
  actionName: string | null
  cwd: string | null
  input: unknown
  status: JobStatus
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  logs: Array<{ at: string; message: string }>
  result: unknown
  error: string | null
}

export type PromptActionDefinition = {
  kind: 'prompt'
  name: string
  path: string
  description: string | null
  prompt: string
}

export type WorkflowActionContext = {
  codex: CodexClient
  config: ServerConfig
  job: JobRecord
  cwd: string | null
  log: (message: string) => Promise<void>
  createThread: (options?: ThreadOptions) => Promise<CodexThread>
  runPrompt: (prompt: string, options?: ThreadOptions) => Promise<RunResult>
}

export type WorkflowActionDefinition<Input = unknown, Output = unknown> = {
  kind?: 'workflow'
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  run: (ctx: WorkflowActionContext, input: Input) => Promise<Output> | Output
}

export type ActionDefinition = PromptActionDefinition | WorkflowActionDefinition

export type ServerConfig = {
  host: string
  port: number
  apiKey: string | null
  codexPath?: string
  actionsDir: string
  dataDir: string
  jobsDir: string
  defaultCwd: string
  defaultModel?: string
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'never' | 'on-request' | 'on-failure' | 'untrusted'
}
