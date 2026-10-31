import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createAgentKit, type AgentSession, type ProviderId } from '../../src/index.ts'

const providers: ProviderId[] = process.argv.slice(2).length ? process.argv.slice(2) : ['mock']
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms) })])
  } finally { if (timer) clearTimeout(timer) }
}
async function until(test: () => boolean, ms = 15000) { const end = Date.now() + ms; while (!test()) { if (Date.now() > end) throw new Error('timed out'); await sleep(25) } }
const dir = mkdtempSync(path.join(os.tmpdir(), 'agentkit-goals-'))
const file = path.join(dir, 'goals.db')
const results: Array<{ name: string; ok: boolean; detail?: string; skipped?: boolean }> = []
async function check(name: string, f: () => Promise<void>) {
  if (process.env.AGENTKIT_GOAL_CHECK && !name.includes(process.env.AGENTKIT_GOAL_CHECK)) return
  try { await f(); results.push({ name, ok: true }); console.log(`✓ ${name}`) }
  catch (error) { const detail = error instanceof Error ? error.message : String(error); results.push({ name, ok: false, detail }); console.error(`✗ ${name}: ${detail}`) }
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function rejectCode(f: () => Promise<unknown>, code: string) { try { await f() } catch (e: any) { if (e.code === code) return; throw e } throw new Error(`expected ${code}`) }
async function codexGoals() {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  const kit = createAgentKit({ store: file, hub: false })
  // Exercise the candidate capsule before its capability flags are enabled.
  Object.assign(kit.capabilities('codex'), { goals: true, goalPause: true, goalBudget: true })
  const events: any[] = []
  const s = await kit.session({ provider: 'codex', cwd: dir, key: 'codex-goals', model: 'gpt-5.6-luna', thinking: 'low', access: 'full-access', onEvent: e => events.push(e) })
  let stopping: Promise<void> | undefined
  let started = 0
  await check('codex: unknown goal status', async () => {
    const native = s.native as any
    native.rpc.onNotification('thread/goal/updated', { threadId: s.id, goal: { objective: 'future status', status: 'futureStatus', tokensUsed: 0, updatedAt: Math.floor(Date.now() / 1000) } })
    assert(s.transcript.goal?.status === 'blocked' && s.transcript.goal.reason === 'unknown Codex status: futureStatus', 'unknown status was not exposed safely')
    native.rpc.onNotification('thread/goal/cleared', { threadId: s.id })
  })
  await check('codex: continuation and stop race', async () => {
    const off = s.on(e => {
      if (e.type === 'turn_started' && ++started === 2) stopping = s.interrupt()
    })
    await s.setGoal('In exactly three separate turns create one file per turn: a.txt containing A, then b.txt containing B, then c.txt containing C. End each turn immediately after creating its single file. Keep this goal active until all three files exist.', { tokenBudget: 70000 })
    await until(() => !!stopping, 90000)
    await stopping
    await until(() => !s.isRunning, 20000)
    assert((await s.getGoal())?.status === 'paused', `goal was not paused: ${JSON.stringify(await s.getGoal())}`)
    const count = started
    await sleep(10000)
    assert(started === count && !s.isRunning, `turn started after Stop: ${count} -> ${started}`)
    const starts = events.filter(e => e.type === 'turn_started')
    const ends = events.filter(e => ['turn_completed', 'turn_canceled', 'turn_failed'].includes(e.type))
    assert(starts.length === 2 && ends.length === 2, `expected two distinct adopted turns and terminals: ${starts.length}/${ends.length}`)
    assert(new Set(starts.map(e => e.turnId)).size === 2, 'duplicate adopted turn')
    const stored = kit.store!.loadTranscript(s.key)
    assert(stored.items.some(i => i.type === 'tool_call') && s.transcript.items.some(i => i.type === 'tool_call'), 'goal work absent from live/store transcript')
    assert(events.some(e => e.type === 'usage'), 'goal turn usage missing')
    assert(existsSync(path.join(dir, 'a.txt')), 'first goal turn did not create a.txt')
    off()
  })
  await check('codex: fork does not inherit goal', async () => {
    const fork = await s.fork()
    assert(await fork.getGoal() === null && fork.transcript.goal === null, 'fork inherited goal')
    await fork.close()
  })
  await check('codex: resume goal', async () => {
    const goal = await s.getGoal()
    assert(goal?.status === 'paused', `expected paused, got ${goal?.status}`)
    await s.resumeGoal()
    await until(() => s.transcript.goal?.status === 'complete' || s.transcript.goal?.status === 'limited' || s.transcript.goal?.status === 'blocked', 90000)
    await until(() => !s.isRunning, 30000)
    assert(s.transcript.goal?.status === 'complete', `goal did not complete: ${JSON.stringify(s.transcript.goal)}`)
    for (const [name, content] of [['a.txt','A'],['b.txt','B'],['c.txt','C']]) assert(readFileSync(path.join(dir, name), 'utf8').trim() === content, `${name} missing or wrong`)
  })
  await check('codex: budget limit and next prompt', async () => {
    await s.clearGoal()
    let n = 0
    const off = s.on(e => { if (e.type === 'turn_started') n++ })
    await s.setGoal('Answer with one short greeting.', { tokenBudget: 1 })
    await until(() => s.transcript.goal?.status === 'limited', 60000)
    await until(() => !s.isRunning, 30000)
    const before = n
    await sleep(3000)
    assert(n === before, 'budget-limited goal started another turn')
    const result = await s.run('Reply with exactly OK.')
    assert(result.status === 'completed' && /OK/i.test(result.finalText), `next prompt failed: ${JSON.stringify(result)}`)
    assert(n === before + 1, 'host turn swallowed or counted twice')
    off()
  })
  await check('codex: active idle handoff and failed start recovery', async () => {
    await s.clearGoal()
    await s.setGoal('Create handoff-a.txt containing A, then handoff-b.txt containing B in separate turns; keep working until both exist.', { tokenBudget: 65000 })
    await until(() => s.isRunning, 30000)
    await s.native.interrupt()
    assert((await s.getGoal())?.status === 'active' && !s.isRunning, 'could not establish an active idle goal')
    const native = s.native as any
    const rpc = native.rpc
    const request = rpc.request.bind(rpc)
    let failedStart = false
    rpc.request = (method: string, params: any, ...rest: any[]) => {
      if (method === 'turn/start' && !failedStart) {
        failedStart = true
        return Promise.reject(new Error('injected turn/start failure'))
      }
      return request(method, params, ...rest)
    }
    try {
      const failed = await s.submit('This request must fail before it reaches Codex.')
      let rejected = false
      try { await bounded(failed.result, 30000) } catch (error) { rejected = String(error).includes('injected turn/start failure') }
      assert(rejected && failedStart, 'turn/start failure was not propagated')
    } finally { rpc.request = request }
    assert((await s.getGoal())?.status === 'active', 'goal was not restored after failed turn/start')
    await until(() => s.isRunning, 30000)
    await s.native.interrupt()
    assert((await s.getGoal())?.status === 'active' && !s.isRunning, 'failed to re-establish active idle goal')

    let raced = false
    let internalCancels = 0
    const cancel = native.cancelTurn.bind(native)
    native.cancelTurn = async (id: string) => { if (native.goalHandoff) internalCancels++; return cancel(id) }
    const prior = events.length
    rpc.request = async (method: string, params: any, ...rest: any[]) => {
      if (method === 'thread/goal/set' && params.status === 'paused' && !raced) {
        raced = true
        const oldStarts = events.filter(e => e.type === 'turn_started').length
        await request('thread/goal/set', { threadId: s.id, status: 'active', origin: 'user' })
        await until(() => events.filter(e => e.type === 'turn_started').length > oldStarts, 30000)
      }
      if (method === 'turn/interrupt' && raced && native.goalHandoff) await sleep(250)
      return request(method, params, ...rest)
    }
    let result: Awaited<ReturnType<typeof s.run>>
    try {
      const submitted = await s.submit('Reply with exactly HANDOFF_OK.')
      result = await bounded(submitted.result, 30000)
    } finally { rpc.request = request; native.cancelTurn = cancel }
    assert(raced && internalCancels > 0, 'live goal-turn cancellation race did not occur')
    assert(result.status === 'completed' && /HANDOFF_OK/.test(result.finalText), `host prompt did not complete: ${JSON.stringify(result)}`)
    const turns = events.slice(prior).filter(e => e.type === 'turn_started')
    assert(turns.length >= 2 && turns[0].turnId !== result.turnId, 'host prompt was merged into goal turn')
    await until(() => s.transcript.goal?.status === 'active', 10000)
    assert((await s.getGoal())?.status === 'active', 'goal was not resumed after host turn')
    await s.interrupt()
    await s.clearGoal()
  })
  await check('codex: queued submit alongside goal', async () => {
    await s.clearGoal()
    await until(() => !s.busy, 15000)
    const first = events.length
    await s.setGoal('Give a brief greeting, then mark this goal complete.', { tokenBudget: 12000 })
    const submission = await s.submit('Reply with exactly QUEUEOK.')
    const result = await Promise.race([submission.result, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('queued submit timed out')), 60000); timer.unref() })])
    assert(result.status === 'completed' && /QUEUEOK/i.test(result.finalText), `queued submit failed: ${JSON.stringify(result)}`)
    await until(() => s.transcript.goal?.status === 'complete' && !s.isRunning, 60000)
    const observed = events.slice(first)
    const hostStart = observed.findIndex(e => e.type === 'turn_started' && e.turnId === result.turnId)
    const hostEnd = observed.findIndex(e => e.type === 'turn_completed' && e.turnId === result.turnId)
    const paused = observed.findIndex(e => e.type === 'goal_updated' && e.goal?.status === 'paused')
    const resumed = observed.findIndex((e, i) => i > hostEnd && e.type === 'goal_updated' && e.goal?.status === 'active')
    const completed = observed.find(e => e.type === 'goal_updated' && e.goal?.status === 'complete')
    const hostMessages = observed.filter(e => e.type === 'timeline' && e.turnId === result.turnId)
    assert(hostMessages.some(e => e.item.type === 'user_message' && e.item.text === 'Reply with exactly QUEUEOK.'), 'queued user message missing from host turn')
    assert(hostMessages.filter(e => e.item.type === 'assistant_message').map(e => e.item.text).join('').includes('QUEUEOK'), 'reply missing from host turn')
    const otherText = observed.filter(e => e.type === 'timeline' && e.turnId && e.turnId !== result.turnId && (e.item.type === 'user_message' || e.item.type === 'assistant_message')).map(e => e.item.text).join('')
    assert(!otherText.includes('QUEUEOK'), 'queued text appeared in another turn')
    assert(paused >= 0 && paused < hostStart && hostEnd >= hostStart && resumed > hostEnd, 'goal did not pause before and resume after the host turn')
    assert(completed?.turnId && completed.turnId !== result.turnId, 'goal did not complete in a separate turn')
    const stored = kit.store!.loadTranscript(s.key)
    assert(stored.items.some(i => i.type === 'user_message' && i.text.includes('QUEUEOK')), 'queued prompt missing from store')
  })
  await check('codex: cold resume pauses before thread resume', async () => {
    const crash = await kit.session({ provider: 'codex', cwd: dir, key: 'codex-restart', model: 'gpt-5.6-luna', thinking: 'low', access: 'full-access' })
    await crash.setGoal('Carefully inspect the current directory, then describe it in a few words.', { tokenBudget: 10000 })
    const handle = crash.handle!
    const native = crash.native as any
    const rpc = native.rpc
    const before = readdirSync(dir).sort().join(',')
    process.kill(rpc.child.pid, 'SIGKILL')
    await rpc.exited
    const resumedEvents: any[] = []
    const resumed = await kit.resume(handle, { key: 'codex-restart-resumed', model: 'gpt-5.6-luna', thinking: 'low', access: 'full-access', onEvent: e => resumedEvents.push(e) })
    assert((await resumed.getGoal())?.status === 'paused', `cold resume goal: ${JSON.stringify(await resumed.getGoal())}`)
    await sleep(10000)
    assert(!resumed.isRunning && !resumedEvents.some(e => e.type === 'turn_started'), 'a turn started after resume')
    assert(readdirSync(dir).sort().join(',') === before, 'files changed during resume')
    await resumed.clearGoal()
    await resumed.close()
    await crash.close()
  })
  await s.clearGoal().catch(() => undefined)
  await kit.shutdown()
  writeFileSync(path.join(dir, 'codex-events.json'), JSON.stringify(events, null, 2))
  results.push({ name: 'codex: evidence', ok: true, detail: `events=${path.join(dir, 'codex-events.json')}, files=${readdirSync(dir).join(',')}` })
}

