// Renders the REAL manager component and asserts on the produced element tree:
// the external row is visible and typed, its status is only ever the measured
// one, and the session-derived surfaces (live output, prompt, usage, continue,
// sidebar) are absent or unchanged for it.
//
// Run it with `pnpm run test`. The bundle is loaded from the repository this
// file lives in, not from the process CWD, so the harness runs from anywhere.
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

globalThis.document = { querySelector: () => true, getElementById: () => null, createElement: () => ({ dataset: {}, style: {}, remove() {} }), head: { appendChild() {} } }
// A real, inspectable preferences store: the deletion memory lives here (same
// key the plugin uses for `archived`), so a mount/refresh sees what a delete wrote.
let storedPrefs = null
globalThis.localStorage = { getItem: () => storedPrefs, setItem: (k, v) => { storedPrefs = v } }
globalThis.window = { confirm: () => true, alert: () => {}, prompt: () => null, innerWidth: 1200, innerHeight: 800 }
let ledgerPayload = { ok: true, active: [], ended: [] }
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ledgerPayload })

let viewDebug = process.env.DEBUG_VIEW === '1'
let cursor = 0
let cells = {}
let childCells = new Map()
let openOnce = false
const setters = []
const effects = []
// The factory body reads `document` as a free variable (the loader supplies its
// globals that way), so the harness — which kept it only as `window.document` —
// gives every boot the same stub in the module scope too.
globalThis.window.document = globalThis.document
const React = {
  useState: initial => {
    const index = cursor++
    if (!(index in cells)) { const base = typeof initial === 'function' ? initial() : initial; const forced = openOnce && depth === 0 && index === 0 ? true : base; cells[index] = forced }
    const set = next => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; if (depth === 0) pendingCommit = true }
    setters[index] = set
    return [cells[index], set]
  },
  useMemo: f => f(),
  useDeferredValue: v => v,
  useEffect: f => { effects.push(f) },
  useRef: v => ({ current: v }),
  Fragment: 'frag',
}
// Function components are the plugin's own bodies; invoke them so the tree is
// real rather than a description of them.
let depth = 0
const renderChild = (type, props) => {
  if (typeof type !== 'function') return { tag: type, props: props || {} }
  // A child's hooks are its own: give it a fresh slot cursor, then restore.
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
// The scope helpers are read out of the same factory so the harness can also
// mount the active float, whose rows are the manager's own row objects.
const src = readFileSync(CLIENT_BUNDLE, 'utf8')
// The same bundle DECODED (the loader wraps the built modules in one factory
// whose body is plain JS), used only to build a CONTROL copy of the code as it
// was before this attempt — see (b) below. Nothing here runs the decoded source
// directly; the control is re-wrapped into a loader module and booted normally.
const libSrc = (() => {
  const before = globalThis.window.__ModuleLoader__
  let factoryFn = null
  globalThis.window.__ModuleLoader__ = { load: ({ factory }) => { factoryFn = factory } }
  try {
    new Function('window', src)(globalThis.window)
  } finally {
    globalThis.window.__ModuleLoader__ = before
  }
  const text = factoryFn && Function.prototype.toString.call(factoryFn)
  if (!text) throw new Error('the bundle factory could not be decoded')
  // `toString()` of an arrow factory is `(require) => { ... }`: take the BODY
  // (outer braces), then drop the wrapper's OWN `return` of the module exports,
  // so the text can be re-wrapped as `(require) => { <body> }` verbatim.
  const body = text.slice(text.indexOf('{') + 1, text.lastIndexOf('}'))
  const exportsReturn = body.lastIndexOf("    return {inject:['sessions','slots','locale'],apply}")
  if (exportsReturn < 0) throw new Error('the decoded bundle has no module-exports return to strip')
  return body.slice(0, exportsReturn) + 'return ' + body.slice(exportsReturn).replace(/^\s+return /, '')
})()
const footer = "    return {inject:['sessions','slots','locale'],apply}"
const scopeSrc = src.replace(footer, `${footer.slice(0, -1)}, ActiveFloat, catalogEntriesOf, modeMap, childModeOf, externalRowsOf, deletedExternalOf, EXTERNAL_REMOVED_LIMIT, externalRemovedCap, externalRemovedAdd, sessionEntitiesOf, absentRowOf}`)
let api = null
globalThis.window.__ModuleLoader__ = { load: ({ factory }) => { api = factory(id => id === 'react' ? React : { jsx: (t, p) => renderChild(t, p), jsxs: (t, p) => renderChild(t, p) }) } }
new Function('window', scopeSrc)(globalThis.window)

const dicts = {}
const registrations = []
let state = { byId: {}, current: 'p1' }
api.apply({
  sessions: { list: { getSnapshot: () => ({ byId: state.byId, current: state.current }) }, binding: () => null },
  effect: fn => { try { fn() } catch {} },
  locale: { register: (ns, d) => { dicts[ns] = d } },
  slots: { inject: (slot, f) => { f() }, register: (config, component) => { registrations.push({ config, component }) } },
  get: () => undefined,
})
// Boot a copy of the bundle from its DECODED source, the way the first copy was
// booted (loader shell -> factory -> apply on a fake sessions runtime). Used by
// the negative control, which must run different SOURCE rather than a replaced
// binding: the linker links every module into one scope, so the manager reads
// the module-local `absentRowOf` and an export override on the live copy never
// reaches it (measured; a stubbed control would prove nothing).
function bootBundle(source, options) {
  let runnerApi = null
  // The loader is a free variable inside the wrapper module, not a property of
  // `window` in this harness; passing it in makes the control copy independent
  // of whatever the first boot left on `window`.
  const loader = { load: ({ factory }) => { runnerApi = factory(id => id === 'react' ? React : { jsx: (t, p) => renderChild(t, p), jsxs: (t, p) => renderChild(t, p) }) } }
  globalThis.window.__ModuleLoader__ = loader
  try {
    new Function('window', '__ModuleLoader__', `return function () { __ModuleLoader__.load({ factory: (require) => {${source}} }) }`)(globalThis.window, loader)()
  } catch (error) {
    throw new Error('control bundle: ' + (error && error.message) + '\n' + String((error && error.stack) || '').split('\n').slice(0, 6).join('\n'))
  }
  if (!runnerApi) throw new Error('control bundle did not call the loader')
  assert.ok(runnerApi, 'the control bundle booted')
  const controlDicts = {}
  const controlRegistrations = []
  runnerApi.__registrations = controlRegistrations
  runnerApi.apply({
    sessions: { list: { getSnapshot: () => ({ byId: state.byId, current: state.current }) }, binding: () => null },
    effect: fn => { try { fn() } catch {} },
    locale: { register: (ns, d) => { controlDicts[ns] = d } },
    slots: { inject: (slot, f) => { f() }, register: (config, component) => { controlRegistrations.push({ config, component }) } },
    get: () => undefined,
  })
  // The control is mounted into the SAME harness component pool, so it can be
  // rendered through the same `commit`/`render` path as the shipped copy.
  const controlManager = runnerApi.__registrations.find((r) => r.config.id === 'subagent-workspace-manager').component
  return { api: runnerApi, dicts: controlDicts, manager: controlManager }
}
const zoomForbidden = null
const zh = dicts['subagent-workspace-ui'].zh
const en = dicts['subagent-workspace-ui'].en
const manager = registrations.find(r => r.config.id === 'subagent-workspace-manager')
assert.ok(manager, 'manager registered')
assert.deepStrictEqual(Object.keys(zh), Object.keys(dicts['subagent-workspace-ui'].en), 'zh/en key order parity')

function render(next, options, fresh) {
  state = next
  cursor = 0
  // React keeps hook state across re-renders; only a new mount starts empty.
  if (fresh) { cells = {}; childCells = new Map() }
  openOnce = Boolean(options && options.open)
  setters.length = 0
  effects.length = 0
  const t = (key, params) => {
    const template = zh[key] !== undefined ? zh[key] : `<${key}>`
    return params ? template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] === undefined ? `{${name}}` : params[name])) : template
  }
  const { open, ...props } = options || {}
  const elementResult = manager.component({ t, useSessions: sel => sel(state), openChild: () => true, openSession: () => true, refresh: () => {}, setCatalogOpen: () => {}, sessionId: 'p1', actions: {}, ...props })
  return collect(elementResult)
}
// One commit + effects + the re-render the effects may have caused.
let pendingCommit = false
let commitOptions = null
let commitState = null
// One full commit: render, run the effects that commit queued, and render once
// more when an effect set component state (the poller's first response does).
async function commit(next, options, fresh) {
  pendingCommit = false
  const first = render(next, options, fresh)
  runEffects()
  // The poller's first response lands on a microtask; let it, then re-render.
  await new Promise(resolve => setTimeout(resolve, 5))
  return pendingCommit ? render(next, options, false) : first
}
// Child components set state too; only the top-level cursor marks a commit.

