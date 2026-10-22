import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
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
//
// Route authority. The plugin serves four exact routes, and dsh's own
// `webServer.register` is NOT an authenticated surface: it hands the request
// straight to the handler, and the official `/api` prefix route that DOES
// authenticate is matched by prefix only after ours, so a bare
// `webServer.register({ kind: 'exact', path: '/api/...' })` answered 200 to a
// request carrying no cookie and no token at all (verified against 0.2.1-rc.2:
// `/api/sessions` and `/api/plugins` answered 401 on the same host while this
// plugin's `/api/dsh-subagent-workspace-ui/external-status` answered 200).
// The correct surface is `ctx.connection.fetch.register`
// (`HostConnectionFetch`), which claims one exact path under `/api` on the
// shared channel: the channel admits the request first (Host/Origin fence, then
// the browser session cookie or an API token) and every exact route it holds
// answers 403 to any principal that is not the owner. So a host that has the
// face gets the official policy for free, and the plugin must not re-implement
// it there.
//
// That ALSO settles the fallback: a `webServer.register({ kind: 'exact' })` on
// an `/api/...` path can never be a fallback, because the carrier resolves the
// EXACT table before the prefix table (`dsh-host-webserver`, `routeFor`), so such
// a route permanently shadows the official `/api` prefix route (itself
// `kind: 'prefix'`). Registering both would leave the fetch route unreachable
// and the unauthenticated one serving. The surfaces are therefore exclusive, and
// a host without the fetch face gets the legacy route PLUS the plugin's own
// verification (see `makeRouteAuthority`).
//
// `ROUTE_BASE_PATH` is the path AS THE BROWSER SEES IT, `/api` included, and
// that is exactly the string the fetch face must be given: `assertFetchRoute`
// requires `endpointFromPath('/api', route.path)` to succeed (the path MUST
// start with `/api/`), and the carriage keeps the full pathname end to end -
// `bridge()` builds `new Request(new URL(req.url))` from the untouched request
// URL and `createSharedFetchHandler` looks the route up by
// `new URL(request.url).pathname`. The registered path and the browser path are
// therefore the SAME string on both surfaces, which is also why one constant can
// serve both without an `/api` prefix appearing twice or disappearing.
const ROUTE_BASE_PATH = '/api/dsh-subagent-workspace-ui'
const ROUTE_NAMES = ['external-status', 'external-stop', 'delete', 'batch-delete']
const EXTERNAL_STATUS_PATH = `${ROUTE_BASE_PATH}/external-status`
const EXTERNAL_STOP_PATH = `${ROUTE_BASE_PATH}/external-stop`
const DELETE_PATH = `${ROUTE_BASE_PATH}/delete`
const BATCH_DELETE_PATH = `${ROUTE_BASE_PATH}/batch-delete`
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

// One registered route, owned by the calling fiber. `ctx.effect` takes a
// generator: the function it is given is started immediately and treated as a
// CLEANUP function, so `yield register(...)` is what keeps the route alive (the
// host's own client-connection does exactly this). Returning the disposer
// without yielding it would unregister the route on the same tick. The
// disposer may be async (the fetch face returns `() => Promise<void>`), and a
// generator effect disposes whatever a `yield` produced.
function routeEffect(ctx, register) {
  if (typeof ctx.effect === 'function') {
    // The fiber disposes the yielded value on scope teardown; the same
    // disposer is returned so a caller can also give a route back early (the
    // surface upgrade does exactly that).
    const disposer = register()
    ctx.effect(function* () {
      yield disposer
    })
    return disposer
  }
  return register()
}

// The host face that authenticates a request, or undefined on a host that has
// none (dsh before the connection service, or a composition without it). This
// is a capability probe, never a version check: a callable `register` is the
// whole test, so a host that ships the service partially still falls back.
function connectionFetchFace(ctx) {
  const connection = serviceOf(ctx, 'connection')
  const face = connection && connection.fetch
  if (face && typeof face.register === 'function') return face
  return undefined
}

