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
const footer = "    return {inject:['sessions','slots','locale'],apply}"
const scopeSrc = src.replace(footer, `${footer.slice(0, -1)}, ActiveFloat, catalogEntriesOf, modeMap, childModeOf, externalRowsOf, deletedExternalOf, EXTERNAL_REMOVED_LIMIT, externalRemovedCap, externalRemovedAdd}`)
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
// Every assertion above has already thrown by the time this line runs, so
// reaching it means the harness passed: exit 0 explicitly, because the plugin's
// pollers leave live timers behind and the event loop would otherwise never
// drain. A failing run throws first and keeps its non-zero status.
console.log(JSON.stringify(results, null, 1))
process.exit(0)
