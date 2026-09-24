// Shared domain types for the subagent workspace manager.
// This module is types-only: the build erases it entirely.

/** Bound translator provided by the DSH client-locale slot. */
export type Tr = (key: string, params?: Record<string, unknown>) => string

export type SubagentMode = 'one-shot' | 'continuable'

export interface TokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * Counters from the same `sessionStats` projection. Read by key, with no
 * version gate: a host that does not fold decoding timings simply omits them
 * (the fold itself reports `decodeMs: null` before the first streamed token),
 * and an absent key means "not reported" — never zero. `decodeTokens` over
 * `decodeMs` is the official output speed (tps).
 */
export interface SessionStats {
  turns?: number
  steps?: number
  llmMs?: number | null
  toolMs?: number | null
  ttftMs?: number | null
  ttftSteps?: number | null
  decodeMs?: number | null
  decodeTokens?: number | null
}

/** One complete model selection as reported by the host projection. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/**
 * Client view of the host `modelSelection` projection. Both fields are null
 * until the session records a request header or a selection, and the whole key
 * is absent on hosts that do not register the projection (capability probe).
 */
export interface ModelSelectionProjection {
  lastUsed: ModelSelection | null
  next: ModelSelection | null
}

/** Durable child identity as carried by the `subagent` projection's client view. */
export interface SubagentIdentity {
  mode: SubagentMode
  label?: string
  seq?: number
}

/**
 * Client view of the host `subagent` identity projection. The wire view is the
 * flat identity, or the serializable `null` sentinel when no valid descriptor
 * exists (the sentinel survives JSON, an absent field would not); a host fold
 * state nests the same identity under `identity`. Both shapes are read, and an
 * absent key means the host mounts no such projection (capability absence).
 */
export interface SubagentIdentityProjection {
  mode?: SubagentMode
  label?: string
  identity?: SubagentIdentity
}

export interface ProjectionValues {
  tokenUsage?: TokenUsage
  sessionStats?: SessionStats
  turns?: number
  steps?: number
  prompt?: string
  modelSelection?: ModelSelectionProjection
  subagent?: SubagentIdentityProjection | null
  /* dsh 0.1.7-rc.1: the parent Session's own direct-child catalog. */
  subagentCatalog?: SubagentCatalogEntry[]
}

/** Public DSH session summary as exposed by the Web session store. */
export interface SessionSummary {
  id: string
  parentId?: string
  origin?: string
  title?: string
  displayTitle?: string
  cwd?: string
  updatedAt: number
  createdAt?: number
  running?: boolean
  prompt?: string
  projectionValues?: ProjectionValues
}

export interface ChildEntry {
  kind: string
  id: string
  mode: SubagentMode
  label?: string
}

export interface ParentSubagents {
  entries?: ChildEntry[]
}

/*
 * dsh 0.1.7-rc.1 replaced `subagentsByParent[parent]` with the parent Session's
 * own `subagentCatalog` projection: the same direct children in catalog event
 * order, but keyed by shape only — no `kind` discriminator, a `createdAt`, and a
 * third `mode: 'unknown'` arm for a child whose creation fact carried no mode
 * (so the reader must not trust any of these fields blindly).
 */
export interface SubagentCatalogEntry {
  id: string
  createdAt?: number
  mode?: string
  label?: string
}

/** One shared projection value set plus its explicit-read lifecycle. */
export interface SessionProjectionSnapshot {
  values?: ProjectionValues
  state?: string
}

export interface SessionState {
  byId: Record<string, SessionSummary>
  /* dsh 0.1.7-rc.1 removed this map; read `subagentCatalog` instead. */
  subagentsByParent?: Record<string, ParentSubagents>
  /* dsh 0.1.7-rc.1: projection values for every Session, opened or not. */
  projectionsBySession?: Record<string, SessionProjectionSnapshot>
  /* dsh 0.1.6-alpha.2 removed this field (selection moved to uiWorkspace). */
  current?: string
}

/** Anything with an optional cwd (session summaries and ad-hoc literals). */
export interface CwdLike {
  cwd?: string
}

export interface ModeInfo {
  mode: SubagentMode
  label?: string
}

/*
 * One catalog row after either host generation has been folded: the child id
 * plus whatever the host published. `mode` stays optional because the 0.1.7
 * catalog's `'unknown'` arm carries a label without a usable mode — the reader
 * drops the mode and keeps the label rather than the other way round.
 */
export interface CatalogEntry {
  id: string
  mode?: SubagentMode
  label?: string
}

/** A catalog row: the session summary joined with its child-entry mode/label. */
export type SubagentRow = SessionSummary & Partial<ModeInfo> & {
  name: string
  parentCwd?: string
}

export interface TabDef {
  id: string
  name?: string
  nameKey?: string
  regex: string
}