// Effects run after the tree is committed, exactly like React; a poller that
// sets state on the first pass then needs one more render to show it.
function runEffects() {
  for (const effect of effects.splice(0)) { try { effect() } catch (error) { throw new Error('effect threw: ' + error.message) } }
}
function collect(element) {
  const out = { nodes: [], text: [] }
  const walk = value => {
    if (value === null || value === undefined || value === false || value === true) return
    if (typeof value === 'string' || typeof value === 'number') { out.text.push(String(value)); return }
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (typeof value !== 'object') return
    const props = value.props || value.p || {}
    const tag = value.tag !== undefined ? value.tag : value.t
    if (tag === 'frag') { walk(props.children); return }
    out.nodes.push({ tag, props })
    walk(props.children)
  }
  walk(element)
  return out
}
const results = {}
const parent = { id: 'p1', origin: 'user', title: 'Parent', cwd: '/work', updatedAt: Date.now() }
const local = { id: 'session-c1', parentId: 'p1', origin: 'subagent', title: 'local child', cwd: '/work', updatedAt: Date.now(), running: true }
const ext = { id: 'da45e0aa-1111-4222-8333-444455556666', parentId: 'p1', origin: 'subagent', title: 'external child', cwd: '/work', updatedAt: Date.now() - 5000, running: false }
const catalog = [
  { id: 'session-c1', mode: 'continuable', label: 'local child' },
  { id: ext.id, mode: 'external', label: 'claude task' },
]
const stateFor = () => ({ byId: { p1: parent, 'session-c1': local, [ext.id]: ext }, current: 'p1', projectionsBySession: { p1: { values: { subagentCatalog: catalog } } } })

// The trigger button opens the panel through its own state setter.
const clickTrigger = collected => {
  const trigger = collected.nodes.find(n => n.tag === 'button' && typeof (n.props || {}).onClick === 'function' && String((n.props || {}).className || '') === 'dsh-sam-trigger')
  assert.ok(trigger, 'trigger rendered: ' + JSON.stringify(collected.nodes.filter(n => n.tag === 'button').map(n => String((n.props || {}).className || ''))))
  trigger.props.onClick()
}

// 1. closed -> open, then the external row is visible with its family + engine badge.
let view = await commit(stateFor())
clickTrigger(view)
view = await commit(stateFor(), { open: true })
assert.ok(view.nodes.some(n => (n.props || {}).className === 'dsh-sam-panel'), 'panel open: ' + JSON.stringify(view.nodes.slice(0, 8).map(n => String((n.props || {}).className || n.tag))))
const text = view.text.join(' ')
assert.ok(text.includes('外部代理'), 'family label visible')
assert.ok(text.includes('状态不可得'), 'no edge => status unavailable')
assert.ok(!text.includes('已结束'), 'unavailable is not rendered as ended')
results.visible = { family: text.includes('外部代理'), unavailable: text.includes('状态不可得') }

// 2. a measured running edge: engine shown, stop offered, no continue/sidebar.
ledgerPayload = { ok: true, active: [{ runId: 'run-1', id: ext.id, provider: 'claude-code', parentId: 'p1', seq: 1, startedAt: Date.now() }], ended: [] }
view = await commit(stateFor(), { open: true, asideAddressOf: () => 'dsh-resource://subagentchat/session/x?parent=p1&mode=continuable', openAside: () => true })
const runningText = view.text.join(' ')
assert.ok(runningText.includes('运行中 · Claude Code'), 'running + engine; text=' + runningText.slice(0, 400))
const extRowIndex = view.nodes.findIndex(n => typeof (n.props||{}).className === 'string' && n.props.className.includes('dsh-sam-row-ext'))
assert.ok(extRowIndex >= 0, 'external row marked')
const buttons = view.nodes.filter(n => n.tag === 'button')
assert.ok(buttons.some(b => String((b.props||{}).children).includes('⏹ 停止')), 'stop offered while running')
assert.ok(!buttons.some(b => String((b.props||{}).title || '').includes('外部代理') && String((b.props||{}).className || '').includes('continue')), 'no continue button for external')
results.running = { text: 'running+engine', stop: true }

// 3. ended edge: stop withdrawn, reason + duration shown from the payload.
ledgerPayload = { ok: true, active: [], ended: [{ runId: 'run-1', id: ext.id, provider: 'claude-code', parentId: 'p1', seq: 1, startedAt: 1000, endedAt: 5000, stopReason: 'aborted', paired: true, durationMs: 4000 }] }
view = await commit(stateFor(), { open: true })
const endedText = view.text.join(' ')
assert.ok(endedText.includes('已结束（已中止 · 4 秒）'), 'ended detail rendered')
assert.ok(!view.nodes.filter(n => n.tag === 'button').some(b => String((b.props||{}).children).includes('⏹ 停止')), 'stop withdrawn after the end')
results.ended = 'reason+duration, no stop'