async function claudeGoals() {
  const kit = createAgentKit({ store: file, hub: false, claude: { settingSources: ['project'], sdkOptions: { maxTurns: process.env.AGENTKIT_CLAUDE_REVIEW ? 1 : 5, maxBudgetUsd: 0.1 } } })
  // Test the candidate before enabling its shipped capability.
  Object.assign(kit.capabilities('claude'), { goals: true, goalPause: false, goalBudget: false })
  const events: any[] = []
  const sdkResults: Array<{ subtype: string; numTurns: number }> = []
  let modelTurns = 0
  const modelTurnLimit = process.env.AGENTKIT_CLAUDE_REVIEW ? 8 : 15
  const observe = (session: AgentSession) => {
    const native = session.native as any
    const original = native.onMessage.bind(native)
    native.onMessage = (message: any) => {
      if (message.type === 'result') {
        const n = message.num_turns ?? 0
        modelTurns += n
        sdkResults.push({ subtype: message.subtype, numTurns: n })
        if (modelTurns > modelTurnLimit) void session.interrupt()
      }
      original(message)
    }
  }
  const must = async (name: string, fn: () => Promise<void>) => {
    if (process.env.AGENTKIT_GOAL_CHECK && !name.includes(process.env.AGENTKIT_GOAL_CHECK)) return
    await check(name, fn)
    if (!results.at(-1)?.ok) throw new Error(`stopping after ${name}`)
    if (modelTurns > modelTurnLimit) throw new Error(`model turn budget exceeded: ${modelTurns}`)
  }
  let s: AgentSession | undefined
  let resumed: AgentSession | undefined
  try {
    s = await kit.session({ provider: 'claude', cwd: dir, key: 'claude-goals', model: 'haiku', access: 'full-access', onEvent: e => events.push(e) })
    observe(s)
    if (process.env.AGENTKIT_CLAUDE_REVIEW) {
      await must('claude review: max turns clears and holds goal', async () => {
        await s!.setGoal('Count aloud from 1 to 1000000, one number per response; the goal is complete only after reaching 1000000. Do not use tools.')
        await until(() => !s!.isRunning, 90000)
        const goal = await s!.getGoal()
        assert(goal?.status === 'paused', `unfinished goal not paused: ${JSON.stringify(goal)}`)
        assert((await (s!.native as any).goalControl('/goal')).startsWith('No goal set'), 'native goal still active')
        assert(goal.reason, 'paused goal has no reason')
        await s!.clearGoal()
      })
      await must('claude review: timeout preserves terminal event', async () => {
        const native = s!.native as any
        const original = native.onMessage.bind(native)
        native.onMessage = (message: any) => {
          if (native.goalCommand && (message.type === 'result' || message.local_command_source)) return
          original(message)
        }
        try {
          const before = events.length
          await s!.setGoal('Say hello, then count to 1000000 one number per response, with no tools.')
          await until(() => !s!.isRunning, 90000)
          const recent = events.slice(before)
          assert(recent.some(e => e.type === 'turn_completed' || e.type === 'turn_failed'), 'original terminal event missing')
          assert(recent.some(e => e.type === 'timeline' && e.item.type === 'notice' && e.item.level === 'warning'), 'timeout warning missing')
          assert(s!.transcript.goal?.reason?.includes('not confirmed'), 'unconfirmed mirror missing')
        } finally {
          native.onMessage = original
        }
        await s!.clearGoal()
      })
      await must('claude review: control serializes turn and maps errors', async () => {
        const native = s!.native as any
        const original = native.onMessage.bind(native)
        const pending: any[] = []
        native.onMessage = (message: any) => {
          if (native.goalCommand && (message.type === 'result' || message.local_command_source)) pending.push(message)
          else original(message)
        }
        try {
          const reading = s!.getGoal()
          await until(() => pending.some(m => m.type === 'result'), 15000)
          await rejectCode(() => native.startTurn('must not be swallowed'), 'CLAUDE_GOAL_PROTOCOL')
          for (const message of pending) original(message)
          await reading
        } finally {
          native.onMessage = original
        }
        const control = native.goalControl.bind(native)
        native.goalControl = async () => 'unrecognized status'
        try {
          await rejectCode(() => s!.getGoal(), 'GOAL_PROTOCOL')
        } finally {
          native.goalControl = control
        }
      })
      await must('claude review: protocol failure cannot block Stop', async () => {
        await s!.setGoal('Count from 1 to 1000000 slowly without tools, one number per response.')
        const native = s!.native as any
        const original = native.getGoal.bind(native)
        native.getGoal = async () => { throw Object.assign(new Error('bad status'), { code: 'CLAUDE_GOAL_PROTOCOL' }) }
        try {
          await s!.interrupt()
          await until(() => !s!.isRunning, 20000)
          assert(events.some(e => e.type === 'turn_canceled'), 'Stop did not cancel the turn')
        } finally {
          native.getGoal = original
        }
        await s!.clearGoal()
      })
    }
    await must('claude: completion and private command transcript', async () => {
      let starts = 0
      const off = s!.on(e => { if (e.type === 'turn_started') starts++ })
      await s!.setGoal('The file proof.txt contains exactly done. First say hello and end your first response without writing files; after the stop check asks you to continue, create and read the file to verify it.')
      await until(() => s!.transcript.goal?.status === 'complete' || s!.transcript.status === 'failed', 120000)
      await until(() => !s!.isRunning, 30000)
      assert(s!.transcript.goal?.status === 'complete', `not complete: ${JSON.stringify(s!.transcript.goal)}`)
      assert(readFileSync(path.join(dir, 'proof.txt'), 'utf8').trim() === 'done', 'goal file not verified')
      assert(starts === 1, `goal produced ${starts} host turns`)
      assert(!s!.transcript.items.some(i => i.type === 'user_message' || i.type === 'assistant_message' && /^(Goal set:|Goal active:|No goal set)/.test(i.text)), 'local command leaked into live transcript')
      const history = await s!.history()
      assert(!history.some(i => i.type === 'user_message' && /<command-name>\/goal<\/command-name>/.test(i.text)), 'local goal command leaked into replay')
      assert((await s!.getGoal())?.status === 'complete', 'completion mirror lost')
      off()
    })
    await must('claude: typed parsing and budget guard', async () => {
      await rejectCode(() => s!.setGoal('budget', { tokenBudget: 1 }), 'UNSUPPORTED_CAPABILITY')
      const native = s!.native as any
      const original = native.goalControl.bind(native)
      native.goalControl = async () => 'unexpected goal status format'
      try { await rejectCode(() => s!.getGoal(), 'GOAL_PROTOCOL') } finally { native.goalControl = original }
    })
    await must('claude: stop clears native goal and permits normal prompt', async () => {
      await s!.clearGoal()
      const goal = await s!.setGoal('First carefully plan, then create stopped-proof.txt containing done.')
      assert(goal.status === 'active', 'goal not active')
      const native = s!.native as any
      let reads = 0
      const control = native.goalControl.bind(native)
      native.goalControl = async (...args: any[]) => { reads++; return control(...args) }
      try {
        const current = await s!.getGoal()
        assert(current?.status === 'active' && reads === 0, 'getGoal disturbed the running turn')
      } finally { native.goalControl = control }
      await s!.interrupt()
      assert((await s!.getGoal())?.status === 'paused', `Stop goal: ${JSON.stringify(await s!.getGoal())}`)
      assert(await s!.native.getGoal!() === null, 'native goal survived Stop')
      const n = events.filter(e => e.type === 'turn_started').length
      await sleep(10000)
      assert(!s!.isRunning && events.filter(e => e.type === 'turn_started').length === n, 'goal continued after Stop')
      const result = await s!.run('Reply exactly PING.')
      assert(result.status === 'completed' && /PING/i.test(result.finalText), `normal prompt failed: ${result.status}`)
    })
    await must('claude: replacement, fork and resume', async () => {
      await until(() => !s!.busy, 10000)
      const replacement = await s!.setGoal('Plan carefully, then create replacement-proof.txt containing done.')
      assert(replacement.objective.startsWith('Plan carefully'), 'replacement objective missing')
      await s!.native.interrupt()
      assert((await s!.native.getGoal!())?.status === 'active', 'native goal did not survive interrupt')
      const handle = s!.handle!
      await (s!.native as any).stopQuery()
      const fork = await s!.fork()
      assert(await fork.getGoal() === null && fork.transcript.goal === null, 'fork inherited goal')
      await fork.close()
      resumed = await kit.resume(handle, { key: 'claude-resumed', model: 'haiku', access: 'full-access' })
      observe(resumed)
      const held = await resumed.getGoal()
      assert(held?.status === 'paused' && held.objective === replacement.objective, `resume did not hold goal: ${JSON.stringify(held)}`)
      assert(await resumed.native.getGoal!() === null, 'native goal not cleared on resume')
      let starts = 0
      const off = resumed.on(e => { if (e.type === 'turn_started') starts++ })
      await sleep(10000)
      assert(starts === 0 && !resumed.isRunning, 'goal continued after resume')
      off()
      await resumed.clearGoal()
    })
  } catch (error) {
    if (!results.some(r => !r.ok)) results.push({ name: 'claude: setup or budget', ok: false, detail: String(error) })
  } finally {
    await resumed?.close().catch(() => undefined)
    await s?.close().catch(() => undefined)
    await kit.shutdown()
    writeFileSync(path.join(dir, 'claude-events.json'), JSON.stringify({ events, sdkResults, modelTurns }, null, 2))
    results.push({ name: 'claude: evidence', ok: true, detail: `modelTurns=${modelTurns}, events=${path.join(dir, 'claude-events.json')}` })
  }
}

