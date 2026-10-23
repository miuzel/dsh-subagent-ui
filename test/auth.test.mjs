// g-024 / att-002: the route-auth test.
//
// Real code on both sides: `lib/index.js` is the plugin under test, and the
// host half is dsh 0.2.1-rc.2's own `HostConnectionService` (cordis Context,
// real `admit`, real signed-cookie code) — no stand-ins for the admission logic.
//
//   A. fetch face   — the plugin registers on `ctx.connection.fetch`; requests
//                     reach it through the host's shared `/api` channel
//                     (`createSharedFetchHandler` + `admit`), exactly as the
//                     real carrier mounts it. No credential -> 401 on all four;
//                     real API cookie -> 200 with the pre-migration body.
//   B. legacy       — no `connection` in the plugin's context: routes go to
//                     `webServer.register`, gated by `connection.admit` read
//                     from the ROOT context, and the gate must refuse every
//                     credential-less request (the 200-it-used-to-answer
//                     regression) and every FORGED cookie.
//   C. later arrival— the same, with `webServer` provided only after `apply`.
//   D. no admit     — a host whose connection service has no `admit`: the
//                     plugin must register NOTHING (fail closed), never a
//                     shape-checked route.
//
// Every scenario carries a NEGATIVE CONTROL (a request that used to be served
// and must now be refused); remove the gate and these flip to 200/400.
//
// THE FORGED-CREDENTIAL REGRESSION (g-024 / att-003). The legacy gate once had a
// last-resort `'shape'` rung: it computed the ONE exported cookie name (the
// authority is public, so anyone can) and accepted any `v<N>.<payload>.<sig>`
// value without verifying the signature, so `v1.AAAA.BBBB` was served 200. The
// name is still computed here, by the test, exactly as an attacker would:
// `FORGED` is a credential that rung admitted and that must now be 401.
//
// WHERE THE HOST HALF COMES FROM. The host half is two packages the host ships:
// `@deepseek-ai/cordis` (a peer dependency here, so the repository's own
// node_modules usually has it) and `@deepseek-ai/dsh-client-connection` (NOT a
// dependency of this package, so it exists only inside a dsh installation).
// `hostPackages()` resolves both without any machine-specific path, in this
// order:
//
//   1. `DSH_HOST_PKGS`            — an explicit override; wins when it resolves.
//   2. this repository's own      — createRequire against the CWD, i.e. the
//                                   copy `pnpm install` put in node_modules.
//   3. the dsh CLI's own install  — `which dsh` on every PATH entry, then the
//                                   realpath of the launcher, up to the
//                                   `@deepseek-ai/dsh` package directory, then
//                                   that package's nested `node_modules`.
//   4. common global roots        — the sibling of the running `node` binary,
//                                   `$NPM_CONFIG_PREFIX/lib/node_modules`, and
//                                   the usual fnm/nvm/volta/HOME locations.
//
// Each candidate is accepted only if `dsh-client-connection` resolves through
// it, so a partial hit never fakes a host. When NO candidate works the harness
// prints one `SKIP` line and exits 0 — a machine without a dsh installation has
// nothing to test here — but a candidate that resolves is always run for real.
import assert from 'node:assert'
import http from 'node:http'
import { createHash, createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CORDIS_SPECIFIER = '@deepseek-ai/cordis'
const CONNECTION_SPECIFIER = '@deepseek-ai/dsh-client-connection'

// The two host packages are resolved SYMMETRICALLY from one root, so the cordis
// Context the plugin runs on and the HostConnectionService built here are the
// same copy of cordis (two copies would be two Context classes).
const candidates = []
const seen = new Set()
function addCandidate(reason, root) {
  if (!root || seen.has(root)) return
  seen.add(root)
  candidates.push({ reason, root })
}

// `@deepseek-ai/dsh/lib/bin.js` -> `.../node_modules/@deepseek-ai/dsh` -> its
// own `node_modules` (where the host keeps its dependency tree), then the
// package directory itself (for layouts that hoist the host's deps to the
// install prefix, resolvable from there through the parent chain).
const DSH_PACKAGE_SEGMENT = 'node_modules/@deepseek-ai/dsh'
function hostRootsFromDshEntry(entry) {
  const index = entry.lastIndexOf(DSH_PACKAGE_SEGMENT)
  if (index === -1) return []
  const packageDir = entry.slice(0, index + DSH_PACKAGE_SEGMENT.length)
  return [join(packageDir, 'node_modules'), packageDir]
}

// A `node_modules` directory, plus the two shapes a bin directory takes: the
// `bin/` of a global prefix and the `node_modules/.bin` of a local install.
function hostRootsFromBin(binPath) {
  const roots = [binPath, join(binPath, '..')]
  if (dirname(binPath) === 'node_modules') roots.push(join(binPath, 'lib', 'node_modules'))
  return roots
}

function tryResolveEsm(root, specifier) {
  try {
    return pathToFileURL(createRequire(join(root, 'noop.js')).resolve(specifier)).href
  } catch {
    return undefined
  }
}

// Resolve both host packages from `root`, or nothing if either is absent.
function resolveHostPair(root) {
  const cordisUrl = tryResolveEsm(root, CORDIS_SPECIFIER)
  const connectionUrl = tryResolveEsm(root, CONNECTION_SPECIFIER)
  if (!cordisUrl || !connectionUrl) return undefined
  return { cordisUrl, connectionUrl }
}

function collectCandidates() {
  const override = process.env.DSH_HOST_PKGS
  if (override) addCandidate('DSH_HOST_PKGS', override)

  // 2. The repository's own dependency tree (the cordis peer; the connection
  //    package only if someone installed it locally).
  addCandidate('repository node_modules', process.cwd())

  // 3. The dsh CLI on PATH, resolved through the filesystem it really lives on.
  //    Both the launcher and its realpath are tried, because fnm/nvm expose
  //    symlinks whose target is what names the install prefix.
  const dshBin = findOnPath('dsh') || findDshViaShell()
  if (dshBin) {
    for (const target of [dshBin, realpathOrSelf(dshBin)]) {
      for (const root of hostRootsFromDshEntry(target)) addCandidate(`dsh CLI (${target})`, root)
      for (const root of hostRootsFromBin(dirname(target))) addCandidate('dsh CLI prefix', root)
    }
  }

  // 4. Common global roots: the running node's own prefix, npm's configured
  //    prefix, the version managers' install trees, and HOME.
  for (const root of hostRootsFromBin(dirname(realpathOrSelf(process.execPath)))) addCandidate('node binary prefix', root)
  const npmPrefix = process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX
  if (npmPrefix) addCandidate('NPM_CONFIG_PREFIX', join(npmPrefix, 'lib', 'node_modules'))
  for (const root of versionManagerRoots()) addCandidate('version manager', root)
  const home = process.env.HOME || process.env.USERPROFILE
  if (home) {
    addCandidate('HOME pnpm global', join(home, '.local', 'share', 'pnpm', 'global', '5', 'node_modules'))
    addCandidate('HOME', home)
  }
}

// fnm, nvm and volta keep one full node installation per version, and a global
// `dsh` lives in that installation's `lib/node_modules`.
function versionManagerRoots() {
  const roots = []
  const list = (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  const fnmDir = process.env.FNM_DIR || (process.env.HOME && join(process.env.HOME, '.local', 'share', 'fnm'))
  if (fnmDir) for (const version of list(join(fnmDir, 'node-versions'))) roots.push(join(fnmDir, 'node-versions', version, 'installation', 'lib', 'node_modules'))
  if (process.env.NVM_DIR) for (const version of list(join(process.env.NVM_DIR, 'versions', 'node'))) roots.push(join(process.env.NVM_DIR, 'versions', 'node', version, 'lib', 'node_modules'))
  if (process.env.VOLTA_HOME) roots.push(join(process.env.VOLTA_HOME, 'tools', 'image', 'node'))
  return roots
}

function realpathOrSelf(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function findOnPath(name) {
  const pathValue = process.env.PATH || ''
  for (const dir of pathValue.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const fileName of process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name]) {
      const full = join(dir, fileName)
      try {
        if (statSync(full).isFile() || statSync(realpathOrSelf(full)).isFile()) return full
      } catch {
        continue
      }
    }
  }
  return undefined
}

// Final fallback: let the platform expand the command, in case `dsh` is a shell
// function/alias resolved only by the login shell.
function findDshViaShell() {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split(/\r?\n/u).map((line) => line.trim()).find(Boolean)
  } catch {
    return undefined
  }
}

