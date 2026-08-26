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

The panel screenshot demonstrates the compact layout:

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

Then append the contents of [`cordis.patch.yml`](cordis.patch.yml) to your Web profile patch (usually `$DSH_HOME/profiles/web/cordis.patch.yml`) and restart the existing `dsh web` process. Refresh `http://127.0.0.1:3080` after the plugin is available.

To make this the sole subagent navigation UI, also enable the optional `ui-subagent` disable stanza in the patch. That removes DSH’s stock header lineage dropdown while retaining this manager button.

## Runtime data boundary

The public DSH Web session store exposes subagent summaries that have been discovered in the current browser runtime. It deliberately does not expose a global historical subagent index or a mode for every unvisited child. Therefore this first plugin version manages the discovered catalog; rows whose type is not yet loaded remain visible and searchable and fall back to DSH's retained session navigation. Exact catalog navigation is used automatically as soon as DSH supplies the address and mode.

A full persistent workspace-wide archive view requires a host-side catalog RPC (or an upstream DSH API) that enumerates every child address and its mode. The public `SessionSummary` does not expose the original prompt or provider/model route, so those are intentionally not queried or displayed. Live output and tool/context activity use the documented bound-session conversation snapshot when the session can be opened; if the host does not publish that snapshot, the panel falls back to the durable summary. The UI is isolated in [`lib/client.js`](lib/client.js), so it can switch to a richer source without changing the panel interaction model.

## Validation

```bash
pnpm run check
```
