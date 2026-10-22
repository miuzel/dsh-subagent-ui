import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'dsh-subagent-workspace-ui'

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) {
    variants.add(sessionId.slice('session-'.length))
  } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    variants.add(`session-${sessionId}`)
  }
  return [...variants]
}

function findSessionDirs(sessionId) {
  const root = sessionsRoot()
  let slugs = []
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const variants = sessionIdVariants(sessionId)
  const found = []
  for (const slug of slugs) {
    for (const variant of variants) {
      const candidate = path.join(root, slug, variant)
      try {
        if (fs.statSync(candidate).isDirectory()) {
          found.push({ slug, dir: candidate, variant })
        }
      } catch {
        // continue
      }
    }
  }
  return found
}

function removeSessionDirs(sessionId) {
  const found = findSessionDirs(sessionId)
  for (const { dir } of found) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // continue
    }
  }
  return found.length > 0
}

async function stopAgentIfRunning(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return false
  let stopped = false
  for (const variant of sessionIdVariants(sessionId)) {
    const agent = agents.get(variant)
    if (!agent) continue
    if (agent.status === 'running' && typeof agent.cancel === 'function') {
      try {
        agent.cancel({ kind: 'user' })
        stopped = true
      } catch {
        // continue
      }
    }
    if (typeof agent.whenIdle === 'function') {
      try {
        await Promise.race([
          agent.whenIdle(),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ])
      } catch {
        // continue
      }
    }
  }
  return stopped
}

function detachLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions) return false
  let detached = false
  for (const variant of sessionIdVariants(sessionId)) {
    try {
      const store = sessions.store
      const entry = store && typeof store.get === 'function' ? store.get(variant) : undefined
      if (entry === undefined) continue
      if (typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry)
        detached = true
      } else if (store && typeof store.delete === 'function') {
        store.delete(variant)
        if (sessions.attachments && entry.session && typeof sessions.attachments.delete === 'function') {
          sessions.attachments.delete(entry.session)
        }
        detached = true
      }
    } catch {
      // continue
    }
  }
  return detached
}

async function stripStorageDomains(ctx, sessionId) {
  const sd = ctx.get('storageDomain')
  if (!sd) return
  const variants = sessionIdVariants(sessionId)

  const proj = sd.get('session_projcache')
  if (proj && typeof proj.table === 'function') {
    try {
      const table = proj.table('sessions')
      for (const variant of variants) {
        if (table.get(variant) !== undefined) {
          await table.delete(variant)
        }
      }
    } catch {
      // ignore
    }
  }

  const ws = sd.get('workspace')
  if (ws && typeof ws.table === 'function') {
    try {
      const workspaces = ws.table('workspaces')
      for (const [wid, rec] of workspaces.entries()) {
        if (rec && Array.isArray(rec.sessionIds) && variants.some((v) => rec.sessionIds.includes(v))) {
          await workspaces.put(wid, {
            ...rec,
            sessionIds: rec.sessionIds.filter((x) => !variants.includes(x)),
          })
        }
      }
    } catch {
      // ignore
    }
    try {
      const g = ws.global
      if (g && typeof g.get === 'function' && typeof g.set === 'function') {
        const state = g.get()
        if (state && Array.isArray(state.archivedSessionIds) && variants.some((v) => state.archivedSessionIds.includes(v))) {
          await g.set({ ...state, archivedSessionIds: state.archivedSessionIds.filter((x) => !variants.includes(x)) })
        }
      }
    } catch {
      // ignore
    }
  }
}

