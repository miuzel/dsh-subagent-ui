// g-026 / att-002: the delete-side storage purge.
//
// THE BUG. Deleting a subagent removes its session directories, but the host
// also keeps per-session records in its `storageDomain` domains
// (`session_projcache.sessions` backs a session header; `workspace.workspaces`
// and the `workspace` global hold membership and the archived/pinned lists). The
// plugin's `stripStorageDomains` read that service with a BARE `ctx.get` from a
// context that never declared it — so on a real host the get produced nothing,
// the function returned before doing anything, and the deleted child's cached
// record survived. The host kept listing the session and the manager kept
// rendering its row: the reported "I deleted it and the row is still there".
//
// THE FIX is `resolveStorageDomain`: the service is resolved per call through
// `ctx.extend({ inject: ['storageDomain'] })` (the same pattern as
// `resolveSubagents`), never through a top-level inject that would stop the
// plugin loading on a host without storage domains. This file proves four
// things about it, against REAL code on both sides:
//
//   A. REAL ROUTE, REAL PURGE. The plugin runs on a real cordis Context; the
//      purge is driven through its real `/delete` route over real HTTP (host
//      `admit`, host-minted cookie). Before the call the child has a checkpoint
//      in the projection domain and an entry in the workspace domain AND
//      global; after it, none of them, `cachePurged:true`, and an unrelated
//      session untouched.
//
//   B. THE CONTROL — THE PRE-FIX READ. The SAME plugin, on the SAME context with
//      the SAME storage, is kept from ever declaring the injection: its
//      `extend` is replaced by a forwarder that drops an `inject` payload (a
//      declared dependency is exactly what a bare `ctx.get` lacks). The record
//      MUST survive and the answer MUST NOT claim a purge. `ctx.get` in cordis
//      is deliberately injection-free, so "uninjected" can only be expressed by
//      denying `extend`; the forwarder keeps everything else working, so B is a
//      real end-to-end delete and not a stubbed one.
//
//   C. FAILURES ARE REPORTED. One table throws while the others succeed:
//      `cachePurged:false`, `status:'partial'`, the failing table named, and a
//      warning logged — while the deletion itself stays `ok:true`.
//
//   D. BATCH. Every item carries its own purge result and the batch-level flag
//      is true only when all of them completed.
//
// The storage half is the host's own `DomainFacility` over the host's own
// `JsonStorageBackend`, opened with the host's own exported domain specs
// (`projectionCacheDomainSpec`, `workspaceDomainSpec`), so the record shapes are
// the shipped ones. Everything lives in a temporary DSH_HOME.
//
// Host packages are resolved like `auth.test.mjs`; without a dsh installation
// the harness prints one SKIP line and exits 0.
import assert from 'node:assert'
import http from 'node:http'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const SPECIFIERS = {
  cordis: '@deepseek-ai/cordis',
  connection: '@deepseek-ai/dsh-client-connection',
  storage: '@deepseek-ai/dsh-storage',
  storageDomain: '@deepseek-ai/dsh-storage-domain',
  storageJson: '@deepseek-ai/dsh-storage-json',
  projcache: '@deepseek-ai/dsh-session-projection-cache',
  workspace: '@deepseek-ai/dsh-workspace',
}

