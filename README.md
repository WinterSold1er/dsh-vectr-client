# dsh-vectr-client

Per-workspace vectr MCP binding **bundle** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): on every `agent/created` (and for already-live agents at startup) it resolves the agent's workspace (session `cwd`), looks up that workspace's vectr daemon port in `~/.vectr/instances.json`, connects a [Streamable HTTP](https://modelcontextprotocol.io/) MCP client to `http://localhost:<port>/mcp`, and registers the vectr tools (`mcp__vectr__*`) scoped to that agent only. `agent/disposed` closes the HTTP connection; the agent scope unwinds the tool registrations on its own.

Each workspace directory has its own vectr daemon (and port), so the binding is entirely derived from the agent's workspace — no global MCP config. Loading this bundle once in a profile covers every agent.

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

## Development

The dev dependencies are `pnpm link:` entries into a local
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) monorepo checkout, so the lockfile and workspace file are dev-only: they embed absolute `link:` paths and are intentionally **not** committed (see `.gitignore`). A contributor installs them by pointing `package.json`'s `link:` entries at their own checkout (or running `pnpm link` from it).

```sh
pnpm install       # links the monorepo dsh packages this bundle builds against
pnpm run typecheck # tsc --noEmit on src/
pnpm test          # vitest (config schema, port resolution, scoped registration, Loader composition)
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
