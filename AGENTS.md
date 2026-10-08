# AGENTS.md

## Project overview

`dsh-subagent-workspace-ui` is a DeepSeek Harness Web client plugin. It adds a Chinese-labeled subagent manager to the conversation header, with search, workspace/session scope, sorting, grouping, local classification tabs, archive/restore controls, batch selection, and active-child live status when the runtime exposes it.

The package is ESM (`"type": "module"`) and publishes the `lib/` directory. Its package entry is `lib/index.js`; its client export is `lib/client.js`. The package declares `@deepseek-ai/cordis` `^4.0.1` as a peer dependency and uses DSH client injection declarations in `package.json`.

Since v1.4.0 the client bundle is **generated from TypeScript sources**: `lib/client.js` is built from `src/client/*.ts` by `scripts/build.mjs` and must never be edited directly.

## Workflow cadence (core memo)

**Branches**: `main` carries released versions only. All development happens on the current `<version>-dev` branch cut from `main` (e.g. `1.4.0-dev`). Commit message prefixes follow history: `feat:` / `fix:` / `refactor:` / `docs:` / `chore:`.

**Daily loop**: edit `src/client/*.ts` (never `lib/client.js`) → `pnpm run build` → `pnpm run check` → commit the sources and the regenerated bundle **together** → re-add the plugin (`dsh plugin --profile web add file:.`), restart `dsh web`, and refresh `http://127.0.0.1:3080` to smoke-test (or run `./test.sh [PORT]`). Host-entry (`lib/index.js`) changes always require a `dsh web` restart to take effect.

**Verification layers**: ① `pnpm run check` — build + `tsc --noEmit` + `node --check lib/index.js` + bundle-freshness gate; ② `node scripts/verify-build.mjs [ref]` — token/line-level comparison against the `v1.3.4` hand-written golden (the migration proof; afterwards a delta viewer that prints the exact differences of any intentional change); ③ smoke — `./test.sh [PORT]`, and `DSH_VERSION=0.1.1-rc.2 ./test.sh` for legacy-API compatibility.