function serviceOf(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch (error) {
    console.warn(`[dsh-subagent-workspace-ui] ${name} service unavailable`, error)
    return undefined
  }
}

// Adapt one node:http request to the WHATWG Request the fetch face hands to a
// handler (headers only: the body is read separately, because the legacy
// surface has not received it until the handler asks). One adapter means the
// SAME handler body serves both surfaces and the four endpoints cannot drift
// apart between them.
function toFetchRequest(req, origin) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, value)
  }
  return new Request(new URL(req.url || '/', origin), { method: req.method || 'GET', headers })
}

// The legacy fallback's policy. `webServer.register` does NOT authenticate (see
// ROUTE_BASE_PATH), so the fallback must carry the official policy itself. It is
// the SAME policy, not a lookalike, and it is evaluated in this order:
//
//   ① `connection.requestRejection(request)` - the connection's own `admit`
//      (Host/Origin fence -> 403, then signed browser cookie or API token -> 401).
//   ② otherwise the host's own verifiers, `connection.browserAuth
//      .authenticateApi` (signature-checked operator id) then `.isAuthenticated`
//      (browser session) - exactly what ① calls internally,
//      reached from the service's public fields (`browserAuth` and its public
//      `secret`/`launchToken` are not `#private`, so nothing is bypassed or
//      re-implemented; the signature is still verified by the host's code).
//   ③ last resort, a host that exposes none of the above: the plugin checks ONE
//      exact exported cookie name (`dsh-auth-<sha256(authority)>`, URL-safe
//      base64; the authority is plain `host` on http and `origin` on https) and
//      that its value has the signed-cookie shape `v<N>.<payload>.<signature>`. This path CANNOT verify the
//      signature - a host with the connection service but without any of its
//      verifiers is not one we can see (its own `/api` would be open too) - so
//      it exists only to keep a degraded host working instead of failing closed,
//      and it is reported as `mode: 'shape'` because the difference matters.
//
// Whatever the rung, `x-dsh-token` is accepted only when an API credential can
// actually be verified against it; a host that cannot verify a token does not
// get a weaker one.
const OFFICIAL_BROWSER_TOKEN_HEADER = 'x-dsh-token'
const COOKIE_NAME_PREFIX = 'dsh-auth-'
const COOKIE_VALUE_PATTERN = /^v[12]\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

function requestSecure(request) {
  try {
    const url = new URL(request.url)
    return url.protocol === 'https:'
  } catch {
    return false
  }
}

// `cookieName(authority)` from the host: the SHA-256 of the authority, in
// URL-safe base64, behind a fixed prefix. Anything that merely starts with
// `dsh-` is a different cookie and never a credential.
function officialCookieName(request, secure) {
  const host = request.headers.get('host')
  if (!host) return undefined
  const authority = secure ? `https://${host}` : host
  const digest = createHash('sha256').update(authority).digest('base64')
  return COOKIE_NAME_PREFIX + digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

function presentedCookie(request, name) {
  const header = request.headers.get('cookie')
  if (!header) return ''
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const index = trimmed.indexOf('=')
    if (index === -1) continue
    if (trimmed.slice(0, index) === name) return trimmed.slice(index + 1)
  }
  return ''
}

function shapeCredential(request, secure) {
  const name = officialCookieName(request, secure)
  if (name && COOKIE_VALUE_PATTERN.test(presentedCookie(request, name))) return true
  return false
}