// 4. only a provider the host knows: the id is shown verbatim, never mapped.
ledgerPayload = { ok: true, active: [{ runId: 'run-2', id: ext.id, provider: 'my-proxy', parentId: 'p1', seq: 2 }], ended: [] }
view = await commit(stateFor(), { open: true })
assert.ok(view.text.join(' ').includes('运行中 · my-proxy'), 'unknown provider shown verbatim')
results.verbatim = 'my-proxy'

// 5. a local continuation row is untouched: continue + sidebar still render,
//    and the external row never borrows them.
ledgerPayload = { ok: true, active: [], ended: [] }
const localChild = { ...local, running: false }
const stateLocal = { byId: { p1: parent, 'session-c1': localChild, [ext.id]: ext }, current: 'p1', projectionsBySession: { p1: { values: { subagentCatalog: catalog } } } }
view = await commit(stateLocal, { open: true, asideAddressOf: () => 'dsh-resource://subagentchat/session/x?parent=p1&mode=continuable', openAside: () => true })
const sidebarButtons = view.nodes.filter(n => n.tag === 'button' && String((n.props||{}).children) === '◫')
assert.strictEqual(sidebarButtons.length, 1, 'sidebar button only on the local row')
results.localUntouched = { sidebarButtons: sidebarButtons.length }

// 6. THE REAL HOST SHAPE: an external execution has NO Session at all. The
//    parent's catalog lists it, `byId` does not, and the ledger reports it
//    running. Before the row-synthesis fix this produced an empty panel and a
//    `0/0` header; these assertions are the regression guard for that.
const extOnly = { id: '3902fbda-97a6-4c1e-9a1b-000000000001', parentId: 'p1' }
// Byte-faithful to the host's own projection (`subagentCatalogEntries`):
// `{ id, createdAt, mode, label }` and NO parentId — the parent is the owner of
// the projection, never a field on the entry. This is exactly what
// `establishExternalCatalogChild` appends for a real codex delegation.
const catalogOnly = [
  { id: 'session-c1', createdAt: 1000, mode: 'continuable', label: 'local child' },
  { id: extOnly.id, createdAt: 2000, mode: 'external', label: 'codex task' },
]
const stateNoSession = () => ({ byId: { p1: parent, 'session-c1': { ...local, running: false } }, current: 'p1', projectionsBySession: { p1: { values: { subagentCatalog: catalogOnly } } } })
assert.ok(!stateNoSession().byId[extOnly.id], 'fixture: the external id has no Session, as on the real host')
ledgerPayload = { ok: true, active: [{ runId: 'run-9', id: extOnly.id, provider: 'codex', parentId: 'p1', seq: 9, startedAt: Date.now() }], ended: [] }
cells = {}; childCells = new Map()
let synthView = await commit(stateNoSession(), { open: true })
const synthText = synthView.text.join(' ')
assert.ok(!synthText.includes('没有符合条件的子代理'), 'panel is not empty for a session-less external run')
assert.ok(synthText.includes('codex task'), 'the catalog label names the row')
assert.ok(synthText.includes('运行中 · Codex'), 'running + engine for the synthesized row; text=' + synthText.slice(0, 300))
assert.ok(synthText.includes('外部代理'), 'family badge present')
const synthStop = synthView.nodes.filter(n => n.tag === 'button').some(b => String((b.props || {}).children).includes('⏹ 停止'))
assert.ok(synthStop, 'stop offered for the synthesized running row')
// Header counts: the closed-panel trigger reads 🧩 子代理 active/total.
const closed = await commit(stateNoSession(), { open: false })
const chip = closed.text.join(' ')
assert.ok(chip.includes('子代理 1/2'), 'header counts the external row as active and in total; chip=' + chip.slice(0, 80))
// After the end edge the same synthesized row reports ended, not running.
ledgerPayload = { ok: true, active: [], ended: [{ runId: 'run-9', id: extOnly.id, provider: 'codex', parentId: 'p1', seq: 9, startedAt: 1000, endedAt: 6500, stopReason: 'completed', paired: true, durationMs: 5500 }] }
synthView = await commit(stateNoSession(), { open: true })
const endedSynth = synthView.text.join(' ')
assert.ok(endedSynth.includes('已结束（正常完成 · 6 秒）'), 'ended after the terminal edge; text=' + endedSynth.slice(0, 300))
results.sessionlessExternal = { row: true, engine: 'Codex', stop: true, chip: 'active 1/2', ended: true }

// 7. A row in `byId` is NOT duplicated by the catalog entry for it.
const dupState = () => ({ byId: { p1: parent, 'session-c1': { ...local, running: false }, [ext.id]: ext }, current: 'p1', projectionsBySession: { p1: { values: { subagentCatalog: catalog } } } })
const dupView = await commit(dupState(), { open: true })
const rowIds = dupView.nodes.filter(n => typeof (n.props || {}).className === 'string' && n.props.className.split(' ').includes('dsh-sam-row')).map(n => n.props.className)
const titleNodes = dupView.nodes.filter(n => (n.props || {}).className === 'dsh-sam-session-id').map(n => String((n.props || {}).children))
const occurrences = titleNodes.filter(id => id === ext.id).length
assert.strictEqual(occurrences, 1, 'the external id appears once even though both a Session and a catalog entry exist; ids=' + JSON.stringify(titleNodes))
const ids = rowIds.length
results.noDuplicates = ids