**Release rhythm** (details under "Release discipline" below): on the dev branch bump the version + write release notes → run the full check → fast-forward merge to `main` → annotated tag `vX.Y.Z` → delete the old dev branch and open the next one off `main`. The owner runs `npm publish --access public` manually (npm 2FA) and pushes `origin main --tags` plus the dev branch. External contributions are reviewed, merged into the dev branch, and credited in the README acknowledgements and release notes (precedent: PR #1 by @Marcuss2).

**Board**: this workspace uses dsh-graph (`.dsh-graph/`, gitignored) for goal tracking; run `graph_*` tools only from the repository root so they resolve the correct graph root.

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

1. On the current dev branch: bump `package.json` version and write the release notes into `CHANGELOG.md` and `CHANGELOG.zh.md` (the new version's section at the top of each file, newest first; the two files are kept in sync, with the English file brief and the Chinese file carrying the complete history). The READMEs carry no release-note bodies — each links to the two changelogs.
2. Run `node --check` on both lib files for syntax.
3. Merge the dev branch into `main` (fast-forward when `main` has not diverged).
4. Create an annotated tag on `main` at the release commit, e.g. `git tag -a vX.Y.Z -m "Release vX.Y.Z"`.
5. **Clean up the old dev branch** and **create the next dev branch** from `main`, e.g. `git checkout -b vNext-dev` then `git branch -d <old-dev>`. This is the standing discipline: every release ends with a fresh dev branch off `main` and the old one removed.

`pnpm publish` git-checks only require a clean working tree (not a tagged HEAD); a stray generated `pnpm-lock.yaml` is gitignored so it does not dirty the tree.

### Smoke run

```bash
./test.sh [PORT]                        # local dsh, port ${PORT:-8084}
DSH_VERSION=0.1.6-alpha.2 ./test.sh     # pnpx @deepseek-ai/dsh@<version> (via proxychains4 -q)
DSH_SMOKE_HOME=/path ./test.sh          # override the isolated smoke HOME
DSH_PLUGIN_DIR=.worktrees/x ./test.sh   # smoke another checkout's bundle (default: repo root via file:.)
```

The script uses an isolated `DSH_HOME` (default `$HOME/tmp/dsh-test`, override with `DSH_SMOKE_HOME`) and aborts if that would be the real `~/.dsh`, removes and re-adds the local plugin to the Web profile, then starts `dsh web --no-open --port ${PORT:-8084}`. With `DSH_VERSION` set it runs through `pnpx @deepseek-ai/dsh@<version>` and passes one `--allow-build=<pkg>` per native dsh dependency (pnpm 12 ignores lifecycle scripts by default; `DSH_ALLOW_BUILDS=…` overrides the comma-separated list, `DSH_PROXY=""` bypasses proxychains). A `DSH_VERSION` run needs network access to the npm registry. It is an environment-dependent smoke setup, not a unit-test runner.

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
- Prompt data may be displayed **only** through the subagent-session preview path added in v1.10.0: the text is read from the child session's own `user/message` events through the plugin's retained binding — **never** from `SessionSummary.prompt`, which carries no prompt — matched to a message node **by message id** (a node key's `<anchor>` is a feed counter, not `event.seq`; a node whose own record is outside the retained window reads its **own** DOM body instead of a neighbour's record), rendered with text nodes only (no third-party markdown library, no `dangerouslySetInnerHTML` / `innerHTML`, links limited to `http(s)` / relative targets), and never written back. A child's type and model may be displayed, but only from the public read-only projections, probed by key, each with an explicit fallback when the host does not publish it; never add a model-switch UI or call a model write API (`selectedModel`). The type goes through the single reader `childModeOf`, whose fallback order must stay: ① the discovered catalog entry — `subagentsByParent[parentId].entries[].mode` on hosts up to **0.1.6-alpha.2**, `byId[parentId].projectionValues.subagentCatalog[].mode` on **0.1.7-rc.1** and later, with `projectionsBySession[parentId].values.subagentCatalog` as a defensive fallback and the legacy source winning whenever a host publishes both (present only once that parent's catalog was pulled — opening the manager panel is one such pull, so it must never be the only rung; an entry whose `mode` is `'unknown'` keeps its label and yields the mode to rung ②) → ② `byId[childId].projectionValues.subagent.mode` (the child's own identity projection, pushed on the live-control stream and on every session-added summary, so a freshly loaded page already has it) → ③ the existing `typeLoading` text (zh + en). The model is `byId[childId].projectionValues.modelSelection` → `next ?? lastUsed`, falling back to `modelUnknown`. Usage figures follow the same read-only rule through the single reader `usageStats` (panel detail row and active float project the same object): the billed input is `uncachedInputTokens + cacheReadTokens + cacheWriteTokens` and that billed input alone is the cache-hit denominator — never the total, which would count output tokens in a prompt-side ratio — the share is formatted with the ported official `formatCacheHitPercent`, so a partial hit can never round up to 100, and tps is `projectionValues.sessionStats.decodeTokens / (decodeMs / 1000)`; a missing bucket, a zero denominator or a non-positive decode window omits that segment (zh + en) instead of rendering 0, `NaN` or `null`.

## Directory guide

- `lib/index.js` — host-side plugin entry; exports `apply()`. Hand-written, edit directly.
- `lib/client.js` — **generated** browser bundle (manager UI, styles, filtering, archive state, live activity rendering, DSH session/slot integration). Do not edit; run `pnpm run build`.
- `src/client/` — TypeScript sources of the client bundle, concatenated in original bundle order: `types.ts` (types-only), `ambient.d.ts` (React/jsx/`sessionsRt` declarations + the `SessionReferenceSourceMap` declaration merge), `styles.ts` (css), `bootstrap.ts`, `format.ts`, `runtime.ts`, `retain.ts`, `live-output.ts`, `detail.ts`, `markdown.ts` (prompt markdown → text-node DOM), `live-events.ts`, `active-float.ts`, `manager.ts`, `i18n.ts`, `prompt-view.ts` (subagent-session prompt preview), `apply.ts`.
- `scripts/build.mjs` — builds `lib/client.js` from `src/client/` (sucrase + linker + wrapper).
- `scripts/verify-build.mjs` — migration proof / delta viewer: compares the generated bundle with the pre-refactor golden (default ref `v1.3.4`) up to insignificant whitespace (token-level and line-level comparison) and prints any intentional differences.
- `scripts/verify-fresh.mjs` — bundle freshness gate used by `pnpm run check` (fails on a stale committed bundle).
- `docs/images/` — README screenshots (`screenshot-1.png` and `screenshot-2.png`); the README banner is `docs/banner.png`.
- `cordis.patch.yml` — bundle patch that inserts this plugin (and nothing else; the two slot shadows live in `src/client/apply.ts`, not in this file). The stock `ui-subagent` plugin is intentionally left enabled: the row/floating-panel “open in the sidebar” button reuses its `subagentchat` right-sidebar tab. What keeps the stock plugin’s **two** header entries invisible is the plugin’s own declarative low-priority shadow, one registration per slot, both funnelled through `registerShadow` (catch → warn → the official entry stays visible, so a host that ever ships its own entry at the same `(id, priority)` pair costs the shadow and not the plugin; an escaping throw would tear down that `slots.inject` effect, and a synchronous one out of `inject` would fail the whole `apply`): `conversation.session.header.lineage` is a `single` slot, so `priority: -1` beats the stock registration’s default 0 outright and the crumb title renders instead of the dropdown; `conversation.session.header.actions` is a `list` slot whose cells are keyed by `id`, so a second registration at `id: "subagent-catalog", priority: -1` wins exactly that one cell (stock registers `id: "subagent-catalog", order: -30` with no priority) and renders `null`, leaving the manager’s own `subagent-workspace-manager` cell and the stock plugin’s four other registrations — including the `subagentchat` right-sidebar tab — untouched. Re-verified on **0.1.7-rc.2**, **0.1.7-rc.1** and **0.2.0-rc.1**: on a parent session with six catalog children the header shows the stock entry nowhere and this plugin’s `🧩 Subagents 0/6` as the only subagent entry (`stock=0`, actions-slot children `2`), the six-row panel still opens, and a row’s `◫` still opens the stock `subagentchat` right-sidebar tab. **Recorded missed detection**: the stock `subagent-catalog` header entry arrived in **0.1.7-rc.1** (0.1.5-rc.3 and 0.1.6-alpha.2 register no such cell; 0.1.7-rc.1 / rc.2 / 0.2.0-rc.1 all do) and only materializes once the current session’s `subagentCatalog` projection has loaded, so the earlier matrix that recorded the 0.1.7-rc.1 header as “normal” was looking at the `lineage` slot alone — the 0.1.7-rc.2 report was the first time both cells were examined side by side, and it was never a 0.1.7-rc.2 regression. The web graph churn in 0.2.0-rc.1 (the `ui-schedule` row dropped, shortcut/telemetry rows added) still leaves this plugin’s six injected packages untouched.
- `test.sh` — local DSH Web smoke setup described above.
- `package.json` — package metadata, exports, DSH client injection declarations, peer dependency, and scripts.
- `README.md` / `README.zh.md` — feature, installation, runtime-boundary, and validation documentation; they carry no release-note bodies, only a link to the changelogs.
- `CHANGELOG.md` / `CHANGELOG.zh.md` — release history, newest first (English brief back to v1.3.2; Chinese complete back to v1.0.1). Not listed in `files`, so it ships to GitHub only, and the READMEs link to it with absolute GitHub URLs.

## Known gotchas

- The plugin manages the catalog discovered by the current browser runtime; it is not a global historical subagent index.
- Exact child navigation uses `{ parentSessionId, childSessionId, mode }` when DSH supplies that address. Otherwise the UI falls back to retained session navigation.
- Archive state is browser-local and does not delete DSH sessions.
- Removing the package removes its bundle patch; the host's `ui-subagent` setting was never modified, and a manually configured user stanza in `$DSH_HOME/profiles/web/cordis.patch.yml` is intentionally preserved. Verified: the user patch file is byte-identical before and after `dsh plugin --profile web remove`. Uninstalling therefore also removes **both** header shadows (they live in this plugin's own `lib/client.js`), and the stock plugin's lineage dropdown and `subagent-catalog` count entry both come back — which is the intended “no plugin, stock UI” state.
- Keep both header shadows **capacity-and-cell shaped, never version-shaped**: the stock plugin registers its lineage entry with *no* priority and its `subagent-catalog` entry with *no* priority either, so the plugin wins by declaring a strictly lower one (`-1`) in the same cell — the slots core throws only on an identical `(cell, priority)` pair and otherwise elects the lowest-priority live entry per cell (`single` slots have one cell; `list` cells are the `id`). Never raise the shadow above the stock value or probe a host version to decide whether to register; if a future host ships its own entry at `-1`, `registerShadow`'s catch keeps the official entry visible and the rest of the plugin working.
- The “open in the sidebar” button must stay **capability-detected, never version-checked**: it requires `ctx.get('sidebarRight').openResource`, `ctx.get('sidebarRightTabs').candidates` and `ctx.sessions.subagentAddress`, and each row's rebuilt `dsh-resource://subagentchat/session/…` address is validated with `candidates(address)` before it is used, so a format drift disables that one row's button instead of throwing at the user. Resolve both faces **per row and per click, never once at activation**: dsh **0.1.7-rc.1** registers `sidebarRight`/`sidebarRightTabs` only *after* this plugin's `apply` has run (0.1.6-alpha.2 has them at apply time), so a one-time probe silently removed the whole `◫` column there — and **0.2.0-rc.1** makes that window later still, because its `ui-sidebar-right` added `shortcuts` to its own inject list (slots/layout/locale/resources/sessions/uiSession → `+shortcuts`), so it waits for one more service before providing those faces. Verified on 0.2.0-rc.1 with a parent session carrying six catalog children: all six rows rendered an enabled `◫`, and clicking one opened that child as the stock `subagentchat` right-sidebar tab (validated by `candidates`, tab title = the child id). Those services are deliberately **not** added to the plugin's cordis `inject` list.
- Live output/tool/context details come from the plugin's **own retained binding**, never from `sessions.binding(id)` alone: that call only *borrows* a binding somebody else already retained (the stock view retains just the selected session), so leaning on it made only the *selected* child stream. `sessions.retain(target, { source: 'subagentWorkspaceUi' })` returns a `SessionReference` whose `binding` stays valid until `release()`; retention is bounded and paired — the float keeps every running child it shows, the panel keeps the running rows it renders, both share `RETAIN_LIMIT` (8) with the float served first and the most recently active child first, and every row that stops rendering or stops running, every closed surface and plugin disposal releases. A host without `retain` falls back to the borrowed `binding` (capability probe, never a version check); when neither yields a binding the UI falls back to the durable summary.
- The package is installed from the local directory with `file:.`; profile installs are store copies, so after changing `src/client/` you must `pnpm run build` and re-add the plugin (or run `./test.sh`) for the Web UI to pick up changes. The build requires the dev dependencies (`sucrase`, `typescript`) — run `pnpm install` after a fresh clone; `scripts/build.mjs` needs Node >= 18 (uses `import.meta.url`; sucrase does the rest).
- `.dsh-plugin-smoke/` and `.dsh-graph/` are ignored local/runtime data; do not treat them as application source.
- The ended-row terminal indicator reads one field only, and that field is **generational**: `byId[childId].projectionValues.subagentTiming.lastTurnCompleted` exists from dsh **0.1.7-alpha.1** (stateVersion 3, folded from the durable `turn/end` `reason.kind === 'completed'`), while **0.1.5-rc.3** and **0.1.6-alpha.2** publish that projection as `{ settledMs, active? }` only (stateVersion 2). Their summaries and projections are otherwise **identical** for a normally finished and for an aborted child (`activity` is live-driven, and `turnOutline[0].response` can be non-empty after an abort), so on those hosts an ended row keeps the neutral dot: that absence is real, must never be upgraded to “normal end”, and must not be replaced by an in-memory guess (only a row retained at the ending instant would have one, and it is lost on refresh — worse than a steady neutral dot). Re-verified on **0.2.0-rc.1**: `dsh-subagent`'s `projection-types.d.ts` / `catalog.d.ts` / `projection.d.ts` are byte-identical to 0.1.7-rc.1 and `dsh-session-stats` / `dsh-session-projection` are unchanged, so `subagentCatalog` / `subagent` / `subagentTiming` (and therefore this generation boundary) still read the same — a child session mounted in that build showed `Ended normally` / the green ring from `lastTurnCompleted`. The sessions contract gained only an optional `fork(onCreated)` (never called here); note that these projections are pushed **per touched session**, so copying an old session's log into an otherwise idle runtime yields rows whose type/model/usage/timing stay at their fallbacks until that child session is opened.
- Two features that touch the same manager row conflict at the **character** level: `src/client/manager.ts` renders a whole row in one very long line (status dot, row-action buttons, the expanded/collapsed disclosure row), so git cannot merge those edits line-wise. Resolve by keeping every side's semantics inside that line and then regenerating the bundle (`git checkout --ours lib/client.js && pnpm run build`) — never hand-merge `lib/client.js` and never take one side wholesale.