// Whichever policy this host gets, one call answers "refuse with what, if
// anything". `mode` names the rung so a response can be traced to the surface
// that served it without reading this file.
function makeRouteAuthority(ctx) {
  const connection = serviceOf(ctx, 'connection')
  const official = connection && typeof connection.requestRejection === 'function'
  const auth = connection && connection.browserAuth && typeof connection.browserAuth.isAuthenticated === 'function'
    ? connection.browserAuth
    : undefined
  const mode = official ? 'official' : auth ? 'host-verifiers' : 'shape'
  return {
    mode,
    rejection(request) {
      try {
        if (official) {
          const status = connection.requestRejection(request)
          return typeof status === 'number' ? status : 0
        }
        const secure = requestSecure(request)
        if (auth) {
          // `authenticateApi` is the ONLY verifier that accepts both credential
          // kinds: it checks the signature and returns the operator id for a
          // `version: 2` cookie (what `/connect?token=` mints, the API credential
          // a fetch caller would present) and `undefined` for a browser session.
          // `isAuthenticated` alone accepts `version: 1` only, so it is the
          // second rung and never the sole test - measured on the host, not
          // assumed.
          if (typeof auth.authenticateApi === 'function' && auth.authenticateApi(request, secure) !== undefined) return 0
          if (auth.isAuthenticated(request, secure)) return 0
          return 401
        }
        return shapeCredential(request, secure) ? 0 : 401
      } catch (error) {
        console.warn('[dsh-subagent-workspace-ui] connection admission failed', error)
        return 401
      }
    },
  }
}

// One endpoint = one descriptor, consumed by both surfaces. `methods` is the
// fetch face's own vocabulary; the legacy surface routes NO method here that
// the descriptor does not own (that is its 405, which the fetch face expresses
// by not owning the method at all). Each handler returns the same JSON body and
// status the pre-migration route wrote, so no client or test sees a change in
// shape once the request is admitted.
function routeDescriptors(deps) {
  const { ctx, ledger } = deps
  return [
    {
      path: EXTERNAL_STATUS_PATH,
      methods: ['GET'],
      async handle() {
        // The ledger is read-only and carries no prompt text or model output;
        // the owner check of the fetch face (or the fallback gate) is what keeps
        // it to the operator.
        return jsonResponse(200, ledger.snapshot())
      },
    },
    {
      path: EXTERNAL_STOP_PATH,
      methods: ['POST'],
      async handle(request) {
        const args = await readJsonArgs(request)
        if (args.error) return jsonResponse(400, { ok: false, error: args.error })
        const runId = args.value && args.value.runId
        if (typeof runId !== 'string' || !runId) {
          return jsonResponse(400, { ok: false, error: 'missing-run-id' })
        }
        const run = ledger.snapshot().active.find((entry) => entry.runId === runId)
        if (!run) return jsonResponse(409, { ok: false, error: 'not-running' })
        if (!run.parentId) return jsonResponse(409, { ok: false, error: 'missing-parent' })
        const subagents = resolveSubagents(ctx)
        if (!subagents || typeof subagents.interrupt !== 'function') {
          return jsonResponse(501, { ok: false, error: 'unsupported' })
        }
        try {
          subagents.interrupt(run.id, { kind: 'user', parentSessionId: run.parentId })
          return jsonResponse(200, { ok: true, interrupt: 'requested', runId: run.runId })
        } catch (e) {
          return jsonResponse(502, { ok: false, error: 'interrupt-failed', message: e && e.message })
        }
      },
    },
    {
      path: DELETE_PATH,
      methods: ['POST'],
      async handle(request) {
        const args = await readJsonArgs(request)
        if (args.error) return jsonResponse(400, { ok: false, error: args.error })
        const { sessionId, parentSessionId } = args.value || {}
        if (!sessionId) return jsonResponse(400, { ok: false, error: 'missing-session-id' })
        try {
          const result = await deleteSingleSubagent(ctx, sessionId, parentSessionId)
          return jsonResponse(200, { ok: true, ...result })
        } catch (e) {
          return jsonResponse(500, { ok: false, error: e.message })
        }
      },
    },
    {
      path: BATCH_DELETE_PATH,
      methods: ['POST'],
      async handle(request) {
        const args = await readJsonArgs(request)
        if (args.error) return jsonResponse(400, { ok: false, error: args.error })
        const { items } = args.value || {}
        if (!Array.isArray(items) || !items.length) {
          return jsonResponse(400, { ok: false, error: 'missing-items' })
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
          return jsonResponse(200, { ok: true, deletedCount: results.length, results })
        } catch (e) {
          return jsonResponse(500, { ok: false, error: e.message })
        }
      },
    },
  ]
}

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