// Resolve both host packages from the candidates in order, first hit wins; a
// candidate that lacks either package is not a host and is skipped.
function hostPackages() {
  collectCandidates()
  const tried = []
  for (const candidate of candidates) {
    const pair = resolveHostPair(candidate.root)
    if (pair) return { ...pair, reason: candidate.reason, root: candidate.root }
    tried.push(candidate.root)
  }
  return { tried }
}

// A closed reader (`node test/auth.test.mjs | head`) must not fail this harness.
// The plugin writes to stdout from inside `apply` and from timers it leaves
// running, so the guard is installed BEFORE the plugin is imported: Node turns a
// failed write into an unhandled `error` event on the socket, which would abort
// the run with exit 1 after the scenarios had already finished asserting.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
const rawConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error }
// Returns false when the write cannot happen (the reader went away), so a
// guarded `console.*` call is a no-op instead of a throw.
function safeWrite(level, args) {
  if (process.stdout.destroyed || !process.stdout.writable) return false
  try {
    rawConsole[level](...args)
    return true
  } catch {
    return false
  }
}
for (const level of ['log', 'info', 'warn', 'error']) console[level] = (...args) => safeWrite(level, args)
// The evidence write has to be awaited (the plugin's timers keep the event loop
// alive, so `process.exit` would otherwise truncate it).
function writeOut(text) {
  return new Promise((resolve) => {
    if (process.stdout.destroyed || !process.stdout.writable) return resolve()
    process.stdout.write(text, resolve)
  })
}

