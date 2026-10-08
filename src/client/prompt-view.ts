// Subagent prompt preview (g-023): a per-message 「渲染 / 原文」 switch injected
// into a subagent conversation's chat flow.
//
// Injection面 decision (owner-arbitrated, do not change): DOM injection beside
// the official node, never a takeover of the `conversation.chat.node` slot. The
// host renders every user message as plain text, so the official node IS the
// raw view; this module keeps it untouched and only adds a sibling block plus a
// visibility class, which means the host's own affordances (attachments, fork,
// copy) stay reachable and a torn-down plugin leaves no trace.
//
// Data source: the durable `user/message` events of the same
// `eventSource` window the conversation view renders (`binding.eventSource` is
// literally the Session's own feed — the host assigns
// `binding.eventSource = session.eventSource`), so the two states are the same
// text: no second request, no rewrite, no re-send. The store's `prompt` /
// `projectionValues.prompt` fields are never read — no host publishes them.
//
// Alignment: a conversation node key is `<seq>:<definitionKind><messageId>`, so
// a node is matched to its event by `event.seq` first, by message id second, and
// only then by position (tail-aligned, because a bounded window is a tail page).
// A node with no event copy gets an explicit notice, never a guess.

import { PROMPT_FOLD_CHARS, PROMPT_FOLD_LINES, PROMPT_RENDER_MAX_CHARS, promptBodyInto } from './markdown'
import { liveBindingFor } from './retain'
import { zh, en } from './i18n'
import type { PromptMessage, PromptPreviewProps, SessionEventWindow, Tr } from './types'

/* Per-node user choice. Rendered is the default, so absence means 「渲染」. */
export const promptMode = new Map<string, string>()
/* Long prompts fold by default; a key listed here has been expanded by hand. */
export const promptUnfolded = new Set<string>()
export const PROMPT_MODE_RENDERED = 'rendered'
export const PROMPT_MODE_RAW = 'raw'
/* Own attribute namespace; every selector below is scoped to it. */
export const PROMPT_BLOCK_ATTR = 'data-dsh-sam-prompt-block'
export const PROMPT_HIDE_CLASS = 'dsh-sam-prompt-hide'
// The official node that carries one user prompt: the plain bubble at the tail
// of a conversation, or the collapsed turn card the host mounts for an older
// turn (its key is still `<seq>:input-message<id>`, so alignment is unchanged).
// A turn card is also a paging anchor, so its own element is never hidden.
const PROMPT_NODE_SELECTOR = '[data-chat-flow-kind="user"], [data-chat-flow-kind="turn-trigger"]'
const promptNodeIsCard = (node: Element) => node.getAttribute('data-chat-flow-kind') === 'turn-trigger'
/* How many ancestors to walk looking for the owning scrollport. */
const PROMPT_MAX_ANCHOR_HOPS = 12
/* Debounce for the mutation/feed driven resync (a streaming turn mutates a lot). */
const PROMPT_SYNC_DELAY = 80

type PromptBlockSpec = {
  key: string
  tr: Tr
  text: string
  source: string
  textOnly: boolean
  notice: string
  head: string
}

// A hook-free reader for the resident session, used only when the slot prop is
// missing: `state.current` exists up to 0.1.6-alpha.1, and on newer hosts the
// session-scoped slot always supplies `sessionId`.
const promptStoreCurrent = () => sessionsRt?.list?.getSnapshot?.()?.current || ''

const promptIsSubagent = (sessionId: string) => {
  if (!sessionId) return false
  const summary = sessionsRt?.list?.getSnapshot?.()?.byId?.[sessionId]
  return Boolean(summary && (summary.origin === 'subagent' || typeof summary.parentId === 'string'))
}

// The plugin's own continue instruction is a real `user/message` with
// `source.kind === 'user'` (it goes through the same session prompt rpc), so it
// can only be told apart by its exact text. Both dictionaries are checked
// because the instruction may have been sent under the other locale.
const promptContinueTexts = () => [zh['continuePrompt'], en['continuePrompt']].filter(Boolean)

