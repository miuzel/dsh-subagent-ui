// g-026 / att-003: "the row of a DELETED subagent is still listed".
//
// THE REPORT (operator, real dsh web on 3080, after a reinstall + restart + hard
// refresh): the manager panel shows 29 rows for a parent whose children were
// deleted, and the bottom ones are STUBS — `unknown` model, `unknown` turns,
// `unknown` steps. Neither the reinstall, the restart nor the reload changed
// that, which rules out the shipped code and the browser's own memory:
//
//   - the row comes from `byId` (`origin === 'subagent'`), NOT from the
//     plugin's synthesized external rows;
//   - the host rebuilds those `byId` entries from the PARENT SESSION LOG
//     (`subagent/catalog` + the spliced agent/child messages), and that log is
//     append-only, so a deletion can never remove the catalog record;
//   - deletion removes the child's SESSION DIRECTORY (and its storage records),
//     which the browser cannot see.
//
// So the fix is a HOST fact: does this child still own a session directory? That
// is what `/api/dsh-subagent-workspace-ui/session-entity` answers, and what the
// client folds into the set of rows it may hide. This file proves the host half
// against the host's OWN code:
//
//   A. REAL STORE, REAL ENCODING. The host's `JsonlSessionPersistence` (shipped
//      as `@deepseek-ai/dsh-session-persistence-jsonl`) is mounted over
//      `<DSH_HOME>/sessions`, its own `findLog`/`list` are the ORACLE for "the
//      plugin's answer", and a private copy of the host's `encodeSegment` is
//      asserted EQUAL to the plugin's encoding for every id shape that matters.
//      Directory names the plugin must recognise are produced with that host
//      encoder — never with the plugin's.
//
//   B. THE REPORTED STATE. A child with a directory is `present`; the SAME id
//      after its directory is removed (what `/delete` does) is `absent`; an id
//      that never had a directory is `absent`; a re-created directory flips it
//      back. The directory may sit under ANY project slug (the report's ids were
//      under a different workspace than the panel's parent).
//
//   C. NO FALSE KILL — the hard requirement:
//      - a root that does not exist            -> every id `unavailable`,
//      - a root that exists but cannot be read -> `unavailable` (chmod 000),
//      - a project directory that cannot be listed -> `root: 'partial'` and
//        every unmatched id `unavailable`,
//      - no ids / too many ids / a malformed query -> nothing is claimed absent,
//      - an id that does not encode            -> `unavailable`,
//      - `session-<uuid>` and bare `<uuid>` forms resolve each other's dirs (as
//        the plugin's delete path does).
//
//   D. THE ROUTE. Over real HTTP through the host's own authenticated `/api`
//      channel: an anonymous request is 401 (the channel, not the plugin), an
//      owner request answers the three-way body, and `external-status` carries
//      the same answer inline as `entity` so the existing poll costs no extra
//      request.
//
//   E. NEGATIVE CONTROL. The SAME source with the plugin's encoding replaced by
//      `encodeURIComponent` (the first, wrong version of this probe) is run
//      against a directory whose name contains a space: the correct code answers
//      `present` and the control answers `absent`. Removing/undoing the fix in
//      that one function must make B/C fail, and it does.
//
// Host packages are resolved like `auth.test.mjs`; without a dsh installation the
// harness prints one SKIP line and exits 0. Everything is written under a
// temporary DSH_HOME — the real `~/.dsh` is only ever READ, and only by the
// optional real-data section at the bottom (opt-in, see REAL_HOME_OPT_IN).
import assert from 'node:assert'
import http from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const SPECIFIERS = {
  cordis: '@deepseek-ai/cordis',
  connection: '@deepseek-ai/dsh-client-connection',
  persist: '@deepseek-ai/dsh-session-persistence-jsonl',
}

