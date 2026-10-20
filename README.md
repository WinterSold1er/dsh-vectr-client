[简体中文](README.zh-CN.md)

# dsh-vectr-client

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives every agent working in a project a **semantic index of that project and a memory that outlives the chat**. The agent searches code by meaning instead of grepping, keeps notes that survive context compaction, and picks up where the last session stopped — per workspace, automatically.

> **Based on Vectr**: built upon [Vectr](https://github.com/swapnanil/vectr) by Swapnanil Saha ([official site & documentation](https://swapnanilsaha.com/tools/vectr)). The index, the memory store and the daemon are Vectr's; this plugin is the harness integration around them (binding, UI, per-workspace routing).

## What you get

- **Semantic Search** — search by meaning: the agent asks for a concept, a symbol or a call relationship ("where is the workspace lock released?") instead of running grep loops. Tools appear as `mcp__vectr__*`, in that agent's scope only.
- **Reliable Working Memory** — findings stored as notes come back in one call, later in the session, after a context trim, or in a new session.
- **Right daemon for the right directory, automatic** — on every agent start the plugin reads the session `cwd`, finds that directory's Vectr daemon in `~/.vectr/instances.json` and connects to it. Agent A never gets agent B's workspace tools, and there is no global MCP config to maintain.
- **Never blocks, never hangs** — a missing, dead or unresponsive daemon means only "this agent has no Vectr tools"; the reason is logged with workspace/cwd/port/pid and the agent keeps working.
- **Status where you type** — a capsule in the session header shows the state, mode and port of that session's daemon; a trigger next to the input opens the console. Both reset cleanly when the session has no directory yet.
- **One-click daemon start** — a `一键启动全部 Daemon` ("start all daemons") button in the console starts every registered daemon in one request and lists the per-workspace outcome.
- **Re-index from the panel** — rebuild a workspace's index, or read why it cannot be rebuilt (memory-only mode, already indexing, not ready, offline) in the button's tooltip.
- **Several codebases per workspace** — local ones and remote ones over SSH (key or password auth), each with its own MCP connection (`vectr_<workspaceKey>_<slug>`, where the key is 12 hex chars of `sha256(workspace)`) and its own port.

## Requirements

- A DeepSeek Harness host with a web profile.
- Vectr installed, with at least one project indexed by it. The binding needs a daemon that is already registered in `~/.vectr/instances.json`; the plugin does not install Vectr itself or build the initial index. Setup and CLI usage live in [Vectr's documentation](https://swapnanilsaha.com/tools/vectr).

## Install

From the directory that contains this checkout:

```sh
dsh plugin --profile web add ./dsh-vectr-client
```

From a git host (the repo commits its compiled `lib/`, so nothing is built on install):

```sh
dsh plugin --profile web add github:WinterSold1er/dsh-vectr-client
```

Remove with `dsh plugin --profile web remove dsh-vectr-client`.

`dsh plugin add` links the package into the profile and installs it; it does **not** edit the profile manifest. The package still has to be listed in the profile's `dsh.profile.bundles` — add it to the profile `package.json` yourself, or use the plugin-manager UI — so the loader enumerates it and applies `cordis.patch.yml` on the next boot. **Restart the host afterwards** — the `/api/vectr/*` routes and the Settings section register at boot, so an already-running host shows no console.

## How the binding works

1. `agent/created` — and every agent already live at startup — gives the plugin the session `cwd`.
2. `~/.vectr/instances.json` is keyed by `sha256(<absolute workspace path>)[:12]`. The lookup is: exact key, then an exact stored-path match (trailing-slash tolerant), then a prefix match so a directory *inside* a registered workspace resolves to that workspace.
3. The record is liveness-checked before binding: pid, TCP port, and `GET /v1/status` with a short budget.
4. Tools are registered in that agent's scope only. `agent/disposed` closes the connection and unwinds them.

A session with no `cwd` is skipped with a warning — deliberately no `process.cwd()` fallback, which would bind an agent to the wrong workspace. Details: `src/index.ts`, `src/registry.ts`.

## Settings → Vectr

The web half mounts a console (the server routes under `/api/vectr/*` live in the plugin):

- a summary strip: registered / live / memory-only / offline;
- one **card per workspace**: identity and full path, status + mode + readiness pills (the memory-only mode is always shown canonically), port / files / notes / languages, and the re-index action;
- expand a card for its codebases (test / start / delete) and a form to add one, bound to that workspace;
- real empty and error states — a failing endpoint shows its actual message instead of an empty table.

One honest note about the icon: the settings **rail** glyph is chosen by the harness host from a fixed id→icon map and falls back to the settings gear; a plugin cannot set it. The plugin's own mark appears inside the panel header and next to the input.

## Configuration

`cordis.patch.yml` inserts one row (`serverName: vectr`); override any key in your profile's patch file:

| Key | Default | Meaning |
|---|---|---|
| `instancesPath` | `~/.vectr/instances.json` | Daemon registry file |
| `serverName` | `vectr` | Tool namespace, `mcp__<serverName>__*` |
| `toolCallTimeoutMs` | `60000` | Per-call timeout for a Vectr tool |
| `reconnect.enabled` | `true` | Reconnect after a lost connection (same port) |
| `reconnect.initialDelayMs` / `maxDelayMs` / `maxAttempts` | `500` / `30000` / `10` | Backoff doubles per failure; `maxDelayMs` is also the uptime after which the attempt budget resets |
| `daemonHttpTimeoutMs` | `5000` | `/v1/status` probe budget |
| `daemonTcpTimeoutMs` | `300` | TCP port pre-check budget |
| `codebasesPath` | `~/.dsh/vectr-codebases.json` | Multi-codebase metadata |
| `secretsPath` | `~/.dsh/vectr-secrets.json` | File secret store (`0600`; the host credential service wins when present) |
| `cliPath` | derived from `PATH` | Custom `vectr` executable |
| `cliTimeoutMs` / `recallTimeoutMs` / `upgradeTimeoutMs` | `30000` / `10000` / `15000` | CLI, note-recall and workspace-upgrade budgets |

## Known limitations

- **First-request race** — the connection opens asynchronously, so a dead daemon can never block the agent; the very first prompt may run before the tools are registered. The next step has them.
- **A daemon that comes back on a different port is not re-resolved** — reconnect retries the same port; a new port is picked up by the next `agent/created`. Start a new session (or restart the host) after moving a daemon.
- **Binding failures are log-visible, not model-visible** — the agent simply gets no Vectr tools; the warning carries workspace/cwd/port/pid.
- **Tools only** — Vectr resources/prompts are not bridged.
- **The console needs a host restart** — routes and the web section register at boot. Host compositions without `ctx.webServer` skip them with a warning; the MCP binding is unaffected.

## Development

```sh
pnpm install
pnpm typecheck   # tsc --noEmit, host + client faces
pnpm test        # vitest
pnpm build       # tsc → lib/ (host + client)
```

`lib/` is committed so consumers need no build step. The `link:` dev dependencies point at a local harness checkout and embed absolute paths, which is why `pnpm-lock.yaml` and the workspace file are dev-only and gitignored — point the `link:` entries at your own checkout.

## Credits

- [Vectr](https://github.com/swapnanil/vectr) by [Swapnanil Saha](https://swapnanilsaha.com/tools/vectr) — the semantic index, the working-memory store and the daemon.
- This plugin is the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) integration around it.

## License

MIT — see `package.json`.
