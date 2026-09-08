#!/usr/bin/env node
// Build lib/client.js from the TypeScript modules in src/client/.
//
// Pipeline per module: sucrase (`typescript` transform, ES transforms disabled
// so modern syntax is preserved byte-for-byte) -> drop relative import lines
// -> drop `export ` prefixes -> concatenate in the ORIGINAL bundle order ->
// wrap in the DSH module-loader factory -> syntax-check the result.
//
// The modules are authored so the emitted bundle is byte-identical to the
// hand-written pre-refactor lib/client.js except for insignificant whitespace
// (blank lines, indentation, type-erasure padding). scripts/verify-build.mjs
// proves this against the git ref that shipped the hand-written bundle.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { transform } from 'sucrase'

// Concatenation order mirrors the original bundle layout exactly. Do not
// reorder: cross-module references resolve by scope position at runtime.
const MODULES = [
  'types',        // types-only: erases to nothing, kept for syntax validation
  'styles',       // const css = `...`
  'bootstrap',    // style injection, DAY/PAGE/key/defaultTabs, DEFAULT_*_BG, load
  'format',       // age/title/short/workspace/modeLabel/tokenTotal/fmt/promptPreview/statsLine/category/rootSession/modeMap/highlight
  'runtime',      // sessionsRt, NOOP
  'live-output',  // LiveOutput
  'detail',       // elapsed, compactPath, toolDetail
  'live-events',  // liveFromEvents
  'active-float', // ActiveFloat
  'manager',      // Manager
  'i18n',         // NS, zh, en
  'apply',        // apply
]

const HEADER = `window.__ModuleLoader__.load({
  id: 'dsh-subagent-workspace-ui',
  factory: (require) => {
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
`

const FOOTER = `    return {inject:['sessions','slots','locale'],apply}
  }
})
`

// Relative imports exist only for module wiring; they dissolve at link time.
// Import statements are single-line by project convention.
const IMPORT_LINE = /^import\s.*\sfrom\s*['"]\.[^'"]*['"];?$/
// `export ` prefixes exist only for module wiring; declarations survive.
const EXPORT_PREFIX = /^export (?=(?:async )?(?:const|let|var|function|class)\b)/
// Full-line comments are documentation for the TS sources; the emitted bundle
// stays comment-free like the hand-written original. (Source convention:
// comments only on their own lines, never inside the css template literal.)
const COMMENT_LINE = /^(\/\/|\/\*|\*)/

const bodies = []
for (const name of MODULES) {
  const url = new URL(`../src/client/${name}.ts`, import.meta.url)
  const source = readFileSync(url, 'utf8')
  const { code } = transform(source, { transforms: ['typescript'], disableESTransforms: true })
  const linked = code
    .split('\n')
    .filter(line => !IMPORT_LINE.test(line.trim()) && !COMMENT_LINE.test(line.trim()))
    .map(line => line.replace(EXPORT_PREFIX, ''))
    .join('\n')
  if (linked.trim()) bodies.push(linked.replace(/^\n+|\n+$/g, ''))
}

// Blank lines are insignificant in the emitted bundle; collapse the seams.
// (No template literal in the sources contains an empty line.)
const body = bodies.join('\n\n').replace(/\n{3,}/g, '\n\n')
const out = HEADER + body + '\n' + FOOTER

writeFileSync(new URL('../lib/client.js', import.meta.url), out)
execFileSync(process.execPath, ['--check', 'lib/client.js'], { stdio: 'inherit' })
console.log(`built lib/client.js (${out.length} bytes) from ${MODULES.length} modules`)