/** Browser-local preferences persisted under the plugin localStorage key. */
export interface Prefs {
  tabs?: TabDef[]
  archived?: string[]
  archivedParents?: Record<string, unknown>
  showArchived?: boolean
  hideOneShot?: boolean
  hideOld?: boolean
  oldDays?: number
  liveCap?: number
  activeFloat?: boolean
  activeFloatLive?: boolean
  customSubagentBg?: boolean
  subagentBgLight?: string
  subagentBgDark?: string
  filterCollapsed?: boolean
  showDetails?: boolean
}

export interface SubagentAddress {
  parentSessionId: string
  childSessionId: string
  mode: SubagentMode
}

/* ------------------------------------------------------------------ */
/* Live-output source types (dsh 0.1.2-alpha.2 raw SessionEvent API).  */
/* ------------------------------------------------------------------ */

export type StreamChunk =
  | { type: 'text-delta'; text?: string }
  | { type: 'reasoning-delta'; text?: string }
  | { type: 'tool-call-delta'; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'block-end'; block?: ContentBlock }
  | { type: string; text?: string; id?: string; name?: string; argumentsDelta?: string; block?: ContentBlock }

export interface ContentBlock {
  type?: string
  id?: string
  name?: string
  text?: string
  arguments?: string
  isError?: boolean
}

export interface EventSource {
  kind?: string
  form?: string
  plugin?: string
  callId?: string
}

export interface EventMessage {
  source?: EventSource
  content?: ContentBlock[]
}

export interface SessionEvent {
  type: string
  data?: {
    chunk?: StreamChunk
    source?: EventSource
    message?: EventMessage
    callId?: string
    name?: string
    arguments?: string
  }
}

export interface EventEntry {
  type: string
  event?: SessionEvent
}

export interface SessionEventWindow {
  entries?: EventEntry[]
  hasMore?: boolean
  revision?: number
  change?: unknown
}

export interface ToolCallRecord {
  name: string
  args: string
  complete: boolean
  running: boolean
}

export interface ToolCallDone {
  name: string
  args: string
  complete: boolean
  isError: boolean | undefined
}

export interface LiveOut {
  pendingCount: number
  activity: string[]
  streamText: string
  thinking: boolean
  finalText: string
}

/* ------------------------------------------------------------------ */
/* Legacy snapshot path (dsh 0.1.1-rc.2 and older: chat.legacy).       */
/* ------------------------------------------------------------------ */

export interface LegacyBlock {
  kind?: string
  text?: string
  name?: string
}

export interface LegacyCall {
  name?: string
  argsRaw?: string
}

export interface LegacyNode {
  kind?: string
  provenance?: { label?: string }
  form?: string
  isError?: boolean
  call?: LegacyCall
  name?: string
}

export interface SessionSnapshot {
  chat?: {
    legacy?: {
      partial?: { blocks?: LegacyBlock[] }
      runningCalls?: LegacyCall[]
      nodes?: LegacyNode[]
    }
  }
}

/* ------------------------------------------------------------------ */
/* Runtime faces.                                                      */
/* ------------------------------------------------------------------ */

export type Unsubscribe = () => void

export interface SessionFace {
  open?: () => unknown
  cancel?: () => unknown
  configureSubagent?: (address: SubagentAddress) => unknown
  getSnapshot?: () => SessionSnapshot | undefined
  subscribe?: (notify: () => void) => Unsubscribe | void
}

export interface SessionEventSource {
  getSnapshot?: () => SessionEventWindow | undefined
  subscribe?: (notify: () => void) => Unsubscribe | void
}

export interface SessionBinding {
  session?: SessionFace | null
  eventSource?: SessionEventSource | null
}

/* ------------------------------------------------------------------ */
/* Retain contract (dsh 0.1.6-alpha.2 `ctx.sessions`).                 */
/* ------------------------------------------------------------------ */

/**
 * Consumer identity carried by one independent Client reference. The host's
 * `SessionReferenceSourceMap` is declaration-merge-extensible through the
 * package's canonical `/client` entry (see ambient.d.ts): the plugin registers
 * its own label instead of borrowing the view-side `mainView`.
 */
export type SessionReferenceSource = string

/**
 * One owned use of an exact Client generation. The host declares `binding` and
 * `sessionId` as required, but a host without the retain contract exposes none
 * of these, so every member is probed defensively here.
 */
export interface SessionReference {
  readonly sessionId?: string
  readonly binding?: SessionBinding | null
  readonly ready?: Promise<unknown>
  release?: () => void
  dispose?: () => void
}

export interface SessionRetainOptions {
  source: SessionReferenceSource
  signal?: AbortSignal
}

/** Local ownership counts (`retainInfo`), never persisted and never catalog facts. */
export interface SessionRetainInfo {
  referenceCount?: number
  retainedBy?: Record<string, number>
}

/** One running row a surface asks this plugin to keep live. */
export interface RetainWant {
  childId: string
  parentId?: string
  mode?: SubagentMode
  updatedAt?: number
}

/** A held reference plus the address signature it was retained for. */
export interface RetainEntry {
  reference: SessionReference
  binding: SessionBinding
  signature: string
}

