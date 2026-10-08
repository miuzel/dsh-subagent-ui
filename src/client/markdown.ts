// Lightweight markdown renderer for the subagent prompt preview (g-023).
//
// Deliberately self-contained: no third-party markdown library, and no HTML
// string ever reaches the page. Every leaf is built with
// `document.createTextNode` or a `textContent` assignment, so a prompt holding
// `<script>`, `<img onerror=…>` or `[x](javascript:alert(1))` can only ever
// produce text nodes plus the small closed set of elements created here. That is
// the same guarantee React's text children give; it is reproduced directly
// because the module-loader wrapper hands out `react` and `react/jsx-runtime`
// only, so there is no ReactDOM to mount an injected block with.
//
// Covered: ATX headings, unordered/ordered lists (nested), bold/italic, inline
// code, fenced code blocks with a language label, blockquotes (nested),
// thematic breaks, paragraphs, and links that resolve to http(s) or a relative
// path. Everything else — tables, images, setext headings, autolinks,
// strikethrough, raw HTML — degrades to the literal text it was written as.

/* Fold above this many characters or lines; the preview then scrolls. */
export const PROMPT_FOLD_CHARS = 2000
export const PROMPT_FOLD_LINES = 40
/* Hard ceiling on what is turned into DOM at all (an explicit, visible cap). */
export const PROMPT_RENDER_MAX_CHARS = 200000
/* Inline nesting depth guard: an adversarial `**`-run must not recurse away. */
export const PROMPT_MAX_INLINE_DEPTH = 8
/* A link target longer than this is not worth an anchor (and stays text). */
export const PROMPT_MAX_HREF_CHARS = 2048

// Block starts. Kept as module-level regexes: they run once per source line.
const PROMPT_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^ \t`]*)[^\n]*$/
const PROMPT_HEAD_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const PROMPT_RULE_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const PROMPT_ITEM_RE = /^([ \t]*)(?:([-*+])|([0-9]{1,9})([.)]))[ \t]+(.*)$/
const PROMPT_QUOTE_RE = /^ {0,3}>[ ]?(.*)$/
const PROMPT_CONT_RE = /^([ \t]*)(.*)$/

// Inline spans. Order matters: code and strong win before emphasis.
const PROMPT_CODE_RE = /^`([^`\n]*)`/
const PROMPT_STRONG_RE = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/
const PROMPT_EM_RE = /^(\*|_)(?=\S)([\s\S]*?\S)\1/
const PROMPT_LINK_RE = /^\[([^\]\n]*)\]\(([^()\n\s]*)\)/

const promptLead = (line: string) => {
  const hit = PROMPT_CONT_RE.exec(line)
  return hit ? hit[1].replace(/\t/g, '    ').length : 0
}

// A fenced block closes on the same marker character, at least as long.
const promptFenceEnd = (line: string, mark: string) => {
  const hit = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
  return Boolean(hit) && hit[1][0] === mark[0] && hit[1].length >= mark.length
}

const promptBlockStart = (line: string) =>
  PROMPT_FENCE_RE.test(line) || PROMPT_HEAD_RE.test(line) || PROMPT_RULE_RE.test(line) || PROMPT_ITEM_RE.test(line) || PROMPT_QUOTE_RE.test(line)

// Only http(s) and relative targets become anchors. Every other scheme —
// javascript:, data:, vbscript:, blob:, file:, mailto: — stays literal text,
// and a protocol-relative `//host` is refused as well.
export const promptSafeHref = (raw: string) => {
  const url = String(raw || '').trim()
  if (!url || url.length > PROMPT_MAX_HREF_CHARS) return ''
  if (url.startsWith('//')) return ''
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url)
  if (scheme) return /^https?$/i.test(scheme[1]) ? url : ''
  return url
}

// One inline pass. Unmatched markers are buffered back out as text, so an
// unclosed `**` or a dangerous link renders exactly as written.
export const promptInlineInto = (target: Node, text: string, depth: number) => {
  if (depth > PROMPT_MAX_INLINE_DEPTH) {
    target.appendChild(document.createTextNode(text))
    return
  }
  let buffer = ''
  const flush = () => {
    if (!buffer) return
    target.appendChild(document.createTextNode(buffer))
    buffer = ''
  }
  let index = 0
  while (index < text.length) {
    const rest = text.slice(index)
    const code = PROMPT_CODE_RE.exec(rest)
    if (code) {
      flush()
      const node = document.createElement('code')
      node.className = 'dsh-sam-prompt-icode'
      node.textContent = code[1]
      target.appendChild(node)
      index += code[0].length
      continue
    }
    const strong = PROMPT_STRONG_RE.exec(rest)
    if (strong) {
      const strongBefore = index > 0 ? text[index - 1] : ''
      const strongAfter = text[index + strong[0].length] || ''
      const strongInWord = strong[1] === '__' && (/[0-9A-Za-z_]/.test(strongBefore) || /[0-9A-Za-z_]/.test(strongAfter))
      if (!strongInWord) {
        flush()
        const node = document.createElement('strong')
        promptInlineInto(node, strong[2], depth + 1)
        target.appendChild(node)
        index += strong[0].length
        continue
      }
    }
    const em = PROMPT_EM_RE.exec(rest)
    if (em) {
      const before = index > 0 ? text[index - 1] : ''
      const after = text[index + em[0].length] || ''
      const insideWord = em[1] === '_' && (/[0-9A-Za-z_]/.test(before) || /[0-9A-Za-z_]/.test(after))
      if (!insideWord) {
        flush()
        const node = document.createElement('em')
        promptInlineInto(node, em[2], depth + 1)
        target.appendChild(node)
        index += em[0].length
        continue
      }
    }
    const link = PROMPT_LINK_RE.exec(rest)
    if (link) {
      const href = promptSafeHref(link[2])
      if (href) {
        flush()
        const anchor = document.createElement('a')
        anchor.className = 'dsh-sam-prompt-link'
        anchor.href = href
        anchor.target = '_blank'
        anchor.rel = 'noopener noreferrer nofollow'
        anchor.textContent = link[1]
        target.appendChild(anchor)
        index += link[0].length
        continue
      }
    }
    buffer += text[index]
    index += 1
  }
  flush()
}