async function opencodeGoals() {
  const model = process.env.AGENTKIT_E2E_OPENCODE_MODEL ?? 'opencode/deepseek-v4.1-flash-free'
  const kit = createAgentKit({ store: file, hub: false })
  Object.assign(kit.capabilities('opencode'), { goals: true, goalPause: true, goalBudget: false })
  const events: any[] = []
  const raw: any[] = []
  let steps = 0
  let s: AgentSession | undefined
  let restored: AgentSession | undefined
  let recoveredKit: ReturnType<typeof createAgentKit> | undefined
  let kitClosed = false
  const observe = (session: AgentSession) => {
    const native = session.native as any
    const original = native.observe.bind(native)
    native.observe = (event: any) => {
      if (event.data?.sessionID === session.id && (event.type.startsWith('session.execution.') || event.type === 'session.step.started' || event.type === 'rpc.opencode.goal.changed')) {
        raw.push(event)
        if (event.type === 'session.step.started' && ++steps >= 12) void session.interrupt()
      }
      original(event)
    }
  }
  const must = async (name: string, f: () => Promise<void>) => {
    try {
      await f()
      if (steps > 12) throw new Error(`model turn limit exceeded: ${steps}`)
      results.push({ name, ok: true })
      console.log(`✓ ${name}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const usageLimited = /free usage limit|usage limit reached|status.?429|http.?429|rate limit/i.test(detail)
      results.push({ name, ok: false, detail, ...(usageLimited ? { skipped: true } : {}) })
      console.error(`${usageLimited ? 'SKIPPED-blocked' : '✗'} ${name}: ${detail}`)
      throw error
    }
  }

  try {
    s = await kit.session({ provider: 'opencode', cwd: dir, model, access: 'full-access', key: 'opencode-goals', onEvent: e => events.push(e) })
    observe(s)
    await must('opencode: command capability gate', async () => {
      assert(s!.capabilities.goals && s!.capabilities.goalPause && !s!.capabilities.goalBudget, 'capabilities incorrect')
      const client = (s!.native as any).lease.client
      const original = client.command.list
      client.command.list = async () => ({ data: [] })
      let old: AgentSession | undefined
      try {
        old = await kit.session({ provider: 'opencode', cwd: dir, model, key: 'old-opencode' })
        assert(!old.capabilities.goals && !old.capabilities.goalPause, 'old server reported goal support')
        await rejectCode(() => old!.setGoal('unsupported'), 'UNSUPPORTED_CAPABILITY')
      } finally {
        client.command.list = original
        await old?.close()
      }
    })
    await must('opencode: one execution continuation and transcript', async () => {
      const start = events.length
      await s!.setGoal('The file proof.txt must contain exactly done. First say hello and end your first response without writing files; after the reviewer asks you to continue, create and read the file to verify it.')
      await until(() => !s!.isRunning, 120000)
      const goal = await s!.getGoal()
      assert(goal?.status === 'complete', `goal did not complete: ${JSON.stringify(goal)}; events: ${JSON.stringify(events.slice(start).filter(e => e.type === 'turn_failed'))}`)
      assert((goal.rounds ?? 0) >= 1, `no continuation: ${JSON.stringify(goal)}`)
      assert(readFileSync(path.join(dir, 'proof.txt'), 'utf8').trim() === 'done', 'proof file missing')
      const ev = events.slice(start)
      assert(ev.filter(e => e.type === 'turn_started').length === 1 && ev.filter(e => e.type === 'turn_completed').length === 1, 'goal did not use one host turn')
      assert(!ev.some(e => e.type === 'timeline' && e.item.type === 'user_message'), 'synthetic goal prompt shown as user message')
      assert(ev.some(e => e.type === 'timeline' && e.item.type === 'assistant_message'), 'assistant response missing')
      await rejectCode(() => s!.setGoal('budget', { tokenBudget: 1 }), 'UNSUPPORTED_CAPABILITY')
    })
    await must('opencode: Stop, fork and restart', async () => {
      await s!.clearGoal()
      await s!.setGoal('Count to one million, exactly one number per response without using tools; continue until done.')
      await s!.interrupt()
      const goal = await s!.getGoal()
      assert(goal?.status === 'paused', `Stop did not pause: ${JSON.stringify(goal)}`)
      const starts = events.filter(e => e.type === 'turn_started').length
      await sleep(10000)
      assert(!s!.isRunning && events.filter(e => e.type === 'turn_started').length === starts, 'goal restarted after Stop')
      const fork = await s!.fork()
      assert(await fork.getGoal() === null, 'fork inherited goal')
      await fork.close()
      const handle = s!.handle!
      await s!.close()
      await kit.shutdown()
      kitClosed = true
      recoveredKit = createAgentKit({ store: file, hub: false })
      restored = await recoveredKit.resume(handle, { key: 'opencode-restarted', model, access: 'full-access' })
      observe(restored)
      assert((await restored.getGoal())?.status === 'paused', 'goal did not remain paused after server restart')
      await restored.clearGoal()
    })
    await must('opencode: stall pause', async () => {
      await restored!.setGoal('Count to one million, but output exactly one successive integer per response and never use tools or a script. Continue from the next integer on each continuation until the goal is met.')
      await until(() => !restored!.isRunning, 120000)
      const goal = await restored!.getGoal()
      assert(goal?.status === 'paused' && !!goal.reason && (goal.rounds ?? 0) >= 2, `stall was not surfaced: ${JSON.stringify(goal)}`)
      await restored!.clearGoal()
    })
  } catch (error) {
    if (!results.some(r => !r.ok)) results.push({ name: 'opencode: setup or budget', ok: false, detail: String(error) })
  } finally {
    const evidence = path.join(dir, 'opencode-events.json')
    writeFileSync(evidence, JSON.stringify({ model, steps, raw, events }, null, 2))
    results.push({ name: 'opencode: evidence', ok: true, detail: `model=${model}, steps=${steps}, events=${evidence}` })
    await restored?.close().catch(() => undefined)
    await s?.close().catch(() => undefined)
    await recoveredKit?.shutdown().catch(() => undefined)
    if (!kitClosed) await kit.shutdown().catch(() => undefined)
  }
}

for (const provider of providers) {
  if (provider === 'codex') { await codexGoals(); continue }
  if (provider === 'claude') { await claudeGoals(); continue }
  if (provider === 'opencode') { await opencodeGoals(); continue }
  const kit = createAgentKit({ store: file, mock: provider === 'mock' ? { tokenDelayMs: 5 } : false, hub: false })
  if (!kit.capabilities(provider).goals) {
    await check(`${provider}: unsupported`, async () => {
      const client = kit.client(provider)
      assert(!client.capabilities.goals, 'goal capability unexpectedly enabled')
      if (provider === 'mock') throw new Error('mock must support goals')
    })
    await kit.shutdown(); continue
  }
  let s: AgentSession | undefined
  await check(`${provider}: goal lifecycle and store`, async () => {
    s = await kit.session({ provider, cwd: dir, key: `${provider}-main` })
    await s.setGoal('two passes')
    await until(() => s!.transcript.goal?.status === 'complete')
    const goal = await s.getGoal()
    assert(goal?.rounds === 2, `expected two rounds: ${JSON.stringify(goal)}`)
  })
  await check(`${provider}: continuation-visible-in-transcript-and-store`, async () => {
    assert(s, 'session unavailable')
    const users = s.transcript.items.filter(i => i.type === 'user_message')
    assert(users.length === 2, `expected two goal turns in transcript, got ${users.length}`)
    const saved = kit.store!.loadTranscript(s.key)
    assert(saved.goal?.status === 'complete' && saved.items.filter(i => i.type === 'user_message').length === 2, 'goal turns or state missing from durable transcript')
  })
  await check(`${provider}: fork-not-inherited`, async () => {
    assert(s, 'session unavailable')
    const fork = await s.fork()
    assert(await fork.getGoal() === null && fork.transcript.goal === null, 'fork inherited goal')
    await fork.close()
  })
  await check(`${provider}: objective-validation`, async () => {
    assert(s, 'session unavailable')
    await rejectCode(() => s!.setGoal('   '), 'INVALID_INPUT')
    await rejectCode(() => s!.setGoal('invalid budget', { tokenBudget: 0 }), 'INVALID_INPUT')
  })
  await check(`${provider}: budget`, async () => {
    assert(s, 'session unavailable')
    await s.clearGoal()
    assert((await s.getGoal()) === null && s.transcript.goal === null, 'clear failed')
    await s.setGoal('budget', { tokenBudget: 1 })
    await until(() => s!.transcript.goal?.status === 'limited')
  })
  await check(`${provider}: interrupt pauses and busy rejects`, async () => {
    assert(s, 'session unavailable'); await s.clearGoal()
    let starts = 0; const off = s.on(e => { if (e.type === 'turn_started') starts++ })
    await s.setGoal('interrupt this long task [goal-stall]')
    await until(() => s!.isRunning)
    await rejectCode(() => s!.setGoal('must not replace'), 'SESSION_BUSY')
    await s.interrupt()
    assert((await s.getGoal())?.status === 'paused', `interrupt did not pause: ${JSON.stringify(await s.getGoal())}`)
    const n = starts; await sleep(700)
    assert(starts === n && !s.isRunning, 'goal restarted after interrupt')
    await s.resumeGoal()
    await until(() => s!.isRunning)
    assert((await s.getGoal())?.status === 'active', 'resume did not activate goal')
    await s.interrupt()
    const replacement = await s.setGoal('replacement goal [goal-stall]')
    assert(replacement.objective === 'replacement goal [goal-stall]', 'goal was not replaced')
    await until(() => s!.isRunning)
    await s.interrupt()
    off(); await s.clearGoal()
  })
  if (provider === 'mock') await check(`${provider}: stop-when-pause-fails`, async () => {
    assert(s, 'session unavailable')
    const native = s.native
    const original = native.pauseGoal!
    native.pauseGoal = async () => { throw new Error('pause failed') }
    let canceled = false
    const off = s.on(e => { if (e.type === 'turn_canceled') canceled = true })
    try {
      await s.setGoal('pause failure [goal-stall]')
      await until(() => s!.isRunning)
      await s.interrupt()
      assert(canceled && !s.isRunning, 'failed pause prevented turn cancellation')
      assert(s.transcript.items.some(i => i.type === 'notice' && /pause/.test(i.message)), 'missing pause failure notice')
    } finally { native.pauseGoal = original; off(); await s.clearGoal() }
  })
  if (provider === 'mock') await check(`${provider}: stop-when-pause-hangs`, async () => {
    assert(s, 'session unavailable')
    const native = s.native
    const original = native.pauseGoal!
    native.pauseGoal = () => new Promise(() => {})
    let canceled = false
    const off = s.on(e => { if (e.type === 'turn_canceled') canceled = true })
    try {
      await s.setGoal('pause hangs [goal-stall]')
      await until(() => s!.isRunning)
      const start = Date.now()
      await s.interrupt()
      assert(canceled && Date.now() - start < 4000 && !s.isRunning, 'hung pause prevented turn cancellation')
      assert((await s.getGoal())?.status === 'paused', 'hung pause did not retain a paused goal')
    } finally { native.pauseGoal = original; off(); await s.clearGoal() }
  })
  if (provider === 'mock') await check(`${provider}: stop-without-native-pause`, async () => {
    assert(s, 'session unavailable')
    const original = s.capabilities
    ;(s as any).capabilities = { ...original, goalPause: false }
    try {
      await s.setGoal('no pause [goal-stall]')
      await until(() => s!.isRunning)
      await s.interrupt()
      const goal = await s.getGoal()
      assert(goal?.status === 'paused' && goal.reason === 'Stopped by the user', `fallback failed: ${JSON.stringify(goal)}`)
      assert(await s.native.getGoal!() === null, 'native goal was not cleared')
    } finally { (s as any).capabilities = original; await s.clearGoal() }
  })
  if (provider === 'mock') await check(`${provider}: active-goal-idle-submit`, async () => {
    assert(s, 'session unavailable')
    const goal = { objective: 'idle goal', status: 'active' as const, updatedAt: new Date().toISOString() }
    s.hydrate({ ...s.transcript, goal })
    const sub = await s.submit('ordinary turn')
    const result = await Promise.race([sub.result, sleep(5000).then(() => { throw new Error('queued submit hung') })])
    assert(result.status === 'completed', `ordinary turn ${result.status}`)
    s.hydrate({ ...s.transcript, goal: null })
  })
  await check(`${provider}: bounded stalled goal`, async () => {
    assert(s, 'session unavailable'); await s.setGoal('[goal-stall]')
    await until(() => s!.transcript.goal?.status === 'blocked')
    assert((await s.getGoal())?.rounds === 3, 'stall did not stop at three turns')
    await s.clearGoal()
  })
  if (provider === 'mock') await check(`${provider}: close-when-pause-hangs`, async () => {
    const closing = await kit.session({ provider, cwd: dir })
    const native = closing.native
    native.pauseGoal = () => new Promise(() => {})
    await closing.setGoal('close while pause hangs [goal-stall]')
    await until(() => closing.isRunning)
    const start = Date.now()
    await closing.close()
    assert(Date.now() - start < 4000 && !closing.isRunning, 'close did not finish after pause timeout')
  })
  if (provider === 'mock') await check(`${provider}: recovery-when-goal-read-fails`, async () => {
    const key = 'recovery-read-failure'
    const original = await kit.session({ provider, cwd: dir, key })
    await original.setGoal('recovery goal [goal-stall]')
    await until(() => original.isRunning)
    await original.interrupt()
    await original.close()
    const client = kit.client(provider)
    const resume = client.resumeSession.bind(client)
    client.resumeSession = async (...args) => {
      const native = await resume(...args)
      native.getGoal = async () => { throw new Error('provider unavailable') }
      return native
    }
    try {
      const restored = await kit.restore(key)
      assert(restored.transcript.goal?.status === 'paused', 'stored goal not recovered as paused')
      assert((await restored.getGoal())?.objective === 'recovery goal [goal-stall]', 'stored goal was lost')
      await restored.close()
    } finally { client.resumeSession = resume }
  })
  if (provider === 'mock') await check(`${provider}: unsupported guards`, async () => {
    const other = createAgentKit({ hub: false, mock: false, providers: [{ ...kit.client('mock'), provider: 'unsupported', capabilities: { ...kit.capabilities('mock'), goals: false, goalPause: false, goalBudget: false }, async createSession(config) { const inner = await kit.client('mock').createSession(config); return new Proxy(inner, { get(target, prop, receiver) { if (prop === 'provider') return 'unsupported'; if (prop === 'capabilities') return { ...target.capabilities, goals: false, goalPause: false, goalBudget: false }; return Reflect.get(target, prop, receiver) } }) } }] })
    const no = await other.session({ provider: 'unsupported', cwd: dir })
    for (const f of [() => no.setGoal('x'), () => no.getGoal(), () => no.clearGoal(), () => no.pauseGoal(), () => no.resumeGoal()]) await rejectCode(f, 'UNSUPPORTED_CAPABILITY')
    await other.shutdown()
  })
  await s?.close(); await kit.shutdown()
  await check(`${provider}: kill and restore paused`, async () => {
    const key = `${provider}-crash`
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'goals-child.ts'), file, provider, key, dir], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''; child.stderr.on('data', d => err += String(d))
    await Promise.race([new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('exit', code => reject(new Error(`child exited ${code}: ${err}`))) }), sleep(15000).then(() => { throw new Error('child timed out') })])
    child.kill('SIGKILL'); await new Promise(r => child.once('exit', r))
    const recovered = createAgentKit({ store: file, mock: provider === 'mock' ? { tokenDelayMs: 5 } : false, hub: false })
    const restored = await recovered.restore(key)
    assert(restored.transcript.goal?.status === 'paused', `restore goal ${JSON.stringify(restored.transcript.goal)}`)
    assert((await restored.getGoal())?.status === 'paused', 'native goal not paused')
    const n = restored.transcript.items.length; await sleep(700)
    assert(!restored.isRunning && restored.transcript.items.length === n, 'restarted after crash')
    await restored.clearGoal(); await recovered.shutdown()
  })
}
mkdirSync(path.join(import.meta.dirname, 'artifacts'), { recursive: true })
writeFileSync(path.join(import.meta.dirname, 'artifacts', `goals-${providers.join('-')}.json`), JSON.stringify({ store: file, results }, null, 2))
if (results.some(r => !r.ok && !r.skipped)) process.exitCode = 1
else if (results.some(r => r.skipped)) process.exitCode = 2