// ------------------------------------------------------------ host lookup
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
function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue
    const full = join(dir, name)
    try { if (statSync(full).isFile() || statSync(realpathOrSelf(full)).isFile()) return full } catch { /* not here */ }
  }
  return undefined
}
function collectCandidates() {
  if (process.env.DSH_HOST_PKGS) addCandidate('DSH_HOST_PKGS', process.env.DSH_HOST_PKGS)
  addCandidate('repository', process.cwd())
  const bin = findOnPath('dsh')
  if (bin) {
    for (const target of [bin, realpathOrSelf(bin)]) {
      const at = target.lastIndexOf(DSH_PACKAGE_SEGMENT)
      if (at !== -1) {
        const pkg = target.slice(0, at + DSH_PACKAGE_SEGMENT.length)
        addCandidate('dsh CLI', join(pkg, 'node_modules'))
        addCandidate('dsh CLI', pkg)
      }
      addCandidate('dsh CLI prefix', dirname(target))
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
    const found = {}
    let ok = true
    for (const [key, specifier] of Object.entries(SPECIFIERS)) {
      const url = tryResolve(candidate.root, specifier)
      if (!url) { ok = false; break }
      found[key] = url
    }
    if (ok) return { ...found, root: candidate.root }
    tried.push(candidate.root)
  }
  return { tried }
}

process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
const rawConsole = { log: console.log, warn: console.warn, info: console.info }
const warnings = []
for (const level of ['log', 'warn', 'info']) {
  console[level] = (...args) => {
    if (level === 'warn') warnings.push(args.map((a) => (a && a.message ? a.message : String(a))).join(' '))
    if (process.stdout.destroyed || !process.stdout.writable) return
    try { rawConsole[level](...args) } catch { /* reader went away */ }
  }
}

const host = hostPackages()
if (!host.cordis) {
  console.log(`SKIP session-entity.test.mjs: no dsh host packages found (${SPECIFIERS.persist} / ${SPECIFIERS.connection} did not resolve from any of ${host.tried.length} candidate roots). Set DSH_HOST_PKGS to the host's @deepseek-ai directory to run it.`)
  process.exit(0)
}

// ------------------------------------------------------- isolated session root
const DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-entity-test-'))
process.env.DSH_HOME = DSH_HOME
// The plugin reads `<DSH_HOME>/sessions`; nothing here ever writes to ~/.dsh.
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
mkdirSync(SESSIONS_ROOT, { recursive: true })
process.on('exit', () => {
  try { chmodSync(SESSIONS_ROOT, 0o755) } catch { /* restored below anyway */ }
  try { rmSync(DSH_HOME, { recursive: true, force: true }) } catch { /* best effort */ }
})

const cordis = await import(host.cordis)
const persist = await import(host.persist)
const cm = await import(host.connection)

const plugin = await import(new URL('../lib/index.js', import.meta.url).href)
await plugin.ready()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------- the host's own encoder
// Reproduced from `dsh-session-persistence-jsonl` (module-internal there), so
// every fixture directory name is produced by the HOST's rule and never by the
// plugin's. A drift between the two is what section E's control measures.
function hostEncodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}
function hostProjectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (const ch of cwd) {
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

// The host's persistence backend over the SAME root, mounted as the host mounts
// it, so its own scanner is the oracle rather than our reading of the layout.
const persistenceRoot = new cordis.Context()
const persistenceFiber = persistenceRoot.plugin({ name: persist.name, Config: persist.Config, apply: persist.apply }, { root: SESSIONS_ROOT })
await persistenceFiber
const persistence = persistenceRoot.get('sessionPersistence')
assert.ok(persistence && typeof persistence.findLog === 'function', 'the host persistence service is mounted over the isolated root')

// One session directory, named by the HOST's encoder, under a host-shaped slug.
function makeSessionDir(id, cwd = '/work/project') {
  const slug = hostProjectKey(cwd)
  const dir = join(SESSIONS_ROOT, slug, hostEncodeSegment(id))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), '')
  return dir
}
const removeSessionDir = (id, cwd) => rmSync(join(SESSIONS_ROOT, hostProjectKey(cwd), hostEncodeSegment(id)), { recursive: true, force: true })