async function emitRemovalMarker(ctx, parentSessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.prepare !== 'function') return false
  const markerId = `session-${randomUUID()}`
  try {
    const marker = sessions.prepare(markerId, { meta: { parentSession: parentSessionId } })
    const detach = sessions.enter(marker)
    try {
      sessions.announce(marker)
      if (typeof sessions.flush === 'function') await sessions.flush(marker)
      await new Promise((resolve) => setTimeout(resolve, 200))
    } finally {
      detach()
    }
    removeSessionDirs(markerId)
    return true
  } catch {
    removeSessionDirs(markerId)
    return false
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

// External-agent runs. A dsh 0.2.1 provider without `prepareContinuable` (the
// claude-code / codex plugins) publishes its child as an "external execution":
// the catalog entry has `mode: 'external'`, the catalog id is a bare
// `randomUUID()` brand rather than a SessionId, and there is no local child
// Session at all. Everything the manager derives from `byId[childId]` is
// therefore empty for such a row, and the host's own `activity` is a hard-coded
// `'inactive'` for it (it resolves `sessions.get(entry.id)`, which never exists).
// The only authoritative live signal is the lifecycle pair `subagent/start` /
// `subagent/end` ({ runId, provider, id, local } + `stopReason`). Those payloads
// are observe-only and scoped: `emit` carries the delegating parent as dispatch
// `this`, and cordis drops a listener whose context does not match it. A plugin
// context carries no scope tag (`scopeOf(ctx) === undefined`) and the carrier
// admits untagged listeners, so this listener observes every parent's runs. A
// host that never provides that service (dsh < 0.2.1, or a composition without
// `dsh-subagent`) simply runs no code and serves an empty set; a host whose
// service predates the lifecycle pair never dispatches them.
const EXTERNAL_STATUS_PATH = '/api/dsh-subagent-workspace-ui/external-status'
const EXTERNAL_STOP_PATH = '/api/dsh-subagent-workspace-ui/external-stop'
const EXTERNAL_ENDED_LIMIT = 50
const EXTERNAL_RUN_LIMIT = 200

function createExternalLedger() {
  const runs = new Map()
  const ended = new Map()
  const seqOf = new Map()
  let seq = 0

  function nextSeq() {
    seq += 1
    return seq
  }

  function start(info, parent) {
    const id = info && info.id
    if (typeof id !== 'string' || info.local !== false) return
    const runId = String(info.runId)
    if (runs.has(runId)) return
    const now = Date.now()
    runs.set(runId, {
      runId,
      id,
      provider: typeof info.provider === 'string' ? info.provider : '',
      parentId: parent && typeof parent.id === 'string' ? parent.id : '',
      startedAt: now,
    })
    seqOf.set(runId, nextSeq())
    if (runs.size > EXTERNAL_RUN_LIMIT) {
      const oldest = [...runs.keys()][0]
      runs.delete(oldest)
      seqOf.delete(oldest)
    }
  }

  function end(info) {
    const id = info && info.id
    if (typeof id !== 'string' || info.local !== false) return
    const runId = String(info.runId)
    const live = runs.get(runId)
    const now = Date.now()
    const record = {
      runId,
      id,
      provider: typeof info.provider === 'string' ? info.provider : (live && live.provider) || '',
      parentId: (live && live.parentId) || '',
      startedAt: live ? live.startedAt : undefined,
      endedAt: now,
      stopReason: typeof info.stopReason === 'string' ? info.stopReason : 'unknown',
      // Whether this process actually saw the run start. An end edge without a
      // start (a restart, or a listener installed mid-run) keeps the stop reason
      // but has no measured duration.
      paired: live !== undefined,
    }
    runs.delete(runId)
    // The ended record keeps the seq the run had while live, so a page that
    // already knew the run's position does not see it move; an unpaired end
    // gets a fresh one.
    ended.set(runId, { ...record, seq: live ? seqOf.get(runId) : nextSeq() })
    seqOf.delete(runId)
    if (ended.size > EXTERNAL_ENDED_LIMIT) {
      const oldest = [...ended.keys()][0]
      ended.delete(oldest)
    }
  }

  function snapshot() {
    const active = []
    for (const [runId, run] of runs) {
      active.push({ ...run, seq: seqOf.get(runId) })
    }
    const finished = [...ended.values()]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, EXTERNAL_ENDED_LIMIT)
      .map((record) => ({
        runId: record.runId,
        id: record.id,
        provider: record.provider,
        parentId: record.parentId,
        seq: record.seq,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        stopReason: record.stopReason,
        paired: record.paired,
        durationMs: record.paired && record.startedAt !== undefined ? record.endedAt - record.startedAt : undefined,
      }))
    return { ok: true, version: 1, active, ended: finished, at: Date.now() }
  }

  return { start, end, snapshot }
}

