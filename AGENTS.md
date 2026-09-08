# AGENTS.md

## Project overview

`dsh-subagent-workspace-ui` is a DeepSeek Harness Web client plugin. It adds a Chinese-labeled subagent manager to the conversation header, with search, workspace/session scope, sorting, grouping, local classification tabs, archive/restore controls, batch selection, and active-child live status when the runtime exposes it.

The package is ESM (`"type": "module"`) and publishes the `lib/` directory. Its package entry is `lib/index.js`; its client export is `lib/client.js`. The package declares `@deepseek-ai/cordis` `^4.0.1` as a peer dependency and uses DSH client injection declarations in `package.json`.

Since v1.4.0 the client bundle is **generated from TypeScript sources**: `lib/client.js` is built from `src/client/*.ts` by `scripts/build.mjs` and must never be edited directly.

## Common commands

Run commands from the repository root.

### Install / use in DSH Web

```bash
dsh plugin --profile web add file:.
```

After the plugin is available, restart the existing `dsh web` process and refresh `http://127.0.0.1:3080`.

### Validation

```bash
pnpm run check
```

`check` rebuilds `lib/client.js` from the TypeScript sources (`scripts/build.mjs`, which also runs `node --check` on the bundle), runs `tsc --noEmit` on `src/client`, runs `node --check` on `lib/index.js`, and finally runs the bundle-freshness gate (`scripts/verify-fresh.mjs`, which fails only when the sources are unchanged vs HEAD but the rebuilt bundle differs — i.e. a stale committed bundle). Individual steps: `pnpm run build`, `pnpm run verify:build`, `pnpm run typecheck`.

The golden comparison in `verify:build` defaults to git ref `v1.3.4` (the last hand-written bundle). It is the one-time migration proof that the TypeScript rewrite did not alter behavior, and afterwards a delta viewer: any intentional behavior change shows up as the exact token/line differences (the first post-migration example is the `scopeKey` → `workspaceKey` latent-bug fix). Pass another ref as `node scripts/verify-build.mjs <ref>` if needed.

### Publish

The project owner publishes releases manually:

```bash
npm publish --access public
```

Confirm the package version in `package.json` and complete npm 2FA when prompted.

### Release discipline (default after every release)

After each feature/fix set is tested and you are asked to release, follow this order:

1. On the current dev branch: bump `package.json` version and update the release notes (README.zh.md release-notes block at the top, and a short `## vX.Y.Z` section in README.md).
2. Run `node --check` on both lib files for syntax.
3. Merge the dev branch into `main` (fast-forward when `main` has not diverged).
4. Create an annotated tag on `main` at the release commit, e.g. `git tag -a vX.Y.Z -m "Release vX.Y.Z"`.
5. **Clean up the old dev branch** and **create the next dev branch** from `main`, e.g. `git checkout -b vNext-dev` then `git branch -d <old-dev>`. This is the standing discipline: every release ends with a fresh dev branch off `main` and the old one removed.

`pnpm publish` git-checks only require a clean working tree (not a tagged HEAD); a stray generated `pnpm-lock.yaml` is gitignored so it does not dirty the tree.

### Smoke run

```bash
./test.sh [PORT]
```

The script sets `DSH_HOME="$HOME/tmp/dsh-test"`, removes and re-adds this local plugin to the Web profile, then starts `dsh web --port ${PORT:-8084}` (defaults to port 8084 if omitted). It is an environment-dependent smoke setup, not a unit-test runner.

### Build / test / lint

There is no project-defined `test` or `lint` script and no test or lint configuration in the repository. The build step is `pnpm run build` (sucrase type-erasure plus a deterministic linker in `scripts/build.mjs`); the checked-in client bundle `lib/client.js` is its output. `pnpm run check` performs full validation (build + `tsc --noEmit` + `node --check lib/index.js` + bundle freshness).

## Code style and conventions

