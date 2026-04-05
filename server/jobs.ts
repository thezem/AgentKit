import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import type { RunResult, ThreadOptions } from '../src/index.ts'
import { loadActionByName } from './action-loader.ts'
import { CodexRuntime } from './runtime.ts'
import type {
  ActionDefinition,
  JobRecord,
  PromptActionDefinition,
  ServerConfig,
  WorkflowActionContext,
  WorkflowActionDefinition,
} from './types.ts'

type PromptJobRequest = {
  prompt: string
  cwd?: string | null
  options?: ThreadOptions
}

type ActionJobRequest = {
  name: string
  input?: unknown
  cwd?: string | null
  options?: ThreadOptions
}

export class JobManager {
  private readonly config: ServerConfig
  private readonly runtime: CodexRuntime
  private readonly jobs = new Map<string, JobRecord>()
  private queue: Promise<void> = Promise.resolve()

  constructor(config: ServerConfig, runtime: CodexRuntime) {
    this.config = config
    this.runtime = runtime
  }

  async createPromptJob(request: PromptJobRequest): Promise<{ job: JobRecord; completion: Promise<JobRecord> }> {
    const job = this.makeJob({
      kind: 'prompt',
      actionName: null,
      cwd: request.cwd ?? null,
      input: request,
    })

    const completion = this.enqueue(job, async () => {
      await this.log(job, 'Starting prompt job')
      const result = await this.runtime.runPrompt(request.prompt, request.cwd, request.options)
      job.result = serializeRunResult(result)
      await this.log(job, 'Prompt job completed')
    })

    return { job, completion }
  }

  async createActionJob(request: ActionJobRequest): Promise<{ job: JobRecord; completion: Promise<JobRecord> }> {
    const action = await loadActionByName(this.config.actionsDir, request.name)
    if (!action) {
      throw new Error(`Unknown action: ${request.name}`)
    }

    const job = this.makeJob({
      kind: 'action',
      actionName: action.name,
      cwd: request.cwd ?? null,
      input: request.input ?? null,
    })

    const completion = this.enqueue(job, async () => {
      await this.log(job, `Starting action ${action.name}`)
      job.result = await this.runAction(action, job, request)
      await this.log(job, `Action ${action.name} completed`)
    })

    return { job, completion }
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const inMemory = this.jobs.get(id)
    if (inMemory) return inMemory

    try {
      const file = path.join(this.config.jobsDir, `${id}.json`)
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw) as JobRecord
      this.jobs.set(id, parsed)
      return parsed
    } catch {
      return null
    }
  }

  async listJobs(): Promise<JobRecord[]> {
    const entries = await readdir(this.config.jobsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -'.json'.length)
      if (this.jobs.has(id)) continue
      await this.getJob(id)
    }

    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  private makeJob(input: Pick<JobRecord, 'kind' | 'actionName' | 'cwd' | 'input'>): JobRecord {
    const now = new Date().toISOString()
    const job: JobRecord = {
      id: randomUUID(),
      kind: input.kind,
      actionName: input.actionName,
      cwd: input.cwd,
      input: input.input,
      status: 'queued',
      createdAt: now,
      startedAt: null,
      completedAt: null,
      logs: [],
      result: null,
      error: null,
    }

    this.jobs.set(job.id, job)
    void this.persist(job)
    return job
  }

  private enqueue(job: JobRecord, run: () => Promise<void>): Promise<JobRecord> {
    const completion = this.queue.then(async () => {
      job.status = 'running'
      job.startedAt = new Date().toISOString()
      await this.persist(job)

      try {
        await run()
        job.status = 'completed'
      } catch (error) {
        job.status = 'failed'
        job.error = asErrorMessage(error)
        await this.log(job, `Job failed: ${job.error}`)
      } finally {
        job.completedAt = new Date().toISOString()
        await this.persist(job)
      }
    })

    this.queue = completion.then(() => undefined, () => undefined)
    return completion.then(() => job)
  }

  private async runAction(
    action: ActionDefinition,
    job: JobRecord,
    request: ActionJobRequest,
  ): Promise<unknown> {
    if (action.kind === 'prompt') {
      return this.runPromptAction(action, request)
    }

    return this.runWorkflowAction(action, job, request)
  }

  private async runPromptAction(action: PromptActionDefinition, request: ActionJobRequest): Promise<unknown> {
    const prompt = buildPromptFromTemplate(action.prompt, request.input)
    const result = await this.runtime.runPrompt(prompt, request.cwd, request.options)
    return serializeRunResult(result)
  }

  private async runWorkflowAction(
    action: WorkflowActionDefinition,
    job: JobRecord,
    request: ActionJobRequest,
  ): Promise<unknown> {
    const codex = await this.runtime.getClient()
    const cwd = request.cwd ?? this.config.defaultCwd

    const ctx: WorkflowActionContext = {
      codex,
      config: this.config,
      job,
      cwd,
      log: async (message) => {
        await this.log(job, message)
      },
      createThread: async (options) => {
        return codex.threads.create({
          cwd,
          model: options?.model ?? this.config.defaultModel,
          sandboxMode: options?.sandboxMode ?? this.config.sandboxMode,
          approvalPolicy: options?.approvalPolicy ?? this.config.approvalPolicy,
          reasoningEffort: options?.reasoningEffort,
          reasoningSummary: options?.reasoningSummary,
          personality: options?.personality,
          config: options?.config,
          baseInstructions: options?.baseInstructions,
          developerInstructions: options?.developerInstructions,
          ephemeral: options?.ephemeral,
          persistExtendedHistory: options?.persistExtendedHistory,
        })
      },
      runPrompt: async (prompt, options) => {
        return this.runtime.runPrompt(prompt, cwd, options)
      },
    }

    return action.run(ctx, request.input)
  }

  private async log(job: JobRecord, message: string): Promise<void> {
    job.logs.push({ at: new Date().toISOString(), message })
    await this.persist(job)
  }

  private async persist(job: JobRecord): Promise<void> {
    const file = path.join(this.config.jobsDir, `${job.id}.json`)
    await writeFile(file, `${JSON.stringify(job, null, 2)}\n`, 'utf8')
  }
}

function buildPromptFromTemplate(template: string, input: unknown): string {
  if (input === undefined || input === null) {
    return template
  }

  return `${template}\n\nInput:\n${JSON.stringify(input, null, 2)}`
}

function serializeRunResult(result: RunResult): Record<string, unknown> {
  return {
    threadId: result.threadId,
    turnId: result.turnId,
    status: result.status,
    text: result.text,
    items: result.items,
  }
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