const host = hostPackages()
if (!host.cordisUrl) {
  // Not a failure: this machine simply has no dsh installation to test the
  // host half against. Say so in ONE line, and say where we looked.
  console.log(`SKIP auth.test.mjs: no dsh host packages found (${CONNECTION_SPECIFIER} did not resolve from any of ${host.tried.length} candidate roots). Set DSH_HOST_PKGS to the host's @deepseek-ai directory to run it. Tried:`)
  for (const root of host.tried) console.log(`  - ${root}`)
  process.exit(0)
}

const cordis = await import(host.cordisUrl)
const cm = await import(host.connectionUrl)

const plugin = await import(new URL('../lib/index.js', import.meta.url).href)
await plugin.ready()

const browserVisible = (name) => `/api/dsh-subagent-workspace-ui/${name}`
const ENDPOINTS = [
  { name: 'external-status', method: 'GET' },
  { name: 'external-stop', method: 'POST' },
  { name: 'delete', method: 'POST' },
  { name: 'batch-delete', method: 'POST' },
]

const evidence = []
const record = (name, facts) => evidence.push({ name, ...facts })

const SECRET = Buffer.alloc(32, 7).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

// Host cookie code, reproduced token for token from
// @deepseek-ai/dsh-client-connection (`encodeBase64Url` / `signature` /
// `encodeCookie`, all module-internal there): same base64url alphabet, same
// `v<N>.<payload>.<hmac-sha256>` layout. Minting with the host's algorithm is
// what makes the plugin's verifier face REAL host-format credentials.
function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}
function signature(secret, body) {
  return createHmac('sha256', secret).update(body).digest()
}
function encodeCookie(payload, secret) {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v${payload.version}.${body}.${encodeBase64Url(signature(secret, body))}`
}
const HOST_SECRET = Buffer.from(SECRET.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
const LAUNCH_TOKEN = 'g024-launch-token'
const DAY = 24 * 60 * 60 * 1000

// The auth owner the host service calls, with the host's own contract:
// `isAuthenticated` accepts a version-1 browser session, `authenticateApi`
// returns the operator id of a version-2 cookie (and `admit` then requires that
// operator to be a live peer, which `/connect` publishes). Signatures and the
// authority binding are verified here with the host secret, so a credential this
// admits is one the real host would admit, for the same reason.
const holder = { conn: undefined }

function readHeader(headers, name) {
  return typeof headers.get === 'function' ? headers.get(name) ?? undefined : headers[name]
}

function decodeCredential(request, secure) {
  const headers = request.headers
  const host = readHeader(headers, 'host')
  if (!host) return undefined
  const authority = secure ? new URL(`https://${host}`).origin : new URL(`http://${host}`).host
  const name = 'dsh-auth-' + encodeBase64Url(createHash('sha256').update(authority).digest())
  const header = readHeader(headers, 'cookie')
  if (!header) return undefined
  let value
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    value = segment.slice(at + 1).trim()
  }
  if (value === undefined) return undefined
  const parts = value.split('.')
  if (parts.length !== 3) return undefined
  const [version, body, encoded] = parts
  if (encoded !== encodeBase64Url(signature(HOST_SECRET, body))) return undefined
  let payload
  try {
    payload = JSON.parse(Buffer.from(body.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'))
  } catch {
    return undefined
  }
  const now = Date.now()
  if (payload.authority !== authority) return undefined
  if (payload.issuedAt > now || payload.expiresAt <= now) return undefined
  if (version !== `v${payload.version}`) return undefined
  return payload
}

const hostAuth = {
  launchToken: LAUNCH_TOKEN,
  isAuthenticated(request, secure = false) {
    return decodeCredential(request, secure)?.version === 1
  },
  authenticateApi(request, secure = false) {
    const payload = decodeCredential(request, secure)
    return payload?.version === 2 ? payload.id : undefined
  },
  // The host's `/connect` exchange: verify the launch token, publish one
  // operator peer, and hand back its signed cookie.
  authorizeConnect(request, response) {
    const match = /[?&]token=([^&]*)/.exec(request.url)
    if (!match || match[1] !== this.launchToken) {
      response.writeHead(401, {})
      response.end()
      return
    }
    // The host's `publishPeer` returns the peer id it just registered, and the
    // cookie carries exactly that id so `admit` can find the peer again.
    const id = holder.conn.publishPeer('none')
    const now = Date.now()
    const authority = new URL(`http://${request.headers.host}`).host
    response.writeHead(302, { 'set-cookie': `${exportedCookieName(authority)}=${encodeCookie({ version: 2, authority, issuedAt: now, expiresAt: now + 30 * DAY, id }, HOST_SECRET)}; Path=/` })
    response.end()
  },
}

// A real HostConnectionService over a real cordis Context. The host's own
// `apply` additionally mounts the `/api` browser transport (which needs the full
// web carrier), so the service is constructed directly; its `admit`, peer scopes
// and `createSharedFetchHandler` are the host's own code.
const realCtx = new cordis.Context()
realCtx.provide('webServer', { protocol: 'http:', host: '127.0.0.1', register: () => () => {} })
const hostConnection = new cm.HostConnectionService(realCtx, [], hostAuth)
hostConnection.browserAuth = hostAuth
holder.conn = hostConnection

function makeWebServer() {
  const exact = new Map()
  return {
    protocol: 'http:',
    host: '127.0.0.1',
    register(route) {
      exact.set(route.path, route)
      return () => exact.delete(route.path)
    },
    exact,
  }
}

function request(port, method, p, { body, rawBody, cookie, token } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}` }
    if (cookie) headers.cookie = cookie
    if (token) headers['x-dsh-token'] = token
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(data) } catch { json = null }
        resolve({ status: res.statusCode, text: data, json, headers: res.headers })
      })
    })
    req.on('error', reject)
    if (rawBody !== undefined) {
      req.setHeader('content-type', 'application/json')
      req.write(rawBody)
    } else if (body !== undefined) {
      req.setHeader('content-type', 'application/json')
      req.write(JSON.stringify(body))
    }
    req.end()
  })
}

async function startServer(dispatch) {
  const server = http.createServer(dispatch)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The exported cookie name, computed independently of the plugin.
function exportedCookieName(authority) {
  const digest = createHash('sha256').update(authority).digest('base64')
  return 'dsh-auth-' + digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

// Mint through the host's own exchange: `/connect?token=` publishes an operator
// and returns its cookie; `/?token=` mints a browser-session cookie. Both are
// bound to the request authority (the test port) by the host's own code path.
function mintCookie(pathname, port) {
  const authority = `127.0.0.1:${port}`
  const now = Date.now()
  if (pathname === '/' ) {
    return `${exportedCookieName(authority)}=${encodeCookie({ version: 1, authority, issuedAt: now, expiresAt: now + 30 * DAY }, HOST_SECRET)}`
  }
  const captured = { headers: {} }
  hostAuth.authorizeConnect(
    { method: 'GET', url: `/connect?token=${LAUNCH_TOKEN}`, headers: { host: authority } },
    { writeHead(status, headers) { captured.status = status; captured.headers = headers || {} }, end() {} },
  )
  const setCookie = captured.headers['set-cookie']
  if (!setCookie) throw new Error(`the host did not mint a cookie for ${pathname} (status ${captured.status})`)
  return setCookie.split(';')[0]
}

async function anonymousSuite(port) {
  const statuses = {}
  for (const { name, method } of ENDPOINTS) {
    const r = await request(port, method, browserVisible(name), { body: method === 'POST' ? {} : undefined })
    statuses[name] = r.status
  }
  return statuses
}

async function authenticatedSuite(port, cookie) {
  const authed = { cookie }
  const status = await request(port, 'GET', browserVisible('external-status'), authed)
  const stopNoRun = await request(port, 'POST', browserVisible('external-stop'), { ...authed, body: {} })
  const stopGone = await request(port, 'POST', browserVisible('external-stop'), { ...authed, body: { runId: 'nope' } })
  const badJson = await request(port, 'POST', browserVisible('delete'), { ...authed, rawBody: '{not json' })
  const delMissing = await request(port, 'POST', browserVisible('delete'), { ...authed, body: {} })
  const batchMissing = await request(port, 'POST', browserVisible('batch-delete'), { ...authed, body: { items: [] } })
  return { status, stopNoRun, stopGone, badJson, delMissing, batchMissing }
}

function assertBodyUnchanged(suite) {
  const { status } = suite
  assert.strictEqual(status.status, 200, 'an authenticated owner is served')
  assert.deepStrictEqual({ ok: status.json.ok, active: status.json.active, ended: status.json.ended }, { ok: true, active: [], ended: [] })
  assert.strictEqual(status.json.version, 1, 'the status payload keeps its version field')
  assert.match(status.text, /"at":\d+/, 'the status payload keeps its timestamp')
  assert.strictEqual(status.headers['cache-control'], 'no-store', 'the status payload keeps its cache policy')
  assert.deepStrictEqual([suite.stopNoRun.status, suite.stopNoRun.json.error], [400, 'missing-run-id'], 'stop keeps its 400')
  assert.deepStrictEqual([suite.stopGone.status, suite.stopGone.json.error], [409, 'not-running'], 'stop keeps its 409')
  assert.deepStrictEqual([suite.badJson.status, suite.badJson.json.error], [400, 'invalid-json'], 'delete keeps its invalid-json 400')
  assert.deepStrictEqual([suite.delMissing.status, suite.delMissing.json.error], [400, 'missing-session-id'], 'delete keeps its missing-id 400')
  assert.deepStrictEqual([suite.batchMissing.status, suite.batchMissing.json.error], [400, 'missing-items'], 'batch-delete keeps its missing-items 400')
}

// ------------------------------------------------------------ A: fetch face
async function scenarioFetchFace() {
  const ws = makeWebServer()
  const ctx = new cordis.Context()
  ctx.provide('webServer', ws)
  ctx.provide('connection', hostConnection)
  plugin.apply(ctx)
  await sleep(30)

  for (const { name } of ENDPOINTS) {
    assert.ok(!ws.exact.has(browserVisible(name)), `${name} must not be registered on the unauthenticated webServer when the fetch face exists`)
  }

  // The official `/api` carrier, mounted as the host mounts it: an admission
  // step, then the bridge to the shared fetch handler. Its route is a PREFIX,
  // so it loses to any EXACT route on the same path - which is why a
  // webServer-registered plugin route on `/api/...` would shadow it entirely.
  const shared = hostConnection.createSharedFetchHandler(cm.API_PATH)
  const mountApi = async (req, res, port) => {
    const admission = hostConnection.admit(req)
    if ('rejection' in admission) {
      res.writeHead(admission.rejection)
      res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(',') : v)
    let body
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = await new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c }); req.on('end', () => resolve(d)) })
    }
    const response = await shared.fetch(new Request(new URL(req.url, `http://127.0.0.1:${port}`), { method: req.method, headers, body }), admission.peer)
    const text = await response.text()
    res.writeHead(response.status, {
      'content-type': response.headers.get('content-type') || 'text/plain',
      'cache-control': response.headers.get('cache-control') || '',
    })
    res.end(text)
  }
  // Same precedence as `dsh-host-webserver`: exact table first, then the
  // longest matching prefix.
  const { server, port } = await startServer(async (req, res) => {
    const pathname = req.url.split('?')[0]
    const exact = ws.exact.get(pathname)
    if (exact) return exact.handler(req, res)
    if (pathname === '/api' || pathname.startsWith('/api/')) return mountApi(req, res, port)
    res.writeHead(404)
    res.end('no route')
  })
  try {
    const anonymous = await anonymousSuite(port)
    assert.deepStrictEqual(anonymous, { 'external-status': 401, 'external-stop': 401, delete: 401, 'batch-delete': 401 }, `the channel must refuse all four without a credential, got ${JSON.stringify(anonymous)}`)

    const forged = await request(port, 'GET', browserVisible('external-status'), { cookie: 'dsh-forged=value' })
    const bogus = await request(port, 'GET', browserVisible('external-status'), { token: 'bogus' })
    assert.strictEqual(forged.status, 401, 'a forged cookie is refused')
    assert.strictEqual(bogus.status, 401, 'a bogus token is refused')

    const suite = await authenticatedSuite(port, mintCookie('/connect', port, `127.0.0.1:${port}`))
    assertBodyUnchanged(suite)

    const tampered = mintCookie('/connect', port, `127.0.0.1:${port}`)
    const cut = tampered.lastIndexOf('.')
    const broken = `${tampered.slice(0, cut + 1)}${tampered.slice(cut + 1, -3)}AAA`
    const tamperedRes = await request(port, 'GET', browserVisible('external-status'), { cookie: broken })
    assert.strictEqual(tamperedRes.status, 401, 'a tampered signature is refused')

    const browser = await request(port, 'GET', browserVisible('external-status'), { cookie: mintCookie('/', port, `127.0.0.1:${port}`) })
    assert.strictEqual(browser.status, 200, 'a browser-session cookie admits on the fetch face')

    const wrongVerb = await request(port, 'POST', browserVisible('external-status'), { cookie: mintCookie('/connect', port, `127.0.0.1:${port}`), body: {} })
    assert.strictEqual(wrongVerb.status, 404, 'a verb the fetch route does not own falls through to the shared channel')

    record('fetch-face', { surface: 'connection', anonymous, forged: forged.status, bogusToken: bogus.status, tampered: tamperedRes.status, browserCookie: browser.status, wrongVerb: wrongVerb.status, body: 'unchanged' })
  } finally {
    server.close()
  }
}

