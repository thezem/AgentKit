import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isTerminalEvent, type AgentEvent, type PersistenceHandle, type PromptInput, type ProviderId, type RunResult } from '../capsules/shared/contract.ts'
import { emptyTranscript, reduceTranscript, type Transcript } from './transcript.ts'

/**
 * Durable layer, borrowed from pi-durable's ideas:
 *  - commit-before-show: every event is written before any listener sees it
 *  - intent / outcome: a submission is saved as `running` before the provider is
 *    called, and its outcome after. Rows still `running` after a crash become
 *    `interrupted`. They are never re-sent automatically.
 */
export type SubmissionStatus = 'queued' | 'running' | 'steered' | 'completed' | 'failed' | 'canceled' | 'withdrawn' | 'interrupted'

export const TERMINAL_SUBMISSION: ReadonlySet<SubmissionStatus> = new Set(['completed', 'failed', 'canceled', 'withdrawn', 'interrupted'])

export interface SubmissionRecord {
  /** Your `requestId`, or a generated one. Idempotency key. */
  id: string
  sessionKey: string
  provider: ProviderId
  status: SubmissionStatus
  prompt: PromptInput
  whenBusy: 'queue' | 'steer' | 'reject'
  /** Native turn id once the provider accepted it. */
  turnId: string | null
  /** Resume point at the time of the intent. */
  handle: PersistenceHandle | null
  /** Outcome without the timeline (that lives in the transcript). */
  result: Omit<RunResult, 'timeline'> | null
  error: string | null
  createdAt: string
  finishedAt: string | null
}