// One block element for one fenced block, language label included.
const promptCodeBlock = (lines: string[], lang: string) => {
  const wrap = document.createElement('div')
  wrap.className = 'dsh-sam-prompt-code'
  if (lang) {
    const label = document.createElement('span')
    label.className = 'dsh-sam-prompt-code-lang'
    label.textContent = lang
    wrap.appendChild(label)
  }
  const pre = document.createElement('pre')
  pre.className = 'dsh-sam-prompt-pre'
  const code = document.createElement('code')
  code.textContent = lines.join('\n')
  pre.appendChild(code)
  wrap.appendChild(pre)
  return wrap
}

// Block pass. A small list stack gives nested lists; every other block lands in
// the innermost open item, so a fence or a quote inside a list item stays there.
export const promptBlocksInto = (target: Node, text: string) => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const stack: { indent: number; ordered: boolean; list: Element; item: Element }[] = []
  const container = () => (stack.length ? stack[stack.length - 1].item : target)
  const closeFor = (indent: number, orEqual: boolean) => {
    while (stack.length && (orEqual ? indent <= stack[stack.length - 1].indent : indent < stack[stack.length - 1].indent)) stack.pop()
  }
  const openList = (ordered: boolean, start: string, indent: number) => {
    const host = container()
    const list = document.createElement(ordered ? 'ol' : 'ul')
    list.className = 'dsh-sam-prompt-list'
    if (ordered && start !== '1') list.setAttribute('start', start)
    host.appendChild(list)
    stack.push({ indent, ordered, list, item: list })
    return stack[stack.length - 1]
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i += 1
      continue
    }
    const indent = promptLead(line)
    const fence = PROMPT_FENCE_RE.exec(line)
    if (fence) {
      closeFor(indent, true)
      const mark = fence[1]
      const body: string[] = []
      i += 1
      while (i < lines.length && !promptFenceEnd(lines[i], mark)) {
        body.push(lines[i])
        i += 1
      }
      i += 1
      container().appendChild(promptCodeBlock(body, fence[2]))
      continue
    }
    const head = PROMPT_HEAD_RE.exec(line)
    if (head) {
      closeFor(indent, true)
      const level = head[1].length
      const node = document.createElement('div')
      node.className = 'dsh-sam-prompt-h dsh-sam-prompt-h' + level
      node.setAttribute('role', 'heading')
      node.setAttribute('aria-level', String(level))
      promptInlineInto(node, head[2], 0)
      container().appendChild(node)
      i += 1
      continue
    }
    if (PROMPT_RULE_RE.test(line)) {
      closeFor(indent, true)
      const rule = document.createElement('hr')
      rule.className = 'dsh-sam-prompt-rule'
      container().appendChild(rule)
      i += 1
      continue
    }
    const quote = PROMPT_QUOTE_RE.exec(line)
    if (quote) {
      closeFor(indent, true)
      const inner: string[] = []
      while (i < lines.length) {
        const hit = PROMPT_QUOTE_RE.exec(lines[i])
        if (hit) {
          inner.push(hit[1])
          i += 1
          continue
        }
        if (!lines[i].trim()) {
          let next = i
          while (next < lines.length && !lines[next].trim()) next += 1
          if (next < lines.length && PROMPT_QUOTE_RE.test(lines[next])) {
            inner.push('')
            i = next
            continue
          }
        }
        break
      }
      const node = document.createElement('blockquote')
      node.className = 'dsh-sam-prompt-quote'
      promptBlocksInto(node, inner.join('\n'))
      container().appendChild(node)
      continue
    }
    const item = PROMPT_ITEM_RE.exec(line)
    if (item) {
      const ordered = item[3] !== undefined
      closeFor(indent, false)
      const top = stack.length ? stack[stack.length - 1] : null
      if (!top || indent > top.indent || top.ordered !== ordered) {
        if (top && indent <= top.indent && top.ordered !== ordered) stack.pop()
        openList(ordered, ordered ? item[3] : '', indent)
      }
      const frame = stack[stack.length - 1]
      const li = document.createElement('li')
      li.className = 'dsh-sam-prompt-li'
      promptInlineInto(li, item[5], 0)
      frame.list.appendChild(li)
      frame.item = li
      i += 1
      continue
    }
    closeFor(indent, true)
    const para: string[] = []
    while (i < lines.length) {
      const next = lines[i]
      if (!next.trim() || promptBlockStart(next)) break
      para.push(next)
      i += 1
    }
    const node = document.createElement('div')
    node.className = 'dsh-sam-prompt-p'
    promptInlineInto(node, para.join('\n'), 0)
    container().appendChild(node)
  }
}

// Build the whole preview body. Returns the number of characters dropped by the
// hard cap (0 when the source was rendered in full) so the caller can say so.
export const promptBodyInto = (target: Node, source: string) => {
  const text = source || ''
  const kept = text.length > PROMPT_RENDER_MAX_CHARS ? text.slice(0, PROMPT_RENDER_MAX_CHARS) : text
  promptBlocksInto(target, kept)
  return text.length - kept.length
}