// ---------------------------------------------------------------- host lookup
const candidates = []
const seenRoots = new Set()
const addCandidate = (reason, root) => {
  if (!root || seenRoots.has(root)) return
  seenRoots.add(root)
  candidates.push({ reason, root })
}
const DSH_PACKAGE_SEGMENT = 'node_modules/@deepseek-ai/dsh'
const realpathOrSelf = (p) => { try { return realpathSync(p) } catch { return p } }
function tryResolve(root, specifier) {
  try { return pathToFileURL(createRequire(join(root, 'noop.js')).resolve(specifier)).href } catch { return undefined }
}
function resolveAll(root) {
  const found = {}
  for (const [key, specifier] of Object.entries(SPECIFIERS)) {
    const url = tryResolve(root, specifier)
    if (!url) return undefined
    found[key] = url
  }
  return found
}
function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue
    const full = join(dir, name)
    try { if (statSync(full).isFile() || statSync(realpathOrSelf(full)).isFile()) return full } catch { continue }
  }
  return undefined
}
function findDshViaShell() {
  try { return execFileSync('which', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').map((l) => l.trim()).find(Boolean) } catch { return undefined }
}
function collectCandidates() {
  if (process.env.DSH_HOST_PKGS) addCandidate('DSH_HOST_PKGS', process.env.DSH_HOST_PKGS)
  addCandidate('repository', process.cwd())
  const bin = findOnPath('dsh') || findDshViaShell()
  if (bin) {
    for (const target of [bin, realpathOrSelf(bin)]) {
      const at = target.lastIndexOf(DSH_PACKAGE_SEGMENT)
      if (at !== -1) {
        const pkg = target.slice(0, at + DSH_PACKAGE_SEGMENT.length)
        addCandidate('dsh CLI', join(pkg, 'node_modules'))
        addCandidate('dsh CLI', pkg)
      }
      addCandidate('dsh CLI prefix', dirname(target))
      addCandidate('dsh CLI prefix', join(dirname(target), '..'))
    }
  }
  const prefix = dirname(dirname(realpathOrSelf(process.execPath)))
  addCandidate('node prefix', prefix)
  addCandidate('node prefix', join(prefix, 'lib', 'node_modules'))
  if (process.env.NPM_CONFIG_PREFIX) addCandidate('npm prefix', join(process.env.NPM_CONFIG_PREFIX, 'lib', 'node_modules'))
  const fnm = process.env.FNM_DIR || (process.env.HOME && join(process.env.HOME, '.local', 'share', 'fnm'))
  if (fnm) {
    let versions = []
    try { versions = readdirSync(join(fnm, 'node-versions')) } catch { versions = [] }
    for (const v of versions) addCandidate('fnm', join(fnm, 'node-versions', v, 'installation', 'lib', 'node_modules'))
  }
  if (process.env.HOME) addCandidate('HOME', process.env.HOME)
}
function hostPackages() {
  collectCandidates()
  const tried = []
  for (const candidate of candidates) {
    const found = resolveAll(candidate.root)
    if (found) return { ...found, root: candidate.root, reason: candidate.reason }
    tried.push(candidate.root)
  }
  return { tried }
}

// A closed reader (`node test/purge.test.mjs | head`) must not fail the run.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
const rawConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error }
const warnings = []
for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...args) => {
    if (level === 'warn') warnings.push(args.map((a) => (a && a.message ? a.message : String(a))).join(' '))
    if (process.stdout.destroyed || !process.stdout.writable) return
    try { rawConsole[level](...args) } catch { /* reader went away */ }
  }
}

const host = hostPackages()
if (!host.cordis) {
  console.log(`SKIP purge.test.mjs: no dsh host packages found (${SPECIFIERS.storageDomain} / ${SPECIFIERS.connection} did not resolve from any of ${host.tried.length} candidate roots). Set DSH_HOST_PKGS to the host's @deepseek-ai directory to run it. Tried:`)
  for (const root of host.tried) console.log(`  - ${root}`)
  process.exit(0)
}

// ------------------------------------------------------------ isolated home
// Everything the plugin and the storage backend write stays under this
// temporary DSH_HOME; the real `~/.dsh` is never touched.
const DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-purge-test-'))
process.env.DSH_HOME = DSH_HOME
process.on('exit', () => { try { rmSync(DSH_HOME, { recursive: true, force: true }) } catch { /* best effort */ } })

const cordis = await import(host.cordis)
const cm = await import(host.connection)
const { Storage } = await import(host.storage)
const { DomainFacility } = await import(host.storageDomain)
const { JsonStorageBackend } = await import(host.storageJson)
const { projectionCacheDomainSpec } = await import(host.projcache)
const { workspaceDomainSpec } = await import(host.workspace)