const promptIsPreviewable = (message: PromptMessage) => {
  if (!message.text.trim()) return false
  const stamp = message.text.trim()
  for (const candidate of promptContinueTexts()) if (candidate && stamp === candidate) return false
  return true
}

// Sample hash: durable user messages are immutable, so the signature only has to
// notice that a *different* text took this key's place. O(1) per message keeps
// the resync cheap while an assistant answer streams into the same container.
const promptSampleHash = (text: string) => {
  const step = text.length > 512 ? Math.floor(text.length / 8) : 1
  let hash = text.length
  for (let index = 0; index < text.length; index += step) hash = (hash * 31 + text.charCodeAt(index)) | 0
  return String(hash)
}

const promptNodeKey = (node: Element) => node.getAttribute('data-chat-node-key') || ''
const promptSeqOfKey = (key: string) => {
  const hit = /^([0-9]+):/.exec(key)
  return hit ? Number(hit[1]) : null
}
// `<seq>:<definitionKind><messageId>` — the message id is what follows the
// definition kind (`input-message` for a user message).
const promptIdOfKey = (key: string) => {
  const cut = key.indexOf(':')
  if (cut < 0) return ''
  return key.slice(cut + 1).replace(/^[a-z][a-z-]*/, '')
}

// Every durable surface `user/message` in the window, in feed order. The
// `surfaceOp === 'append'` test mirrors the conversation layer's own node
// selection, so the record set and the rendered node set agree.
export const promptMessagesFromWindow = (win: SessionEventWindow | null | undefined) => {
  const out: PromptMessage[] = []
  const entries = win && Array.isArray(win.entries) ? win.entries : []
  for (const entry of entries) {
    if (!entry || entry.type !== 'event') continue
    const event = entry.event
    if (!event || event.type !== 'user/message' || event.surfaceOp !== 'append') continue
    const data = event.data
    if (!data) continue
    // A durable user message carries the blocks on `data.content`; the
    // `data.message` shape is the defensive fallback.
    const blocks = Array.isArray(data.content) ? data.content : Array.isArray(data.message?.content) ? data.message.content : []
    let text = ''
    let textOnly = true
    for (const block of blocks) {
      if (!block) continue
      const kind = typeof block.type === 'string' ? block.type : ''
      if (kind && kind !== 'text') {
        textOnly = false
        continue
      }
      if (typeof block.text === 'string') text += block.text
    }
    const source = data.source
    out.push({
      seq: typeof event.seq === 'number' ? event.seq : null,
      id: typeof data.id === 'string' ? data.id : '',
      kind: typeof source?.kind === 'string' ? source.kind : '',
      text,
      textOnly,
    })
  }
  return out
}

// The conversation body tags itself with its Session id
// (`data-conversation-session`); that is the precise lookup. The ancestor walk
// is the fallback for hosts that do not publish it, and a single resident
// scrollport is the last resort.
const promptContainerFor = (anchor: Element | null, sessionId: string) => {
  if (sessionId) {
    const bodies = document.querySelectorAll('[data-conversation-content][data-conversation-session]')
    for (const body of Array.from(bodies)) {
      if (body.getAttribute('data-conversation-session') !== sessionId) continue
      const scroll = body.querySelector('[data-conversation-scroll]')
      if (scroll) return scroll
    }
  }
  let node = anchor ? anchor.parentElement : null
  let hops = 0
  while (node && hops < PROMPT_MAX_ANCHOR_HOPS) {
    const found = node.querySelectorAll('[data-conversation-scroll]')
    if (found.length === 1) return found[0]
    if (found.length > 1) break
    node = node.parentElement
    hops += 1
  }
  const all = document.querySelectorAll('[data-conversation-scroll]')
  return all.length === 1 ? all[0] : null
}

// Text of the official rendering only: our own sibling blocks are skipped.
const promptOfficialText = (node: Element) => {
  let text = ''
  for (const child of Array.from(node.children)) {
    if (child.hasAttribute(PROMPT_BLOCK_ATTR)) continue
    text += child.textContent || ''
  }
  return text
}