// The fetch face hands a buffered body over through `request.json()`; the
// legacy surface hands a stream. One reader erases the difference, keeping the
// legacy error taxonomy: an unparseable (or unreadable) body is `invalid-json`,
// an empty body is `{}`.
async function readJsonArgs(request) {
  try {
    const text = await request.text()
    if (!text) return { value: {} }
    return { value: JSON.parse(text) }
  } catch {
    return { error: 'invalid-json' }
  }
}

function registerFetchRoutes(ctx, face, descriptors) {
  for (const descriptor of descriptors) {
    routeEffect(ctx, () => face.register({
      path: descriptor.path,
      methods: descriptor.methods,
      requestBody: 'buffered',
      fetch: descriptor.handle,
    }))
  }
}

function legacyOrigin(webServer) {
  const protocol = webServer && webServer.protocol === 'https:' ? 'https:' : 'http:'
  const host = (webServer && webServer.host) || '127.0.0.1'
  return `${protocol}//${host}`
}

function registerLegacyRoutes(ctx, webServer, descriptors) {
  const origin = (() => {
    try {
      return legacyOrigin(webServer)
    } catch {
      return 'http://127.0.0.1'
    }
  })()
  const disposers = []
  for (const descriptor of descriptors) {
    // The browser-visible absolute path, which already carries `/api`: the
    // legacy surface strips nothing, so this is the whole route path.
    disposers.push(routeEffect(ctx, () => webServer.register({
      kind: 'exact',
      path: descriptor.path,
      handler: async (req, res) => {
        const request = toFetchRequest(req, origin)
        const rejection = await descriptor.authority.rejection(request)
        if (rejection) {
          sendJson(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
          return
        }
        if (!descriptor.methods.includes(req.method)) {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        let response
        try {
          response = await descriptor.handle(new Request(request.url, {
            method: req.method,
            headers: request.headers,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req),
          }))
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e && e.message ? e.message : String(e) })
          return
        }
        const body = await response.text()
        res.writeHead(response.status, {
          'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
        })
        res.end(body)
      },
    })))
  }
  // One disposer that gives every legacy route back, used by the upgrade.
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        console.warn('[dsh-subagent-workspace-ui] could not dispose a legacy route', error)
      }
    }
  }
}

// How long a webServer binding may be held while waiting for the connection
// service, whose fetch face is the authenticated surface. MEASURED on
// 0.2.1-rc.2: `webServer` provides at ~1.0 s after plugin activation and
// `connection` + its fetch face at ~1.26 s, so the window is real and small.
// The timer is `ctx.setTimeout`, so it dies with the plugin.
const FETCH_FACE_GRACE_MS = 3000