// The plugin purges by domain name, so the names are asserted against the host's
// own spec exports rather than assumed.
assert.strictEqual(projectionCacheDomainSpec.name, 'session_projcache', 'host domain name')
assert.strictEqual(workspaceDomainSpec.name, 'workspace', 'host domain name')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// One real storage facility over the host's JSON backend: what the host's
// `dsh-storage-domain` + `dsh-storage-json` mount, opened with the host's specs.
//
// The facility is PROVIDED BY A PLUGIN FIBER — the way the host mounts
// `@deepseek-ai/dsh-storage-domain` — and that detail is load-bearing: cordis
// only gates a plugin-provided service (a context that never declared it reads
// `undefined`; a service provided directly on the root is readable from
// anywhere). Providing it here from the root would silently disable the very
// distinction the control below relies on, so the fixture mounts it exactly as
// the host does: `ctx.inject([backend], (domainCtx) => { mount; provide })`.
async function makeStorage(ctx, storageDir) {
  mkdirSync(storageDir, { recursive: true })
  const backend = new JsonStorageBackend(storageDir)
  // What the host's `dsh-storage-json` apply does: register the backend on the
  // hub AND publish it under its service key (the domain form injects that key,
  // so publishing only the registration leaves the facility never mounting).
  ctx.effect(() => ctx.storage.backend.register('json', backend))
  ctx.provide('storage.backend.json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const fiber = ctx.inject(['storage.backend.json'], (domainCtx) => {
    domainCtx.effect(() => { domainCtx.storage.mount('domain', facility) })
    domainCtx.provide('storageDomain', facility)
  })
  await fiber
  await sleep(40)
  const proj = await facility.open(projectionCacheDomainSpec)
  const ws = await facility.open(workspaceDomainSpec)
  return { facility, proj, ws, storageDir }
}

// A projection checkpoint in the host's current record shape.
const checkpointOf = (id) => ({
  identity: { formatVersion: 1, createdAt: Date.now(), cwd: DSH_HOME, isSeeded: true },
  rows: {
    sessionStats: {
      ver: 1,
      seq: 9,
      val: {
        turns: 1, steps: 1, llmMs: 10, toolMs: 0, ttftMs: 5, ttftSteps: 1,
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
        uncachedInputTokens: 10, decodeMs: 10, decodeTokens: 5,
      },
    },
  },
  formatVersion: 1,
  id,
})