// 8. A DELETED external child must not linger as a stub row. The host catalog is
//    append-only (no removal event exists) and an external child has no Session,
//    so the only fact that separates "deleted" from "running/ended/not yet
//    started" is the browser's own record of the completed deletion. This is the
//    regression guard for the reported bug: 3 catalog entries, 1 live child.
// The plugin's own helpers, read out of the factory it returned (the harness only
// widens the return object; the functions are the shipped ones).
const sessionEntitiesOf = api.sessionEntitiesOf, absentRowOfGate = api.absentRowOf
const externalRowsOf = api.externalRowsOf, deletedExternalOf = api.deletedExternalOf, EXTERNAL_REMOVED_LIMIT = api.EXTERNAL_REMOVED_LIMIT, externalRemovedCap = api.externalRemovedCap, externalRemovedAdd = api.externalRemovedAdd
assert.ok(typeof externalRowsOf === 'function' && typeof externalRemovedCap === 'function', 'plugin helpers exported for direct assertions')
const ROWS = view => view.nodes.filter(n => typeof (n.props || {}).className === 'string' && n.props.className.split(' ').includes('dsh-sam-row'))
const stubFixture = entries => ({
  byId: {
    p1: parent,
    alive: { id: 'alive', parentId: 'p1', origin: 'subagent', title: '活着的子代理', cwd: '/work', updatedAt: Date.now() },
  },
  current: 'p1',
  projectionsBySession: { p1: { values: { subagentCatalog: entries } } },
})
const threeEntries = [
  { id: 'alive', createdAt: 1, mode: 'continuable', label: '活着的子代理' },
  { id: 'deleted-ext-1', createdAt: 2, mode: 'external', label: '已删的外部代理1' },
  { id: 'deleted-ext-2', createdAt: 3, mode: 'external', label: '已删的外部代理2' },
]
// (a) NEGATIVE CONTROL, and the exact reported repro: with no deletion recorded
//     the two external entries still render (3 rows) — proving the assertions
//     below have teeth rather than passing on an already-broken fixture.
storedPrefs = null
cells = {}; childCells = new Map()
ledgerPayload = { ok: true, active: [], ended: [] }
let stubView = await commit(stubFixture(threeEntries), { open: true }, true)
assert.strictEqual(ROWS(stubView).length, 3, 'control: 3 undeleted-but-catalogued rows (1 local + 2 external) without any deletion record')
assert.ok(stubView.text.join(' ').includes('已删的外部代理1'), 'control: the deleted external entry renders while no deletion is recorded')
// (b) The fix: the same state, with those two ids recorded as deleted (what
//     deleteSubagent / batch-delete write on a successful host answer). The
//     count must drop to the ONE live child, exactly as on a page refresh.
storedPrefs = JSON.stringify({ removedExternal: ['deleted-ext-1', 'deleted-ext-2'] })
stubView = await commit(stubFixture(threeEntries), { open: true }, true)
const afterDeleteRows = ROWS(stubView)
const afterDeleteText = stubView.text.join(' ')
assert.strictEqual(afterDeleteRows.length, 1, 'only the live child renders; rows=' + afterDeleteRows.length)
assert.ok(afterDeleteText.includes('活着的子代理'), 'the undeleted local child still renders')
assert.ok(!afterDeleteText.includes('已删的外部代理1'), 'deleted external 1 is gone')
assert.ok(!afterDeleteText.includes('已删的外部代理2'), 'deleted external 2 is gone')
// The HEADER COUNTS (the closed-panel chip and the panel summary) are derived from
// the same rows, so a deleted child must not be counted either.
const closedAfterDelete = await commit(stubFixture(threeEntries), { open: false }, true)
const chipAfterDelete = closedAfterDelete.text.join(' ')
assert.ok(!chipAfterDelete.includes('0/3'), 'the header does not count the deleted external rows; chip=' + chipAfterDelete.slice(0, 60))
assert.ok(afterDeleteText.includes('当前会话 1 个'), 'the panel summary counts 1; text=' + afterDeleteText.slice(0, 200))
results.deletedExternal = { control: 3, afterDelete: afterDeleteRows.length, chip: true }
// (c) REVERSE CONSTRAINT — no false kill. A deletion record must never hide a
//     child that is (i) running right now (the id was re-delegated), (ii) ended
//     with a measured edge, or (iii) catalogued with no edge at all (running or
//     just started, which this page cannot see). Only (iv) really is deleted.
storedPrefs = null
cells = {}; childCells = new Map()
const fourExternal = [
  { id: 'ext-running', createdAt: 1, mode: 'external', label: '运行中的外部代理' },
  { id: 'ext-ended', createdAt: 2, mode: 'external', label: '已结束的外部代理' },
  { id: 'ext-quiet', createdAt: 3, mode: 'external', label: '刚启动的外部代理' },
  { id: 'ext-gone', createdAt: 4, mode: 'external', label: '真正删除的外部代理' },
]
ledgerPayload = {
  ok: true,
  active: [{ runId: 'r-run', id: 'ext-running', provider: 'codex', parentId: 'p1', seq: 1, startedAt: Date.now() }],
  ended: [{ runId: 'r-end', id: 'ext-ended', provider: 'claude-code', parentId: 'p1', seq: 2, startedAt: 1000, endedAt: 4000, stopReason: 'completed', paired: true, durationMs: 3000 }],
}
storedPrefs = JSON.stringify({ removedExternal: ['ext-gone'] })
stubView = await commit(stubFixture(fourExternal), { open: true }, true)
const reverseText = stubView.text.join(' ')
assert.ok(reverseText.includes('运行中的外部代理'), 'a running external run is still shown')
assert.ok(reverseText.includes('已结束的外部代理'), 'an ended external run is still shown')
assert.ok(reverseText.includes('刚启动的外部代理'), 'an external run with no measured edge is still shown')
assert.ok(!reverseText.includes('真正删除的外部代理'), 'the deleted external row is hidden')
// The running run also outranks a stale deletion record for the SAME id (a
// re-delegation reuses the catalog id), so deletion must never mask a live run.
ledgerPayload = { ok: true, active: [{ runId: 'r-gone', id: 'ext-gone', provider: 'codex', parentId: 'p1', seq: 3, startedAt: Date.now() }], ended: [] }
stubView = await commit(stubFixture(fourExternal), { open: true }, true)
assert.ok(stubView.text.join(' ').includes('真正删除的外部代理'), 'a recorded deletion never hides a currently RUNNING child of the same id')
// The predicate itself, unit-shaped: live/ended/unknown are all shown, and only
// the recorded-and-not-running id is hidden.
const shown = externalRowsOf(k => k, stubFixture(fourExternal), { 'ext-running': { status: 'running' }, 'ext-ended': { status: 'ended' }, 'ext-quiet': { status: 'unknown' } }, ['ext-running', 'ext-gone']).map(r => r.id)
assert.deepStrictEqual(shown.sort(), ['ext-ended', 'ext-quiet', 'ext-running'], 'only the recorded, non-running id is excluded (a recorded RUNNING id stays); got=' + JSON.stringify(shown))
assert.strictEqual(deletedExternalOf(['a'], { a: { status: 'running' } })('a'), false, 'running outranks a deletion record')
assert.strictEqual(deletedExternalOf(['a'], { a: { status: 'ended' } })('a'), true, 'an ended child with a deletion record is hidden')
assert.strictEqual(deletedExternalOf(undefined, undefined)('a'), false, 'no record => never hidden (and no crash)')
results.noFalseKill = { running: true, ended: true, quiet: true, runningBeatsRecord: true }
// (d) The memory is BOUNDED and self-cleaning: at most EXTERNAL_REMOVED_LIMIT
//     entries, newest kept, oldest evicted; adding is idempotent and moves the id
//     to the newest end; an id that has a Session again is dropped by the panel.
assert.ok(EXTERNAL_REMOVED_LIMIT > 0 && EXTERNAL_REMOVED_LIMIT <= 2000, 'a sane cap exists: ' + EXTERNAL_REMOVED_LIMIT)
const overfull = Array.from({ length: EXTERNAL_REMOVED_LIMIT + 25 }, (_, i) => `id-${i}`)
const capped = externalRemovedCap(overfull)
assert.strictEqual(capped.length, EXTERNAL_REMOVED_LIMIT, 'the list is capped at ' + EXTERNAL_REMOVED_LIMIT)
assert.strictEqual(capped[0], 'id-25', 'the oldest entries are the ones evicted')
assert.strictEqual(capped[capped.length - 1], 'id-' + (EXTERNAL_REMOVED_LIMIT + 24), 'the newest entry is kept')
const dedup = externalRemovedAdd(externalRemovedAdd(['a', 'b'], 'a'), 'a')
assert.deepStrictEqual(dedup, ['b', 'a'], 're-adding moves the id to the newest end instead of duplicating it')
assert.strictEqual(externalRemovedAdd(capped, 'fresh').length, EXTERNAL_REMOVED_LIMIT, 'adding to a full list still obeys the cap')
// Natural cleanup: once a recorded id has a Session again, a mount drops it.
storedPrefs = JSON.stringify({ removedExternal: ['deleted-ext-1', 'deleted-ext-2'] })
const revived = {
  ...stubFixture(threeEntries),
  byId: { ...stubFixture(threeEntries).byId, 'deleted-ext-1': { id: 'deleted-ext-1', parentId: 'p1', origin: 'subagent', title: '又活了的子代理', cwd: '/work', updatedAt: Date.now() } },
}
const pruned = await commit(revived, { open: true }, true)
assert.strictEqual(ROWS(pruned).length, 2, 'the revived id renders once (from byId), the still-deleted one stays hidden; rows=' + ROWS(pruned).length)
runEffects()
const persisted = JSON.parse(storedPrefs || '{}')
assert.deepStrictEqual(persisted.removedExternal, ['deleted-ext-2'], 'the record for an id that exists again was pruned; stored=' + storedPrefs)
// The explicit clear control: offered while a deletion is recorded, and clicking
// it empties the memory (the escape hatch for a wrong record).
storedPrefs = JSON.stringify({ removedExternal: ['deleted-ext-1', 'deleted-ext-2'], filterCollapsed: false })
const withMemory = await commit(stubFixture(threeEntries), { open: true }, true)
const clearBtn = withMemory.nodes.filter(n => n.tag === 'button' && typeof (n.props || {}).className === 'string' && (n.props || {}).className.includes('dsh-sam-clear-removed'))
assert.strictEqual(clearBtn.length, 1, 'a clear control is offered while deletions are recorded')
clearBtn[0].props.onClick()
// The click only queues the preference change; the commit effect is what writes
// localStorage, so one more commit (a re-render of the same mount) persists it.
await commit(stubFixture(threeEntries), { open: true })
assert.deepStrictEqual(JSON.parse(storedPrefs || '{}').removedExternal, [], 'the clear control empties the memory; stored=' + storedPrefs)
// With the memory cleared, the catalogued externals come back (honest: the host
// still lists them) — the control is reversible, not destructive.
const afterClear = await commit(stubFixture(threeEntries), { open: true }, true)
assert.strictEqual(ROWS(afterClear).length, 3, 'clearing the memory restores the catalogued rows')
results.bounded = { limit: EXTERNAL_REMOVED_LIMIT, dedup: true, pruned: true, cleared: true }
// (e) One-shot / continuable behavior is untouched: their rows come from `byId`
//     and a deletion record for a LOCAL id changes nothing about them.
storedPrefs = JSON.stringify({ removedExternal: ['session-c1'] })
cells = {}; childCells = new Map()
const localRecorded = await commit(stateLocal, { open: true, asideAddressOf: () => 'dsh-resource://subagentchat/session/x?parent=p1&mode=continuable', openAside: () => true }, true)
const localText = localRecorded.text.join(' ')
assert.ok(localText.includes('local child'), 'a continuable row still renders regardless of the deletion memory')
assert.strictEqual(localRecorded.nodes.filter(n => n.tag === 'button' && String((n.props || {}).children) === '◫').length, 1, 'its sidebar action is unchanged')
results.localUnchanged = true
// 9. g-026 / att-003 — THE REPORTED BUG, on the operator's real data.
//
// The operator deleted subagents through the panel, reinstalled the plugin,
// restarted `dsh web` and hard-refreshed, and the panel STILL listed 29 rows;
// the tail ones are stubs ("unknown" model / turns / steps). Diagnosis (his
// environment): the row comes from `byId`, the host rebuilds those entries from
// the parent session's append-only log, and deletion only removes the child's
// SESSION DIRECTORY, which the browser cannot look at. So the browser's own
// `removedExternal` list is not the fact that matters — the HOST's answer is.
//
// What is asserted here, through the REAL manager component and the REAL bundle:
//   (a) the reported repro — the host reports the child's directory gone and the
//       row disappears (panel rows, panel summary AND the closed-panel header
//       chip), while a child the host reports present stays;
//   (b) NEGATIVE CONTROL against the shipped feature set: the SAME bundle with
//       rung 2 disabled (`isAbsentRow` forced to false — i.e. the code as it was
//       before this attempt) renders all three rows for the SAME host answer.
//       That control is what proves the assertions have teeth.
//   (c) the conservative arms — no answer, a failed probe, an `unavailable`
//       root, a `partial` root, a present id, a malformed body: EVERY row shows;
//   (d) a running child outweighs an `absent` answer (re-delegation);
//   (e) one batched request for the whole candidate set (never one per row).
const ENTITY_URL = '/api/dsh-subagent-workspace-ui/session-entity'
// The fetched ground truth: an id => exists map, plus a mode for failures.
let entityWorld = { mode: 'ok', exists: {}, present: [], absent: [], unavailable: [], root: 'read' }
let entityCalls = []
const baseFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  const target = String(url)
  if (!target.startsWith(ENTITY_URL)) return baseFetch(url, options)
  entityCalls.push(target)
  if (entityWorld.mode === 'throw') throw new Error('network down')
  const ids = [...new URL(target, 'http://x').searchParams.getAll('id')]
  const answer = {
    ok: true,
    version: 1,
    root: entityWorld.root,
    present: ids.filter((id) => entityWorld.exists[id] === true || (entityWorld.present || []).includes(id)),
    absent: entityWorld.mode === 'unavailable' ? [] : ids.filter((id) => entityWorld.present.every((p) => p !== id) && entityWorld.exists[id] !== true),
    unavailable: entityWorld.mode === 'unavailable' ? ids : [],
  }
  if (entityWorld.mode === 'malformed') return { ok: true, status: 200, json: async () => ({ ok: true }) }
  return { ok: true, status: 200, json: async () => answer }
}
globalThis.fetch = globalThis.fetch
// The gate every row passes through in the panel's external-row builder.
// Exported for the unit-shaped assertions; the CONTROL does not stub it (the
// bundle links the modules into one scope, so the panel never sees a replaced
// binding — a real control has to run different SOURCE, see `withDisabledGate`).
const preFix = api.absentRowOf
const hostState = entries => ({
  byId: { p1: parent, 'session-c1': { ...local, running: false } },
  current: 'p1',
  projectionsBySession: { p1: { values: { subagentCatalog: entries } } },
})
const mixed = [
  { id: 'session-c1', createdAt: 1, mode: 'continuable', label: '真实存在的一次性子代理' },
  { id: 'ext-present', createdAt: 2, mode: 'external', label: '目录仍在的外部代理' },
  { id: 'ext-deleted-a', createdAt: 3, mode: 'external', label: '已删除的外部代理A' },
  { id: 'ext-deleted-b', createdAt: 4, mode: 'external', label: '已删除的外部代理B' },
]
// The reported state: one child the host still has, two whose directories are
// gone (his parent's catalog keeps all of them forever, append-only).
const realWorld = () => ({
  mode: 'ok',
  root: 'read',
  exists: { 'session-c1': true, 'ext-present': true },
  present: ['ext-present'],
  absent: ['ext-deleted-a', 'ext-deleted-b'],
})
// (a) THE FIX: the deleted rows are gone; the live ones stay — and so does the
//     ROW COUNT everywhere it is shown.
async function settled(next, options) {
  storedPrefs = null
  cells = {}; childCells = new Map()
  ledgerPayload = { ok: true, active: [], ended: [] }
  entityWorld = realWorld()
  entityCalls = []
  const first = await commit(next, { open: true, ...options }, true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  // The probe's effect stores the answer, which re-renders the panel.
  return render(next, { open: true, ...options }, false)
}
let fixedView = await settled(hostState(mixed))
let fixedText = fixedView.text.join(' ')
const fixedRows = ROWS(fixedView)
assert.ok(!fixedText.includes('已删除的外部代理A'), 'the deleted external row A is NOT rendered; text=' + fixedText.slice(0, 400))
assert.ok(!fixedText.includes('已删除的外部代理B'), 'the deleted external row B is NOT rendered')
assert.ok(fixedText.includes('目录仍在的外部代理'), 'the external row the host still has IS rendered')
assert.ok(fixedText.includes('真实存在的一次性子代理'), 'the continuable row is untouched')
assert.strictEqual(fixedRows.length, 2, 'exactly the two live rows remain; rows=' + fixedRows.length)
assert.ok(fixedText.includes('显示 2/2'), 'the panel summary counts only the live rows; text=' + fixedText.slice(0, 200))
const fixedChip = (await settled(hostState(mixed), { open: false })).text.join(' ')
assert.ok(!fixedChip.includes('0/4') && !fixedChip.includes('/4'), 'the header does NOT count the deleted rows; chip=' + fixedChip.slice(0, 60))
// The probe is ONE batched request naming every session-less external
// candidate — never one request per row.
assert.strictEqual(entityCalls.length, 1, 'one existence request for the whole panel; calls=' + JSON.stringify(entityCalls))
const probed = new URL(entityCalls[0], 'http://x').searchParams.getAll('id').sort()
// `session-c1` is listed without a Session in `byId` here, so it is a candidate
// too — that is the second reported class of stub row (a child the host rebuilt
// from the log whose directory is gone), and it is answered in the same batch.
assert.deepStrictEqual(probed, ['ext-deleted-a', 'ext-deleted-b', 'ext-present', 'session-c1'], 'the batch names every catalog child without a Session (all four here); got=' + JSON.stringify(probed))
results.hostEntityFix = { rows: fixedRows.length, batch: probed.length, deletedHidden: true, liveShown: true }

// (b) NEGATIVE CONTROL: the SAME source with rung 2 disabled — `isAbsentRow`
//     becomes the constant `false`, which is exactly the behavior of the code
//     before this attempt (only rung 1, the browser's own record, can hide a
//     row). It is run as a SECOND copy of the bundle, because the linker puts
//     every module into one shared scope: replacing an exported binding on the
//     first copy provably does not reach the manager (measured), so a stub over
//     the live bundle would be a control that controls nothing.
// The decoded bundle is the BUILT (type-erased) code, so the gate there has no
// annotations. Anchor on the built text, not the TypeScript source.
const GATE_MARK = 'const absentRowOf=(absent,externalStates)=>{'
const gateAt = libSrc.indexOf(GATE_MARK)
if (gateAt < 0) throw new Error('the control patch cannot find the shipped gate in the decoded bundle')
const gateEnd = libSrc.indexOf('\n', gateAt)
const CONTROL_SRC = libSrc.slice(0, gateAt) + 'const absentRowOf=(absent,externalStates)=>(id)=>false' + libSrc.slice(gateEnd)
if (CONTROL_SRC === libSrc) throw new Error('the control patch changed nothing')
const controlRun = await bootBundle(CONTROL_SRC, zoomForbidden)
// (b2) The control is driven through the harness renderer with ITS manager.
async function settledWith(component, next, options) {
  storedPrefs = null
  cells = {}; childCells = new Map()
  ledgerPayload = { ok: true, active: [], ended: [] }
  entityWorld = realWorld()
  entityCalls = []
  const t = (key, params) => {
    const template = zh[key] !== undefined ? zh[key] : `<${key}>`
    return params ? template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] === undefined ? `{${name}}` : params[name])) : template
  }
  const run = (open) => {
    cursor = 0
    setters.length = 0
    effects.length = 0
    openOnce = open
    const { open: _ignored, ...props } = options || {}
    return collect(component({ t, useSessions: sel => sel(state), openChild: () => true, openSession: () => true, refresh: () => {}, setCatalogOpen: () => {}, sessionId: 'p1', actions: {}, ...props }))
  }
  state = next
  run(Boolean(options && options.open !== false))
  runEffects()
  await new Promise((resolve) => setTimeout(resolve, 10))
  return render(next, { open: true, ...(options || {}) }, false) && run(Boolean(options && options.open !== false))
}
const controlView = await settledWith(controlRun.manager, hostState(mixed), { open: true })
const controlText = controlView.text.join(' ')
assert.strictEqual(ROWS(controlView).length, 4, 'CONTROL (pre-fix gate): every catalogued row renders; rows=' + ROWS(controlView).length)
assert.ok(controlText.includes('已删除的外部代理A') && controlText.includes('已删除的外部代理B'), 'CONTROL (pre-fix gate): both deleted rows are back')
const controlChip = (await settledWith(controlRun.manager, hostState(mixed), { open: false })).text.join(' ')
assert.ok(controlChip.includes('0/4') || controlChip.includes('/4'), 'CONTROL: the header counts the deleted rows too; chip=' + controlChip.slice(0, 60))
const restored = await settled(hostState(mixed))
assert.strictEqual(ROWS(restored).length, 2, 'the shipped bundle (rung 2 on) removes them again')
results.hostEntityControl = { preFixRows: 4, fixedRows: 2 }

