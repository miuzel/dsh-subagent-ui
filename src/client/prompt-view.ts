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
/* The compact re-open button that lives inside the official action row. */
export const PROMPT_TRIGGER_ATTR = 'data-dsh-sam-prompt-trigger'
const PROMPT_TRIGGER_CLASS = 'dsh-sam-prompt-trigger'
const PROMPT_TRIGGER_ON_CLASS = 'dsh-sam-prompt-trigger-on'
const PROMPT_BLOCK_HIDDEN_CLASS = 'dsh-sam-prompt-block-hidden'
// The official copy affordance is matched by its localized label (zh + en, and
// its `copied` form for the second after a click) and its action row by the
// locale-independent `data-clock` marker; the row's own class names are
// per-build hashes and are never used.
const PROMPT_COPY_TEXT = /复制|cop(y|ied)/i
const PROMPT_ROW_SELECTOR = '[data-clock]'
const PROMPT_OFFICIAL_SELECTOR = '[data-slot="conversation.chat.node"]'
// The official body of one message, never the card chrome: the host marks a card
// body with `data-context-text`, and everything that is chrome (clock, actions,
// buttons, the card title/time/chevron, the card's explanation line) is either
// inside `data-clock` or one of the element kinds below.
const PROMPT_BODY_SELECTOR = '[data-context-text="true"]'
const PROMPT_CHROME_SELECTOR = '[data-clock],button,time,svg,style,script,[aria-hidden="true"]'
// Only the single-glyph ellipsis a body clipped by the host ends with: three
// ASCII dots are ordinary message content.
const PROMPT_CLIPPED_MARK = /(?:…|⋯)\s*$/
/* A collapsed turn card renders its header only, so its body is not in the DOM. */
const PROMPT_CARD_COLLAPSED_SELECTOR = '[data-turn-trigger] [aria-expanded="false"]'
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
  limited: boolean
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

// Text of the official rendering only: our own elements are skipped. A card body
// carries the host's own mark; a plain user bubble has none, so its longest
// chrome-free leaf stands in for it. The node's concatenated text is never used,
// because that is what would append the card title, its clock, the explanation
// line and the action labels to the message body.
const promptChromeNode = (el: Element) => el.matches(PROMPT_CHROME_SELECTOR) || promptIsOurs(el)

const promptTextClipped = (text: string) => PROMPT_CLIPPED_MARK.test(text)

const promptCollapsedCard = (node: Element) => Boolean(node.querySelector(PROMPT_CARD_COLLAPSED_SELECTOR))

// The text of one subtree with every chrome descendant dropped: skipping an
// element is not enough, because `textContent` would still pull in the chrome
// below it (a collapsed card's header holds both its title and its clock).
const promptTextOf = (el: Element) => {
  let out = ''
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out += node.nodeValue || ''
      return
    }
    if (!(node instanceof Element)) return
    if (promptChromeNode(node)) return
    for (const child of Array.from(node.childNodes)) walk(child)
  }
  walk(el)
  return out
}

const promptLongestLeafText = (root: Element) => {
  let best = ''
  const visit = (node: Node) => {
    if (!(node instanceof Element)) return
    if (promptChromeNode(node)) return
    let branch = false
    for (const child of Array.from(node.children)) {
      if (!promptChromeNode(child)) branch = true
    }
    if (!branch) {
      const text = promptTextOf(node)
      if (text.trim().length > best.trim().length) best = text
      return
    }
    for (const child of Array.from(node.children)) visit(child)
  }
  for (const child of Array.from(root.children)) visit(child)
  return best
}

const promptOfficialText = (node: Element) => {
  for (const el of Array.from(node.querySelectorAll(PROMPT_BODY_SELECTOR))) {
    if (promptIsOurs(el)) continue
    const text = el.textContent || ''
    if (text.trim()) return text
  }
  return promptLongestLeafText(node)
}

const promptIsOurs = (el: Element) => el.hasAttribute(PROMPT_BLOCK_ATTR) || el.hasAttribute(PROMPT_TRIGGER_ATTR)

const promptButtonLabel = (button: Element) => String(button.getAttribute('aria-label') || '') + ' ' + String(button.getAttribute('title') || '')

// The official copy button of one message, or null when the host renders no
// action row at all (an older turn card, a host without the row).
const promptCopyButton = (node: Element) => {
  const buttons = Array.from(node.querySelectorAll('button')).filter(button => !promptIsOurs(button))
  for (const button of buttons) {
    if (PROMPT_COPY_TEXT.test(promptButtonLabel(button))) return button
  }
  return null
}

// Where the compact trigger goes: right after the official copy button; inside
// the same action row when only the row is recognizable; otherwise appended to
// the official node itself so the position never depends on the state.
const promptActionAnchor = (node: Element) => {
  const copy = promptCopyButton(node)
  if (copy) return copy
  const row = node.querySelector(PROMPT_ROW_SELECTOR)
  if (!row) return null
  const buttons = Array.from(row.querySelectorAll('button')).filter(button => !promptIsOurs(button))
  return buttons.length ? buttons[buttons.length - 1] : row
}

