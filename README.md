# DSH Subagent Workspace UI

A Web client plugin that adds a **子代理管理** button to the conversation-header action row. It opens a searchable panel for the subagents currently discovered by the DSH client runtime.

## Features

- Compact title-bar trigger shows the active-child count and animated activity dot without opening the panel.
- Defaults to the main session's current workspace and current session, even when the user is viewing a child session.
- Workspace and session selectors support current workspace, all workspaces, named workspaces, current session, and named sessions.
- Sort by recent activity, name, or type; recently running children remain near the top after they finish.
- Group by session, workspace, category, type, or no grouping. Session headers show the workspace and parent session name.
- Browser-local classification tabs support custom regular expressions. Built-ins include all, other, review, test, implementation, and planning.
- One-shot children carry a compact `⚡ 一次性` badge; continuable children remain visually uncluttered.
- Archive state is local and never deletes a DSH session. Single-row archive actions and a batch mode support shift-selection, select-all, time-based selection (up to 1,000 rows), batch archive, restore, and archive-all.
- Load catalogs in pages of 40 with an independent wheel-scroll container; batch time selection expands loading up to 1,000 children.
- Batch mode changes cards into selection targets and hides individual archive/restore actions. The highlighted 完成 button exits batch mode.
- Open a loaded child at its exact `{ parentSessionId, childSessionId, mode }` address. In normal mode the whole card opens the child; archive controls do not.
- Show session IDs beside names, compact metadata, token totals, and creation time in the relative-time tooltip.
- Active children are grouped at the top in a collapsible section. When the runtime exposes conversation snapshots, the panel shows the latest two lines of live output, recent tool calls, context injection, command status, and a gray final snapshot after completion.

## Screenshot guide

The screenshots demonstrate the compact manager and active-agent floating panel:

![Subagent manager panel](docs/images/screenshot-1.png)

![Active subagent floating panel](docs/images/screenshot-2.png)

1. **Header** — title, current-session/workspace counts, and close action.
2. **Search and scope row** — ordinary name/title/workspace search, with `id: xxx` reserved for Session ID search; workspace, session, sorting, and grouping selectors stay on one compact row.
3. **Classification row** — built-in and custom categories, with custom-category deletion inside the same tab frame.
4. **Filter row** — hide one-shot, hide stale children, show archived, and reset filters.
5. **Results** — collapsible active group, workspace/session group headers, Session ID beside each name, relative activity time, and archive status.
6. **Live activity** — when available, the last two output lines or the latest tool/context status appear at the bottom of the card; the final snapshot remains gray after completion.

## Install in the Web profile

From this directory:

```bash
dsh plugin --profile web add file:.
```

The bundle includes [`cordis.patch.yml`](cordis.patch.yml), which inserts the manager and disables DSH’s stock `ui-subagent` lineage dropdown while the package is installed. Removing the package removes this bundle layer and restores the underlying `ui-subagent` setting. Restart the existing `dsh web` process, then refresh `http://127.0.0.1:3080` after the plugin is available.

If you previously disabled `ui-subagent` manually in `$DSH_HOME/profiles/web/cordis.patch.yml`, remove that manual stanza when testing automatic restoration; user-owned settings are intentionally preserved.

## Runtime data boundary

The public DSH Web session store exposes subagent summaries that have been discovered in the current browser runtime. It deliberately does not expose a global historical subagent index or a mode for every unvisited child. Therefore this first plugin version manages the discovered catalog; rows whose type is not yet loaded remain visible and searchable and fall back to DSH's retained session navigation. Exact catalog navigation is used automatically as soon as DSH supplies the address and mode.

A full persistent workspace-wide archive view requires a host-side catalog RPC (or an upstream DSH API) that enumerates every child address and its mode. The public `SessionSummary` does not expose the original prompt or provider/model route, so those are intentionally not queried or displayed. Live output and tool/context activity are read from the bound session automatically: on dsh **0.1.2-alpha.2** they are derived from the raw `binding.eventSource` event stream (showing the tool description or target filename), while older hosts (e.g. **0.1.1-rc.2**) fall back to `session.getSnapshot().chat.legacy`. Capability detection selects the path, so the plugin stays forward compatible. If the host publishes neither, the panel falls back to the durable summary. The UI is isolated in [`lib/client.js`](lib/client.js), so it can switch to a richer source without changing the panel interaction model.