const promptBlockFor = (spec: PromptBlockSpec) => {
  const tr = spec.tr
  const wrapper = document.createElement('div')
  wrapper.className = 'dsh-sam-prompt'
  wrapper.setAttribute(PROMPT_BLOCK_ATTR, '')
  wrapper.setAttribute('data-dsh-sam-prompt-key', spec.key)
  wrapper.setAttribute('data-dsh-sam-prompt-source', spec.source)
  // Set before either branch: a notice block must be recognized as unchanged by
  // the next resync too, otherwise it would be rebuilt on every pass.
  wrapper.setAttribute('data-dsh-sam-prompt-sig', promptBlockSignature(spec))
  const bar = document.createElement('div')
  bar.className = 'dsh-sam-prompt-bar'
  const badge = document.createElement('span')
  badge.className = 'dsh-sam-prompt-badge'
  badge.textContent = tr('prompt.bar')
  bar.appendChild(badge)
  if (!spec.text) {
    wrapper.setAttribute('data-dsh-sam-prompt-kind', 'notice')
    wrapper.setAttribute('data-dsh-sam-prompt-state', 'notice')
    const note = document.createElement('span')
    note.className = 'dsh-sam-prompt-notice'
    note.textContent = spec.notice || tr('prompt.unavailable')
    bar.appendChild(note)
    wrapper.appendChild(bar)
    return wrapper
  }
  if (spec.head) {
    const head = document.createElement('div')
    head.className = 'dsh-sam-prompt-head'
    head.textContent = spec.head
    wrapper.appendChild(head)
  }
  wrapper.setAttribute('data-dsh-sam-prompt-kind', 'preview')
  const lines = spec.text.split('\n').length
  const foldable = spec.text.length > PROMPT_FOLD_CHARS || lines > PROMPT_FOLD_LINES
  wrapper.setAttribute('data-dsh-sam-prompt-foldable', foldable ? 'true' : 'false')
  /* Attachments live in the official node; there we never hide it. */
  wrapper.setAttribute('data-dsh-sam-prompt-hide-official', spec.textOnly ? 'true' : 'false')
  for (const pair of [['rendered', tr('prompt.rendered')], ['raw', tr('prompt.raw')]]) {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.className = 'dsh-sam-prompt-tab'
    tab.setAttribute('data-dsh-sam-prompt-mode', pair[0])
    tab.title = tr('prompt.toggleAria')
    tab.textContent = pair[1]
    bar.appendChild(tab)
  }
  if (foldable) {
    const fold = document.createElement('button')
    fold.type = 'button'
    fold.className = 'dsh-sam-prompt-fold'
    fold.setAttribute('data-dsh-sam-prompt-fold', '')
    bar.appendChild(fold)
  }
  const body = document.createElement('div')
  body.className = 'dsh-sam-prompt-body'
  body.setAttribute('data-dsh-sam-prompt-body', '')
  const dropped = promptBodyInto(body, spec.text)
  if (dropped > 0) {
    const cut = document.createElement('span')
    cut.className = 'dsh-sam-prompt-cut'
    cut.textContent = tr('prompt.truncated', { shown: String(PROMPT_RENDER_MAX_CHARS), total: String(spec.text.length) })
    bar.appendChild(cut)
  }
  wrapper.appendChild(bar)
  wrapper.appendChild(body)
  wrapper.addEventListener('mousedown', event => event.stopPropagation())
  wrapper.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const mode = target.closest('[data-dsh-sam-prompt-mode]')
    if (mode) {
      event.preventDefault()
      event.stopPropagation()
      promptSetMode(spec.key, mode.getAttribute('data-dsh-sam-prompt-mode') || PROMPT_MODE_RENDERED, spec.tr)
      return
    }
    if (target.closest('[data-dsh-sam-prompt-fold]')) {
      event.preventDefault()
      event.stopPropagation()
      promptToggleFold(spec.key, spec.tr)
    }
  })
  promptApplyState(wrapper, spec.tr)
  return wrapper
}