// Relabel one trigger; only the raw state shows it, so the button can never sit
// next to a dead fold control.
export const promptApplyTrigger = (trigger: Element, tr: Tr) => {
  const key = trigger.getAttribute('data-dsh-sam-prompt-key') || ''
  const state = promptMode.get(key) === PROMPT_MODE_RAW ? PROMPT_MODE_RAW : PROMPT_MODE_RENDERED
  trigger.setAttribute('data-dsh-sam-prompt-state', state)
  trigger.classList.toggle(PROMPT_TRIGGER_ON_CLASS, state === PROMPT_MODE_RAW)
  const label = tr('prompt.previewAria')
  if (trigger.textContent !== tr('prompt.preview')) trigger.textContent = tr('prompt.preview')
  if (trigger.getAttribute('aria-label') !== label) trigger.setAttribute('aria-label', label)
  if (trigger.getAttribute('title') !== label) trigger.setAttribute('title', label)
}

// The official row child that holds the copy affordance: the button may sit
// inside a tooltip/skin wrapper, and the trigger must land next to that whole
// group as a direct child of the action row, never inside the wrapper.
const promptRowChild = (node: Element, el: Element) => {
  const row = node.querySelector(PROMPT_ROW_SELECTOR)
  if (!row) return null
  let current: Element | null = el
  while (current && current.parentElement && current.parentElement !== row) current = current.parentElement
  if (!current || current.parentElement !== row) return null
  return current
}

const promptTriggerFor = (key: string, node: Element, tr: Tr) => {
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = PROMPT_TRIGGER_CLASS
  trigger.setAttribute(PROMPT_TRIGGER_ATTR, '')
  trigger.setAttribute('data-dsh-sam-prompt-key', key)
  promptApplyTrigger(trigger, tr)
  trigger.addEventListener('mousedown', event => event.stopPropagation())
  trigger.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    promptSetMode(key, PROMPT_MODE_RENDERED, tr)
  })
  const anchor = promptActionAnchor(node)
  const rowChild = anchor ? promptRowChild(node, anchor) : null
  if (rowChild) rowChild.after(trigger)
  else if (anchor && anchor.tagName === 'BUTTON') anchor.after(trigger)
  else if (anchor) anchor.appendChild(trigger)
  else {
    const official = node.querySelector(PROMPT_OFFICIAL_SELECTOR)
    if (official) official.appendChild(trigger)
    else node.appendChild(trigger)
  }
  return trigger
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
  if (!spec.text) {
    wrapper.setAttribute('data-dsh-sam-prompt-kind', 'notice')
    wrapper.setAttribute('data-dsh-sam-prompt-state', 'notice')
    const note = document.createElement('span')
    note.className = 'dsh-sam-prompt-notice'
    note.textContent = spec.notice || tr('prompt.unavailable')
    wrapper.appendChild(note)
    promptApplyState(wrapper, spec.tr)
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
  wrapper.setAttribute('data-dsh-sam-prompt-limited', spec.limited ? 'true' : 'false')
  /* Attachments live in the official node; there we never hide it. */
  wrapper.setAttribute('data-dsh-sam-prompt-hide-official', spec.textOnly ? 'true' : 'false')
  // The toolbar only ever exists inside the rendered block, so switching back to
  // the raw text removes it together with the block: nothing can jump or go dead.
  const raw = document.createElement('button')
  raw.type = 'button'
  raw.className = 'dsh-sam-prompt-tab'
  raw.setAttribute('data-dsh-sam-prompt-mode', PROMPT_MODE_RAW)
  raw.title = tr('prompt.toggleAria')
  raw.textContent = tr('prompt.raw')
  bar.appendChild(raw)
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
    wrapper.appendChild(cut)
  }
  if (spec.limited) {
    const clipped = document.createElement('span')
    clipped.className = 'dsh-sam-prompt-cut dsh-sam-prompt-limited'
    clipped.textContent = tr('prompt.limited')
    wrapper.appendChild(clipped)
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
  return [kind, spec.source, spec.text.length, text, spec.textOnly ? 't' : 'm', spec.limited ? 'c' : '', spec.notice, spec.head, spec.tr('prompt.raw')].join('|')
}