// (c) THE CONSERVATIVE ARMS. Every one of them must show EVERY row: a probe
//     that cannot answer is never evidence of deletion.
const conservative = [
  ['probe throws', () => { entityWorld = { ...realWorld(), mode: 'throw' } }],
  ['host says root unavailable', () => { entityWorld = { ...realWorld(), mode: 'unavailable' } }],
  ['root partially readable', () => { entityWorld = { ...realWorld(), root: 'partial' } }],
  ['malformed body', () => { entityWorld = { ...realWorld(), mode: 'malformed' } }],
  ['host reports both present', () => { entityWorld = { mode: 'ok', root: 'read', exists: { 'session-c1': true, 'ext-present': true, 'ext-deleted-a': true, 'ext-deleted-b': true }, present: ['ext-present', 'ext-deleted-a', 'ext-deleted-b'] } }],
]
for (const [label, prepare] of conservative) {
  storedPrefs = null
  cells = {}; childCells = new Map()
  ledgerPayload = { ok: true, active: [], ended: [] }
  prepare()
  const first = await commit(hostState(mixed), { open: true }, true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const view2 = render(hostState(mixed), { open: true }, false)
  const text2 = view2.text.join(' ')
  assert.strictEqual(ROWS(view2).length, 4, `"${label}": all four rows must show; rows=` + ROWS(view2).length + ' first=' + ROWS(first).length)
  assert.ok(text2.includes('已删除的外部代理A') || entityWorld.mode !== 'ok', `"${label}": rows are shown when the answer is not evidence`)
}
// The structural arms of the fold itself, unit-shaped: an answer that is not
// `root: 'read'` never yields an id, and neither does junk.
assert.deepStrictEqual([...sessionEntitiesOf([{ ok: true, root: 'unavailable', absent: ['x'] }])], [], 'unavailable root asserts nothing')
assert.deepStrictEqual([...sessionEntitiesOf([{ ok: true, root: 'partial', absent: ['x'] }])], [], 'partial root asserts nothing')
assert.deepStrictEqual([...sessionEntitiesOf([{ ok: false, root: 'read', absent: ['x'] }])], [], 'a refused answer asserts nothing')
assert.deepStrictEqual([...sessionEntitiesOf([{ ok: true, root: 'read', absent: ['x'], present: ['x'] }])], [], 'a contradictory answer is not evidence')
assert.deepStrictEqual([...sessionEntitiesOf([null, undefined, 7, 'x', {}, { root: 'read' }])], [], 'junk answers assert nothing')
assert.deepStrictEqual([...sessionEntitiesOf([{ ok: true, root: 'read', absent: ['x', 42, ''], present: [] }])], ['x'], 'only non-empty string ids under a read root become absent')
// The fold has its own CONTROL, run as a second copy of the bundle: the two
// guards that make a failure non-evidence are removed one at a time, and the
// fold must then claim a child absent from an answer that proves nothing.
const FOLD_GUARD = "    if(answer.root!=='read')continue\n"
assert.ok(libSrc.includes(FOLD_GUARD), 'the fold\'s root guard is where the control expects it')
// The harness appends every helper it needs to the module-exports object, the
// same way `scopeSrc` does for the shipped bundle. In the DECODED body that
// object is a bare `return {…}` (the loader wrapper's indentation is gone).
const EXPORT_LINE = "return {inject:['sessions','slots','locale'],apply}"
const appendExports = (source) => {
  const at = source.indexOf(EXPORT_LINE)
  if (at < 0) throw new Error('the decoded bundle lost its module-exports line')
  return source.slice(0, at) + EXPORT_LINE.slice(0, -1) + ',sessionEntitiesOf}' + source.slice(at + EXPORT_LINE.length)
}
const foldControl = bootBundle(appendExports(libSrc.replace(FOLD_GUARD, '')), null)
assert.deepStrictEqual([...foldControl.api.sessionEntitiesOf([{ ok: true, root: 'unavailable', absent: ['x'] }])], ['x'], 'CONTROL: without the root guard an UNREADABLE root would hide x')
const OK_GUARD = "    if(answer.ok===false)continue\n"
assert.ok(libSrc.includes(OK_GUARD), 'the fold\'s ok guard is where the control expects it')
const okControl = bootBundle(appendExports(libSrc.replace(OK_GUARD, '')), null)
assert.deepStrictEqual([...okControl.api.sessionEntitiesOf([{ ok: false, root: 'read', absent: ['y'] }])], ['y'], 'CONTROL: without the ok guard a REFUSED answer would hide y')
assert.deepStrictEqual([...sessionEntitiesOf([{ ok: false, root: 'read', absent: ['y'] }])], [], 'the shipped fold hides nothing for that answer')
assert.strictEqual(absentRowOfGate(undefined, undefined)('x'), false, 'no memory => never hidden')
assert.strictEqual(absentRowOfGate(new Set(['x']), { x: { status: 'running' } })('x'), false, 'a running child outranks an absent answer')
assert.strictEqual(absentRowOfGate(new Set(['x']), { x: { status: 'ended' } })('x'), true, 'an ended, absent child is hidden')
results.hostEntityConservative = { arms: conservative.length, allShown: true }

// (a2) THE OPERATOR'S EXACT SHAPE: the stub rows live in `byId`, not in the
//      external synthesis. His parent log names 37 children (all `continuable`)
//      and only 13 of those directories still exist; the host rebuilds the other
//      24 as `origin: 'subagent'` summaries with no model/turns/steps — the
//      "未知（未缓存 未知 / 未知 / 未知）· 未知轮 · 未知步" rows he reported. The
//      rows therefore come from the `byId` pass and the existence answer has to
//      reach THAT pass too (asserted here by implication: the count and the
//      labels below can only be produced by filtering `byId` rows).
const liveChild = { id: 'session-live-1', parentId: 'p1', origin: 'subagent', title: '目录仍在的子代理', cwd: '/work', updatedAt: Date.now() }
const byIdStubChild = id => ({ id, parentId: 'p1', origin: 'subagent', title: id, cwd: '/work', updatedAt: 1 })
const byIdStubIds = ['session-stub-1', 'session-stub-2', 'session-stub-3']
const byIdCatalog = [
  { id: 'session-live-1', createdAt: 1, mode: 'continuable', label: '目录仍在的子代理' },
  ...byIdStubIds.map((id, i) => ({ id, createdAt: 2 + i, mode: 'continuable', label: id })),
]
const byIdStubState = () => ({
  byId: { p1: parent, 'session-live-1': liveChild, ...Object.fromEntries(byIdStubIds.map(id => [id, byIdStubChild(id)])) },
  current: 'p1',
  projectionsBySession: { p1: { values: { subagentCatalog: byIdCatalog } } },
})
// The GUIDE shape: a catalogued child with NO Session in byId whose directory is
// gone. No browser memory names it, so only the host's answer can hide it.
const ghostByIdState = () => ({
  byId: { p1: parent, 'session-live-1': liveChild },
  current: 'p1',
  projectionsBySession: { p1: { values: { subagentCatalog: byIdCatalog } } },
})
const byIdWorld = () => ({ mode: 'ok', root: 'read', exists: { 'session-live-1': true }, present: ['session-live-1'], absent: byIdStubIds })
const DEBUG_BYID = process.env.DEBUG_BYID === '1'
// A direct read of what the panel PROBED, so a regression here names itself.
const probeIds = element => {
  const out = []
  const walk = value => {
    if (value === null || value === undefined) return
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (typeof value !== 'object') return
    const props = value.props || {}
    for (const [k, v] of Object.entries(props)) if (k === 'ids' && Array.isArray(v)) out.push(...v)
    if (props.children && Array.isArray(props.children)) for (const c of props.children) walk(c)
    const kid = props.children
    if (kid && typeof kid === 'object' && !Array.isArray(kid)) walk(kid)
    walk(props.children)
  }
  walk(element)
  return out
}
const renderByIdWorld = async (next, world, options) => {
  storedPrefs = null
  cells = {}; childCells = new Map()
  ledgerPayload = { ok: true, active: [], ended: [] }
  entityWorld = world()
  entityCalls = []
  await commit(next, { open: true, ...(options || {}) }, true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  return render(next, { open: true, ...(options || {}) }, false)
}
let byIdView = await renderByIdWorld(byIdStubState(), byIdWorld)
let byIdText = byIdView.text.join(' ')
assert.strictEqual(ROWS(byIdView).length, 1, 'REPORTED SHAPE: only the child whose directory exists renders; rows=' + ROWS(byIdView).length)
assert.ok(byIdText.includes('目录仍在的子代理'), 'the existing child is shown')
for (const id of byIdStubIds) assert.ok(!byIdText.includes(id), 'the stub row ' + id + ' is gone')
const byIdChip = (await renderByIdWorld(byIdStubState(), byIdWorld, { open: false })).text.join(' ')
assert.ok(!byIdChip.includes('/4'), 'the header no longer counts the stub rows; chip=' + byIdChip.slice(0, 60))
assert.ok(byIdChip.includes('/1'), 'the header counts the one real child; chip=' + byIdChip.slice(0, 60))
// The same answer hides a catalogued child that has no Session at all.
const ghostByIdView = await renderByIdWorld(ghostByIdState(), byIdWorld)
assert.strictEqual(ROWS(ghostByIdView).length, 1, 'a session-less catalogued child whose directory is gone is hidden too; rows=' + ROWS(ghostByIdView).length)
// …and NONE of it happens without the existence rung: the pre-fix bundle renders
// all four rows in both shapes (the control's teeth for the `byId` path).
const byIdControl = await settledWith(controlRun.manager, byIdStubState(), { open: true })
assert.strictEqual(ROWS(byIdControl).length, 4, 'CONTROL (pre-fix): all four byId rows render; rows=' + ROWS(byIdControl).length)
// Conservative arms on the SAME byId shape: no answer => every stub row shows.
for (const world of [
  () => ({ ...byIdWorld(), mode: 'unavailable' }),
  () => ({ ...byIdWorld(), mode: 'throw' }),
  () => ({ ...byIdWorld(), root: 'partial' }),
]) {
  const view3 = await renderByIdWorld(byIdStubState(), world)
  assert.strictEqual(ROWS(view3).length, 4, 'no usable answer => every byId row is shown; rows=' + ROWS(view3).length)
}
// A `byId` child the host still has always stays, even when the host does not
// mention it at all (absent is a positive claim, never a default).
// `present` is the host's honest answer for these (it does not know they are
// stubs), so this arm says: a positive/present answer hides NOTHING — the row
// comes back exactly as before rung 2 existed.
const unmentioned = await renderByIdWorld(byIdStubState(), () => ({ mode: 'ok', root: 'read', exists: { 'session-live-1': true }, present: ['session-live-1', ...byIdStubIds], absent: [] }))
assert.strictEqual(ROWS(unmentioned).length, 4, 'a `present` answer hides nothing — the rows come back')
results.hostEntityByIdRows = { reported: 4, fixed: 1, ghost: 1, control: 4, conservative: 3 }

// (d) A RE-DELEGATED id: the host says the directory is gone (an old run) while
//     the ledger says it is RUNNING right now. The live run wins.
entityWorld = realWorld()
ledgerPayload = { ok: true, active: [{ runId: 'live-1', id: 'ext-deleted-a', provider: 'codex', parentId: 'p1', seq: 5, startedAt: Date.now() }], ended: [] }
storedPrefs = null
cells = {}; childCells = new Map()
await commit(hostState(mixed), { open: true }, true)
await new Promise((resolve) => setTimeout(resolve, 10))
const redelegated = render(hostState(mixed), { open: true }, false)
const redelegatedText = redelegated.text.join(' ')
assert.ok(redelegatedText.includes('已删除的外部代理A'), 'a currently RUNNING child is shown even when its old directory is gone')
assert.ok(redelegatedText.includes('运行中 · Codex'), 'and it is shown as running')
assert.ok(!redelegatedText.includes('已删除的外部代理B'), 'the sibling that is not running stays hidden')
ledgerPayload = { ok: true, active: [], ended: [] }
results.hostEntityRunningWins = true

// (e) The pre-existing browser memory is untouched by all of this: a recorded
//     deletion still hides its id, and the clear control still restores the
//     host-listed rows (rung 1 is additive, not replaced).
storedPrefs = JSON.stringify({ removedExternal: ['ext-present'] })
entityWorld = realWorld()
cells = {}; childCells = new Map()
await commit(hostState(mixed), { open: true }, true)
await new Promise((resolve) => setTimeout(resolve, 10))
const memoryView = render(hostState(mixed), { open: true }, false)
const memoryText = memoryView.text.join(' ')
assert.ok(!memoryText.includes('目录仍在的外部代理'), 'a browser-recorded deletion still hides its row (rung 1 unchanged)')
assert.strictEqual(ROWS(memoryView).length, 1, 'only the continuable row is left; rows=' + ROWS(memoryView).length)
results.hostEntityMemoryKept = true

// Every assertion above has already thrown by the time this line runs, so
// reaching it means the harness passed: exit 0 explicitly, because the plugin's
// pollers leave live timers behind and the event loop would otherwise never
// drain. A failing run throws first and keeps its non-zero status.
console.log(JSON.stringify(results, null, 1))
process.exit(0)