// D. THE REAL 0.2.1 ORDERING (measured on dsh 0.2.1-rc.2): `webServer`
//    provides first, `connection` ~250 ms later. Binding the first-arriving
//    service would pin the plugin to the UNAUTHENTICATED surface for the life of
//    the process, which is exactly what the fetch-face migration exists to
//    prevent. The plugin must end up on `connection` and leave no webServer
//    exact route behind.
//
//    NOTE: this scenario intentionally provides NO `connection` during the first
//    30 ms, so the fallback cannot bind at all (no `admit` => fail closed) until
//    the service arrives; what it asserts is the SETTLED state, which is the one
//    that matters: once `connection` shows up, the plugin must be on the fetch
//    face and no webServer exact route may remain.
async function scenarioConnectionArrivesLate() {
  const ws = makeWebServer()
  const ctx = new cordis.Context()
  ctx.provide('webServer', ws)
  plugin.apply(ctx)
  await sleep(30)
  const early = [...ws.exact.keys()].sort()
  ctx.provide('connection', hostConnection)
  await sleep(120)
  for (const { name } of ENDPOINTS) {
    assert.ok(!ws.exact.has(browserVisible(name)), `${name} must not stay on the webServer surface once the authenticated face arrives`)
  }
  record('connection-arrives-late', { early: early.length ? 'webServer' : 'none (no admit yet)', settled: 'connection', webServerRoutes: ws.exact.size })
}