## Compatibility

v1.5.0 supports dsh **0.1.6-alpha.2** and stays backward compatible with all DeepSeek Harness versions. Opening a subagent session is capability-detected at runtime and degrades in three tiers:

```text
# dsh 0.1.2-alpha.5 .. 0.1.6-alpha.1: the session controller entry points
ctx.sessions.openSubagent(address)   # exact child address
ctx.sessions.open(sessionId)         # retained session navigation

# dsh 0.1.6-alpha.2 and later: the workspace navigation service
ctx.get('uiWorkspace').openSession({ parentSessionId, childSessionId, mode } | sessionId)

# neither is available: the click reports that the host has no session navigation API
```

`uiWorkspace` is read through `ctx.get('uiWorkspace')`, never through a required injection, so hosts that do not register the service (everything before **0.1.2-alpha.5**) still load and keep using the session-controller path, while hosts that removed `openSubagent`/`open` (**0.1.6-alpha.2**) use the workspace service. **The probe order follows the argument shape, not the version**: `sessions.openSubagent` accepts an address object on every host that has it, whereas `uiWorkspace.openSession` only accepts a `SessionTarget` from **0.1.6-alpha.2** on — on **0.1.5-alpha.2 … 0.1.6-alpha.1** it is `openSession(sessionId)` and routes through `sessions.open(id)`, which throws on an address. The session-controller tier is therefore tried first and the workspace service is the fallback. Within the controller tier the exact `{ parentSessionId, childSessionId, mode }` address is used first and only a missing mode/child falls back to plain session navigation, because `openSubagent` rejects addresses that are not healthy catalog children. The 0.1.2-series capability paths (live output via `binding.eventSource`, chat-tab switch via slot `actions`) remain the primary branches, and the **0.1.1-rc.2** legacy fallbacks (`chat.legacy` snapshot) are unchanged.

## v1.5.0