// Decide the ONE surface that takes the routes and keep them there.
//
// The two surfaces are mutually exclusive on the same path (a webServer EXACT
// route shadows the official `/api` prefix route; see ROUTE_BASE_PATH), so the
// choice cannot be "first service that arrives": a real 0.2.1 host provides
// `webServer` first and would then be pinned to the unauthenticated surface for
// the life of the process. The policy is therefore:
//   1. fetch face present  -> use it (authenticated, official).
//   2. only webServer      -> bind the legacy surface immediately BUT keep
//                             waiting for the fetch face for
//                             FETCH_FACE_GRACE_MS; if it arrives, dispose the
//                             legacy routes and move over, so the steady state
//                             on a modern host is always the fetch face.
//   3. after the window    -> the legacy binding (plus its own verification)
//                             is what this host gets, permanently.
function routeSurfaces(ctx, ledger) {
  const descriptors = routeDescriptors({ ctx, ledger })
  const authority = makeRouteAuthority(ctx)
  const bound = descriptors.map((descriptor) => ({ ...descriptor, authority }))
  let current = 'none'
  let legacyDisposer
  let graceTimer

  function useConnection(face) {
    closeGrace()
    if (legacyDisposer) {
      legacyDisposer()
      legacyDisposer = undefined
    }
    try {
      registerFetchRoutes(ctx, face, bound)
    } catch (error) {
      // A second registration of the same path throws (the connection service
      // refuses duplicates). That means another binding already owns it, so the
      // right answer is not to crash the plugin: report and stay put.
      console.warn('[dsh-subagent-workspace-ui] the connection fetch route was already claimed', error)
      return false
    }
    current = 'connection'
    console.info('[dsh-subagent-workspace-ui] external-agent and delete routes served on connection')
    return true
  }

  function useLegacy(webServer) {
    legacyDisposer = registerLegacyRoutes(ctx, webServer, bound)
    current = 'webServer'
    console.info(
      `[dsh-subagent-workspace-ui] external-agent and delete routes served on webServer (policy: ${authority.mode}); waiting ${FETCH_FACE_GRACE_MS} ms for the authenticated connection surface`,
    )
    // The plugin context has no `setTimeout`, so the window uses a plain timer
    // and its cleanup is owned through `ctx.effect` (it dies with the plugin).
    // The timer only CLOSES the window: it never tears the legacy routes down,
    // so a host without the fetch face keeps serving exactly as before.
    graceTimer = setTimeout(() => {
      graceTimer = undefined
      if (current === 'webServer' && !connectionFetchFace(ctx)) {
        console.info('[dsh-subagent-workspace-ui] connection surface absent; the verified webServer fallback is permanent')
      }
    }, FETCH_FACE_GRACE_MS)
    if (typeof graceTimer.unref === 'function') graceTimer.unref()
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        if (graceTimer) {
          clearTimeout(graceTimer)
          graceTimer = undefined
        }
      })
    }
  }

  function closeGrace() {
    if (!graceTimer) return
    clearTimeout(graceTimer)
    graceTimer = undefined
  }

  return {
    get current() {
      return current
    },
    // True when this call installed a surface (the caller stops polling).
    attach() {
      if (current !== 'none') return true
      const face = connectionFetchFace(ctx)
      if (face) {
        useConnection(face)
        return true
      }
      const webServer = serviceOf(ctx, 'webServer')
      if (!webServer) return false
      useLegacy(webServer)
      return true
    },
    // Upgrade a webServer binding the moment the fetch face shows up. Idempotent
    // and independent of the timer, so the upgrade does not depend on which of
    // the two events (service arrival, timer expiry) the runtime delivers first.
    upgrade() {
      if (current !== 'webServer') return
      const face = connectionFetchFace(ctx)
      if (face) useConnection(face)
    },
  }
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
  // Routes are wrapped in `ctx.effect`, whose disposer removes them, so each
  // surface is installed exactly once. Readiness is either carrier, injected
  // SEPARATELY (a multi-service `ctx.inject` fires only when EVERY name is
  // present, which would leave a webServer-only host with no routes at all).
  const surfaces = routeSurfaces(ctx, ledger)
  const tryAttach = () => {
    if (surfaces.attach()) return true
    return false
  }
  if (connectionFetchFace(ctx)) {
    surfaces.attach()
    return
  }
  if (serviceOf(ctx, 'webServer') !== undefined) {
    // `webServer` is here but the connection service may still be loading: bind
    // the verified fallback now, then let the inject below upgrade it.
    surfaces.attach()
  }
  ctx.inject(['webServer'], () => {
    tryAttach()
  })
  ctx.inject(['connection'], () => {
    if (surfaces.current === 'none') surfaces.attach()
    else surfaces.upgrade()
  })
}