// Apply one node's state to one block: block visibility, official-node
// visibility, the fold label and the in-block toolbar labels. Pure DOM, no React
// state. Only the rendered state keeps the block on screen, so the raw state can
// never show a toolbar whose fold control has nothing left to fold.
export const promptApplyState = (block: Element, tr: Tr) => {
  const key = block.getAttribute('data-dsh-sam-prompt-key') || ''
  const state = promptMode.get(key) === PROMPT_MODE_RAW ? PROMPT_MODE_RAW : PROMPT_MODE_RENDERED
  const rendered = state === PROMPT_MODE_RENDERED
  block.setAttribute('data-dsh-sam-prompt-state', state)
  block.classList.toggle(PROMPT_BLOCK_HIDDEN_CLASS, !rendered)
  const body = block.querySelector('[data-dsh-sam-prompt-body]')
  if (body) {
    const foldable = block.getAttribute('data-dsh-sam-prompt-foldable') === 'true'
    const folded = foldable && !promptUnfolded.has(key)
    body.classList.toggle('dsh-sam-prompt-body-hidden', !rendered)
    body.classList.toggle('dsh-sam-prompt-folded', folded)
    const fold = block.querySelector('[data-dsh-sam-prompt-fold]')
    if (fold) fold.textContent = folded ? tr('prompt.expand') : tr('prompt.collapse')
  }
  const tab = block.querySelector('[data-dsh-sam-prompt-mode="' + PROMPT_MODE_RAW + '"]')
  if (tab) tab.textContent = tr('prompt.raw')
  const attachPoint = block.parentElement
  if (!attachPoint) return
  const hide = rendered && block.getAttribute('data-dsh-sam-prompt-hide-official') === 'true'
  for (const child of Array.from(attachPoint.children)) {
    if (child === block || promptIsOurs(child)) continue
    child.classList.toggle(PROMPT_HIDE_CLASS, hide)
  }
  for (const trigger of Array.from(attachPoint.querySelectorAll('[' + PROMPT_TRIGGER_ATTR + ']'))) {
    if (trigger.getAttribute('data-dsh-sam-prompt-key') === key) promptApplyTrigger(trigger, tr)
  }
}

// One key can be mounted twice (main pane and the stock sidebar chat tab), so a
// state change is broadcast to every block and every trigger carrying that key.
export const promptRefreshKey = (key: string, tr: Tr) => {
  const blocks = document.querySelectorAll('[' + PROMPT_BLOCK_ATTR + ']')
  for (const block of Array.from(blocks)) {
    if (block.getAttribute('data-dsh-sam-prompt-key') !== key) continue
    promptApplyState(block, tr)
  }
  const triggers = document.querySelectorAll('[' + PROMPT_TRIGGER_ATTR + ']')
  for (const trigger of Array.from(triggers)) {
    if (trigger.getAttribute('data-dsh-sam-prompt-key') !== key) continue
    promptApplyTrigger(trigger, tr)
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
  const triggers = new Map<string, Element>()
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
    for (const trigger of Array.from(triggers.values())) if (trigger.parentNode) trigger.parentNode.removeChild(trigger)
    triggers.clear()
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
    // Every durable surface `user/message` in the window, whatever its
    // `source.kind`: a context injection (relay / plugin / recall) is a real
    // node with real text, and leaving it out was what turned the older turn
    // cards of a long session into "cannot preview". A node with no record here
    // is the genuinely missing case, and only that one reads the DOM.
    const records = promptMessagesFromWindow(win)
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
      let limited = false
      let notice = ''
      if (message) {
        text = message.text
        textOnly = message.textOnly && !promptNodeIsCard(node)
      } else {
        // No event for this node: the window is a tail page that starts after this
        // message, or the conversation has no feed at all. The official node still
        // renders the body (an expanded turn card keeps it in the DOM), so read it
        // there instead of reporting the message as unavailable; only an empty
        // read is reported as a notice.
        const dom = promptOfficialText(node)
        if (dom.trim()) {
          text = dom
          sourceKind = 'dom'
          limited = promptTextClipped(text)
          textOnly = !node.querySelector('img') && !promptNodeIsCard(node)
        } else if (promptCollapsedCard(node)) {
          // The body is hidden behind the card's own disclosure, so the notice
          // names the way back to it instead of claiming the text is missing.
          notice = tr('prompt.expandCard')
        } else {
          notice = paged ? tr('prompt.notLoaded') : tr('prompt.unavailable')
        }
      }
      const head = text && headPending ? tr('prompt.notLoaded') : ''
      if (text) headPending = false
      const spec = { key, tr, text, source: sourceKind, textOnly, limited, notice, head }
      const signature = promptBlockSignature(spec)
      // The trigger is anchored to the official action row once and then only
      // relabelled, so its position is byte-stable across every state change.
      const trigger = triggers.get(key)
      if (trigger && trigger.parentNode) promptApplyTrigger(trigger, tr)
      else triggers.set(key, promptTriggerFor(key, node, tr))
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
    for (const key of Array.from(triggers.keys())) {
      if (seen.has(key)) continue
      const trigger = triggers.get(key)
      if (trigger && trigger.parentNode) trigger.parentNode.removeChild(trigger)
      triggers.delete(key)
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
        if (child === block || promptIsOurs(child)) continue
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
