// g-026: the panel must SURFACE a failed host-cache purge instead of reporting a
// silent success. Drives the shipped bundle's own delete button with the two
// answers the host can give, and reads what the operator would see.
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
globalThis.document = { querySelector: () => true, getElementById: () => null, createElement: () => ({ dataset: {}, style: {}, remove() {} }), head: { appendChild() {} } }
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
const alerts = []
globalThis.window = { confirm: () => true, alert: (m) => alerts.push(String(m)), prompt: () => null, innerWidth: 1200, innerHeight: 800 }
let payload = { ok: true, deleted: true, cachePurged: false, cachePurge: { status: 'partial', purged: ['workspace.global'], failed: [{ domain: 'session_projcache', table: 'sessions', error: 'boom' }] } }
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload })
const cells = {}
let cursor = 0
const React = { useState(init) { const i = cursor++; if (!(i in cells)) cells[i] = typeof init === 'function' ? init() : init; return [cells[i], () => {}] }, useMemo(f) { return f() }, useDeferredValue(v) { return v }, useEffect() {}, useRef(v) { return { current: v } }, Fragment: 'frag' }
const el = (tag, props) => ({ tag, props: props || {} })
let api = null
globalThis.window.__ModuleLoader__ = { load: ({ factory }) => { api = factory((id) => (id === 'react' ? React : { jsx: el, jsxs: el })) } }
const src = readFileSync('lib/client.js', 'utf8')
const footer = "    return {inject:['sessions','slots','locale'],apply}"
new Function('window', src.replace(footer, `${footer.slice(0, -1)}, Manager}`))(globalThis.window)
const parent = { id: 'p1', origin: 'user', title: 'P', cwd: '/w', updatedAt: Date.now() }
const child = { id: 'c1', parentId: 'p1', origin: 'subagent', title: 'child', cwd: '/w', updatedAt: Date.now() }
const state = { byId: { p1: parent, c1: child }, current: 'p1' }
api.apply({ sessions: { list: { getSnapshot: () => state }, binding: () => null }, effect: () => {}, locale: { register: () => {} }, slots: { inject: (s, f) => f(), register: () => {} }, get: () => undefined, on: () => {} })
const walk = (n, visit) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach((x) => walk(x, visit)); return } if (n.tag === 'frag') { const c = n.props && n.props.children; (Array.isArray(c) ? c : [c]).forEach((x) => walk(x, visit)); return } visit(n); const c = n.props && n.props.children; (Array.isArray(c) ? c : [c]).forEach((x) => walk(x, visit)) }
const props = { t: (k, p) => (p ? k + ':' + JSON.stringify(p) : k), useSessions: (sel) => sel(state), openChild: () => true, openSession: () => true, refresh: () => {}, setCatalogOpen: () => {}, sessionId: 'p1', actions: {} }
cells[0] = true      // open
cells[2] = 'none'    // grouping
cells[4] = { filterCollapsed: false, showDetails: false } // prefs
cells[7] = 'all'     // scope
cursor = 0
const hits = []
walk(api.Manager(props), (n) => { if (n.props && String(n.props.className || '').includes('dsh-sam-delete-btn')) hits.push(n) })
const all = []
walk(api.Manager(props), (n) => { if (n.props && n.props.className) all.push(String(n.props.className)) })
assert.ok(hits.length >= 1, 'the panel renders the delete action for a subagent row')
hits[0].props.onClick({ stopPropagation() {} })
await new Promise((r) => setTimeout(r, 60))
assert.strictEqual(alerts.length, 1, 'a failed cache purge is surfaced to the operator, once')
assert.match(alerts[0], /cachePurgeFailed/, 'the warning uses the dedicated message')
assert.match(alerts[0], /session_projcache\.sessions/, 'the warning names the table that failed')
const unpurgedAlert = alerts[0]
alerts.length = 0
payload = { ok: true, deleted: true, cachePurged: true, cachePurge: { status: 'purged', purged: ['a.b'], failed: [] } }
hits[0].props.onClick({ stopPropagation() {} })
await new Promise((r) => setTimeout(r, 60))
assert.deepStrictEqual(alerts, [], 'a completed purge shows no warning at all')
console.log(JSON.stringify({ unpurged: 1, purged: 0, alert: unpurgedAlert.slice(0, 60) }))
process.exit(0)
