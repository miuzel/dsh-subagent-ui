# AGENTS.md

## Project overview

`dsh-subagent-workspace-ui` is a DeepSeek Harness Web client plugin. It adds a Chinese-labeled subagent manager to the conversation header, with search, workspace/session scope, sorting, grouping, local classification tabs, archive/restore controls, batch selection, and active-child live status when the runtime exposes it.

The package is ESM (`"type": "module"`) and publishes the `lib/` directory. Its package entry is `lib/index.js`; its client export is `lib/client.js`. The package declares `@deepseek-ai/cordis` `^4.0.1` as a peer dependency and uses DSH client injection declarations in `package.json`.

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

`check` runs `node --check` against both `lib/client.js` and `lib/index.js`.

### Publish

The project owner publishes releases manually:

```bash
npm publish --access public
```

Confirm the package version in `package.json` and complete npm 2FA when prompted.

### Smoke run

```bash
./test.sh
```

The script sets `DSH_HOME=/tmp/dsh-test`, removes and re-adds this local plugin to the Web profile, then starts `dsh web --port 8084`. It is an environment-dependent smoke setup, not a unit-test runner.

### Build / test / lint

There is no project-defined `build`, `test`, or `lint` script in `package.json`. No test or lint configuration is present in the repository. The checked-in client bundle is `lib/client.js`; `pnpm run check` is the available syntax validation command.

## Code style and conventions

- Use ECMAScript modules. `lib/index.js` uses `export` and the package is explicitly marked as ESM.
- Match the existing semicolon-free JavaScript style and two-space indentation where code is formatted across lines.
- Keep the host entry (`lib/index.js`) minimal; the UI is loaded through the package `dsh.client` declaration.
- The client entry is a DSH module-loader bundle. It obtains React and `react/jsx-runtime` through the supplied `require` function and returns an object with `inject` and `apply`.
- Register UI through the existing DSH `sessions` and `slots` injections. The current slot is `conversation.session.header.actions` and the manager id is `subagent-workspace-manager`.
- Preserve the plugin’s existing CSS class prefix (`dsh-sam-`) and local preference key (`dsh-subagent-workspace-ui/preferences`) when changing UI behavior.
- Keep user-facing labels and accessibility attributes consistent with the existing Chinese UI unless a change explicitly requires otherwise.
- Avoid querying or displaying prompt/provider/model data: the README documents that the public `SessionSummary` does not expose those fields.

## Directory guide

- `lib/index.js` — host-side plugin entry; exports `apply()`.
- `lib/client.js` — browser-side manager UI, styles, filtering, archive state, live activity rendering, and DSH session/slot integration.
- `src/` — currently empty; there are no source files here.
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
- The package is installed from the local directory with `file:.`; do not assume a separate build step exists.
- `.dsh-plugin-smoke/` and `.dsh-graph/` are ignored local/runtime data; do not treat them as application source.