// -------------------------------------------------------------- host auth
const HOST_SECRET = Buffer.alloc(32, 7)
const LAUNCH_TOKEN = 'g026-launch-token'
const b64url = (value) => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const sign = (body) => createHmac('sha256', HOST_SECRET).update(body).digest()
const encodeCookie = (payload) => {
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v${payload.version}.${body}.${b64url(sign(body))}`
}
const cookieName = (authority) => 'dsh-auth-' + createHash('sha256').update(authority).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
function credentialOf(request) {
  const authority = new URL(`http://${request.headers.host}`).host
  const name = cookieName(authority)
  const header = request.headers.cookie
  if (!header) return undefined
  let value
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    value = segment.slice(at + 1).trim()
  }
  if (!value) return undefined
  const parts = value.split('.')
  if (parts.length !== 3) return undefined
  const [version, body, encoded] = parts
  if (encoded !== b64url(sign(body))) return undefined
  let payload
  try { payload = JSON.parse(Buffer.from(body.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8')) } catch { return undefined }
  if (payload.authority !== authority || payload.issuedAt > Date.now() || payload.expiresAt <= Date.now()) return undefined
  return version === `v${payload.version}` ? payload : undefined
}
const holder = { conn: undefined }
const hostAuth = {
  isAuthenticated: (request) => credentialOf(request)?.version === 1,
  authenticateApi: (request) => { const payload = credentialOf(request); return payload?.version === 2 ? payload.id : undefined },
  authorizeConnect(request, response) {
    const match = /[?&]token=([^&]*)/.exec(request.url)
    if (!match || match[1] !== LAUNCH_TOKEN) { response.writeHead(401, {}); response.end(); return }
    const id = holder.conn.publishPeer('none')
    const authority = new URL(`http://${request.headers.host}`).host
    const now = Date.now()
    response.writeHead(302, { 'set-cookie': `${cookieName(authority)}=${encodeCookie({ version: 2, authority, issuedAt: now, expiresAt: now + 86400000, id }, HOST_SECRET)}; Path=/` })
    response.end()
  },
}
function mintCookie(port) {
  const captured = { headers: {} }
  hostAuth.authorizeConnect({ url: `/connect?token=${LAUNCH_TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, { writeHead(status, headers) { captured.status = status; captured.headers = headers || {} }, end() {} })
  if (!captured.headers['set-cookie']) throw new Error('the host minted no cookie')
  return captured.headers['set-cookie'].split(';')[0]
}

// The CONTROL: the same plugin source with the injected facility ignored — the
// shape the pre-fix code had (`ctx.get`, which never reached the service). The
// module is re-read from disk and re-evaluated as a copy in the isolated home,
// so the control runs the REAL delete path with only this one line differing.
const PRE_FIX_PATCH = (source) => source.replace(
  'function resolveStorageDomain() {\n  return storageDomainState.facility\n}',
  'function resolveStorageDomain() {\n  return undefined\n}',
)
async function loadPreFixPlugin() {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const patched = PRE_FIX_PATCH(source)
  assert.notStrictEqual(patched, source, 'the control patch applied to the shipped source')
  const dir = join(DSH_HOME, 'prefix-plugin')
  mkdirSync(dir, { recursive: true })
  const copy = join(dir, `index-${mounts}.mjs`)
  writeFileSync(copy, patched)
  const mod = await import(pathToFileURL(copy).href)
  await mod.ready()
  return mod
}
let mounts = 0

// Mount the plugin (a fresh module instance, so nothing leaks between scenarios)
// on a real cordis root and serve it over real HTTP through the host's own
// `/api` carrier (admit -> shared fetch handler).
//
// `preFix: true` ignores the injected facility (the control); everything else —
// routes, auth, storage, the delete itself — stays the real code.
async function mountPlugin(dirnameOfRun, options = {}) {
  const root = new cordis.Context()
  // The host's storage hub registers ITSELF as `storage` on construction.
  new Storage(root)
  const ws = { protocol: 'http:', host: '127.0.0.1', exact: new Map(), register(route) { this.exact.set(route.path, route); return () => this.exact.delete(route.path) } }
  root.provide('webServer', ws)
  const connection = new cm.HostConnectionService(root, [], hostAuth)
  connection.browserAuth = hostAuth
  holder.conn = connection
  const storage = await makeStorage(root, join(dirnameOfRun, 'backend'))
  const serverCtx = root
  const url = new URL('../lib/index.js', import.meta.url)
  url.search = `?g026=${mounts++}`
  const mounted = options.preFix ? await loadPreFixPlugin() : await import(url.href)
  await mounted.ready()
  // The plugin's own fiber declares NOTHING (the shipped `inject: []`): the
  // reader fiber it starts itself is what sees `storageDomain`.
  const pluginFiber = serverCtx.plugin({ name: 'dsh-subagent-workspace-ui', inject: [], apply: mounted.apply })
  await pluginFiber
  await sleep(60)
  const shared = connection.createSharedFetchHandler(cm.API_PATH)
  const server = http.createServer(async (req, res) => {
    const admission = connection.admit(req)
    if ('rejection' in admission) { res.writeHead(admission.rejection); res.end('refused'); return }
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(',') : v)
    let body
    if (req.method !== 'GET' && req.method !== 'HEAD') body = await new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c }); req.on('end', () => resolve(d)) })
    const response = await shared.fetch(new Request(new URL(req.url, `http://127.0.0.1:${server.address().port}`), { method: req.method, headers, body }), admission.peer)
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'text/plain' })
    res.end(await response.text())
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { storage, server, port, cookie: mintCookie(port), root, pluginFiber }
}

function postJson(port, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', cookie } }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => { let json = null; try { json = JSON.parse(data) } catch { json = null } resolve({ status: res.statusCode, json, text: data }) })
    })
    req.on('error', reject)
    req.write(JSON.stringify(body))
    req.end()
  })
}

// Every file the storage root actually holds, so "purged" is checked on the
// medium and not only in the facility's memory.
function filesUnder(dir) {
  const out = []
  const walk = (current) => {
    let names = []
    try { names = readdirSync(current) } catch { return }
    for (const name of names) {
      const full = join(current, name)
      let isDir = false
      try { isDir = statSync(full).isDirectory() } catch { continue }
      if (isDir) walk(full)
      else out.push(full)
    }
  }
  walk(dir)
  return out
}