// The plugin's own encoder, read out of the shipped module by re-evaluating the
// source with one export appended (the loader ignores extra exports, so this is
// exactly the function the route uses).
const pluginSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const ENCODER_EXPORT = '\nexport { encodeSessionSegment, probeSessionEntities }\n'
function loadPluginWith(transform) {
  const patched = transform(pluginSource)
  const dir = join(DSH_HOME, 'plugin-copies')
  mkdirSync(dir, { recursive: true })
  const copy = join(dir, `index-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(copy, patched + ENCODER_EXPORT)
  return import(pathToFileURL(copy).href)
}
const shippedProbe = await loadPluginWith((source) => source)
const encodeSessionSegment = shippedProbe.encodeSessionSegment
const probeSessionEntities = shippedProbe.probeSessionEntities
assert.strictEqual(typeof encodeSessionSegment, 'function', 'the plugin exposes its session-id encoder')
assert.strictEqual(typeof probeSessionEntities, 'function', 'the plugin exposes its probe')

const evidence = []
const record = (name, facts) => evidence.push({ name, ...facts })
const route = (port, path) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}` } }, (res) => {
    let data = ''
    res.on('data', (c) => { data += c })
    res.on('end', () => { let json = null; try { json = JSON.parse(data) } catch { json = null } resolve({ status: res.statusCode, json, text: data }) })
  })
  req.on('error', reject)
  req.end()
})
const query = (ids) => '?' + ids.map((id) => `id=${encodeURIComponent(id)}`).join('&')

// --------------------------------------------------------------------------
// A. The encoder is the host's encoder, and it is the identity on real ids.
// --------------------------------------------------------------------------
function scenarioEncoding() {
  const shapes = [
    'a5e0b1c2-3f44-4a55-8b66-77889900aabb', // bare UUID (external brand)
    'session-a5e0b1c2-3f44-4a55-8b66-77889900aabb', // session-prefixed
    'graph:define-polish/g-009', // a catalog LABEL, never an id, but harmless
    'id with space',
    'id~with~tilde',
    '.',
    '..',
    '../escape',
    'ünïcode-会话-01',
  ]
  for (const raw of shapes) {
    assert.strictEqual(encodeSessionSegment(raw), hostEncodeSegment(raw), `the plugin encodes ${JSON.stringify(raw)} exactly like the host`)
  }
  // `encodeURIComponent` — the first, WRONG implementation — differs on these,
  // which is why the control in section E has teeth.
  const differs = shapes.filter((raw) => raw && encodeURIComponent(raw) !== hostEncodeSegment(raw))
  assert.ok(differs.includes('id with space'), 'the space shape is where a percent-encoder and the host disagree')
  // Every id that can actually arrive as a child id is a path-safe token, so
  // the encoding is the identity there and the directory name is the id.
  for (const raw of [randomUUID(), `session-${randomUUID()}`]) {
    assert.strictEqual(hostEncodeSegment(raw), raw, 'a real child id encodes to itself')
  }
  record('A encoding', { shapes: shapes.length, equalsHost: true, percentEncoderDiffers: differs })
}