export const promptBlockSignature = (spec: PromptBlockSpec) => {
  const kind = spec.text ? 'preview' : 'notice'
  const text = spec.text ? promptSampleHash(spec.text) : ''
  // The locale marker is part of the signature so a language switch rebuilds
  // the block instead of leaving stale labels behind.
  return [kind, spec.source, spec.text.length, text, spec.textOnly ? 't' : 'm', spec.notice, spec.head, spec.tr('prompt.raw')].join('|')
}

// Apply one node's state to one block: body visibility, official-node
// visibility, the pressed tab and the fold label. Pure DOM, no React state.
export const promptApplyState = (block: Element, tr: Tr) => {
  const key = block.getAttribute('data-dsh-sam-prompt-key') || ''
  if (block.getAttribute('data-dsh-sam-prompt-kind') !== 'preview') return
  const state = promptMode.get(key) === PROMPT_MODE_RAW ? PROMPT_MODE_RAW : PROMPT_MODE_RENDERED
  const rendered = state === PROMPT_MODE_RENDERED
  block.setAttribute('data-dsh-sam-prompt-state', state)
  const body = block.querySelector('[data-dsh-sam-prompt-body]')
  if (body) {
    const foldable = block.getAttribute('data-dsh-sam-prompt-foldable') === 'true'
    const folded = foldable && !promptUnfolded.has(key)
    body.classList.toggle('dsh-sam-prompt-body-hidden', !rendered)
    body.classList.toggle('dsh-sam-prompt-folded', folded)
    const fold = block.querySelector('[data-dsh-sam-prompt-fold]')
    if (fold) fold.textContent = folded ? tr('prompt.expand') : tr('prompt.collapse')
  }
  for (const tab of Array.from(block.querySelectorAll('[data-dsh-sam-prompt-mode]'))) {
    const on = tab.getAttribute('data-dsh-sam-prompt-mode') === state
    tab.classList.toggle('dsh-sam-prompt-tab-on', on)
    tab.setAttribute('aria-pressed', on ? 'true' : 'false')
  }
  const attachPoint = block.parentElement
  if (!attachPoint) return
  const hide = rendered && block.getAttribute('data-dsh-sam-prompt-hide-official') === 'true'
  for (const child of Array.from(attachPoint.children)) {
    if (child === block || child.hasAttribute(PROMPT_BLOCK_ATTR)) continue
    child.classList.toggle(PROMPT_HIDE_CLASS, hide)
  }
}

// One key can be mounted twice (main pane and the stock sidebar chat tab), so a
// state change is broadcast to every block carrying that key.
export const promptRefreshKey = (key: string, tr: Tr) => {
  const blocks = document.querySelectorAll('[' + PROMPT_BLOCK_ATTR + ']')
  for (const block of Array.from(blocks)) {
    if (block.getAttribute('data-dsh-sam-prompt-key') !== key) continue
    promptApplyState(block, tr)
  }
}

export const promptSetMode = (key: string, mode: string, tr: Tr) => {
  if (mode !== PROMPT_MODE_RAW && mode !== PROMPT_MODE_RENDERED) return
  promptMode.set(key, mode)
  promptRefreshKey(key, tr)
}

export const promptToggleFold = (key: string, tr: Tr) => {
  if (promptUnfolded.has(key)) promptUnfolded.delete(key)
  else promptUnfolded.add(key)
  promptRefreshKey(key, tr)
}

// A language switch has to relabel the injected blocks; the locale marker in the
// signature makes the resync rebuild them.
const promptSyncs = new Set<() => void>()
export const promptPreviewRefresh = () => {
  for (const sync of Array.from(promptSyncs)) {
    try {
      sync()
    } catch (error) {
      console.warn('subagent-workspace-ui: unable to refresh the prompt preview', error)
    }
  }
}

/**
 * Attach one conversation view. Returns the disposal that removes every injected
 * block and restores the official nodes it had hidden. Resyncs on DOM churn, on
 * feed publication and on demand; every write is idempotent, so the mutation it
 * causes terminates after one no-op pass.
 */