// ------------------------------------- B/C: the plugin's context lacks `connection`
// The plugin still has to refuse a credential-less request AND verify a real
// credential, through `ctx.get('connection')` on the root context (the protocol
// channel of a cordis delivery), which is the composition this fallback exists
// for (a plugin context that carries `webServer` only).
//
// What must NOT exist any more is the `'shape'` rung: a credential computed from
// the PUBLIC authority and never signature-checked. `FORGED` is exactly such a
// credential, built the way an attacker builds it, and the fallback must answer
// 401 to it. Remove the gate and this scenario fails on that assert.
// The host's admission is reachable from the plugin's fiber but the plugin's own
// fiber is NOT the one that provided it, which is the composition this fallback
// exists for. cordis resolves a service up the fiber chain, so providing
// `connection` on the ROOT while the plugin runs on a child context (and on a
// service object that has no `fetch` face to register on) reproduces exactly
// that: `ctx.get('connection')` works, `connection.fetch` does not exist.
function makeAdmitOnlyConnection() {
  return {
    admit: (request) => hostConnection.admit(request),
    requestRejection: (request) => hostConnection.requestRejection(request),
    browserAuth: hostAuth,
    // Deliberately no `fetch`, no `rpc`: a host that authenticates but does not
    // publish the exact-route registry this plugin prefers.
  }
}

