import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { listActions } from './action-loader.ts'
import { JobManager } from './jobs.ts'
import { CodexRuntime } from './runtime.ts'
import type { ServerConfig } from './types.ts'

export function createHttpServer(config: ServerConfig, runtime: CodexRuntime, jobs: JobManager): http.Server {
  return http.createServer(async (req, res) => {
    try {
      if (!authorize(req, config)) {
        return writeJson(res, 401, { error: 'Unauthorized' })
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const pathname = url.pathname

      if (req.method === 'GET' && pathname === '/health') {
        return handleHealth(res, runtime)
      }

      if (req.method === 'GET' && pathname === '/account') {
        return handleAccount(res, runtime)
      }

      if (req.method === 'GET' && pathname === '/actions') {
        const actions = await listActions(config.actionsDir)
        return writeJson(res, 200, {
          actions: actions.map((action) => ({
            name: action.name,
            kind: action.kind,
            description: 'description' in action ? action.description ?? null : null,
            path: 'path' in action ? action.path : null,
          })),
        })
      }

      if (req.method === 'GET' && pathname.startsWith('/jobs/')) {
        const id = pathname.slice('/jobs/'.length)
        const job = await jobs.getJob(id)
        if (!job) {
          return writeJson(res, 404, { error: `Job not found: ${id}` })
        }
        return writeJson(res, 200, job)
      }

      if (req.method === 'GET' && pathname === '/jobs') {
        return writeJson(res, 200, { jobs: await jobs.listJobs() })
      }

      if (req.method === 'POST' && pathname === '/run') {
        const body = await readJsonBody(req)
        const prompt = typeof body.prompt === 'string' ? body.prompt : null
        if (!prompt) {
          return writeJson(res, 400, { error: 'Expected JSON body with prompt:string' })
        }

        const wait = body.wait !== false
        const { job, completion } = await jobs.createPromptJob({
          prompt,
          cwd: typeof body.cwd === 'string' ? body.cwd : null,
          options: isPlainObject(body.options) ? body.options : undefined,
        })

        if (!wait) {
          return writeJson(res, 202, { jobId: job.id, status: job.status })
        }

        const completed = await completion
        return writeJson(res, completed.status === 'completed' ? 200 : 500, completed)
      }

      if (req.method === 'POST' && pathname.startsWith('/actions/')) {
        const name = pathname.slice('/actions/'.length)
        const body = await readJsonBody(req)
        const wait = body.wait !== false

        const { job, completion } = await jobs.createActionJob({
          name,
          input: body.input,
          cwd: typeof body.cwd === 'string' ? body.cwd : null,
          options: isPlainObject(body.options) ? body.options : undefined,
        })

        if (!wait) {
          return writeJson(res, 202, { jobId: job.id, status: job.status })
        }

        const completed = await completion
        return writeJson(res, completed.status === 'completed' ? 200 : 500, completed)
      }

      return writeJson(res, 404, { error: 'Not found' })
    } catch (error) {
      return writeJson(res, 500, { error: asErrorMessage(error) })
    }
  })
}

async function handleHealth(res: ServerResponse, runtime: CodexRuntime): Promise<void> {
  try {
    const account = await runtime.getAccount()
    writeJson(res, 200, {
      ok: true,
      authenticated: account.account !== null,
      account,
    })
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: asErrorMessage(error),
    })
  }
}

async function handleAccount(res: ServerResponse, runtime: CodexRuntime): Promise<void> {
  const account = await runtime.getAccount()
  writeJson(res, 200, account)
}

function authorize(req: IncomingMessage, config: ServerConfig): boolean {
  if (!config.apiKey) {
    return true
  }

  const authHeader = req.headers.authorization
  if (authHeader === `Bearer ${config.apiKey}`) {
    return true
  }

  const headerKey = req.headers['x-codexkit-key']
  return headerKey === config.apiKey
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) {
    return {}
  }

  const parsed = JSON.parse(raw) as unknown
  if (!isPlainObject(parsed)) {
    throw new Error('Expected JSON object body')
  }

  return parsed
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(payload))
  res.end(payload)
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
