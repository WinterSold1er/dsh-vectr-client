[简体中文](README.zh-CN.md)

# dsh-vectr-client

> **Based on Vectr**: Built upon [Vectr](https://github.com/swapnanil/vectr) by Swapnanil Saha ([Official Website & Documentation](https://swapnanilsaha.com/tools/vectr)).

Per-workspace vectr MCP binding **bundle** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): on every `agent/created` (and for already-live agents at startup) it resolves the agent's workspace (session `cwd`), looks up that workspace's vectr daemon port in `~/.vectr/instances.json`, connects a [Streamable HTTP](https://modelcontextprotocol.io/) MCP client to `http://localhost:<port>/mcp`, and registers the vectr tools (`mcp__vectr__*`) scoped to that agent only. `agent/disposed` closes the HTTP connection; the agent scope unwinds the tool registrations on its own.

Each workspace directory has its own vectr daemon (and port), so the binding is entirely derived from the agent's workspace — no global MCP config. Loading this bundle once in a profile covers every agent.

## Core Capabilities of Vectr

Vectr equips DeepSeek Harness agents with two foundational capabilities:

- **Semantic Search**: Fast, high-precision code and concept retrieval. Rather than guessing exact file paths or running exhaustive grep loops across large repositories, agents locate symbols, implementation patterns, and structural relationships by describing them in plain language.
- **Reliable Working Memory**:
  - **<50ms Sub-millisecond Recall**: Fetch stored findings, active decisions, and architectural invariants on demand with near-zero latency.
  - **Resilience to Context Compaction**: Working notes stored in Vectr survive context window trimming and conversation compaction, retaining precise function signatures and operational guidelines without degradation.
  - **Cross-Session Recovery**: Instantly pick up where prior sessions left off from turn 1, eliminating repetitive codebase rediscovery.
  - **Multi-Agent Shared Memory Bus**: Provides a durable, low-token handoff bus between orchestrators and subagents.

## Install

From the directory that contains this package:

```sh
dsh plugin --profile web add ./dsh-vectr-client
```

This links the checkout into the profile, appends `dsh-vectr-client` to `dsh.profile.bundles` (because the manifest declares `dsh.bundle`), and applies `cordis.patch.yml` on the next boot. Remove with `dsh plugin --profile web remove dsh-vectr-client`.

From a git host (the repo commits its compiled `lib/`, so no build step runs on install; the private repo needs GitHub credentials for the machine running pnpm):

```sh
dsh plugin --profile web add github:WinterSold1er/dsh-vectr-client
```

### Host bundle enablement (one-time, host side)

The bundle is **discovery-ready** out of the box — its `package.json` declares both `dsh.bundle.patch` (→ `cordis.patch.yml`, which inserts the `vectr-client` server row) and `dsh.client` (`platform: 'web'`, which the host's `dsh-client-modules` loader mounts as the browser console). It is not loaded until a profile *enumerates* it:

1. The package must be an installed dependency of the target profile (the `dsh plugin --profile web add` command above does this; a manual `pnpm add` into the profile package also works).
2. The profile's `package.json` must list it in `dsh.profile.bundles` — again done by `dsh plugin add`. The loader (`apps/cli/src/plugin.ts` → `reconcileBundles`) scans installed dependencies that declare `dsh.bundle` and composes their `cordis.patch.yml` layers over the profile tree.
3. Restart the host. The server row (MCP binding + `/api/vectr/*` routes) and the web console both register at boot; the section appears under **Settings → Vectr** (a top-level entry, alongside Plugins) only after restart.

**Verify:** after restart, `GET /api/vectr/workspaces` answers, and an agent whose workspace has a live vectr daemon registers `mcp__vectr__*` tools. No code change in this repo is required to enable it — only the host-side one-time `dsh plugin add` + restart.

> Constraints honored: this plugin does **not** modify the DSH harness source, `~/.dsh/profiles/web`, or the vectr binary; enablement is purely additive bundle configuration on the host profile.

## Config

| Field | Required | Description |
|---|---|---|
| `instancesPath` | no | Path of the vectr daemon registry (default `~/.vectr/instances.json`; an absolute path is used as-is, a relative path resolves against the process cwd) |
| `serverName` | no | Local namespace for the vectr tools, `mcp__<serverName>__*` (default `vectr`) |
| `toolCallTimeoutMs` | no | Timeout per vectr MCP tool call in ms (default `60000`) |
| `reconnect.enabled` | no | Reconnect automatically after a lost connection (default `false` — see Known Limitations) |
| `reconnect.initialDelayMs` | no | First reconnect delay in ms; doubles per consecutive failed attempt (default 500) |
| `reconnect.maxDelayMs` | no | Backoff ceiling in ms; also the uptime after which the attempt budget resets (default 30000) |
| `reconnect.maxAttempts` | no | Consecutive failed attempts per outage before giving up for good (default 10) |

The bundle patch inserts the row with `serverName: vectr`; users override any field in their profile's `cordis.patch.yml`.

## Workspace resolution

`~/.vectr/instances.json` maps `sha256(<absolute workspace path>)[:12]` to a daemon record (`workspace`, `port`, `pid`, `host`, …). For one agent, the plugin resolves its session `cwd` (`agent.session.header.cwd`; a session with no `cwd` is skipped with a warn and bound to nothing — there is deliberately no `process.cwd()` fallback, which would risk binding the agent to the wrong workspace's daemon) in this order:

1. Exact `sha256(cwd)[:12]` registry key.
2. Prefix match: the `cwd` is inside a listed workspace directory (`cwd` equals the stored workspace or starts with it plus a path separator).
3. String match on the stored `workspace`, trailing-slash tolerant.

No match logs `vectr-client: no vectr daemon for <cwd>, skipping` and the agent gets no vectr tools. A missing registry file logs `vectr-client: no daemon registry at <path>, skipping`; a present-but-unparseable registry is a misconfiguration and fails the plugin load loud.

## Behavior

- Seeds already-live agents at plugin load, then listens for `agent/created` / `agent/disposed`.
- The connection is started through the shared `dsh-mcp-client` supervisor (`startConnection`) with the **agent-scoped** context (`agent.ctx`), so every tool registration lands in that agent's tool layer: `mcp__vectr__vectr_search`, `mcp__vectr__vectr_locate`, `mcp__vectr__vectr_trace`, … appear only in the owning agent's view and unwind when the agent is disposed. The same `serverName` across agents is legal because the layers are per-scope.
- Connect failure is surfaced on the **agent-visible** logger when the session has one (`vectr-client: vectr connection failed for session <id> (cwd=…, port=…): …`), falling back to the loader-fiber logger otherwise; it never rejects the `agent/created` listener — a synchronous throw there would veto publication. The first prompt may therefore race tool discovery (see Known Limitations).
- A registry entry is **liveness-checked before binding** (see Known Limitations): a dead pid (or an unlistening port when no pid is recorded) is skipped with a warn carrying workspace/cwd/port/pid, and never blocks `agent/created`.
- The registry is **re-read on every `agent/created` and at seed time**, so a daemon restart that rewrites `instances.json` (new port/pid) is picked up without a Host reload.
- On teardown the plugin disposes every live connection handle (idempotent; `agent/disposed` and the effect disposer both call `dispose`).

## Services consumed

| Service | Usage |
|---|---|
| `ctx.agents` | List live agents, listen for `agent/created` / `agent/disposed` |
| `ctx.tools` (via `dsh-mcp-client`) | Register/unregister vectr tools in each agent's scope |
| `ctx.webServer` (optional, via `ctx.get`) | Host two management routes (see below); absent in headless harness compositions, where the console routes are skipped with a warn |

## Workspace console (feature A / C1)

The bundle also ships a **host data plane + browser console** for inspecting and re-indexing every vectr daemon in `~/.vectr/instances.json`. This is the "C1 同包双面" (same-bundle Node + web faces) implementation: the Node half registers HTTP routes and the web half mounts a React view as the top-level **Settings → Vectr** section (a tab bar hosts the workspace console and the codebase manager).

### Host routes (registered in the plugin's root scope)

- `GET /api/vectr/workspaces` — calls `scanWorkspaces(instancesPath)`: reads the registry, liveness-probes every entry, then concurrently `GET http://<host>:<port>/v1/status` (AbortSignal ~3s, `Promise.allSettled`). Returns an array of rows `{ workspace, port, pid?, mode?, live, error?, status? }`. One dead/unresponsive daemon never blocks the table; offline rows still appear with a reason.
- `POST /api/vectr/trigger-index` (body `{ "port": <n> }` or `{ "workspace": "<path>" }`) — resolves the single matching registry entry and calls `triggerIndex(entry)`: `POST /v1/index` body `{"force":false}`. It pre-flights `memory_only` / `search_only` modes and `fully_ready === false` (clear errors, no network call) and passes a daemon's 503 "reindex in progress" wording through verbatim.

Both handlers are Cordis effects, disposed with the plugin fiber. All data logic lives on the host; the browser half only fetches these same-origin relative paths.

### Browser view

The `dsh.client` dual-face declaration (`platform: 'web'`) makes the host load `lib/client.js` and mount `VectrSettings` into the `settings.section` slot (id `vectr`); the shell hosts `WorkspaceConsole` and the codebase manager behind a tab bar. It renders a table (workspace, online/offline + reason, port, pid, mode, indexed files, chunks, languages, last indexed, notes, fully_ready) with a per-row **re-index** button (disabled with a reason when offline / `memory_only` / `search_only` / `fully_ready === false` / `reindex_in_progress`) and a global **refresh** button.

### Deployment note

The web half and its routes take effect only after the **host process is restarted** (the `dsh.client` scan and the route registration run at boot). Until then the plugin still binds vectr tools normally; the console is simply absent. End-to-end (routes answering through host 3081, the tab mounting) is verified after a host restart — see Known Limitations.

## Session Button Deduplication & Mutual Exclusion

To prevent visual clutter, eliminate redundant UI triggers, and strictly adhere to workspace isolation principles:

- **Single Source of Truth**: The domain invariant `hasActiveSession(sessionId)` in `src/domain/rules.ts` acts as the pure authority across conversation components. It defensively filters out empty strings, whitespace, string literals `'null'` / `'undefined'`, and non-finite numbers (`NaN`, `Infinity`).
- **Active Session** (valid `sessionId`):
  - Top header capsule (`SessionHeaderAction` in `conversation.session.header.utilities`): Dynamically resolves `session.cwd` and displays live daemon status, mode, and port. When `session.cwd` is unresolved or not yet ready, it resets state to `null`, strictly avoids issuing background network requests, and does not open dialogues with a generic `.` fallback.
  - Input-adjacent action (`ConversationInputRightAction` in `conversation.input.right`): Yields and returns `null` to avoid duplicate action buttons.
- **Blank / New Session** (absent, empty, whitespace, or sentinel `sessionId`):
  - Input-adjacent action (`ConversationInputRightAction`): Renders as a pure, hook-free static trigger to open the Vectr management console.
  - Top header capsule (`SessionHeaderAction`): Returns `null` immediately and makes zero background network calls.

## Multi-codebase management (feature B)

Feature B extends the bundle to manage **multiple vectr daemons** — local ones started with `vectr start --path` and remote ones provisioned over `ssh` — and to register each one as its own host-level MCP server. The metadata file `~/.dsh/vectr-codebases.json` records every managed codebase; the secret store (`~/.dsh/vectr-secrets.json`, or the host `ctx.credentials` service when present) holds only the password ref — **the plaintext password never lands in the metadata file**.

### Host module (`src/codebases.ts`) — pure logic, injected side effects

Every external effect is injected so the whole surface is unit-testable with fakes:

- `spawnRunner` — wraps `node:child_process` `spawn`/`execFile` with no shell interpolation (no injection surface); used for `vectr start --path --json` / `vectr stop --port`.
- `sshRunner` — wraps `ssh` for remote probe, `uv tool install vectr`, remote `vectr start <path> --host 127.0.0.1`, and the local tunnel `ssh -f -N -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort> <host>`.
- `credStore` — `set`/`get`/`unset` over a ref; the value never leaves the store into metadata.
- `metaPath` — the metadata file path.

Core operations:

- `loadCodebases(metaPath)` — missing file → `[]`; malformed JSON → throws (misconfiguration fails loud); on load, the in-process server-name uniqueness registry is re-hydrated.
- `saveCodebases(metaPath, list)` — atomic write via tmp + `renameSync`, `0600` mode.
- `createCodebase(deps, metaPath, spec)`:
  - **local** — `vectr start --path <path> --json`; parses `{ status, port, pid, mcp_url }`; `status === 'failed'` → throw; exit ≠ 0 → throw; the derived `serverName` is `vectr_<slug>` and must match `^[A-Za-z0-9_-]{1,32}$` and be process-unique.
  - **remote** — ssh probe → `uv tool install vectr` (failure throws "install manually") → remote `vectr start <path> --host 127.0.0.1` → local `ssh -f -N -L …` tunnel; the password is stored via `credStore.set` *before* commands run; `tunnelPid` is recorded; any step failing cleans up what was already built (and unsets the stored secret).
- `deleteCodebase(deps, metaPath, entry)` — `vectr stop --port` (local) or ssh remote `vectr stop --port` + `ssh -O exit` on the tunnel control socket (fallback `process.kill(tunnelPid, 'SIGTERM')`) + remove from metadata + `credStore.unset`.

**Remote password auth** requires `sshpass` on the host PATH: password-auth codebases resolve the secret from `credStore` and the host `sshRunner` writes it to a `0600` temp file, then runs `sshpass -f <0600 temp file> ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no …`. The plaintext password never enters `argv` (visible in `ps` / `/proc`) or the process environment, and the temp file is unlinked once the `ssh` process exits — on both success and failure. Key-auth hosts (the default `auth: 'key'`) run plain `ssh` using already-configured keys and never touch the password. The tunnel is opened as an ssh control master (`-M -S <ctl>`); its PID is read reliably via `ssh -O check` (`Master running (pid=…)`) rather than the unreliable `Process ID <pid>` line, and the remote daemon port is read from the remote `~/.vectr/instances.json` (matched by workspace) with `vectr start` stdout scrape as fallback.
- `testCodebase(entry)` — `GET http://127.0.0.1:<localPort>/v1/status` with a 3s AbortController timeout.
- `CredentialStore` — `{ set, get, unset }`; `FileCredentialStore` is the 0600 fallback.

### Host routes (registered in the plugin's root scope)

- `GET /api/vectr/codebases` — list persisted entries (secrets stripped via `stripSecret`).
- `POST /api/vectr/codebases` (body `CodebaseSpec`) — create; the password is forwarded only to the store and never echoed back.
- `DELETE /api/vectr/codebases/:slug` — delete.
- `POST /api/vectr/codebases/:slug/test` — liveness probe.

On startup each `status === 'up'` codebase is also connected as its own `startConnection` (transport `streamable-http`, `serverName: vectr_<slug>`, `url: http://127.0.0.1:<localPort>/mcp`, `failOnStartupError: false`); a failed bind only warns and never blocks the main workspace. The plugin's teardown disposer kills any surviving tunnel PIDs.

### Browser view

The `dsh.client` web face mounts the **Codebase Manager** as the second tab inside the top-level **Settings → Vectr** section (alongside the workspace console). It renders a create form (type / path / host / slug / auth key|password + password field — the password is never read back or displayed) and a table with per-row **test** / **delete** actions.

### Configuration

| Field | Required | Description |
|---|---|---|
| `codebasesPath` | no | Path of the multi-codebase metadata file (default `~/.dsh/vectr-codebases.json`) |
| `secretsPath` | no | Path of the file-backed secret store (default `~/.dsh/vectr-secrets.json`; unused when the host `ctx.credentials` service is available) |
| `daemonHttpTimeoutMs` | no | HTTP `/v1/status` liveness-probe budget in ms (default `5000`); below the known hang window |
| `daemonTcpTimeoutMs` | no | TCP port-listening probe budget in ms (default `300`) |

## Development

The dev dependencies are `pnpm link:` entries into a local
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) monorepo checkout, so the lockfile and workspace file are dev-only: they embed absolute `link:` paths and are intentionally **not** committed (see `.gitignore`). A contributor installs them by pointing `package.json`'s `link:` entries at their own checkout (or running `pnpm link` from it).

```sh
pnpm install       # links the monorepo dsh packages this bundle builds against
pnpm run typecheck # tsc --noEmit on src/ (host + client faces)
pnpm test          # vitest (config schema, port resolution, scoped registration, Loader composition, workspace console, codebase management)
pnpm build         # tsc emits lib/index.js + lib/codebases.js (host) and lib/client/index.js (web face, bundles codebases.tsx)
```

The published package itself declares no bundled dev machinery: consumers need only the `peerDependencies` — `@deepseek-ai/cordis`, `@deepseek-ai/dsh-mcp-client`, `@deepseek-ai/dsh-agent` — which the host profile already resolves.

## Model Experience

### Scoped vectr tools

#### What the model sees

For an agent whose workspace has a vectr daemon, the vectr tool set appears as native tools named `mcp__vectr__<rawName>` (e.g. `mcp__vectr__vectr_search`) with the daemon's descriptions and input schemas. The tools are visible only to that agent; other agents and unscoped views never see them. Disposal of the agent or the plugin removes them.

#### Token effect

Data-dependent schema cost is paid on every request while the tools are registered in the agent's scope. The `mcp__vectr__`-qualified names add tokens to every tool definition and call.

#### KV Cache effect

Prefix-stable while the vectr daemon's advertised tool set and schemas are unchanged. A re-sync that changes a schema replaces definitions and may invalidate reuse from the first changed token; a reconnect that recovers an unchanged list stays prefix-stable.

## Known Limitations and Deferred Work

- **First-request race** — the connection is started asynchronously inside the `agent/created` listener (never awaited, so a connection failure cannot veto publication); the first prompt's tool set may miss the vectr tools if the initial discovery has not settled. A call that fails for this reason should be retried on the next step, when the tools are registered. `conn.ready` always settles even under `failOnStartupError: false` (verified against `packages/mcp/mcp-client/src/connection.ts`: the `ready` promise resolves with the outcome — success `{}` or `{ error }` — after the first attempt, regardless of reconnect), so the plugin never hangs on a dead daemon.
- **Port changes on daemon restart are not re-resolved** — reconnect is disabled by default; a vectr daemon that restarts on a different port leaves the old connection dead and no re-registration until the next session (reconnect, when enabled, retries the same port). A daemon that rewrites `instances.json` with a new port *is* picked up by the next `agent/created`, since the registry is re-read per call.
- **Connect failures are agent-visible, not model-visible** — a failed bind logs on the session logger (and the loader logger as fallback) with cwd/port/error, but the model is not otherwise told; the agent simply gets no vectr tools until connection succeeds.
- **Daemon absent/dead → silent skip (now diagnosed)** — an agent whose workspace has no vectr entry, or whose entry points at a dead pid/unlistening port, simply has no vectr tools; the skip is a warn carrying workspace/cwd/port/pid, so a missing or crashed daemon is at least diagnosable in logs rather than invisible.
- **Same `serverName` across agents is legal** — every agent's tools live in its own scope layer; there is no global `mcp__vectr__*` reservation and no conflict.
- **Tools are the only bridged capability** — vectr Resources/Prompts (if any appear) have no harness consumer; this bundle bridges only the tool set, consistent with `dsh-mcp-client`.
- **Console routes/tab need a host restart** — the `dsh.client` declaration and the `/api/vectr/*` route registration run at boot; loading this bundle into an already-running host shows no console until the host is restarted. The route registration is also a no-op in harness compositions that do not provide `ctx.webServer` (it degrades with a warn, and the MCP-binding path is unaffected). End-to-end verification of the routes and the Settings → Vectr section is therefore pending a host restart, not a code gap.
