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

export interface SessionStats {
  turns?: number
  steps?: number
}

export interface ProjectionValues {
  tokenUsage?: TokenUsage
  sessionStats?: SessionStats
  turns?: number
  steps?: number
  prompt?: string
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

export interface SessionState {
  byId: Record<string, SessionSummary>
  subagentsByParent: Record<string, ParentSubagents>
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

/** The ctx.sessions runtime the host plugin hands to apply(). */
export interface SessionsRuntime {
  binding?: (childId: string) => SessionBinding | null
  list?: { getSnapshot?: () => SessionState }
  refresh?: () => void
  refreshSubagents?: (parentId: string) => void
  open?: (sessionId: string) => void
  openSubagent?: (address: unknown) => void
  setSubagentCatalogOpen?: (parentId: string, open: boolean) => void
}

/**
 * The ctx.uiWorkspace navigation face. The service itself is provided from
 * dsh 0.1.2 on, but openSession only exists from 0.1.5-rc.2; runtimes before
 * that keep the other methods, so both layers are optional here.
 */
export interface UiWorkspaceRuntime {
  openSession?: (target: unknown) => void
}

/* ------------------------------------------------------------------ */
/* Component props.                                                    */
/* ------------------------------------------------------------------ */

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
}
