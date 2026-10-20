[简体中文](README.zh-CN.md)

# dsh-vectr-client

> **Based on Vectr**: built upon [Vectr](https://github.com/swapnanil/vectr) by Swapnanil Saha ([official site & documentation](https://swapnanilsaha.com/tools/vectr)). The index, the memory store and the daemon are Vectr's; this plugin is the harness integration around them (binding, UI, per-workspace routing).

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives every agent working in a project a **semantic index of that project and a memory that outlives the chat**. The agent searches code by meaning instead of grepping, keeps notes that survive context compaction, and picks up where the last session stopped — per workspace, automatically.

## What you get

- **Semantic Search** — search by meaning: the agent asks for a concept, a symbol or a call relationship ("where is the workspace lock released?") instead of running grep loops.
- **Reliable Working Memory** — findings stored as notes come back in one call, later in the session, after a context trim, or in a new session.
- **Right daemon for the right directory, automatic** — on every agent start the plugin finds that directory's registered Vectr daemon and connects to it. Agent A never gets agent B's workspace tools, and there is no global MCP config to maintain.
- **Never blocks, never hangs** — a missing, dead or unresponsive daemon means only "this agent has no Vectr tools"; the reason is logged with workspace/cwd/port/pid and the agent keeps working.
- **Status where you type** — a capsule in the session header shows the state, mode and port of that session's daemon; a trigger next to the input opens the console. Both reset cleanly when the session has no directory yet.
- **One-click daemon start, and re-index from the panel** — a `一键启动全部 Daemon` button starts every registered daemon in one request; a workspace's index can be rebuilt, or the reason it cannot be rebuilt (memory-only, already indexing, not ready, offline) read in the tooltip of that button.

## How to use

Four steps: install, open the console, start the daemons, then just ask.

### Install

Run the command for your source — a local checkout, or the git host (the repo commits its compiled `lib/`, so nothing is built on install).

```sh
dsh plugin --profile web add ./dsh-vectr-client
```

```sh
dsh plugin --profile web add github:WinterSold1er/dsh-vectr-client
```

Remove with `dsh plugin --profile web remove dsh-vectr-client`.

`dsh plugin add` links the package into the profile and installs it; it does **not** edit the profile manifest. The package still has to be listed in the profile's `dsh.profile.bundles` — add it to the profile `package.json` yourself, or use the plugin-manager UI — so the loader enumerates it and applies `cordis.patch.yml` on the next boot.

**Restart the host afterwards** — the `/api/vectr/*` routes and the Settings section register at boot, so an already-running host shows no console.

Vectr itself must already be installed, with at least one project indexed. The binding needs a daemon that is already registered in `~/.vectr/instances.json`; the plugin does not install Vectr itself or build the initial index.

### Open the console

Open Settings → Vectr.

The console opens on a summary strip — registered / live / memory-only / offline — and one card per workspace: identity and full path, status, mode and readiness pills, then port, files, notes and languages. Expand a card for its codebases and for the form that adds one; a failing endpoint shows its actual message instead of an empty table.

The `一键启动全部 Daemon` button sits in the toolbar above the cards.

![Settings → Vectr overview](docs/assets/settings-overview.png)

### Start the daemons

Click `一键启动全部 Daemon`.

One request starts every registered daemon and lists the per-workspace outcome. From then on, an agent that starts in a registered directory binds to that directory's daemon on its own, with no configuration.

### Just ask

Open any session and just ask about the code.

Ask for what you want in plain English ("where is the workspace lock released?") — no grep, no file paths. The capsule in the session header shows that session's daemon state, mode and port, and the Vectr trigger next to the input opens the console.

![Vectr mark in the panel header](docs/assets/panel-header-mark.png)

A daemon's mode decides whether it can be re-indexed. A `memory_only` daemon still serves search and memory, but it cannot be re-indexed: the re-index button stays disabled and its tooltip carries the reason. A ready daemon rebuilds its index from the panel in one click.

![A memory_only workspace card](docs/assets/card-memory-only.png)

## Configuration

`cordis.patch.yml` inserts one row (`serverName: vectr`); override any key in your profile's patch file:

| Key | Default | Meaning |
|---|---|---|
| `instancesPath` | `~/.vectr/instances.json` | Daemon registry file |
| `serverName` | `vectr` | Tool namespace, `mcp__<serverName>__*` |
| `toolCallTimeoutMs` | `60000` | Per-call timeout for a Vectr tool |
| `reconnect.enabled` | `true` | Reconnect after a lost connection (same port) |

The remaining keys — codebase and secret paths, daemon/CLI/recall/upgrade timeouts — are in the `Config` schema in `src/index.ts`.

## Known limitations

- **First-request race** — the connection opens asynchronously, so a dead daemon can never block the agent; the very first prompt may run before the tools are registered. The next step has them. A failed bind is equally quiet: the agent just has no Vectr tools, and the reason is logged with workspace/cwd/port/pid.
- **A daemon that comes back on a different port is not re-resolved** — reconnect retries the same port; a new port is picked up at the next session start.
- **The console needs a host restart** — routes and the web section register at boot.

One honest note about the icon: the settings **rail** glyph is chosen by the harness host from a fixed id→icon map and falls back to the settings gear; a plugin cannot set it. The plugin's own mark appears inside the panel header and next to the input.

## Development

```sh
pnpm typecheck
pnpm test
pnpm build
```

`lib/` is committed so consumers need no build step.

## Credits

- [Vectr](https://github.com/swapnanil/vectr) by [Swapnanil Saha](https://swapnanilsaha.com/tools/vectr) — the semantic index, the working-memory store and the daemon.
- This plugin is the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) integration around it.

## License

MIT — see `package.json`.