- Use ECMAScript modules. `lib/index.js` uses `export` and the package is explicitly marked as ESM.
- Match the existing semicolon-free JavaScript style and two-space indentation where code is formatted across lines.
- Keep the host entry (`lib/index.js`) minimal; the UI is loaded through the package `dsh.client` declaration.
- The client bundle is generated: edit `src/client/*.ts`, never `lib/client.js`, then run `pnpm run build`. The bundle is a DSH module-loader module: `scripts/build.mjs` erases types with sucrase (`disableESTransforms`), dissolves the single-line relative imports and `export ` prefixes, and wraps the concatenated bodies in the `window.__ModuleLoader__.load({ id, factory })` shell that obtains React and `react/jsx-runtime` through the supplied `require` function and returns `{ inject, apply }`.
- TypeScript source conventions (kept so the emitted bundle stays byte-consistent with the hand-written original): annotate only in erasable positions (parameter/variable types, generics, optional parameters, function-declaration return types); **never** use arrow-function return-type annotations (`): T =>`), `as` casts, `satisfies`, enums, or namespaces (they leave artifacts or get rewritten); keep `import` statements single-line; comments only on their own lines; no comments or blank lines inside the `css` template literal; keep shared top-level names unique across modules (they link into one factory scope).
- Register UI through the existing DSH `sessions` and `slots` injections. The current slot is `conversation.session.header.actions` and the manager id is `subagent-workspace-manager`.
- Preserve the plugin’s existing CSS class prefix (`dsh-sam-`) and local preference key (`dsh-subagent-workspace-ui/preferences`) when changing UI behavior.
- Keep user-facing labels and accessibility attributes consistent with the existing Chinese UI unless a change explicitly requires otherwise.
- Avoid querying or displaying prompt/provider/model data: the README documents that the public `SessionSummary` does not expose those fields.

## Directory guide

- `lib/index.js` — host-side plugin entry; exports `apply()`. Hand-written, edit directly.
- `lib/client.js` — **generated** browser bundle (manager UI, styles, filtering, archive state, live activity rendering, DSH session/slot integration). Do not edit; run `pnpm run build`.
- `src/client/` — TypeScript sources of the client bundle, concatenated in original bundle order: `types.ts` (types-only), `ambient.d.ts` (React/jsx/`sessionsRt` declarations), `styles.ts` (css), `bootstrap.ts`, `format.ts`, `runtime.ts`, `live-output.ts`, `detail.ts`, `live-events.ts`, `active-float.ts`, `manager.ts`, `i18n.ts`, `apply.ts`.
- `scripts/build.mjs` — builds `lib/client.js` from `src/client/` (sucrase + linker + wrapper).
- `scripts/verify-build.mjs` — migration proof / delta viewer: compares the generated bundle with the pre-refactor golden (default ref `v1.3.4`) up to insignificant whitespace (token-level and line-level comparison) and prints any intentional differences.
- `scripts/verify-fresh.mjs` — bundle freshness gate used by `pnpm run check` (fails on a stale committed bundle).
- `docs/images/` — README screenshots (`screenshot-1.png` and `screenshot-2.png`).
- `cordis.patch.yml` — bundle patch that inserts this plugin and disables DSH’s stock `ui-subagent` lineage dropdown while installed.
- `test.sh` — local DSH Web smoke setup described above.
- `package.json` — package metadata, exports, DSH client injection declarations, peer dependency, and scripts.
- `README.md` / `README.zh.md` — feature, installation, runtime-boundary, and validation documentation.

## Known gotchas

- The plugin manages the catalog discovered by the current browser runtime; it is not a global historical subagent index.
- Exact child navigation uses `{ parentSessionId, childSessionId, mode }` when DSH supplies that address. Otherwise the UI falls back to retained session navigation.
- Archive state is browser-local and does not delete DSH sessions.
- Removing the package removes its bundle patch and restores the underlying `ui-subagent` setting. A manually configured user stanza in `$DSH_HOME/profiles/web/cordis.patch.yml` is intentionally preserved.
- Live output/tool/context details require the documented bound-session conversation snapshot; without it, the UI falls back to the durable summary.
- The package is installed from the local directory with `file:.`; profile installs are store copies, so after changing `src/client/` you must `pnpm run build` and re-add the plugin (or run `./test.sh`) for the Web UI to pick up changes. The build requires the dev dependencies (`sucrase`, `typescript`) — run `pnpm install` after a fresh clone; `scripts/build.mjs` needs Node >= 18 (uses `import.meta.url`; sucrase does the rest).
- `.dsh-plugin-smoke/` and `.dsh-graph/` are ignored local/runtime data; do not treat them as application source.
