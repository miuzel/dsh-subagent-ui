#!/usr/bin/env node
// Verify that the generated lib/client.js is equivalent to the hand-written
// pre-refactor bundle, allowing only insignificant whitespace differences
// (blank lines, indentation, trailing spaces, type-erasure padding).
//
//   node scripts/verify-build.mjs [git-ref]     (default ref: v1.3.4)
//
// Check 1 (token stream): both sides are lexed; whitespace and comments
// outside string/template/regex literals are dropped, and the resulting token
// texts must be identical. This is the semantic guarantee.
// Check 2 (line stream): both sides are compared line-by-line after trimming
// and dropping blank lines. This is the strict, human-readable guarantee and
// should also pass for this refactor.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const ref = process.argv[2] || 'v1.3.4'
const golden = execFileSync('git', ['show', `${ref}:lib/client.js`], { encoding: 'utf8', maxBuffer: 1 << 26 })
const built = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/* ------------------------------------------------------------------ */
/* Minimal JS lexer: emits token texts with whitespace/comments removed */
/* outside literals. Both sides are lexed identically, so only real     */
/* differences surface.                                                 */
/* ------------------------------------------------------------------ */

const ID_START = /[$A-Za-z_]/
const ID_PART = /[$\w]/
const REGEX_ALLOWED_AFTER = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
])

function lex(src) {
  const tokens = []
  let i = 0
  const n = src.length
  let prev = null // previous significant token text
  const push = t => { tokens.push(t); prev = t }

  const readString = quote => {
    const start = i++
    while (i < n) {
      const c = src[i]
      if (c === '\\') { i += 2; continue }
      i++
      if (c === quote) break
    }
    push(src.slice(start, i))
  }

  const readTemplate = () => {
    // Lex a template literal as text-chunk tokens plus interpolated
    // expressions (lexed normally via recursion on the main loop state).
    const start = i++
    let out = '`'
    while (i < n) {
      const c = src[i]
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue }
      if (c === '`') { i++; out += '`'; push(out); return }
      if (c === '$' && src[i + 1] === '{') {
        i += 2
        let depth = 1
        const exprStart = i
        while (i < n && depth > 0) {
          const ch = src[i]
          if (ch === '{') depth++
          else if (ch === '}') depth--
          if (depth === 0) break
          if (ch === "'" || ch === '"' || ch === '`') {
            // skip nested literal inside the interpolation
            const q = ch
            i++
            while (i < n) {
              if (src[i] === '\\') { i += 2; continue }
              if (src[i] === q) { i++; break }
              if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
                // nested template: skip its interpolation braces naively
                i++
              }
              i++
            }
            continue
          }
          i++
        }
        const expr = src.slice(exprStart, i)
        i++ // consume '}'
        out += '${' /* expression lexed separately below */ + '}'
        // Emit chunk so far, then lex the expression recursively, then continue.
        push(out)
        for (const t of lex(expr)) push(t)
        out = ''
        // reopening chunk continues after '}' — mark with a synthetic opener
        // so text after the interpolation is still compared byte-exactly.
        const resume = i
        out = src.slice(resume, resume) // ''
        continue
      }
      out += c
      i++
    }
    push(out)
  }

  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') { i++; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue }
    if (c === "'") { readString("'"); continue }
    if (c === '"') { readString('"'); continue }
    if (c === '`') { readTemplate(); continue }
    if (c === '/') {
      const regexAllowed = prev === null ||
        (!ID_PART.test(prev[prev.length - 1]) && prev !== ')' && prev !== ']' && prev !== '}') ||
        REGEX_ALLOWED_AFTER.has(prev)
      if (regexAllowed) {
        const start = i++
        let inClass = false
        while (i < n) {
          const ch = src[i]
          if (ch === '\\') { i += 2; continue }
          if (ch === '[') inClass = true
          else if (ch === ']') inClass = false
          else if (ch === '/' && !inClass) { i++; break }
          else if (ch === '\n') break // not a regex after all; bail out
          i++
        }
        while (i < n && /[a-z]/.test(src[i])) i++ // flags
        push(src.slice(start, i))
        continue
      }
      push('/'); i++; continue
    }
    if (ID_START.test(c)) {
      const start = i++
      while (i < n && ID_PART.test(src[i])) i++
      push(src.slice(start, i))
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const start = i++
      while (i < n && /[\w.]/.test(src[i])) i++
      push(src.slice(start, i))
      continue
    }
    push(c); i++
  }
  return tokens
}

function diffTokens(a, b) {
  const len = Math.max(a.length, b.length)
  const diffs = []
  for (let k = 0; k < len; k++) {
    if (a[k] !== b[k]) {
      diffs.push({ index: k, golden: a[k], built: b[k] })
      if (diffs.length >= 10) break
    }
  }
  return diffs
}

/* ---------------- line-level comparison ---------------- */

const toLines = s => s.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0)
const goldenLines = toLines(golden)
const builtLines = toLines(built)
const lineDiffs = []
for (let k = 0; k < Math.max(goldenLines.length, builtLines.length); k++) {
  if (goldenLines[k] !== builtLines[k]) {
    lineDiffs.push({ index: k + 1, golden: goldenLines[k], built: builtLines[k] })
    if (lineDiffs.length >= 10) break
  }
}

/* ---------------- report ---------------- */

let failed = false
const goldenTokens = lex(golden)
const builtTokens = lex(built)
const tokenDiffs = diffTokens(goldenTokens, builtTokens)

if (tokenDiffs.length === 0 && goldenTokens.length === builtTokens.length) {
  console.log(`token stream: OK (${goldenTokens.length} tokens identical)`)
} else {
  failed = true
  console.error(`token stream: MISMATCH (${goldenTokens.length} golden vs ${builtTokens.length} built tokens)`)
  for (const d of tokenDiffs) {
    console.error(`  #${d.index}\n    golden: ${JSON.stringify(d.golden)?.slice(0, 200)}\n    built:  ${JSON.stringify(d.built)?.slice(0, 200)}`)
  }
}

if (lineDiffs.length === 0 && goldenLines.length === builtLines.length) {
  console.log(`line stream:  OK (${goldenLines.length} non-blank lines identical after trim)`)
} else {
  failed = true
  console.error(`line stream:  MISMATCH (${goldenLines.length} golden vs ${builtLines.length} built lines)`)
  for (const d of lineDiffs) {
    console.error(`  line #${d.index}\n    golden: ${d.golden?.slice(0, 200)}\n    built:  ${d.built?.slice(0, 200)}`)
  }
}

if (failed) {
  console.error(`\nverify-build FAILED against ${ref}:lib/client.js`)
  process.exit(1)
}
console.log(`verify-build OK: lib/client.js matches ${ref}:lib/client.js up to insignificant whitespace`)