/** The ctx.sessions runtime the host plugin hands to apply(). */
export interface SessionsRuntime {
  binding?: (childId: string) => SessionBinding | null
  list?: { getSnapshot?: () => SessionState }
  refresh?: () => void
  /* dsh 0.1.7-rc.1 deleted setSubagentCatalogOpen and replaced refreshSubagents
     with refreshProjections(sessionId); every call site capability-probes. */
  refreshSubagents?: (parentId: string) => void
  refreshProjections?: (sessionId: string) => void
  open?: (sessionId: string) => void
  openSubagent?: (address: unknown) => void
  setSubagentCatalogOpen?: (parentId: string, open: boolean) => void
  /* dsh 0.1.6-alpha.2: resolve an already discovered direct-parent address. */
  subagentAddress?: (childId: string) => SubagentAddress | undefined
  /* dsh 0.1.6-alpha.2: create the binding that `binding` only borrows. */
  retain?: (target: unknown, options: SessionRetainOptions) => SessionReference
  retainInfo?: (childId: string) => { getSnapshot?: () => SessionRetainInfo } | null
}

/**
 * The ctx.uiWorkspace navigation face. The service itself is provided from
 * dsh 0.1.2 on, but openSession only exists from 0.1.5-rc.2; runtimes before
 * that keep the other methods, so both layers are optional here.
 */
export interface UiWorkspaceRuntime {
  openSession?: (target: unknown) => void
}

/**
 * The cross-plugin right-Sidebar navigation face (`ctx.sidebarRight`,
 * `ISidebarRight`). The service exists from dsh 0.1.6-alpha.2 on; older hosts
 * expose no such service, so every member is optional and probed by the caller.
 */
export interface SidebarRightRuntime {
  /* An address outside dsh-resource:// or one no tab type claims throws (wiring error). */
  openResource?: (address: string, options?: SidebarRightPlacement) => void
  isExpanded?: () => boolean
}

/** The placement share of `openResource` this plugin uses (`SidebarRightPlacement`). */
export interface SidebarRightPlacement {
  preferNewPane?: boolean
}

/**
 * The right-Sidebar tab-type registry (`ctx.sidebarRightTabs`). Only
 * `candidates` is used: a synchronous, side-effect-free probe for whether any
 * registered type would claim an address.
 */
export interface SidebarRightTabsRuntime {
  candidates?: (address: string) => readonly unknown[]
}

/* ------------------------------------------------------------------ */
/* Component props.                                                    */
/* ------------------------------------------------------------------ */

/** Props of the shadow this plugin registers over the stock lineage dropdown. */
export interface LineageShadowProps {
  lineageSessionId?: string
  displayTitle?: string
  openTitle?: () => void
  useSessions?: <T>(selector: (state: SessionState) => T) => T
}

export interface LiveOutputProps {
  t: Tr
  parentId?: string
  childId: string
  running?: boolean
  prefix?: boolean
  autoLoad?: boolean
  onLoad?: () => void
  live?: boolean
}

export interface ActiveFloatProps {
  t: Tr
  rows: SubagentRow[]
  openRow: (row: SubagentRow) => void
  onHide: () => void
  stopAgent: (row: SubagentRow) => unknown
  stopAllAgents: (rows: SubagentRow[]) => unknown
  stoppingIds: Set<string>
  liveEnabled: boolean
  onLiveChange: (value: boolean) => void
  liveCap: number
  /* Right-sidebar capability: both are absent when the host exposes no such face. */
  asideAddressOf?: ((row: SubagentRow) => string | null) | null
  openAside?: ((address: string) => boolean) | null
}

export interface ManagerProps {
  t: Tr
  useSessions: <T>(selector: (state: SessionState) => T, equal?: (a: T, b: T) => boolean) => T
  openChild: (address: unknown) => boolean
  openSession: (sessionId: string) => boolean
  refresh: (parentId: string) => void
  setCatalogOpen: (parentId: string, open: boolean) => void
  sessionId?: string
  actions?: { setView?: (viewId: string) => void }
  /* Right-sidebar capability: both are absent when the host exposes no such face. */
  asideAddressOf?: ((row: SubagentRow) => string | null) | null
  openAside?: ((address: string) => boolean) | null
}

/** The plugin context handed to apply() by the DSH client runtime. */
export interface PluginCtx {
  sessions: SessionsRuntime
  effect: (fn: () => void, id?: string) => void
  locale: { register: (ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }) => void }
  slots: {
    inject: (slot: string, factory: () => unknown) => void
    register: (config: Record<string, unknown>, component: unknown) => void
  }
  /* Optional-service probe (dsh client root contexts expose ctx.get). */
  get?: (name: string) => unknown
  /* Optional right-Sidebar faces; never declared as hard injections. */
  sidebarRight?: SidebarRightRuntime
  sidebarRightTabs?: SidebarRightTabsRuntime
}
