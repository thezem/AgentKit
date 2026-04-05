import { loadConfig } from './config.ts'
import { createHttpServer } from './http.ts'
import { JobManager } from './jobs.ts'
import { CodexRuntime } from './runtime.ts'

const config = await loadConfig()
const runtime = new CodexRuntime(config)
const jobs = new JobManager(config, runtime)
const server = createHttpServer(config, runtime, jobs)

server.listen(config.port, config.host, () => {
  console.log(`codexkit-server listening on http://${config.host}:${config.port}`)
  console.log(`actions dir: ${config.actionsDir}`)
  console.log(`default cwd: ${config.defaultCwd}`)
  if (config.apiKey) {
    console.log('api auth: enabled')
  } else {
    console.log('api auth: disabled')
  }
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(async () => {
      await runtime.close()
      process.exit(0)
    })
  })
}