export const promptPreviewAttach = (anchor: Element, propSessionId: string, translate: () => Tr) => {
  const blocks = new Map<string, Element>()
  const hidden = new Set<Element>()
  let container: Element | null = null
  let feed: { subscribe?: (notify: () => void) => unknown } | null = null
  let unsubscribe: (() => void) | null = null
  let disposed = false
  let scheduled = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const detachFeed = () => {
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch (error) {
        console.warn('subagent-workspace-ui: unable to release the event feed subscription', error)
      }
      unsubscribe = null
    }
    feed = null
  }
  const restoreOfficial = () => {
    for (const child of Array.from(hidden)) child.classList.remove(PROMPT_HIDE_CLASS)
    hidden.clear()
  }
  const dropBlocks = () => {
    for (const block of Array.from(blocks.values())) if (block.parentNode) block.parentNode.removeChild(block)
    blocks.clear()
  }
  const clearAll = () => {
    dropBlocks()
    restoreOfficial()
  }

  const sync = () => {
    if (disposed) return
    const tr = translate()
    const sessionId = propSessionId || promptStoreCurrent()
    if (!sessionId || !promptIsSubagent(sessionId)) {
      detachFeed()
      clearAll()
      container = null
      return
    }
    const nextContainer = promptContainerFor(anchor, sessionId)
    if (nextContainer !== container) {
      clearAll()
      container = nextContainer
    }
    if (!container) return
    const source = liveBindingFor(sessionId)?.eventSource || null
    if (source !== feed) {
      detachFeed()
      feed = source
      if (source && typeof source.subscribe === 'function') {
        const off = source.subscribe(schedule)
        unsubscribe = typeof off === 'function' ? off : null
      }
    }
    const win = source && typeof source.getSnapshot === 'function' ? source.getSnapshot() || null : null
    // Alignment set: the records the conversation layer renders as user nodes.
    // Anything with a foreign `source.kind` renders as a context node instead.
    const records = promptMessagesFromWindow(win).filter(message => !message.kind || message.kind === 'user')
    const bySeq = new Map<number, PromptMessage>()
    const byId = new Map<string, PromptMessage>()
    for (const message of records) {
      if (message.seq !== null && !bySeq.has(message.seq)) bySeq.set(message.seq, message)
      if (message.id && !byId.has(message.id)) byId.set(message.id, message)
    }
    const used = new Set<PromptMessage>()
    const nodes = Array.from(container.querySelectorAll(PROMPT_NODE_SELECTOR))
    const mapped: (PromptMessage | null)[] = nodes.map(node => {
      const key = promptNodeKey(node)
      const seq = promptSeqOfKey(key)
      if (seq !== null) {
        const hit = bySeq.get(seq)
        if (hit && !used.has(hit)) {
          used.add(hit)
          return hit
        }
      }
      const id = promptIdOfKey(key)
      if (id) {
        const hit = byId.get(id)
        if (hit && !used.has(hit)) {
          used.add(hit)
          return hit
        }
      }
      return null
    })
    // Positional fill for whatever the key could not address. A bounded window
    // is a tail page, so unmatched nodes are the older ones: align both ends.
    const freeNodes: number[] = []
    mapped.forEach((hit, index) => {
      if (!hit) freeNodes.push(index)
    })
    const freeMessages = records.filter(message => !used.has(message))
    if (freeMessages.length && freeNodes.length) {
      const count = Math.min(freeMessages.length, freeNodes.length)
      const nodeStart = freeNodes.length - count
      const messageStart = freeMessages.length - count
      for (let step = 0; step < count; step += 1) mapped[freeNodes[nodeStart + step]] = freeMessages[messageStart + step]
    }
    // No feed evidence at all (a legacy snapshot-only conversation): fall back to
    // the official node's own text and mark the block's provenance as "dom".
    const legacy = records.length === 0 && !(win && win.hasMore)
    const paged = Boolean(win && win.hasMore)
    let headPending = paged
    const seen = new Set<string>()
    nodes.forEach((node, index) => {
      const key = promptNodeKey(node) || 'node:' + index
      seen.add(key)
      const message = mapped[index]
      const preview = message ? promptIsPreviewable(message) : false
      // A matched message with no renderable text (empty content) is filtered
      // out entirely: no block, no notice, no fabricated state.
      if (message && !preview) {
        const existing = blocks.get(key)
        if (existing) {
          if (existing.parentNode) existing.parentNode.removeChild(existing)
          blocks.delete(key)
        }
        return
      }
      let text = ''
      let sourceKind = 'events'
      let textOnly = true
      let notice = ''
      if (message) {
        text = message.text
        textOnly = message.textOnly && !promptNodeIsCard(node)
      } else if (legacy) {
        text = promptOfficialText(node)
        sourceKind = 'dom'
        textOnly = !node.querySelector('img') && !promptNodeIsCard(node)
        if (!text.trim()) text = ''
      }
      if (!text) notice = paged ? tr('prompt.notLoaded') : tr('prompt.unavailable')
      const head = text && headPending ? tr('prompt.notLoaded') : ''
      if (text) headPending = false
      const spec = { key, tr, text, source: sourceKind, textOnly, notice, head }
      const signature = promptBlockSignature(spec)
      const existing = blocks.get(key)
      if (existing && existing.parentElement === node && existing.getAttribute('data-dsh-sam-prompt-sig') === signature) {
        promptApplyState(existing, tr)
        return
      }
      if (existing) {
        if (existing.parentNode) existing.parentNode.removeChild(existing)
        blocks.delete(key)
      }
      const block = promptBlockFor(spec)
      node.appendChild(block)
      blocks.set(key, block)
    })
    for (const key of Array.from(blocks.keys())) {
      if (seen.has(key)) continue
      const block = blocks.get(key)
      if (block && block.parentNode) block.parentNode.removeChild(block)
      blocks.delete(key)
    }
    // Apply every block's state once the block sits inside its node, so the
    // official sibling's visibility follows the current mode.
    for (const block of Array.from(blocks.values())) promptApplyState(block, tr)
    // The official nodes are restored whenever no block claims them, so a
    // session switch can never leave a message invisible. `promptApplyState`
    // has already set the class per block; this only keeps the bookkeeping (and
    // the elements of removed blocks) in step.
    const claimed = new Set<Element>()
    for (const block of Array.from(blocks.values())) {
      if (block.getAttribute('data-dsh-sam-prompt-state') !== PROMPT_MODE_RENDERED) continue
      if (block.getAttribute('data-dsh-sam-prompt-hide-official') !== 'true') continue
      const owner = block.parentElement
      if (!owner) continue
      for (const child of Array.from(owner.children)) {
        if (child === block || child.hasAttribute(PROMPT_BLOCK_ATTR)) continue
        claimed.add(child)
      }
    }
    for (const child of Array.from(hidden)) {
      if (claimed.has(child)) continue
      child.classList.remove(PROMPT_HIDE_CLASS)
      hidden.delete(child)
    }
    for (const child of Array.from(claimed)) hidden.add(child)
  }

  const run = () => {
    try {
      sync()
    } catch (error) {
      console.warn('subagent-workspace-ui: prompt preview sync failed', error)
    }
  }

  function schedule() {
    if (disposed || scheduled) return
    scheduled = true
    timer = setTimeout(() => {
      scheduled = false
      timer = null
      run()
    }, PROMPT_SYNC_DELAY)
  }

  promptSyncs.add(run)
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  run()
  return () => {
    disposed = true
    promptSyncs.delete(run)
    observer.disconnect()
    detachFeed()
    if (timer) clearTimeout(timer)
    clearAll()
  }
}

/**
 * Headless host. It renders one hidden anchor and drives the DOM injection for
 * the conversation it belongs to; being session-scoped, the host remounts on
 * every session switch, and the injected blocks are also resynced from the
 * mutation observer, so a session change can never strand a stale block.
 */
export function PromptPreview({ t: tr, sessionId }: PromptPreviewProps) {
  const hostRef = React.useRef<Element | null>(null)
  const trRef = React.useRef<Tr>(tr)
  trRef.current = tr
  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    return promptPreviewAttach(host, sessionId || '', () => trRef.current)
  }, [sessionId])
  React.useEffect(() => {
    promptPreviewRefresh()
  }, [tr])
  return jsx('span', { ref: hostRef, className: 'dsh-sam-prompt-host', 'aria-hidden': 'true' })
}
