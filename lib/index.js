import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

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
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 64 * 1024) {
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

function registerHttpRoutes(webServer, ctx) {
  ctx.effect(() => webServer.register({
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
  }))

  ctx.effect(() => webServer.register({
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
  }))
}

export function apply(ctx) {
  console.info('[dsh-subagent-workspace-ui] host plugin loaded')
  const ws = ctx.get('webServer')
  if (ws !== undefined) {
    registerHttpRoutes(ws, ctx)
  } else {
    ctx.inject(['webServer'], (sub) => {
      registerHttpRoutes(sub.webServer, sub)
    })
  }
}