async function scenarioLegacy(label, provideWebServer) {
  const ws = makeWebServer()
  const root = new cordis.Context()
  root.provide('connection', makeAdmitOnlyConnection())
  if (provideWebServer) root.provide('webServer', ws)
  const ctx = root.extend({})
  plugin.apply(ctx)
  await sleep(30)
  if (!provideWebServer) {
    root.provide('webServer', ws)
    await sleep(30)
  }

  const registered = [...ws.exact.keys()].sort()
  assert.deepStrictEqual(registered, ENDPOINTS.map((e) => browserVisible(e.name)).sort(), 'the legacy surface registers the browser-visible /api paths')

  const { server, port } = await startServer((req, res) => {
    const route = ws.exact.get(req.url.split('?')[0])
    if (!route) { res.writeHead(404); res.end('no route'); return }
    route.handler(req, res)
  })
  // The forged cookies are named for THIS port, the way an attacker computes
  // them: the authority is the one the browser is talking to.
  const forgedForPort = (suffix) => `${exportedCookieName(`127.0.0.1:${port}`)}=${suffix}`
  const forged = {}
  try {
    const anonymous = await anonymousSuite(port)
    assert.deepStrictEqual(anonymous, { 'external-status': 401, 'external-stop': 401, delete: 401, 'batch-delete': 401 }, `the fallback must refuse all four without a credential, got ${JSON.stringify(anonymous)}`)

    // NEGATIVE CONTROL 1: this exact request answered 200 before the fix.
    const control = await request(port, 'GET', browserVisible('external-status'))
    assert.notStrictEqual(control.status, 200, 'the credential-less 200 this task is about must be gone')

    // NEGATIVE CONTROL 2 — THE FORGED-CREDENTIAL REGRESSION. Every one of these
    // was served 200 by the `'shape'` rung, which never verified a signature.
    for (const [variant, suffix] of [
      ['all-as', 'v1.AAAA.BBBB'],
      ['garbage-payload', 'v1.YWJjZGVm.Z2hpamtsbW5vcA'],
      ['v2', 'v2.QUJDREVGL'],
      ['truncated', 'v1.only-two-parts'],
      ['empty-signature', 'v1.AAAA.'],
    ]) {
      for (const { name, method } of ENDPOINTS) {
        const res = await request(port, method, browserVisible(name), { cookie: forgedForPort(suffix), body: method === 'POST' ? {} : undefined })
        assert.strictEqual(res.status, 401, `a forged ${variant} cookie (${suffix}) must be 401 on ${name}, got ${res.status}`)
      }
      forged[variant] = 401
    }
    // A correct real cookie whose signature was altered is still not a credential.
    const tampered = mintCookie('/connect', port, `127.0.0.1:${port}`)
    const cut = tampered.lastIndexOf('.')
    const broken = `${tampered.slice(0, cut + 1)}${tampered.slice(cut + 1, -3)}AAA`
    const tamperedRes = await request(port, 'GET', browserVisible('external-status'), { cookie: broken })
    assert.strictEqual(tamperedRes.status, 401, 'a tampered signature is refused')

    const lookalike = await request(port, 'GET', browserVisible('external-status'), { cookie: 'dsh-auth-looks-real=v1.abc.def' })
    assert.strictEqual(lookalike.status, 401, 'a cookie that only LOOKS like the session cookie is not a credential')
    const bogus = await request(port, 'GET', browserVisible('external-status'), { token: 'bogus' })
    assert.strictEqual(bogus.status, 401, 'a token the host cannot verify is not a credential')

    const suite = await authenticatedSuite(port, mintCookie('/connect', port, `127.0.0.1:${port}`))
    assertBodyUnchanged(suite)
    const browser = await request(port, 'GET', browserVisible('external-status'), { cookie: mintCookie('/', port, `127.0.0.1:${port}`) })
    assert.strictEqual(browser.status, 200, 'a browser-session cookie admits on the fallback surface')

    const wrongVerb = await request(port, 'POST', browserVisible('external-status'), { cookie: mintCookie('/connect', port, `127.0.0.1:${port}`), body: {} })
    assert.deepStrictEqual([wrongVerb.status, wrongVerb.json.error], [405, 'method-not-allowed'], 'the legacy surface keeps its 405 for a wrong verb')

    record(label, { surface: 'webServer', gate: 'connection.admit', registered, anonymous, control: control.status, forged, tampered: tamperedRes.status, lookalike: lookalike.status, bogusToken: bogus.status, browserCookie: browser.status, wrongVerb: wrongVerb.status, body: 'unchanged' })
  } finally {
    server.close()
  }
}