const evidence = []
const record = (name, facts) => evidence.push({ name, ...facts })
const ROUTE = '/api/dsh-subagent-workspace-ui/'
let runIndex = 0
const newDir = () => { runIndex += 1; const dir = join(DSH_HOME, `run-${runIndex}`); mkdirSync(dir, { recursive: true }); return dir }
const closeMount = async (mount) => { mount.server.close(); await sleep(20) }

// --------------------------------------------------------------------------
// A. THE FIX, end to end through the real route.
// --------------------------------------------------------------------------
async function scenarioPurge() {
  const mount = await mountPlugin(newDir())
  try {
    const id = randomUUID()
    const other = randomUUID()
    const proj = mount.storage.proj.table('sessions')
    const wsTable = mount.storage.ws.table('workspaces')
    const wid = randomUUID()
    const stamp = new Date().toISOString()
    await proj.put(id, checkpointOf(id))
    await proj.put(other, checkpointOf(other))
    await wsTable.put(wid, { path: DSH_HOME, title: 'w', sessionIds: [id, other], createdAt: stamp, updatedAt: stamp })
    const g = mount.storage.ws.global
    await g.set({ ...g.get(), archivedSessionIds: [id, other], pinnedSessionIds: [id] })
    assert.ok(proj.get(id), 'fixture: the projection checkpoint exists BEFORE the delete')
    const before = filesUnder(mount.storage.storageDir)
    assert.ok(before.some((file) => file.includes(id)), 'fixture: the checkpoint is on disk BEFORE the delete')

    const res = await postJson(mount.port, ROUTE + 'delete', { sessionId: id }, mount.cookie)
    assert.strictEqual(res.status, 200, 'delete answers 200; body=' + res.text)
    assert.strictEqual(res.json.ok, true, 'the session is deleted')
    assert.strictEqual(res.json.deleted, true, '`deleted` is reported')
    assert.strictEqual(res.json.cachePurged, true, '`cachePurged` is true; body=' + res.text)
    assert.strictEqual(res.json.cachePurge.status, 'purged', 'purge status')
    assert.deepStrictEqual([...res.json.cachePurge.purged].sort(), ['session_projcache.sessions', 'workspace.global', 'workspace.workspaces'], 'every session-indexed table was purged')
    assert.deepStrictEqual(res.json.cachePurge.failed, [], 'no step failed')

    assert.strictEqual(proj.get(id), undefined, 'the projection checkpoint of the deleted child is GONE')
    assert.ok(proj.get(other), 'an unrelated session checkpoint is untouched')
    assert.deepStrictEqual(wsTable.get(wid).sessionIds, [other], 'workspace membership keeps only the other session')
    const state = g.get()
    assert.deepStrictEqual(state.archivedSessionIds, [other], 'the archived list keeps only the other session')
    assert.deepStrictEqual(state.pinnedSessionIds, [], 'the pinned list dropped the deleted session')
    const after = filesUnder(mount.storage.storageDir)
    assert.ok(!after.some((file) => file.includes(id)), 'no stored document for the deleted session survives')
    assert.strictEqual(after.length, before.length - 1, `exactly one stored document was removed (${before.length} -> ${after.length})`)
    record('A end-to-end purge', { cachePurged: res.json.cachePurged, status: res.json.cachePurge.status, tables: res.json.cachePurge.purged, docsBefore: before.length, docsAfter: after.length })
  } finally {
    await closeMount(mount)
  }
}