// The delegating parent Agent behind a lifecycle edge. Cordis binds the scoped
// carrier as dispatch `this`, and `emit` passes ONLY the payload — the parent is
// not an argument. That carrier's routing key (`carrierKeyOf`, exported by
// `@deepseek-ai/dsh-scope`, the package the subagent runtime builds the carrier
// with) IS the exact live parent Agent; the Agent is not an own property of the
// carrier, so reading `this.id` finds nothing.
//
// The carrier registry is a module-private WeakMap, so this must be the SAME
// module instance the host runtime used — an ESM import of the host CLI's own
// store, never a CJS `require` (which yields a second instance that matches
// nothing). This plugin declares no such dependency on purpose: on a host
// without a subagent runtime the import fails, and an external run then has no
// parent — which the ledger reports as such instead of inventing an authority.
// The module is loaded during activation (`loadScopeModule()` from `apply`) so
// it is settled long before the first edge arrives.
const SCOPE_MODULE_URL = '@deepseek-ai/dsh-scope'
let scopeModule
let scopeReady = null
function loadScopeModule() {
  if (scopeReady) return scopeReady
  const candidates = [SCOPE_MODULE_URL]
  try {
    const fromHost = createRequire(path.join(process.execPath, '..', '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    candidates.push(pathToFileURL(fromHost.resolve(SCOPE_MODULE_URL)).href)
  } catch {
    // continue
  }
  scopeReady = (async () => {
    for (const specifier of candidates) {
      try {
        const value = await import(specifier)
        if (value && typeof value.carrierKeyOf === 'function') {
          scopeModule = value
          return value
        }
      } catch {
        // continue
      }
    }
    return undefined
  })()
  return scopeReady
}

function parentAgentOf(receiver) {
  if (!receiver || !scopeModule) return undefined
  try {
    const key = scopeModule.carrierKeyOf(receiver)
    return key && typeof key.id === 'string' ? key : undefined
  } catch (error) {
    console.warn('[dsh-subagent-workspace-ui] unable to resolve the delegating parent', error)
    return undefined
  }
}

function attachExternalLedger(ctx) {
  const ledger = createExternalLedger()
  if (typeof ctx.on !== 'function') return ledger
  // Cordis `emit` binds the dispatch receiver as `this` and passes only the
  // payload as the argument: the receiver is the scoped carrier created from the
  // delegating parent Agent, so the parent is read from `this` (and ignored when
  // it is not an Agent). The identity edge carries `local: false` for an
  // external execution. A context whose scope does not match the carrier never
  // receives these events at all (cordis filters before dispatch), so no extra
  // scope check is needed here.
  try {
    ctx.on('subagent/start', function (info) {
      ledger.start(info, parentAgentOf(this))
    })
    ctx.on('subagent/end', function (info) {
      ledger.end(info)
    })
  } catch (error) {
    console.warn('[dsh-subagent-workspace-ui] external-agent lifecycle listener unavailable', error)
  }
  return ledger
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 8 * 1024 * 1024) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

async function deleteSingleSubagent(ctx, sessionId, parentSessionId) {
  await stopAgentIfRunning(ctx, sessionId)
  detachLiveSession(ctx, sessionId)
  removeSessionDirs(sessionId)
  await stripStorageDomains(ctx, sessionId)
  if (parentSessionId) {
    await emitRemovalMarker(ctx, parentSessionId)
  }
  return { sessionId, deleted: true }
}

// The host's `subagents` service is only readable from a context that declares
// it. Our own context does not (the plugin must stay loadable on hosts that
// ship no subagent runtime at all), so the service is resolved per call by
// extending this context with the injection — the same guard `ctx.get` applies
// internally, just with the dependency declared. A missing service is reported
// as such, never as a successful stop.
function resolveSubagents(ctx) {
  try {
    const probe = typeof ctx.extend === 'function' ? ctx.extend({ inject: ['subagents'] }) : ctx
    return probe.get('subagents')
  } catch (error) {
    console.warn('[dsh-subagent-workspace-ui] subagents service unavailable', error)
    return undefined
  }
}

// One exact route, owned by the calling fiber. `ctx.effect` takes a generator:
// the function it is given is started immediately and treated as a CLEANUP
// function, so `yield register(...)` is what keeps the route alive (the host's
// own client-connection does exactly this). Returning the disposer without
// yielding it would unregister the route on the same tick.
function routeEffect(ctx, webServer, route) {
  if (typeof ctx.effect === 'function') {
    ctx.effect(function* () {
      yield webServer.register(route)
    })
    return
  }
  webServer.register(route)
}

function registerHttpRoutes(webServer, ctx, ledger) {
  routeEffect(ctx, webServer, {
    kind: 'exact',
    path: EXTERNAL_STATUS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      sendJson(res, 200, ledger.snapshot())
    },
  })

  // The host's `interrupt(targetSessionId, { kind: 'user', parentSessionId })`
  // is the same path the manager already uses for a local child: for an
  // external activation it aborts that run's controller and disposes it, which
  // is also what terminates the native claude/codex process. The parent id is
  // required by the authority check (the host compares it with the activation's
  // own parent), and it is taken from the parent the ledger observed, never
  // from the browser. A run the ledger no longer holds is NOT reported as
  // stopped: the host treats an absent target as an accepted no-op, so calling
  // through would be a silent lie.
  routeEffect(ctx, webServer, {
    kind: 'exact',
    path: EXTERNAL_STOP_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      let args = {}
      try {
        const body = await readBody(req)
        if (body) args = JSON.parse(body)
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid-json' })
      }
      const runId = args && args.runId
      if (typeof runId !== 'string' || !runId) {
        return sendJson(res, 400, { ok: false, error: 'missing-run-id' })
      }
      const run = ledger.snapshot().active.find((entry) => entry.runId === runId)
      if (!run) return sendJson(res, 409, { ok: false, error: 'not-running' })
      if (!run.parentId) return sendJson(res, 409, { ok: false, error: 'missing-parent' })
      const subagents = resolveSubagents(ctx)
      if (!subagents || typeof subagents.interrupt !== 'function') {
        return sendJson(res, 501, { ok: false, error: 'unsupported' })
      }
      try {
        subagents.interrupt(run.id, { kind: 'user', parentSessionId: run.parentId })
        sendJson(res, 200, { ok: true, interrupt: 'requested', runId: run.runId })
      } catch (e) {
        sendJson(res, 502, { ok: false, error: 'interrupt-failed', message: e && e.message })
      }
    },
  })

  routeEffect(ctx, webServer, {
    kind: 'exact',
    path: '/api/dsh-subagent-workspace-ui/delete',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      let args = {}
      try {
        const body = await readBody(req)
        if (body) args = JSON.parse(body)
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid-json' })
      }
      const { sessionId, parentSessionId } = args
      if (!sessionId) {
        return sendJson(res, 400, { ok: false, error: 'missing-session-id' })
      }
      try {
        const result = await deleteSingleSubagent(ctx, sessionId, parentSessionId)
        sendJson(res, 200, { ok: true, ...result })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
    },
  })

  routeEffect(ctx, webServer, {
    kind: 'exact',
    path: '/api/dsh-subagent-workspace-ui/batch-delete',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      let args = {}
      try {
        const body = await readBody(req)
        if (body) args = JSON.parse(body)
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid-json' })
      }
      const { items } = args
      if (!Array.isArray(items) || !items.length) {
        return sendJson(res, 400, { ok: false, error: 'missing-items' })
      }
      try {
        const results = []
        const parents = new Set()
        for (const item of items) {
          const sid = typeof item === 'string' ? item : item.sessionId
          const pid = typeof item === 'object' ? item.parentSessionId : undefined
          if (pid) parents.add(pid)
          const resSingle = await deleteSingleSubagent(ctx, sid, undefined)
          results.push(resSingle)
        }
        for (const pid of parents) {
          await emitRemovalMarker(ctx, pid)
        }
        sendJson(res, 200, { ok: true, deletedCount: results.length, results })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message })
      }
    },
  })
}


// Exposed for verification harnesses only; the host loader ignores extra
// exports. It resolves once the optional scope helper has settled.
export function ready() {
  return loadScopeModule()
}

export function apply(ctx) {
  console.info('[dsh-subagent-workspace-ui] host plugin loaded')
  // Started here so the scope module settles during activation, before any
  // lifecycle edge can arrive (see parentAgentOf).
  loadScopeModule()
  const ledger = attachExternalLedger(ctx)
  const ws = ctx.get('webServer')
  if (ws !== undefined) {
    registerHttpRoutes(ws, ctx, ledger)
  } else {
    ctx.inject(['webServer'], (sub) => {
      registerHttpRoutes(sub.webServer, sub, ledger)
    })
  }
}