- **Fix**: on DeepSeek Harness **0.1.6-alpha.2** clicking a subagent row failed with `TypeError: ctx.sessions.openSubagent is not a function` (the click was silently swallowed by the row's `try`/`catch`, so the panel just looked dead). 0.1.6-alpha.2 removed `sessions.openSubagent(address)` and `sessions.open(id)`; the plugin now detects the navigation capability at runtime in three tiers (`sessions.openSubagent` → `sessions.open` → `uiWorkspace.openSession`) instead of hard-switching, so the same bundle keeps working on both sides of that upstream change, and the failure is surfaced in the UI when no navigation API exists at all.
- **Fix**: the tier order above is argument-shape driven, because **0.1.5-alpha.2 … 0.1.6-alpha.1** ships a `uiWorkspace.openSession(sessionId)` that only accepts a string id and throws `sessions.select: unknown session [object Object]` for an address, while `sessions.openSubagent(address)` is still present and does accept one on those hosts. Trying the workspace service first there swallowed that throw and showed the "unsupported version" notice, so the address now goes to the object-capable controller entry point first and `uiWorkspace` remains the fallback for 0.1.6-alpha.2+. Verified live on both sides of the band: on **0.1.5-alpha.1** (client packages 0.1.5-rc.2) the reordered bundle switches session in ~142 ms with no alert and no navigation error, and on **0.1.6-alpha.2** the served bundle still resolves to `uiWorkspace.openSession` and opens the child session.
- **Fix**: 0.1.6-alpha.2 also dropped the `current` field from the session list snapshot, which the current-session resolution and the Chat-tab fallback relied on. Both now degrade gracefully: the fallback recognizes a missing `current`, tries the host's own Chat tab immediately, and gives up quietly after 2 s instead of polling for 8 s.

## v1.4.0

- **Compatibility**: supports DeepSeek Harness **0.1.5-rc.2**, backward compatible with all dsh versions. 0.1.5-rc.2 changed the conversation view structure (the slot renderer no longer injects store `actions` into entries that do not declare a store, and the selected view is now persisted per session, with new tabs such as Trajectory) — clicking a subagent lands back on the Chat tab again (when `actions` is unavailable the plugin clicks the host's own Chat tab, preserving the host's activation and persistence semantics). The 0.1.2 capability-detection path remains the untouched primary branch and the 0.1.1 legacy fallback is unchanged.
- **TypeScript migration**: `src/client/*.ts` is now the single source of truth and `lib/client.js` is generated by `pnpm run build` (sucrase type erasure + deterministic linker) instead of being hand-written. New tooling: `verify-build` (token/line-level diff against the v1.3.4 hand-written golden — migration equivalence proof and delta viewer for intentional changes) and `verify-fresh` (stale-bundle gate); `pnpm run check` runs build + typecheck + syntax + freshness in one shot.
- **Fix**: a latent `scopeKey` ReferenceError in the collapsed filter summary (found during the TypeScript migration) is corrected to `workspaceKey`.

## v1.3.4

- **Feature**: the whole UI is localized through DSH client-locale (zh/en, AI-assisted English strings). Labels, buttons, stats, live output (context injection / thinking / tool details) and confirm dialogs now use translation keys and follow the host language. Contributed by [@Marcuss2](https://github.com/Marcuss2) in [PR #1](https://github.com/miuzel/dsh-subagent-ui/pull/1) — thank you!

## v1.3.3

- **Fix**: batch delete no longer errors on large selections (host request-body limit raised to 8 MiB).
- **Feature**: with details hidden, hovering a row/name shows the stats (`输入/输出 · 缓存命中 · 轮数 · 步数`) via the title tooltip.
- **Fix**: live output now shows context injection (`上下文注入 · <form>`) and the thinking state.
- **Feature**: while thinking, a rotating "思考中…" spinner indicates the state instead of the low-priority reasoning text.

## v1.3.2

- **Performance**: the manager now does one base scan (`subagentRows`) and derives `allRows`/`activeRows`/`tabCounts` from it (no repeated full scans or `modeMap` merges), `tabCounts` is computed from a deferred value and is skipped while the panel is closed, and `useSessions` subscribes only the fields the manager reads. Live output is capped to a few simultaneous subagents (`liveCap`, default 3, `0` = unlimited) and fully releases its subscriptions when live display is off or the float/panel is closed.
- **UX**: opening a subagent now auto-switches the session to the Chat tab.
- **Fix**: the batch "select N hours ago" now selects the truly-old subagents in the current view (accurate count) and no longer overwrites or re-selects your manual changes.

## Validation

The client bundle `lib/client.js` is **generated from the TypeScript sources** in [`src/client/`](src/client/) — edit those, never the bundle, then rebuild:

```bash
pnpm install      # dev deps: sucrase + typescript
pnpm run build    # scripts/build.mjs -> lib/client.js
pnpm run check    # build + tsc --noEmit + node --check lib/index.js + bundle freshness gate
```

`pnpm run verify:build` compares the generated bundle with the hand-written pre-refactor bundle (git ref `v1.3.4`) up to insignificant whitespace, using token-level and line-level comparison. After the migration it doubles as a delta viewer that prints the exact differences of any intentional change.

Smoke-test a specific dsh version:

```bash
./test.sh                                      # local dsh, port 8084
./test.sh 8085                                 # explicit port
DSH_VERSION=0.1.6-alpha.2 ./test.sh            # pnpx @deepseek-ai/dsh@0.1.6-alpha.2 (via proxychains4 -q)
DSH_VERSION=0.1.1-rc.2 ./test.sh               # legacy-API smoke on an old dsh
DSH_PLUGIN_DIR=.worktrees/x ./test.sh          # smoke another checkout's bundle
```

The script always uses an isolated `DSH_HOME` (`$HOME/tmp/dsh-test`, override with `DSH_SMOKE_HOME=…`) and refuses to touch the real `~/.dsh` profile. With `DSH_VERSION` set it runs `pnpx @deepseek-ai/dsh@<version>`; pnpm 12 ignores dependency lifecycle scripts by default, so the script passes `--allow-build=<pkg>` for dsh's native dependencies (`DSH_ALLOW_BUILDS=…` overrides the list).

## Acknowledgements

- UI localization (zh/en) contributed by [@Marcuss2](https://github.com/Marcuss2) via [PR #1](https://github.com/miuzel/dsh-subagent-ui/pull/1) — many thanks!
- Subagent permanent deletion and session cleanup design inspired by and referencing [@heiheiha798/dsh-plugin-subagent-delete](https://github.com/heiheiha798/dsh-plugin-subagent-delete).