// --------------------------------------------------------------------------
// B. THE CONTROL: the same plugin, storage and route, but the dependency can
//    never be declared (the pre-fix read). The record survives, and the answer
//    does not pretend otherwise.
// --------------------------------------------------------------------------
async function scenarioPreFixControl() {
  const mount = await mountPlugin(newDir(), { preFix: true })
  try {
    const id = randomUUID()
    const other = randomUUID()
    const proj = mount.storage.proj.table('sessions')
    await proj.put(id, checkpointOf(id))
    await proj.put(other, checkpointOf(other))
    assert.ok(proj.get(id), 'fixture: the checkpoint exists before the delete')
    const res = await postJson(mount.port, ROUTE + 'delete', { sessionId: id }, mount.cookie)
    assert.strictEqual(res.status, 200, 'the deletion itself still succeeds; body=' + res.text)
    assert.strictEqual(res.json.deleted, true, 'the session is deleted')
    assert.ok(proj.get(id), 'control: the projection checkpoint SURVIVES the undeclared read — this is the reported bug')
    assert.strictEqual(res.json.cachePurged, false, 'control: the answer does NOT claim a purge that never ran; body=' + res.text)
    assert.strictEqual(res.json.cachePurge.status, 'missing', 'control: the report names the missing service; body=' + res.text)
    record('B pre-fix control', { cachePurged: res.json.cachePurged, status: res.json.cachePurge.status, recordSurvived: true })
  } finally {
    await closeMount(mount)
  }
}

// --------------------------------------------------------------------------
// C. A FAILING STEP IS REPORTED, not swallowed.
// --------------------------------------------------------------------------
async function scenarioPartialFailure() {
  const mount = await mountPlugin(newDir())
  try {
    const id = randomUUID()
    const proj = mount.storage.proj.table('sessions')
    await proj.put(id, checkpointOf(id))
    const original = proj.delete.bind(proj)
    proj.delete = async () => { throw new Error('simulated write failure') }
    try {
      const res = await postJson(mount.port, ROUTE + 'delete', { sessionId: id }, mount.cookie)
      assert.strictEqual(res.status, 200, 'the route still answers 200; body=' + res.text)
      assert.strictEqual(res.json.ok, true, 'the session is deleted, so ok stays true')
      assert.strictEqual(res.json.cachePurged, false, 'a failed purge is NOT reported as purged; body=' + res.text)
      assert.strictEqual(res.json.cachePurge.status, 'partial', 'the other tables still completed')
      const failed = res.json.cachePurge.failed.map((entry) => entry.domain + '.' + entry.table)
      assert.deepStrictEqual(failed, ['session_projcache.sessions'], 'the failing table is named; body=' + res.text)
      assert.match(String(res.json.cachePurge.failed[0].error), /simulated write failure/, 'the error text is carried')
      assert.ok(warnings.some((line) => line.includes('could not purge session_projcache.sessions')), 'a warning was logged for the failing table')
      assert.deepStrictEqual([...res.json.cachePurge.purged].sort(), ['workspace.global', 'workspace.workspaces'], 'the steps that worked are reported as purged')
    } finally {
      proj.delete = original
    }
    record('C partial failure', { cachePurged: false, status: 'partial', named: 'session_projcache.sessions', warned: true })
  } finally {
    await closeMount(mount)
  }
}

// --------------------------------------------------------------------------
// D. Batch delete reports the purge for every item.
// --------------------------------------------------------------------------
async function scenarioBatch() {
  const mount = await mountPlugin(newDir())
  try {
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    const proj = mount.storage.proj.table('sessions')
    for (const id of ids) await proj.put(id, checkpointOf(id))
    const res = await postJson(mount.port, ROUTE + 'batch-delete', { items: ids.map((sessionId) => ({ sessionId })) }, mount.cookie)
    assert.strictEqual(res.status, 200, 'batch delete answers 200; body=' + res.text)
    assert.strictEqual(res.json.deletedCount, 3, 'all three deleted')
    assert.strictEqual(res.json.cachePurged, true, 'the batch purge completed')
    for (const entry of res.json.results) assert.strictEqual(entry.cachePurged, true, 'each item reports its purge: ' + entry.sessionId)
    for (const id of ids) assert.strictEqual(proj.get(id), undefined, 'every checkpoint is gone: ' + id)
    record('D batch', { items: 3, cachePurged: true })
  } finally {
    await closeMount(mount)
  }
}

try {
  await scenarioPurge()
  await scenarioPreFixControl()
  await scenarioPartialFailure()
  await scenarioBatch()
} catch (error) {
  console.log(JSON.stringify({ evidence, warnings: warnings.slice(0, 5) }, null, 1))
  throw error
}
console.log(JSON.stringify({ evidence }, null, 1))
// The plugin leaves live timers behind, so the loop would never drain.
process.exit(0)
