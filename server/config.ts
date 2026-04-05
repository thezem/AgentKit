import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { ServerConfig } from './types.ts'

export async function loadConfig(): Promise<ServerConfig> {
  const rootDir = process.cwd()
  const dataDir = path.resolve(process.env.CODEXKIT_DATA_DIR ?? path.join(rootDir, 'data'))
  const jobsDir = path.join(dataDir, 'jobs')
  const actionsDir = path.resolve(process.env.CODEXKIT_ACTIONS_DIR ?? path.join(rootDir, 'actions'))

  await mkdir(dataDir, { recursive: true })
  await mkdir(jobsDir, { recursive: true })
  await mkdir(actionsDir, { recursive: true })

  const host = process.env.HOST ?? process.env.CODEXKIT_HOST ?? '127.0.0.1'
  const apiKey = process.env.CODEXKIT_API_KEY ?? null
  const allowInsecure = process.env.CODEXKIT_ALLOW_INSECURE === 'true'

  if (!apiKey && host !== '127.0.0.1' && host !== 'localhost' && !allowInsecure) {
    throw new Error(
      'Refusing to bind Codexkit server to a non-local host without CODEXKIT_API_KEY. Set CODEXKIT_API_KEY or CODEXKIT_ALLOW_INSECURE=true.',
    )
  }

  return {
    host,
    port: Number(process.env.PORT ?? process.env.CODEXKIT_PORT ?? '3789'),
    apiKey,
    codexPath: process.env.CODEXKIT_CODEX_PATH,
    actionsDir,
    dataDir,
    jobsDir,
    defaultCwd: path.resolve(process.env.CODEXKIT_DEFAULT_CWD ?? rootDir),
    defaultModel: process.env.CODEXKIT_MODEL,
    sandboxMode: parseSandboxMode(process.env.CODEXKIT_SANDBOX_MODE),
    approvalPolicy: parseApprovalPolicy(process.env.CODEXKIT_APPROVAL_POLICY),
  }
}

function parseSandboxMode(value: string | undefined): ServerConfig['sandboxMode'] {
  if (value === 'read-only' || value === 'danger-full-access') {
    return value
  }

  return 'workspace-write'
}

function parseApprovalPolicy(value: string | undefined): ServerConfig['approvalPolicy'] {
  if (value === 'on-request' || value === 'on-failure' || value === 'untrusted') {
    return value
  }

  return 'never'
}
