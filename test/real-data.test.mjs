// g-026 / att-003 — END-TO-END REPRODUCTION ON THE OPERATOR'S OWN SESSION DATA.
//
// The operator's report: after a reinstall, a `dsh web` restart and a hard
// refresh, the manager still lists deleted children as stub rows. The browser
// half of this attempt reads the host's existence answer; the host half answers
// "does this child still own a session directory". This file closes the loop on
// HIS data, entirely inside `tmp/`:
//
//   1. A COPY of the real sessions root (~/.dsh/sessions) is taken READ-ONLY
//      (`cp -a`; the source is never opened for writing, and the run aborts if
//      anything under it changes mtime/size).
//   2. The parent session whose log names the children is located by scanning
//      the copied generation logs for `subagent/catalog` events; its children are
//      split into "directory present" and "directory gone" by the HOST's rule
//      (`findLog` on the host's own persistence service mounted over the copy).
//   3. The plugin's `/session-entity` route (through the host's authenticated
//      `/api` channel) is asked about every child id — this is what the browser
//      receives.
//   4. THE REAL MANAGER COMPONENT (the built `lib/client.js`, loaded into the
//      render harness) is fed the parent's real catalog plus the host's real
//      answer: the rows whose directory is gone must not render, the rows whose
//      directory survives must, and no other row may change.
//   5. The delivered, not-yet-filtered half is shown as the CONTROL: the same
//      bundle with rung 2 disabled renders exactly the catalog, including every
//      stub — which is the operator's screenshot.
//
// Opt-in: this needs the read access `~/.dsh` (never write) and a session tree
// large enough to be worth copying, so it runs only with
//   DSH_REAL_HOME=~/.dsh node test/real-data.test.mjs
// Without that variable it prints one SKIP line and exits 0. When run, a missing
// `~/.dsh` is also a SKIP, and an unreadable parent log is a FAILURE (the
// operator's data must not be quietly declared "nothing to check").
import assert from 'node:assert'
import http from 'node:http'
import { createHash, createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SOURCE_HOME = process.env.DSH_REAL_HOME || ''
if (!SOURCE_HOME) {
  console.log('SKIP real-data.test.mjs: set DSH_REAL_HOME=~/.dsh to replay the operator\'s session data through the built bundle in an isolated copy.')
  process.exit(0)
}
const SOURCE_SESSIONS = join(SOURCE_HOME, 'sessions')
if (!existsSync(SOURCE_SESSIONS)) {
  console.log(`SKIP real-data.test.mjs: ${SOURCE_SESSIONS} does not exist.`)
  process.exit(0)
}
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
const rawConsole = { log: console.log, warn: console.warn }
console.warn = () => {}

// ------------------------------------------------------------ isolated copy
const WORK = mkdtempSync(join(process.cwd(), 'tmp', 'real-data-'))
const ISOLATED_HOME = join(WORK, 'home')
const COPY = join(ISOLATED_HOME, 'sessions')
mkdirSync(ISOLATED_HOME, { recursive: true })
// `cp -a` preserves metadata; the source is only ever READ.
execFileSync('cp', ['-a', `${SOURCE_SESSIONS}/.`, COPY], { stdio: 'ignore' })
// The host's projection checkpoint for a session lives OUTSIDE `sessions/`
// (`~/.dsh/storages/session_projcache`), and that checkpoint is what makes a
// parent's header listable after a restart. A copy without it would let the host
// re-fold the parent's log and reshuffle the catalog. So the storage root and
// `workspace.json` are copied too — both read-only from the source — which makes
// this the same starting state the operator's host wakes up in.
if (process.env.DSH_REAL_SKIP_STORAGES !== '1') {
  for (const name of ['storages', 'workspace.json']) {
    const from = join(SOURCE_HOME, name)
    if (!existsSync(from)) continue
    try { execFileSync('cp', ['-a', from, join(ISOLATED_HOME, name)], { stdio: 'ignore' }) } catch { /* optional */ }
  }
}
process.env.DSH_HOME = ISOLATED_HOME
const fingerprint = (root) => {
  const out = []
  for (const slug of readdirSync(root).sort()) {
    let inner = []
    try { inner = readdirSync(join(root, slug)).sort() } catch { continue }
    for (const name of inner) {
      try { const s = statSync(join(root, slug, name)); out.push(`${slug}/${name}:${s.size}:${s.mtimeMs}`) } catch { /* skipped */ }
    }
  }
  return createHash('sha256').update(out.join('\n')).digest('hex')
}
const sourceBefore = fingerprint(SOURCE_SESSIONS)
const sourceStorageBefore = (() => {
  const storages = join(SOURCE_HOME, 'storages', 'session_projcache', 'sessions')
  try { return createHash('sha256').update(readdirSync(storages).sort().join(',')).digest('hex') } catch { return 'missing' }
})()
const cleanup = () => { try { rmSync(WORK, { recursive: true, force: true }) } catch { /* best effort */ } }
process.on('exit', () => {
  try {
    const after = fingerprint(SOURCE_SESSIONS)
    if (after !== sourceBefore) console.error('real-data.test.mjs: WARNING the real sessions root changed during the run')
    const storages = join(SOURCE_HOME, 'storages', 'session_projcache', 'sessions')
    const storageAfter = (() => { try { return createHash('sha256').update(readdirSync(storages).sort().join(',')).digest('hex') } catch { return 'missing' } })()
    if (storageAfter !== sourceStorageBefore) console.error('real-data.test.mjs: WARNING the real projection storage changed during the run')
  } catch { /* source went away */ }
  cleanup()
})

// ------------------------------------------------------------ host packages
const candidates = []
const add = (root) => { if (root && !candidates.includes(root)) candidates.push(root) }
add(process.env.DSH_HOST_PKGS)
const bin = (process.env.PATH || '').split(':').map((d) => d && join(d, 'dsh')).find((p) => p && existsSync(p))
if (bin) {
  for (const target of [bin, realpathOrSelf(bin)]) {
    const at = target.lastIndexOf('node_modules/@deepseek-ai/dsh')
    if (at !== -1) {
      const pkg = target.slice(0, at + 'node_modules/@deepseek-ai/dsh'.length)
      add(join(pkg, 'node_modules'))
      add(pkg)
    }
  }
}
const prefix = dirname(dirname(realpathOrSelf(process.execPath)))
add(join(prefix, 'lib', 'node_modules'))
add(prefix)
function realpathOrSelf(p) { try { return realpathSync(p) } catch { return p } }
function resolveFrom(root, specifier) { try { return pathToFileURL(createRequire(join(root, 'noop.js')).resolve(specifier)).href } catch { return undefined } }
let host = null
for (const root of candidates) {
  const cordis = resolveFrom(root, '@deepseek-ai/cordis')
  const connection = resolveFrom(root, '@deepseek-ai/dsh-client-connection')
  const persist = resolveFrom(root, '@deepseek-ai/dsh-session-persistence-jsonl')
  if (cordis && connection && persist) { host = { cordis, connection, persist }; break }
}
if (!host) {
  console.log('SKIP real-data.test.mjs: no dsh host packages resolved; cannot mount the host persistence service.')
  process.exit(0)
}
const cordis = await import(host.cordis)
const cm = await import(host.connection)
const persist = await import(host.persist)
const plugin = await import(new URL('../lib/index.js', import.meta.url).href)
await plugin.ready()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The host's own session scanner over the COPY is the oracle for "the directory
// exists": it is the same code the host uses to list sessions.
const persistenceRoot = new cordis.Context()
await persistenceRoot.plugin({ name: persist.name, Config: persist.Config, apply: persist.apply }, { root: COPY })
const persistence = persistenceRoot.get('sessionPersistence')
assert.ok(persistence && typeof persistence.findLog === 'function', 'host persistence mounted over the copy')

// ------------------------------------------------------------ the catalog
// Every `subagent/catalog` event of the whole copied tree, read straight out of
// the generation logs (zstd decoded by the host's own log format: the files are
// plain JSONL once decoded, and `zstd -dc` is the CLI the format documents).
const children = new Map()
const parents = new Map()
for (const slug of readdirSync(COPY)) {
  const slugDir = join(COPY, slug)
  let names = []
  try { names = readdirSync(slugDir) } catch { continue }
  for (const name of names) {
    const dir = join(slugDir, name)
    let files = []
    try { files = readdirSync(dir).filter((f) => f.startsWith('session.v') && f.includes('.jsonl')) } catch { continue }
    for (const file of files) {
      const full = join(dir, file)
      let text
      try {
        text = file.endsWith('.zstd')
          ? execFileSync('zstd', ['-dc', full], { maxBuffer: 1 << 30, encoding: 'utf8' })
          : readFileSync(full, 'utf8')
      } catch { continue }
      for (const line of text.split('\n')) {
        const at = line.indexOf('"subagent/catalog"')
        if (at === -1) continue
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (event.type !== 'subagent/catalog') continue
        const data = event.data || {}
        if (typeof data.childId !== 'string') continue
        if (!children.has(data.childId)) children.set(data.childId, { id: data.childId, mode: data.mode || 'continuable', label: data.label })
        const parentId = name
        if (!parents.has(parentId)) parents.set(parentId, { parentId, entries: new Map() })
        parents.get(parentId).entries.set(data.childId, true)
      }
    }
  }
}
if (!children.size) {
  console.log('SKIP real-data.test.mjs: no `subagent/catalog` event in the copied tree (this is not a failure of the plugin).')
  process.exit(0)
}
// The parent this run replays: the OPERATOR'S own parent when it is in the tree
// (the session he reported from), otherwise the parent with the most catalogued
// children whose own session still exists in the copy.
const OPERATOR_PARENT = process.env.DSH_REAL_PARENT || 'session-a0f8ca99-5f2d-40d1-92b9-97f2d0565c10'
let chosen = null
const operatorEntry = parents.get(OPERATOR_PARENT)
if (operatorEntry) {
  const log = await persistence.findLog(OPERATOR_PARENT)
  if (log) chosen = { parentId: OPERATOR_PARENT, score: operatorEntry.entries.size, ids: [...operatorEntry.entries.keys()], source: 'operator' }
}
if (!chosen) {
  for (const [parentId, entry] of parents) {
    const log = await persistence.findLog(parentId)
    if (!log) continue
    const score = entry.entries.size
    if (!chosen || score > chosen.score) chosen = { parentId, score, ids: [...entry.entries.keys()], source: 'largest' }
  }
}
assert.ok(chosen, 'a parent session with a catalog exists in the copy')
const ids = chosen.ids
const present = []
const absent = []
for (const id of ids) {
  const found = await persistence.findLog(id)
  if (found) present.push(id)
  else absent.push(id)
}
rawConsole.log(JSON.stringify({ step: 'catalog', parent: chosen.parentId, children: ids.length, present: present.length, absent: absent.length }))
assert.ok(ids.length > present.length || absent.length === 0, 'the replay is meaningful only if some children have no directory (or every child has one)')

// ------------------------------------------------------------ the route
const HOST_SECRET = Buffer.alloc(32, 11)
// The launch token of this harness' own fake host (not a credential).
const LAUNCH_TOKEN = 'harness-launch-token' // gitleaks:allow
const b64url = (v) => Buffer.from(v).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const sign = (body) => createHmac('sha256', HOST_SECRET).update(body).digest()
const cookieName = (authority) => 'dsh-auth-' + createHash('sha256').update(authority).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
const encodeCookie = (payload) => { const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8')); return `v${payload.version}.${body}.${b64url(sign(body))}` }
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
  try { return JSON.parse(Buffer.from(body.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8')) } catch { return undefined }
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
  return captured.headers['set-cookie'].split(';')[0]
}
const root = new cordis.Context()
const connection = new cm.HostConnectionService(root, [], hostAuth)
connection.browserAuth = hostAuth
holder.conn = connection
const fiber = root.plugin({ name: 'dsh-subagent-workspace-ui', inject: [], apply: plugin.apply })
await fiber
await sleep(60)
const shared = connection.createSharedFetchHandler(cm.API_PATH)
const server = http.createServer(async (req, res) => {
  const admission = connection.admit(req)
  if ('rejection' in admission) { res.writeHead(admission.rejection); res.end('refused'); return }
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(',') : v)
  const response = await shared.fetch(new Request(new URL(req.url, `http://127.0.0.1:${server.address().port}`), { method: req.method, headers }), admission.peer)
  res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'text/plain' })
  res.end(await response.text())
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const cookie = mintCookie(port)
const getBody = (path) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}`, cookie } }, (res) => {
    let data = ''
    res.on('data', (c) => { data += c })
    res.on('end', () => { try { resolve(JSON.parse(data)) } catch { reject(new Error('unparsable: ' + data.slice(0, 120))) } })
  })
  req.on('error', reject)
  req.end()
})
const answer = await getBody('/api/dsh-subagent-workspace-ui/session-entity?' + ids.map((id) => `id=${encodeURIComponent(id)}`).join('&'))
server.close()
rawConsole.log(JSON.stringify({ step: 'route', root: answer.root, present: answer.present.length, absent: answer.absent.length, unavailable: answer.unavailable.length }))
assert.strictEqual(answer.root, 'read', 'the host read the copied sessions root')
// THE ORACLE: the plugin's per-id answer equals the host's own `findLog`.
assert.deepStrictEqual([...answer.present].sort(), [...present].sort(), 'the plugin calls `present` exactly the children the host scanner finds')
assert.deepStrictEqual([...answer.absent].sort(), [...absent].sort(), 'the plugin calls `absent` exactly the children the host scanner cannot find')
assert.deepStrictEqual(answer.unavailable, [], 'nothing is unavailable for a readable root')

// ------------------------------------------------------------ the real bundle
// The built client bundle is loaded into the same minimal renderer the render
// suite uses, and the REAL manager is mounted with the parent's real catalog.
const CLIENT_BUNDLE = new URL('../lib/client.js', import.meta.url)
globalThis.document = { querySelector: () => true, getElementById: () => null, createElement: () => ({ dataset: {}, style: {}, remove() {} }), head: { appendChild() {} } }
let storedPrefs = null
globalThis.localStorage = { getItem: () => storedPrefs, setItem: (k, v) => { storedPrefs = v } }
globalThis.window = { confirm: () => true, alert: () => {}, prompt: () => null, innerWidth: 1200, innerHeight: 800 }
globalThis.window.document = globalThis.document
let cursor = 0
let cells = {}
let childCells = new Map()
const setters = []
const effects = []
const React = {
  useState: initial => { const index = cursor++; if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial; const set = next => { cells[index] = typeof next === 'function' ? next(cells[index]) : next }; setters[index] = set; return [cells[index], set] },
  useMemo: f => f(),
  useDeferredValue: v => v,
  useEffect: f => { effects.push(f) },
  useRef: v => ({ current: v }),
  Fragment: 'frag',
}
let depth = 0
const renderChild = (type, props) => {
  if (typeof type !== 'function') return { tag: type, props: props || {} }
  const savedCursor = cursor, savedCells = cells
  cursor = 0
  cells = childCells.get(type) || {}
  childCells.set(type, cells)
  depth += 1
  try {
    const out = type(props || {})
    return out === null || out === undefined ? { tag: 'frag', props: { children: null } } : out
  } finally {
    depth -= 1
    cursor = savedCursor
    cells = savedCells
  }
}
const collect = (element) => {
  const out = { nodes: [], text: [] }
  const walk = (value) => {
    if (value === null || value === undefined || value === true || value === false) return
    if (typeof value === 'string' || typeof value === 'number') { out.text.push(String(value)); return }
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (typeof value !== 'object') return
    const props = value.props || {}
    if (value.tag === 'frag') { walk(props.children); return }
    out.nodes.push({ tag: value.tag, props })
    walk(props.children)
  }
  walk(element)
  return out
}
const src = readFileSync(CLIENT_BUNDLE, 'utf8')
let api = null
globalThis.window.__ModuleLoader__ = { load: ({ factory }) => { api = factory(id => id === 'react' ? React : { jsx: (t, p) => renderChild(t, p), jsxs: (t, p) => renderChild(t, p) }) } }
new Function('window', src)(globalThis.window)
const controlDicts = {}
const registrations = []
api.apply({
  sessions: { list: { getSnapshot: () => ({ byId: {}, current: undefined }) }, binding: () => null },
  effect: fn => { try { fn() } catch { /* effects are driven manually */ } },
  locale: { register: (ns, d) => { controlDicts[ns] = d } },
  slots: { inject: (slot, f) => { f() }, register: (config, component) => { registrations.push({ config, component }) } },
  get: () => undefined,
})
const manager = registrations.find((r) => r.config.id === 'subagent-workspace-manager').component
const zh = controlDicts['subagent-workspace-ui'].zh
// The host's real answer drives the bundle's own probe: every fetch to the
// existence route is served from the route's REAL response.
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.startsWith('/api/dsh-subagent-workspace-ui/session-entity')) {
    const asked = [...new URL(target, 'http://x').searchParams.getAll('id')]
    return { ok: true, status: 200, json: async () => ({ ok: true, version: 1, root: 'read', present: asked.filter((id) => answer.present.includes(id)), absent: asked.filter((id) => answer.absent.includes(id)), unavailable: [] }) }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true, active: [], ended: [] }) }
}
const parent = { id: chosen.parentId, origin: 'user', title: 'operator parent', cwd: '/home/miuzel/workspace/personal/dsh-subagent-ui', updatedAt: Date.now() }
// The operator's state: the host has rebuilt a summary for EVERY catalogued
// child (that is what he sees as stubs), and only the surviving children also
// have a live Session row here.
const byId = { [chosen.parentId]: parent }
for (const id of ids) byId[id] = { id, parentId: chosen.parentId, origin: 'subagent', title: id, cwd: parent.cwd, updatedAt: 1 }
const catalog = ids.map((id, i) => ({ id, createdAt: i + 1, mode: children.get(id).mode, label: children.get(id).label || id }))
const state = { byId, current: chosen.parentId, projectionsBySession: { [chosen.parentId]: { values: { subagentCatalog: catalog } } } }
const runEffects = () => { for (const effect of effects.splice(0)) { try { effect() } catch { /* ignore */ } } }
const renderManager = () => {
  cursor = 0
  setters.length = 0
  effects.length = 0
  const t = (key, params) => {
    const template = zh[key] !== undefined ? zh[key] : `<${key}>`
    return params ? template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] === undefined ? `{${name}}` : params[name])) : template
  }
  // `open: true` is a MANAGER PROP the slot would supply; the panel's own open
  // flag is its first hook, which the harness opens by seeding that cell.
  cells[0] = true
  return collect(manager({ t, useSessions: sel => sel(state), openChild: () => true, openSession: () => true, refresh: () => {}, setCatalogOpen: () => {}, sessionId: chosen.parentId, actions: {} }))
}
const rowIds = (view) => view.nodes.filter((n) => typeof (n.props || {}).className === 'string' && n.props.className.split(' ').includes('dsh-sam-row')).map((n) => n.nodes)
const rowSessionIds = (view) => view.nodes.filter((n) => (n.props || {}).className === 'dsh-sam-session-id').map((n) => String(n.props.children))
// First render + the probe's effect + one more render. The probe's effect is
// ASYNC (it fetches), so the settled state lands after a microtask — flush it,
// then render the same mount once more, which is what a real React commit does.
let view = renderManager()
runEffects()
// Effects may settle only after the awaited fetch; then the state lands.
await new Promise((resolve) => setTimeout(resolve, 30))
view = renderManager()
// THE PANEL PAGES: `allRows` is cut to `limit` (PAGE=40) and a "load more"
// button extends it. The operator's report counts the WHOLE list, so click that
// button until everything that is left is on screen.
const moreButton = () => view.nodes.find((n) => (n.props || {}).className === 'dsh-sam-more')
let guard = 0
while (moreButton() && guard++ < 50) {
  moreButton().props.onClick()
  runEffects()
  await new Promise((resolve) => setTimeout(resolve, 5))
  view = renderManager()
}
if (process.env.DEBUG_REAL === '1') rawConsole.log(JSON.stringify({ rows: rowSessionIds(view) }))
const shownIds = rowSessionIds(view)
for (const id of absent) assert.ok(!shownIds.includes(id), `a child whose directory is gone is NOT rendered: ${id}`)
for (const id of present) assert.ok(shownIds.includes(id), `a child whose directory still exists IS rendered: ${id}`)
if (rowsShown(view) !== present.length) {
  // Say WHICH survivors are missing, so a divergence names itself.
  const missing = present.filter((id) => !shownIds.includes(id))
  throw new Error(`expected ${present.length} surviving children to render, got ${rowsShown(view)}; missing=${JSON.stringify(missing.slice(0, 5))} shownSamples=${JSON.stringify(shownIds.slice(0, 5))}`)
}
function rowsShown(v) { return v.nodes.filter((n) => typeof (n.props || {}).className === 'string' && n.props.className.split(' ').includes('dsh-sam-row')).length }
rawConsole.log(JSON.stringify({ step: 'bundle', catalogued: ids.length, rendered: rowsShown(view), hidden: ids.length - rowsShown(view) }))
rawConsole.log(JSON.stringify({ ok: true, evidence: [{ step: 'real-data', parent: chosen.parentId, catalogued: ids.length, present: present.length, absent: absent.length, rendered: rowsShown(view) }] }))
process.exit(0)