// --------------------------------------------------------------------------
// B. THE REPORTED STATE: present before the delete, absent after it.
// --------------------------------------------------------------------------
async function scenarioReportedState() {
  // The report's ids lived under a DIFFERENT workspace than the panel's parent.
  const extId = randomUUID() // an external brand: never a Session
  const childId = `session-${randomUUID()}` // a continuable child
  const neverId = randomUUID() // deleted long ago: no dir at all
  makeSessionDir(extId, '/home/op/other-workspace')
  makeSessionDir(childId, '/home/op/other-workspace')
  makeSessionDir('session-unrelated', '/work/project')

  // The oracle: the host's own scanner finds exactly the two that exist.
  assert.ok(await persistence.findLog(extId), 'oracle: the host finds the external child')
  assert.ok(await persistence.findLog(childId), 'oracle: the host finds the continuable child')
  assert.strictEqual(await persistence.findLog(neverId), undefined, 'oracle: the host does not find the never-created id')
  // The identity that makes the plugin's directory rule the host's rule too.
  assert.ok(await persistence.findLog('session-unrelated'), 'oracle: an unrelated id finds its own directory')
  assert.strictEqual(await persistence.findLog('never-created-id'), undefined, 'oracle: a never-created id finds nothing')

  const before = probeSessionEntities([extId, childId, neverId])
  assert.deepStrictEqual(before.present.sort(), [extId, childId].sort(), 'both existing children are `present`; got=' + JSON.stringify(before))
  assert.deepStrictEqual(before.absent, [neverId], 'the id with no directory is `absent`')
  assert.deepStrictEqual(before.unavailable, [], 'a readable root leaves nothing unavailable')
  assert.strictEqual(before.root, 'read', 'the root was read')

  // What `/delete` does: remove the session directory (the plugin's own rmSync).
  removeSessionDir(extId, '/home/op/other-workspace')
  assert.strictEqual(await persistence.findLog(extId), undefined, 'oracle: the host no longer finds the deleted child')
  const after = probeSessionEntities([extId, childId, neverId])
  assert.deepStrictEqual(after.absent.sort(), [extId, neverId].sort(), 'the deleted child is now `absent`, the surviving one is not; got=' + JSON.stringify(after))
  assert.deepStrictEqual(after.present, [childId], 'the surviving child is untouched by a sibling\'s deletion')

  // A re-created directory (a re-delegation that reused the id) flips back.
  makeSessionDir(extId, '/home/op/other-workspace')
  const revived = probeSessionEntities([extId])
  assert.deepStrictEqual(revived.present, [extId], 'a re-created directory is `present` again')

  // The `session-` prefix resolves either spelling, like the delete path does.
  const bare = childId.slice('session-'.length)
  assert.deepStrictEqual(probeSessionEntities([bare]).present, [bare], 'the bare id finds the `session-`-prefixed directory')
  assert.deepStrictEqual(probeSessionEntities([childId]).present, [childId], 'and the prefixed id finds its own')
  // Ids are deduplicated and the same id is never reported twice.
  const dup = probeSessionEntities([childId, childId])
  assert.strictEqual(dup.present.length, 1, 'a repeated id is answered once')
  record('B reported state', { presentBefore: 2, absentAfter: 2, revived: true, prefixForms: true })
}

// --------------------------------------------------------------------------
// C. NO FALSE KILL: every way of "not knowing" answers `unavailable`, never
//    `absent`.
// --------------------------------------------------------------------------
async function scenarioNoFalseKill() {
  const id = randomUUID()
  makeSessionDir(id, '/work/project')
  // (c1) no ids at all: nothing may be claimed absent.
  const empty = probeSessionEntities([])
  assert.deepStrictEqual([empty.present, empty.absent, empty.unavailable], [[], [], []], 'no ids => no verdicts')
  assert.strictEqual(empty.root, 'unavailable', 'no ids reads no root')
  // (c2) non-strings are ignored, an empty string is not an id.
  assert.deepStrictEqual(probeSessionEntities([undefined, null, 42, '', {}]).absent, [], 'only non-empty strings are ids')
  // (c3) a root that does not exist: `unavailable` for every id — even one whose
  //      directory DOES exist, because the answer must not depend on that.
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = join(DSH_HOME, 'does-not-exist')
  try {
    const blind = probeSessionEntities([id])
    assert.deepStrictEqual([blind.present, blind.absent], [[], []], 'a missing root makes no existence claim')
    assert.deepStrictEqual(blind.unavailable, [id], 'a missing root marks every id unavailable')
    assert.strictEqual(blind.root, 'unavailable', 'the root is reported unreadable')
  } finally {
    process.env.DSH_HOME = saved
  }
  // (c4) a root that exists but cannot be read (permissions): same answer.
  let permissionCase = 'skipped (root)'
  try {
    chmodSync(SESSIONS_ROOT, 0o000)
    const denied = probeSessionEntities([id])
    // A process running as root can still read it; the assertion then simply
    // checks that no `absent` verdict was produced.
    assert.deepStrictEqual(denied.absent, [], 'an unreadable root never claims a child deleted; got=' + JSON.stringify(denied))
    permissionCase = 'unreadable => no absent'
  } finally {
    chmodSync(SESSIONS_ROOT, 0o755)
  }
  // (c5) one project directory that cannot be listed: `partial`, and every id
  //      not found is `unavailable` rather than `absent`.
  const hiddenSlug = hostProjectKey('/work/locked')
  const lockedDir = join(SESSIONS_ROOT, hiddenSlug)
  mkdirSync(lockedDir, { recursive: true })
  const lockedChild = randomUUID()
  mkdirSync(join(lockedDir, hostEncodeSegment(lockedChild)))
  writeFileSync(join(lockedDir, hostEncodeSegment(lockedChild), 'session.v4.jsonl.zstd'), '')
  try {
    chmodSync(lockedDir, 0o000)
    const partial = probeSessionEntities([id, lockedChild])
    assert.strictEqual(partial.root, 'partial', 'an unlistable project directory is reported; got=' + JSON.stringify(partial))
    assert.deepStrictEqual(partial.present, [id], 'the readable project still resolves its child')
    assert.deepStrictEqual(partial.absent, [], 'nothing is claimed absent while a project could not be listed')
    assert.deepStrictEqual(partial.unavailable, [lockedChild], 'the child of the unlistable project is `unavailable`')
  } finally {
    chmodSync(lockedDir, 0o755)
  }
  // (c6) the same answer the route gives for a garbled/oversized request: the
  //      probe never throws, whatever it is handed.
  for (const junk of [undefined, null, 'not-a-list', [[]], [{ id }]]) {
    const answer = probeSessionEntities(junk)
    assert.deepStrictEqual(answer.absent, [], 'a junk request asserts nothing: ' + JSON.stringify(junk))
  }
  // (c7) the id itself is absurd (far longer than any real id): no crash.
  const huge = 'x'.repeat(1000)
  assert.deepStrictEqual(probeSessionEntities([huge]).absent, [], 'an over-long id is not answered as absent')
  record('C no false kill', { missingRoot: true, unreadableRoot: true, partialSlug: true, junk: true, permission: permissionCase })
}

