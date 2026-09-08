#!/usr/bin/env node
// Bundle freshness gate for `pnpm run check`.
//
// Fails only when the COMMITTED bundle is stale: the sources are unchanged
// vs HEAD, yet a rebuild just produced a different lib/client.js — meaning a
// previous commit updated the sources without rebuilding and committing the
// bundle. During development (sources dirty vs HEAD) any bundle difference
// is expected and passes. Not a git repo / no HEAD -> skipped.
import { execFileSync } from 'node:child_process'

const dirty = paths => {
  try {
    return execFileSync('git', ['status', '--porcelain', '--', ...paths], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const sourcesDirty = dirty(['src', 'scripts'])
const bundleDirty = dirty(['lib/client.js'])

if (!sourcesDirty && bundleDirty) {
  console.error('lib/client.js is stale: the sources are unchanged but the rebuilt bundle differs.')
  console.error('Run `pnpm run build` and commit lib/client.js together with the sources.')
  process.exit(1)
}
if (!sourcesDirty && !bundleDirty) console.log('bundle freshness: OK (in sync with committed sources)')
else if (sourcesDirty && bundleDirty) console.log('bundle freshness: OK (uncommitted source + bundle changes — expected during development)')
else console.log('bundle freshness: OK (source-only changes that do not affect the bundle)')