// E. A host whose connection service has NO `admit`: there is no honest policy
//    the plugin can apply (it cannot verify a signature itself), so the fallback
//    must register NOTHING. The failure mode this replaces is the `'shape'`
//    route: present, answering 200 to a fabricated cookie.
async function scenarioNoAdmit() {
  const ws = makeWebServer()
  const noAdmit = {
    browserAuth: hostAuth,
    requestRejection: () => undefined,
  }
  const root = new cordis.Context()
  root.provide('webServer', ws)
  root.provide('connection', noAdmit)
  plugin.apply(root.extend({}))
  await sleep(30)

  const registered = [...ws.exact.keys()]
  assert.deepStrictEqual(registered, [], `without connection.admit no legacy route may be registered, got ${JSON.stringify(registered)}`)

  const { server, port } = await startServer((req, res) => {
    const route = ws.exact.get(req.url.split('?')[0])
    if (!route) { res.writeHead(404); res.end('no route'); return }
    route.handler(req, res)
  })
  const forged = {}
  try {
    const anonymous = await anonymousSuite(port)
    assert.deepStrictEqual(anonymous, { 'external-status': 404, 'external-stop': 404, delete: 404, 'batch-delete': 404 }, `no route may serve, got ${JSON.stringify(anonymous)}`)
    for (const [variant, suffix] of [['all-as', 'v1.AAAA.BBBB'], ['garbage-payload', 'v1.YWJjZGVm.Z2hpamtsbW5vcA'], ['v2', 'v2.QUJDREVGL']]) {
      const res = await request(port, 'GET', browserVisible('external-status'), { cookie: `${exportedCookieName(`127.0.0.1:${port}`)}=${suffix}` })
      assert.strictEqual(res.status, 404, `a forged ${variant} cookie must not reach a service at all, got ${res.status}`)
      forged[variant] = 404
    }
    // Not even a REAL credential is served: there is no route to serve it.
    const real = await request(port, 'GET', browserVisible('external-status'), { cookie: mintCookie('/connect', port, `127.0.0.1:${port}`) })
    assert.strictEqual(real.status, 404, 'with no admission the surface is simply absent')
    record('no-admit', { surface: 'none (fail closed)', registered: registered.length, anonymous, forged, real: real.status })
  } finally {
    server.close()
  }
}

await scenarioConnectionArrivesLate()
await scenarioLegacy('legacy-fallback', true)
await scenarioLegacy('legacy-arrives-later', false)
await scenarioNoAdmit()
await scenarioFetchFace()

// Every scenario above asserts as it goes, so reaching this line means they all
// passed. The plugin leaves live timers behind, so the event loop would never
// drain: write the evidence, wait for that write to flush, then exit 0.
await writeOut(JSON.stringify({ ok: true, evidence }, null, 2) + '\n')
process.exit(0)