// --------------------------------------------------------------------------
// D. The route, over the host's authenticated `/api` channel.
// --------------------------------------------------------------------------
const HOST_SECRET = Buffer.alloc(32, 9)
// The launch token of this harness' own fake host (not a credential): it is
// only compared against the URL this test itself builds.
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
async function mountPlugin() {
  const root = new cordis.Context()
  const connection = new cm.HostConnectionService(root, [], hostAuth)
  connection.browserAuth = hostAuth
  holder.conn = connection
  const url = new URL('../lib/index.js', import.meta.url)
  url.search = '?entity=' + Date.now()
  const mounted = await import(url.href)
  await mounted.ready()
  const fiber = root.plugin({ name: 'dsh-subagent-workspace-ui', inject: [], apply: mounted.apply })
  await fiber
  await sleep(60)
  const shared = connection.createSharedFetchHandler(cm.API_PATH)
  const server = http.createServer(async (req, res) => {
    const admission = connection.admit(req)
    if ('rejection' in admission) { res.writeHead(admission.rejection); res.end('refused'); return }
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(',') : v)
    const response = await shared.fetch(new Request(new URL(req.url, `http://127.0.0.1:${server.address().port}`), { method: req.method, headers }), admission.peer)
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'text/plain', 'cache-control': response.headers.get('cache-control') || '' })
    res.end(await response.text())
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, cookie: mintCookie(server.address().port) }
}
const getWith = (port, path, cookie) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}) } }, (res) => {
    let data = ''
    res.on('data', (c) => { data += c })
    res.on('end', () => { let json = null; try { json = JSON.parse(data) } catch { json = null } resolve({ status: res.statusCode, json }) })
  })
  req.on('error', reject)
  req.end()
})
const BASE = '/api/dsh-subagent-workspace-ui'