export interface StoredSession {
  key: string
  provider: ProviderId
  handle: PersistenceHandle | null
  /** Your app data (title, settings...). */
  meta: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface AgentStore {
  putSession(key: string, data: { provider: ProviderId; handle: PersistenceHandle | null; meta?: Record<string, unknown> }): void
  updateSession(key: string, patch: { handle?: PersistenceHandle | null; meta?: Record<string, unknown> }): void
  getSession(key: string): StoredSession | null
  listSessions(): StoredSession[]
  deleteSession(key: string): void
  /** Called before the event is shown to anyone. */
  appendEvent(key: string, event: AgentEvent): void
  /** Snapshot the transcript and drop the events it already contains. */
  checkpoint(key: string, transcript: Transcript): void
  loadTranscript(key: string): Transcript
  putSubmission(record: SubmissionRecord): void
  getSubmission(id: string): SubmissionRecord | null
  listSubmissions(filter?: { sessionKey?: string; status?: SubmissionStatus }): SubmissionRecord[]
  /** Mark unfinished work from dead processes `interrupted` and close it out in the transcript. */
  recover(): SubmissionRecord[]
  close(): void
}

export function sqliteStore(file: string): AgentStore {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS sessions (
      key TEXT PRIMARY KEY, provider TEXT NOT NULL, handle TEXT, meta TEXT NOT NULL DEFAULT '{}',
      snapshot TEXT, snapshot_seq INTEGER NOT NULL DEFAULT 0, owner INTEGER,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, event TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_by_session ON events(session_key, seq);
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY, session_key TEXT NOT NULL, status TEXT NOT NULL, owner INTEGER, data TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS submissions_by_session ON submissions(session_key, created_at);
  `)
  const now = () => new Date().toISOString()
  const owner = process.pid

  const toSession = (row: any): StoredSession => ({
    key: row.key,
    provider: row.provider,
    handle: row.handle ? JSON.parse(row.handle) : null,
    meta: JSON.parse(row.meta),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  const q = {
    insertSession: db.prepare(
      `INSERT INTO sessions (key, provider, handle, meta, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET provider = excluded.provider, handle = excluded.handle, meta = excluded.meta, owner = excluded.owner, updated_at = excluded.updated_at`,
    ),
    getSession: db.prepare('SELECT * FROM sessions WHERE key = ?'),
    listSessions: db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE key = ?'),
    deleteEvents: db.prepare('DELETE FROM events WHERE session_key = ?'),
    deleteSubs: db.prepare('DELETE FROM submissions WHERE session_key = ?'),
    touch: db.prepare('UPDATE sessions SET updated_at = ?, owner = ? WHERE key = ?'),
    appendEvent: db.prepare('INSERT INTO events (session_key, event) VALUES (?, ?)'),
    eventsAfter: db.prepare('SELECT seq, event FROM events WHERE session_key = ? AND seq > ? ORDER BY seq'),
    maxSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_key = ?'),
    snapshot: db.prepare('UPDATE sessions SET snapshot = ?, snapshot_seq = ?, updated_at = ? WHERE key = ?'),
    dropEvents: db.prepare('DELETE FROM events WHERE session_key = ? AND seq <= ?'),
    putSub: db.prepare(
      `INSERT INTO submissions (id, session_key, status, owner, data, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, owner = excluded.owner, data = excluded.data`,
    ),
    getSub: db.prepare('SELECT data FROM submissions WHERE id = ?'),
    subsBySession: db.prepare('SELECT data FROM submissions WHERE session_key = ? ORDER BY created_at'),
    subsByStatus: db.prepare('SELECT data FROM submissions WHERE status = ? ORDER BY created_at'),
    allSubs: db.prepare('SELECT data FROM submissions ORDER BY created_at'),
    unfinished: db.prepare(`SELECT data, owner FROM submissions WHERE status IN ('queued', 'running', 'steered')`),
    liveSessions: db.prepare('SELECT key, owner FROM sessions'),
  }

  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const store: AgentStore = {
    putSession(key, data) {
      const t = now()
      const existing = q.getSession.get(key) as any
      q.insertSession.run(key, data.provider, data.handle ? JSON.stringify(data.handle) : null, JSON.stringify(data.meta ?? (existing ? JSON.parse(existing.meta) : {})), owner, existing?.created_at ?? t, t)
    },
    updateSession(key, patch) {
      const row = q.getSession.get(key) as any
      if (!row) return
      const handle = patch.handle !== undefined ? patch.handle : row.handle ? JSON.parse(row.handle) : null
      const meta = patch.meta ? { ...JSON.parse(row.meta), ...patch.meta } : JSON.parse(row.meta)
      q.insertSession.run(key, row.provider, handle ? JSON.stringify(handle) : null, JSON.stringify(meta), owner, row.created_at, now())
    },
    getSession(key) {
      const row = q.getSession.get(key)
      return row ? toSession(row) : null
    },
    listSessions() {
      return q.listSessions.all().map(toSession)
    },
    deleteSession(key) {
      tx(() => {
        q.deleteEvents.run(key)
        q.deleteSubs.run(key)
        q.deleteSession.run(key)
      })
    },
    appendEvent(key, event) {
      q.appendEvent.run(key, JSON.stringify(event))
      if (event.type !== 'timeline' && event.type !== 'usage') q.touch.run(now(), owner, key)
    },
    checkpoint(key, transcript) {
      tx(() => {
        const { seq } = q.maxSeq.get(key) as any
        q.snapshot.run(JSON.stringify(transcript), seq, now(), key)
        q.dropEvents.run(key, seq)
      })
    },
    loadTranscript(key) {
      const row = q.getSession.get(key) as any
      if (!row) return emptyTranscript()
      let state: Transcript = row.snapshot ? { ...emptyTranscript(), ...JSON.parse(row.snapshot) } : emptyTranscript()
      for (const entry of q.eventsAfter.all(key, row.snapshot_seq) as any[]) state = reduceTranscript(state, JSON.parse(entry.event))
      return state
    },
    putSubmission(record) {
      q.putSub.run(record.id, record.sessionKey, record.status, owner, JSON.stringify(record), record.createdAt)
    },
    getSubmission(id) {
      const row = q.getSub.get(id) as any
      return row ? JSON.parse(row.data) : null
    },
    listSubmissions(filter = {}) {
      const rows = filter.sessionKey ? q.subsBySession.all(filter.sessionKey) : filter.status ? q.subsByStatus.all(filter.status) : q.allSubs.all()
      return (rows as any[]).map((row) => JSON.parse(row.data) as SubmissionRecord).filter((r) => !filter.status || r.status === filter.status)
    },
    recover() {
      const recovered: SubmissionRecord[] = []
      const touched = new Map<string, SubmissionRecord | null>()
      for (const row of q.unfinished.all() as any[]) {
        if (isAlive(row.owner)) continue
        const record: SubmissionRecord = JSON.parse(row.data)
        const outcome = terminalFor(record)
        const next: SubmissionRecord = outcome
          ? { ...record, ...outcome, finishedAt: now() }
          : { ...record, status: 'interrupted', error: 'process exited before the turn finished; not re-sent', finishedAt: now() }
        store.putSubmission(next)
        recovered.push(next)
        if (record.status === 'running' && !outcome) touched.set(record.sessionKey, next)
        else if (!touched.has(record.sessionKey)) touched.set(record.sessionKey, null)
      }
      // Sessions whose transcript still says "running" (e.g. a turn started with start()) get closed too.
      for (const row of q.liveSessions.all() as any[]) {
        if (isAlive(row.owner) || touched.has(row.key)) continue
        const t = store.loadTranscript(row.key)
        if (t.activeTurnId || t.inbox.length) touched.set(row.key, null)
      }
      for (const [key, record] of touched) {
        const t = store.loadTranscript(key)
        const provider = (store.getSession(key)?.provider ?? record?.provider ?? 'unknown') as ProviderId
        if (t.activeTurnId || record) {
          store.appendEvent(key, { type: 'turn_interrupted', provider, turnId: t.activeTurnId ?? record?.turnId ?? null, submissionId: record?.id ?? null, reason: 'process exited mid-turn' })
        }
        if (t.inbox.length) store.appendEvent(key, { type: 'inbox_changed', provider, inbox: [] })
        store.checkpoint(key, store.loadTranscript(key))
      }
      return recovered
    },
    close() {
      db.close()
    },
  }

  /** A submission whose terminal event made it to disk before the crash is not "interrupted"; it finished. */
  function terminalFor(record: SubmissionRecord): Partial<SubmissionRecord> | null {
    if (!record.turnId) return null
    for (const entry of q.eventsAfter.all(record.sessionKey, 0) as any[]) {
      const event: AgentEvent = JSON.parse(entry.event)
      if (isTerminalEvent(event) && event.turnId === record.turnId) {
        const status = event.type === 'turn_completed' ? 'completed' : event.type === 'turn_failed' ? 'failed' : 'canceled'
        return { status, error: event.type === 'turn_failed' ? event.error : null }
      }
    }
    return null
  }

  return store
}

function isAlive(pid: number | null): boolean {
  if (!pid || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === 'EPERM'
  }
}