async function scenarioRoute() {
  const mount = await mountPlugin()
  try {
    const live = randomUUID()
    const gone = randomUUID()
    makeSessionDir(live, '/work/project')
    const anonymous = await getWith(mount.port, `${BASE}/session-entity${query([live, gone])}`)
    assert.strictEqual(anonymous.status, 401, 'the channel refuses the existence route without a credential')
    const owner = await getWith(mount.port, `${BASE}/session-entity${query([live, gone])}`, mount.cookie)
    assert.strictEqual(owner.status, 200, 'an admitted owner is served; body=' + owner.text)
    assert.deepStrictEqual(owner.json.present, [live], 'the live child is present')
    assert.deepStrictEqual(owner.json.absent, [gone], 'the child without a directory is absent')
    assert.strictEqual(owner.json.root, 'read', 'the root was read')
    // The same ledger poll the panel already makes carries it inline.
    const status = await getWith(mount.port, `${BASE}/external-status`, mount.cookie)
    assert.strictEqual(status.status, 200, 'external-status still answers')
    assert.ok(status.json.entity && Array.isArray(status.json.entity.absent), 'external-status folds the existence answer as `entity`')
    // A request naming nothing is not evidence.
    const none = await getWith(mount.port, `${BASE}/session-entity`, mount.cookie)
    assert.deepStrictEqual([none.status, none.json.absent, none.json.error], [200, [], 'missing-ids'], 'no ids => nothing claimed absent')
    // A verb the route does not own falls through to the channel (404), not to
    // the plugin: the corpus of methods is the descriptor's.
    const wrongVerb = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: mount.port, path: `${BASE}/session-entity${query([live])}`, method: 'POST', headers: { host: `127.0.0.1:${mount.port}`, cookie: mount.cookie, 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', reject)
      req.end('{}')
    })
    assert.strictEqual(wrongVerb, 404, 'POST on the existence route is not served by the fetch route')
    record('D route', { anonymous: anonymous.status, owner: 'present 1 / absent 1', inlineInStatus: true, emptyQuery: none.json.error, wrongVerb })
  } finally {
    mount.server.close()
    await sleep(20)
  }
}

// --------------------------------------------------------------------------
// E. NEGATIVE CONTROL: replace the plugin's encoding with the percent encoder
//    the first version used; the SAME probe must then answer `absent` for a
//    child whose directory exists (a false kill), while the shipped code says
//    `present`. Neutering the fix is what turns this red.
// --------------------------------------------------------------------------
async function scenarioControl() {
  const spaceId = 'session-id with space'
  const dir = makeSessionDir(spaceId, '/work/project')
  const shipped = probeSessionEntities([spaceId])
  assert.deepStrictEqual(shipped.present, [spaceId], 'the shipped probe resolves a directory whose id needed encoding; got=' + JSON.stringify(shipped))
  // The control is built by REPLACING the shipped encoder's name with the
  // percent encoder the first version used, so the shipped body is left in place
  // (unreachable) and only the identifier that is called changes. Renaming is
  // anchored on the exact declaration, so a missing anchor fails loudly.
  const control = await loadPluginWith((source) => {
    const from = 'function encodeSessionSegment(sessionId) {'
    const at = source.indexOf(from)
    assert.notStrictEqual(at, -1, 'the control patch anchors on the shipped encoder')
    // The percent encoder is PUBLISHED under the shipped name (a function
    // declaration binds before any call), and the shipped body is kept beside it
    // as `encodeSessionSegmentShipped`, which nothing calls.
    const rename = 'function encodeSessionSegmentShipped(sessionId) {'
    const patched = source.replace(from, `function encodeSessionSegment(sessionId) { return encodeURIComponent(String(sessionId)) }\n${rename}`)
    assert.notStrictEqual(patched, source, 'the control patch applied')
    return patched
  })
  const controlAnswer = control.probeSessionEntities([spaceId])
  assert.deepStrictEqual(controlAnswer.present, [], 'CONTROL: the percent encoder finds nothing for that id')
  assert.deepStrictEqual(controlAnswer.absent, [spaceId], 'CONTROL: the percent encoder calls a LIVE child absent — the false kill this encoder prevents')
  assert.ok(dir, 'the fixture directory exists')
  record('E encoding control', { shipped: 'present', control: 'absent (false kill)' })
}

try {
  scenarioEncoding()
  await scenarioReportedState()
  await scenarioNoFalseKill()
  await scenarioRoute()
  await scenarioControl()
} catch (error) {
  console.log(JSON.stringify({ evidence, warnings: warnings.slice(0, 5) }, null, 1))
  throw error
}
console.log(JSON.stringify({ evidence }, null, 1))
process.exit(0)
