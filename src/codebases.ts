/**
 * Multi-codebase management for the vectr-client plugin (feature B).
 *
 * This module is pure logic: every side effect (spawning vectr, running ssh,
 * storing secrets, resolving free ports) is injected by the caller so the whole
 * surface is unit-testable with fakes. The on-disk metadata file
 * (`~/.dsh/vectr-codebases.json`) records only non-secret fields and a
 * `credentialRef` pointing at the secret store; the secret value itself is
 * never written to that file.
 *
 * @module dsh-vectr-client/codebases
 */

import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { isPortListening } from './probe'
import { WORKSPACE_KEY_LENGTH, resolveInstance, type InstancesFile } from './registry'

/** TCP connect budget for the `isPortListening` liveness check of the FORWARDED
 * local port (ms) — used by `ensureTunnelUp` purely to decide
 * reuse-vs-reallocate of `localPort`. This is NOT the ssh control-master
 * liveness path: `ssh -O check` (the authoritative up/down signal) has its own
 * `-o ConnectTimeout=5` and is independent of this budget. */
export const DEFAULT_TUNNEL_PROBE_MS = 800

/** Reserved local tunnel-bind port range (inclusive). Both `createCodebase` and
 * `ensureTunnelUp` allocate from this same window so the forwarded
 * Streamable-HTTP endpoints stay in one predictable band. Shared as a constant
 * so the two call sites cannot drift apart. */
export const TUNNEL_PORT_MIN = 8760
export const TUNNEL_PORT_MAX = 8799

/** Discriminant for where a codebase's vectr daemon runs. */
export type CodebaseType = 'local' | 'remote'

/** How a remote host authenticates (informational; the secret lives in the store). */
export type CodebaseAuth = 'key' | 'password'

/** Input description of a codebase to create. */
export interface CodebaseSpec {
  /** Where the daemon runs. */
  type: CodebaseType
  /** Absolute workspace path served by the daemon. */
  path: string
  /** Owning workspace (absolute). Local == `path`; remote == the remote workspace the daemon serves. Composite `serverName` is derived from this + `slug`. */
  workspace?: string
  /** Remote host (`user@host` or `host`) for `type === 'remote'`. */
  host?: string
  /** Remote auth method. */
  auth?: CodebaseAuth
  /** Plaintext password for `auth === 'password'`; consumed, never persisted here. */
  password?: string
  /** Stable short identifier, also used to derive `serverName`. */
  slug: string
}

/** Runtime / persisted record of one managed codebase. */
export interface CodebaseEntry {
  /** `slug` (stable identifier). */
  id: string
  /** `slug` duplicate field kept for callers expecting `id` + `slug`. */
  slug: string
  /** Where the daemon runs. */
  type: CodebaseType
  /** Absolute workspace path served by the daemon. */
  path: string
  /** Remote host for `type === 'remote'`. */
  host?: string
  /** Owning workspace (absolute); enables per-workspace binding isolation. Local == `path`; remote == the remote workspace. */
  workspace?: string
  /** Derived MCP server name (`vectr_<sha256(workspace)[:12]>_<slug>`) — globally unique across workspaces. */
  serverName: string
  /** Local Streamable HTTP port the host connects to (tunnel endpoint / daemon port). */
  localPort?: number
  /** Remote daemon port for `type === 'remote'`. */
  remotePort?: number
  /** PID of the ssh tunnel process for `type === 'remote'`. */
  tunnelPid?: number
  /** Control-socket path of the ssh tunnel master (`-M -S`); reliable PID query + clean teardown. */
  tunnelCtl?: string
  /** Reference into the credential store (never the value). */
  credentialRef?: string
  /** Connection status. */
  status: 'up' | 'down' | 'error'
  /** Last error detail when `status === 'error'`. */
  error?: string
}

/**
 * Secret store seam. Implemented either by a wrapper over `ctx.credentials`
 * (async host service) or a {@link FileCredentialStore} fallback. Only
 * `set`/`get`/`unset` of a `ref` are needed by this module; the secret value
 * never appears in the metadata file.
 */
export interface CredentialStore {
  /** Store a secret value under `ref`. */
  set(ref: string, value: string): Promise<void> | void
  /** Read a secret value by `ref`, or `undefined` when absent. */
  get(ref: string): Promise<string | undefined> | string | undefined
  /** Remove a secret value by `ref`. */
  unset(ref: string): Promise<void> | void
}

/** Result of a local `vectr start --json` invocation. */
interface VectrStartResult {
  status: string
  port?: number
  pid?: number
  mcp_url?: string
  [key: string]: unknown
}

/**
 * Spawned-process runner. Mirrors `child_process.spawn` semantics: returns a
 * handle whose `promise` resolves with `{ code, stdout, stderr }`.
 */
export interface SpawnHandle {
  /** Resolves when the process exits. */
  promise: Promise<{ code: number; stdout: string; stderr: string }>
  /** Kill the process (e.g. to clean up a partially-started daemon). */
  kill(): void
}

/** Function that spawns a local vectr command. */
export type SpawnRunner = (command: string, args: string[]) => SpawnHandle

/** Auth context the ssh runner may need to satisfy (e.g. password hosts). */
export interface SshAuthContext {
  /** Plaintext password for password-auth hosts; the runner feeds it to ssh (e.g. via sshpass). */
  password?: string
}

/** Function that spawns an ssh command (used for remote probe / install / start / tunnel). */
export type SshRunner = (args: string[], auth?: SshAuthContext) => SpawnHandle

/** Dependencies injected into the management functions (kept minimal / faked in tests). */
export interface CodebaseDeps {
  /** Local vectr runner. */
  spawnRunner: SpawnRunner
  /** Remote ssh runner. */
  sshRunner: SshRunner
  /** Secret store. */
  credStore: CredentialStore
}

/** Validation regex for a slug (also used to derive `serverName`). */
export const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Default metadata file location. */
export const DEFAULT_CODEBASES_FILE = join(homedir(), '.dsh', 'vectr-codebases.json')

/**
 * In-process set of taken `serverName`s, enforcing global uniqueness across
 * create calls within one process (per spec). Reset between logical sessions is
 * the caller's responsibility; the registry is module-level by design.
 */
const takenServerNames = new Set<string>()

/** Clear the in-process server-name registry (test helper). */
export function _resetServerNameRegistry(): void {
  takenServerNames.clear()
}

/**
 * In-progress create locks keyed by slug. A second concurrent `createCodebase`
 * for the same slug awaits the in-flight one and then re-validates the slug, so
 * two simultaneous creates of the same slug cannot both register (which would
 * collide on the derived `serverName` / daemon registration).
 */
const createLocks = new Map<string, Promise<CodebaseEntry>>()

/** Ports reserved by in-flight `createCodebase` calls (TOCTOU guard for `findFreePort`). */
const inProgressLocalPorts = new Set<number>()

/**
 * Per-slug self-heal locks. A second concurrent `ensureTunnelUp` for the same
 * slug awaits the in-flight one and returns its result, so a startup
 * `void ensureTunnelUp` and a user-initiated `testCodebase` heal racing on the
 * same slug cannot both reopen the tunnel and collide on the bound `localPort`
 * (EADDRINUSE / ctl-exists -> spurious `'error'`). See {@link ensureTunnelUp}.
 */
const healLocks = new Map<string, Promise<EnsureTunnelResult>>()

/** Sentinel `workspace` for old entries that cannot be inferred during migration. */
export const UNASSIGNED_WORKSPACE = '__unassigned__'

/**
 * Derive the MCP server name from an owning workspace + slug. The workspace is
 * hashed (sha256, first {@link WORKSPACE_KEY_LENGTH} hex chars — the same key
 * vectr writes into `~/.vectr/instances.json`) so two workspaces may reuse the
 * same slug while still getting globally-unique server names (binding isolation
 * at the MCP-registration layer). Reuses the registry's key length constant so
 * the two never drift.
 * @param workspace - absolute owning workspace path.
 * @param slug - the codebase slug.
 * @returns `vectr_<workspaceKey>_<slug>`.
 */
/**
 * C2: only remove a file we actually own under a controlled base directory.
 * A corrupted/absent `tunnelCtl` (or any meta-derived path) must never let us
 * `rmSync` an arbitrary file on disk. We resolve and require the target to be
 * strictly inside `base`; otherwise throw instead of deleting.
 * @param path - candidate path to remove.
 * @param base - the only directory under which removal is permitted.
 */
export function safeRemove(path: string, base: string): void {
  const safeBase = resolve(base)
  const target = resolve(path)
  if (!target.startsWith(`${safeBase}${sep}`)) {
    throw new Error(`vectr-client: refusing to remove ${path}: outside controlled dir ${base}`)
  }
  rmSync(target, { force: true })
}

export function deriveServerName(workspace: string, slug: string): string {
  const key = createHash('sha256').update(workspace).digest('hex').slice(0, WORKSPACE_KEY_LENGTH)
  return `vectr_${key}_${slug}`
}

/**
 * Validate a slug and its derived server name, enforcing the format and the
 * in-process uniqueness invariant (composite key: workspace + slug).
 * @param workspace - absolute owning workspace path.
 * @param slug - candidate slug.
 * @throws when the slug is malformed or its composite server name is already taken.
 */
export function assertServerNameAvailable(workspace: string, slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`invalid slug "${slug}": must match ${String(SLUG_PATTERN)}`)
  }
  const serverName = deriveServerName(workspace, slug)
  if (takenServerNames.has(serverName)) {
    throw new Error(`server name "${serverName}" is already in use (workspace "${workspace}" + slug "${slug}" conflicts)`)
  }
}

/**
 * Read the codebase metadata file. A missing file yields `[]`; a malformed file
 * throws with a clear diagnostic (misconfiguration must fail loud).
 * @param metaPath - absolute path of the metadata JSON.
 * @returns the parsed entries.
 */
export function loadCodebases(metaPath: string): CodebaseEntry[] {
  if (!existsSync(metaPath)) return []
  let text: string
  try {
    text = readFileSync(metaPath, 'utf8')
  } catch (error) {
    throw new Error(`vectr-client: failed to read ${metaPath}: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`vectr-client: failed to parse ${metaPath}: ${String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`vectr-client: ${metaPath} must be a JSON array of codebase entries`)
  }
  // Re-hydrate the in-process uniqueness registry so a fresh process that
  // loads an existing file still rejects duplicate server names on create.
  for (const entry of parsed as CodebaseEntry[]) {
    if (typeof entry.serverName === 'string') takenServerNames.add(entry.serverName)
  }
  return parsed as CodebaseEntry[]
}

/**
 * Atomically write the codebase metadata file (tmp + rename, 0600). The secret
 * value is never present in `list` — only `credentialRef`.
 * @param metaPath - absolute path to write.
 * @param list - entries to persist.
 */
export function saveCodebases(metaPath: string, list: CodebaseEntry[]): void {
  const dir = dirname(metaPath)
  mkdirSync(dir, { recursive: true })
  const tmp = `${metaPath}.${process.pid}.tmp`
  const payload = JSON.stringify(list, null, 2)
  writeFileSync(tmp, payload, { mode: 0o600 })
  renameSync(tmp, metaPath)
  // Best-effort: ensure final mode is 0600 even if umask interfered.
  try {
    writeFileSync(metaPath, payload, { mode: 0o600 })
  } catch {
    // rename already committed the content; ignore re-write failure.
  }
}

/**
 * Find the first free TCP port in `[min, max]`. Implemented by attempting to
 * `listen` and immediately `close`; the OS assigns a port when we pass 0, but
 * here we bind the candidate to detect occupancy.
 * @param min - first candidate port (inclusive).
 * @param max - last candidate port (inclusive).
 * @returns the first free port, or `undefined` when none are free.
 */
export async function findFreePort(min = TUNNEL_PORT_MIN, max = TUNNEL_PORT_MAX, exclude?: Set<number>): Promise<number | undefined> {
  const { createServer } = await import('node:net')
  for (let port = min; port <= max; port++) {
    if (exclude?.has(port)) continue
    const free = await new Promise<boolean>((resolveFree) => {
      const server = createServer()
      server.once('error', () => resolveFree(false))
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolveFree(true))
      })
    })
    if (free) return port
  }
  return undefined
}

/**
 * Create a codebase: spawn (local) or ssh-provision + tunnel (remote), then
 * persist the entry. Any partial failure cleans up what was already built.
 * @param deps - injected runners / store.
 * @param metaPath - metadata file path to persist into.
 * @param spec - the codebase to create.
 * @returns the created entry.
 */
export async function createCodebase(
  deps: CodebaseDeps,
  metaPath: string,
  spec: CodebaseSpec,
): Promise<CodebaseEntry> {
  // P4: serialize concurrent creates for the same slug via a per-slug lock.
  // If a create for this slug is already in flight, wait for it to settle and
  // re-validate the slug (the winner may have claimed the server name), so two
  // concurrent creates of the same slug cannot both register.
  const prev = createLocks.get(spec.slug)
  if (prev !== undefined) {
    await prev
    assertServerNameAvailable(spec.workspace ?? spec.path, spec.slug)
  }
  const run = (async () => {
    try {
      return await createCodebaseCore(deps, metaPath, spec)
    } finally {
      createLocks.delete(spec.slug)
    }
  })()
  createLocks.set(spec.slug, run)
  return run
}

/**
 * Build argv for a remote shell command that must resolve the uv-installed
 * `vectr` binary WITHOUT depending on the remote non-interactive ssh PATH.
 *
 * Non-interactive ssh exposes only `/usr/local/sbin:/usr/local/bin:/usr/bin`
 * (no `~/.local/bin`), so a bare `vectr` fails with "command not found"
 * (confirmed on the conan trial host: `bash: line 1: vectr: command not
 * found`). We prepend an explicit PATH export to a single remote-shell command
 * string; `$HOME`/`$PATH` are expanded by the remote login shell. `uv` itself
 * lives at `/usr/bin/uv` (on the default PATH), so wrapping it here is
 * harmless and keeps every remote tool invocation uniform.
 *
 * ponytail: single-string form; workspace paths without spaces assumed (this
 * plugin serves absolute workspace paths that do not contain spaces in
 * practice). If quoted-path support is ever needed, switch to per-arg quoting.
 */
function remoteShellCmd(host: string, command: string): string[] {
  // Tokenize into shell words (paths without spaces assumed) and prepend an
  // explicit PATH export so `vectr` resolves under non-interactive ssh. Kept
  // as a token list (not a single string) so callers/tests can still match
  // individual command words. The remote shell joins the words with spaces,
  // yielding `export PATH=... && <command>` — equivalent to the single-string
  // form.
  return [host, 'export', 'PATH=$HOME/.local/bin:$PATH', '&&', ...command.split(' ')]
}

async function createCodebaseCore(
  deps: CodebaseDeps,
  metaPath: string,
  spec: CodebaseSpec,
): Promise<CodebaseEntry> {
  const workspace = spec.workspace ?? spec.path
  // B2: a remote codebase's `workspace` is the CALLER's local cwd — it cannot be
  // inferred from the remote `path` (a different machine). The client must report
  // it at create time (阶段2 UI). Refuse remote entries that omit it so we never
  // silently bind a remote entry to the wrong (remote) workspace. Local entries
  // default `workspace` to `path`, which is correct.
  if (spec.type === 'remote' && spec.workspace === undefined) {
    throw new Error('remote codebase requires an explicit workspace (the caller local cwd); server-side isolation cannot infer it')
  }
  assertServerNameAvailable(workspace, spec.slug)
  const serverName = deriveServerName(workspace, spec.slug)

  if (spec.type === 'local') {
    const handle = deps.spawnRunner('vectr', ['start', '--path', spec.path, '--json'])
    const result = await handle.promise
    if (result.code !== 0) {
      takenServerNames.delete(serverName)
      throw new Error(`vectr start failed (exit ${result.code}): ${result.stderr}`)
    }
    let parsed: VectrStartResult
    try {
      parsed = JSON.parse(result.stdout) as VectrStartResult
    } catch (error) {
      takenServerNames.delete(serverName)
      throw new Error(`vectr start returned non-JSON stdout: ${String(error)}`)
    }
    if (parsed.status === 'failed') {
      takenServerNames.delete(serverName)
      throw new Error(`vectr start reported failed status: ${result.stderr}`)
    }
    if (typeof parsed.port !== 'number') {
      takenServerNames.delete(serverName)
      throw new Error('vectr start did not report a port')
    }
    const entry: CodebaseEntry = {
      id: spec.slug,
      slug: spec.slug,
      type: 'local',
      path: spec.path,
      workspace,
      serverName,
      localPort: parsed.port,
      status: 'up',
    }
    takenServerNames.add(serverName)
    persist(metaPath, entry)
    return entry
  }

  // remote
  if (spec.host === undefined) {
    takenServerNames.delete(serverName)
    throw new Error('remote codebase requires a host')
  }
  // 1) connectivity probe. For password-auth hosts the password is threaded
  // through the injected ssh runner (which feeds it to ssh via sshpass), and
  // `BatchMode=yes` is dropped (it would disable password auth); key-auth hosts
  // keep `BatchMode=yes` to fail fast when no key is configured.
  let credentialRef: string | undefined
  let sshPassword: string | undefined
  if (spec.auth === 'password') {
    // Store the secret under a ref BEFORE issuing any command, so a later step
    // failure can unset it. The plaintext is also resolved back out for injection
    // into the ssh session (password-auth hosts need it; key-auth hosts ignore it).
    credentialRef = `VECTR_SSH_${spec.slug.toUpperCase()}`
    if (spec.password !== undefined) await deps.credStore.set(credentialRef, spec.password)
    const resolved = await deps.credStore.get(credentialRef)
    sshPassword = typeof resolved === 'string' ? resolved : spec.password
  }
  // P8: password auth but no resolvable password must fail loud, NOT silently
  // downgrade to key auth (which would then fail the probe with a misleading
  // "cannot reach" error). The caller must supply a password for password-auth.
  if (spec.auth === 'password' && sshPassword === undefined) {
    takenServerNames.delete(serverName)
    throw new Error(`password auth requested for ${spec.host ?? spec.slug} but no password was provided`)
  }
  const sshAuth: SshAuthContext | undefined = sshPassword !== undefined ? { password: sshPassword } : undefined
  const ssh = (args: string[]): SpawnHandle => deps.sshRunner(args, sshAuth)

  const probe = ssh(sshPassword !== undefined
    ? ['-o', 'ConnectTimeout=5', spec.host, 'true']
    : ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', spec.host, 'true'])
  const probeResult = await probe.promise
  if (probeResult.code !== 0) {
    takenServerNames.delete(serverName)
    if (credentialRef !== undefined) await deps.credStore.unset(credentialRef)
    throw new Error(`cannot reach ${spec.host}: ${probeResult.stderr || `exit ${probeResult.code}`}`)
  }
  // 2) install vectr remotely (idempotent). `uv tool install` returns non-zero
  // when vectr is ALREADY installed (known uv behavior), which previously
  // aborted a retried create at this step. Probe first with `uv tool list` and
  // skip the install when vectr is present; only then attempt the install, and
  // tolerate uv's "already installed" non-zero exit instead of failing the
  // whole create.
  const list = ssh(remoteShellCmd(spec.host, 'uv tool list'))
  const listResult = await list.promise
  const alreadyInstalled = listResult.code === 0 && /\bvectr\b/i.test(listResult.stdout)
  if (!alreadyInstalled) {
    const install = ssh(remoteShellCmd(spec.host, 'uv tool install vectr'))
    const installResult = await install.promise
    if (installResult.code !== 0) {
      const msg = `${installResult.stdout}\n${installResult.stderr}`
      // Tolerate uv's "already installed" exit; only hard-fail on a real error.
      if (!/\balready installed\b|\bup to date\b|\brequirements already satisfied\b/i.test(msg)) {
        takenServerNames.delete(serverName)
        if (credentialRef !== undefined) await deps.credStore.unset(credentialRef)
        throw new Error(`failed to install vectr on ${spec.host} (install manually): ${installResult.stderr}`)
      }
    }
  }
  // 3) start remote daemon bound to loopback (PATH-injected so non-interactive
  // ssh, whose PATH lacks ~/.local/bin, can still resolve the uv-installed binary)
  const start = ssh(remoteShellCmd(spec.host, `vectr start ${spec.path} --host 127.0.0.1`))
  const startResult = await start.promise
  if (startResult.code !== 0) {
    takenServerNames.delete(serverName)
    if (credentialRef !== undefined) await deps.credStore.unset(credentialRef)
    throw new Error(`failed to start vectr on ${spec.host}: ${startResult.stderr}`)
  }
  // 4) resolve the remote daemon port. Preferred: read the remote
  // `~/.vectr/instances.json` over ssh and match by workspace (the daemon writes
  // its real port there). Fallback: scrape `vectr start` stdout. There is NO
  // silent magic default: if both resolvers fail the daemon's real port is
  // genuinely unknown, so we clean up what was already allocated and fail loud
  // (改动3) instead of binding the tunnel to a dead port.
  //
  // NOTE (C4, retry semantics): the remote vectr daemon is intentionally LEFT
  // RESIDENT — it is a long-lived service, NOT a per-create ephemeral process.
  // On a retried `create` for the same workspace we must NOT start a second
  // daemon; instead `resolveRemotePort` reads the remote `instances.json` FIRST
  // and reuses the already-assigned port (the `vectr start` in step 3 is a
  // no-op/idempotent when the daemon is already up). Querying the registry before
  // falling back to stdout is what makes a retry safe rather than a duplicate.
  const remotePort = (await resolveRemotePort(ssh, spec.host, spec.path)) ?? parseRemotePort(startResult.stdout)
  if (remotePort === undefined) {
    // The tunnel/port steps below must not run with an undefined port. Roll back
    // the already-reserved server name and any stored credential, then throw with
    // a self-diagnosing message naming the host and workspace (no 8760 fallback).
    takenServerNames.delete(serverName)
    if (credentialRef !== undefined) await deps.credStore.unset(credentialRef)
    throw new Error(
      `could not resolve remote vectr daemon port on ${spec.host} for workspace ${spec.path}: `
      + `~/.vectr/instances.json had no matching entry and 'vectr start' reported no port. `
      + `Verify the remote daemon is running and writing its registry.`,
    )
  }
  // 5) open the tunnel; pick the first free local port in the reserved range.
  const localPort = await findFreePort(TUNNEL_PORT_MIN, TUNNEL_PORT_MAX, inProgressLocalPorts)
  if (localPort === undefined) {
    takenServerNames.delete(serverName)
    if (credentialRef !== undefined) await deps.credStore.unset(credentialRef)
    throw new Error(`no free local tunnel port in range ${TUNNEL_PORT_MIN}-${TUNNEL_PORT_MAX}`)
  }
  // Reserve the port for the duration of this create so a concurrent create in
  // the same process cannot probe-and-bind the same port (TOCTOU between
  // findFreePort's probe and the tunnel's actual bind).
  inProgressLocalPorts.add(localPort)
  try {
  // 6) open the SSH tunnel as a control master (`-M -S <ctl>`). The control
  // socket lets us read the master PID reliably (`ssh -O check`) and tear the
  // tunnel down cleanly later (`ssh -O exit`), instead of relying on the
  // unreliable "Process ID <pid>" line that `ssh -f` sometimes prints.
  const ctl = join(tmpdir(), `vectr-tunnel-${spec.slug}-${process.pid}.sock`)
  const tunnel = ssh(['-o', 'ConnectTimeout=5', '-o', 'ExitOnForwardFailure=yes', '-f', '-N', '-M', '-S', ctl, '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, spec.host])
  const tunnelResult = await tunnel.promise
  if (tunnelResult.code !== 0) {
    takenServerNames.delete(serverName)
    if (credentialRef !== undefined) await deps.credStore.unset(credentialRef)
    throw new Error(`failed to open tunnel to ${spec.host}: ${tunnelResult.stderr}`)
  }
  // Query the master PID through the control socket. `ssh -f -N -M` may not
  // have finished the master handshake the instant the `ssh` process exits, so
  // a single `ssh -O check` can transiently fail (exit != 0, no pid) — retrying
  // a few times with small backoff absorbs that race. If the PID still can't
  // be read after retries we fall back to the legacy "Process ID <pid>" scrape
  // of the tunnel-open stdout, then proceed: teardown keys off `tunnelCtl`
  // (see deleteCodebase), so a failed read never orphans the tunnel.
  let tunnelPid: number | undefined
  for (let attempt = 0; attempt < 3; attempt++) {
    const check = ssh(['-o', 'ConnectTimeout=5', '-O', 'check', '-S', ctl, spec.host])
    const checkResult = await check.promise
    const pid = tunnelPidFrom(checkResult.stdout)
    if (pid !== undefined) {
      tunnelPid = pid
      break
    }
    if (checkResult.code !== 0 && attempt < 2) {
      await new Promise((resolveBackoff) => setTimeout(resolveBackoff, 50 * (attempt + 1)))
      continue
    }
    tunnelPid = tunnelPidFrom(tunnelResult.stdout)
    break
  }
  const entry: CodebaseEntry = {
    id: spec.slug,
    slug: spec.slug,
    type: 'remote',
    path: spec.path,
    workspace,
    host: spec.host,
    serverName,
    localPort,
    remotePort,
    ...(tunnelPid !== undefined ? { tunnelPid } : {}),
    ...(ctl !== undefined ? { tunnelCtl: ctl } : {}),
    ...(credentialRef !== undefined ? { credentialRef } : {}),
    status: 'up',
  }
  takenServerNames.add(serverName)
  persist(metaPath, entry)
  return entry
  } finally {
    inProgressLocalPorts.delete(localPort)
  }
}

/**
 * Extract a tunnel master PID from ssh output. Preferred: `ssh -O check` prints
 * `Master running (pid=<pid>)`. Fallback: some `ssh -f` builds print
 * `Process ID <pid>` on fork — parsed defensively and never fails when absent.
 */
function tunnelPidFrom(stdout: string): number | undefined {
  const master = /Master running \(pid=(\d+)\)/.exec(stdout)
  if (master !== null && master[1] !== undefined) return Number(master[1])
  const legacy = /Process ID (\d+)/.exec(stdout)
  if (legacy !== null && legacy[1] !== undefined) return Number(legacy[1])
  return undefined
}

/**
 * Resolve a remote vectr daemon's port by reading its `~/.vectr/instances.json`
 * over ssh and matching the entry by workspace path. Returns `undefined` when
 * the file is unreadable or has no matching entry, so the caller can fall back
 * to scraping `vectr start` stdout.
 * @param ssh - injected ssh runner (already carrying auth context).
 * @param host - `user@host` remote target.
 * @param workspace - absolute workspace path the remote daemon serves.
 */
async function resolveRemotePort(
  ssh: (args: string[]) => SpawnHandle,
  host: string,
  workspace: string,
): Promise<number | undefined> {
  // The `cat` runs on the REMOTE host, so the path must be the remote user's
  // home. A literal `~` is expanded by the remote login shell to that user's
  // `$HOME` (e.g. conan's `/home/edogawaconan/.vectr/instances.json`); using
  // the local `homedir()` would point `cat` at a path that does not exist on
  // the remote, making the read fail silently and fall back to stdout/8760.
  const cat = ssh([host, 'cat', '~/.vectr/instances.json'])
  const result = await cat.promise
  if (result.code !== 0) return undefined
  try {
    const registry = JSON.parse(result.stdout) as Record<string, { workspace?: string; port?: number }>
    const match = Object.values(registry).find(
      e => e !== null && typeof e === 'object' && e.workspace === workspace,
    )
    if (match?.port !== undefined) return match.port
  } catch {
    // malformed remote registry; fall through to stdout parse
  }
  return undefined
}

/** Best-effort parse of a remote `vectr start` port line. */
function parseRemotePort(stdout: string): number | undefined {
  const match = /"port"\s*:\s*(\d+)/.exec(stdout)
  if (match !== null && match[1] !== undefined) return Number(match[1])
  const m2 = /port[=:]\s*(\d+)/i.exec(stdout)
  if (m2 !== null && m2[1] !== undefined) return Number(m2[1])
  return undefined
}

/**
 * Append or replace an entry in the metadata file.
 * @param metaPath - metadata file path.
 * @param entry - entry to upsert (matched by `slug`).
 */
function persist(metaPath: string, entry: CodebaseEntry): void {
  const list = loadCodebases(metaPath).filter(e => e.slug !== entry.slug)
  list.push(entry)
  saveCodebases(metaPath, list)
}

/**
 * Delete a codebase: stop the daemon (local or remote), kill the tunnel, and
 * remove the entry from metadata.
 * @param deps - injected runners.
 * @param metaPath - metadata file path.
 * @param entry - the entry to delete.
 */
export async function deleteCodebase(
  deps: CodebaseDeps,
  metaPath: string,
  entry: CodebaseEntry,
): Promise<void> {
  if (entry.type === 'local') {
    if (entry.localPort !== undefined) {
      const stop = deps.spawnRunner('vectr', ['stop', '--port', String(entry.localPort)])
      await stop.promise
    }
  } else {
    // 1) Tear down the SSH tunnel FIRST. Teardown keys off the control socket
    //    (`ssh -O exit -S <ctl>`) so it never depends solely on `tunnelPid`; a
    //    transient `-O check` race at create time can leave `tunnelPid` unset
    //    while the master (and its socket) is still alive. The PID kill is only a
    //    best-effort fallback for entries built by older revisions that stored no
    //    socket. The tunnel is a transport only — its teardown is independent of
    //    the remote stop below, which opens its OWN ssh connection to the host.
    if (entry.tunnelCtl !== undefined) {
      try {
        await deps.sshRunner(['-O', 'exit', '-S', entry.tunnelCtl, entry.host ?? '']).promise
      } catch {
        // control-socket exit failed; fall through to the PID kill below.
      }
    }
    if (entry.tunnelPid !== undefined) {
      try {
        process.kill(entry.tunnelPid, 'SIGTERM')
      } catch {
        // tunnel already gone; ignore.
      }
    }
    // 2) Stop the REMOTE daemon. It listens on `entry.remotePort` (the port the
    //    conan daemon actually binds), NOT `entry.localPort` (our local tunnel
    //    endpoint). Stopping via `localPort` is a silent no-op: `vectr stop
    //    --port <localPort>` reaches nothing on the remote host, leaving the
    //    remote daemon (pid on conan) and its `~/.vectr/instances.json` entry
    //    orphaned. The PATH export makes `vectr` resolve under non-interactive
    //    ssh (whose PATH lacks `~/.local/bin`). The daemon's own `stop` removes
    //    its instances.json entry — the plugin must NEVER hand-write that file.
    if (entry.remotePort !== undefined) {
      const stop = deps.sshRunner(remoteShellCmd(entry.host ?? '', `vectr stop --port ${entry.remotePort}`))
      await stop.promise
    }
  }
  const list = loadCodebases(metaPath).filter(e => e.slug !== entry.slug)
  saveCodebases(metaPath, list)
  takenServerNames.delete(entry.serverName)
  if (entry.credentialRef !== undefined) await deps.credStore.unset(entry.credentialRef)
}

/**
 * Probe a codebase's local MCP endpoint for liveness.
 * @param entry - the entry to test (uses `localPort`).
 * @returns `{ ok, status? }` on success or `{ ok: false, error }` on failure.
 */
/**
 * Result of probing a remote codebase's SSH tunnel for liveness.
 */
export interface TunnelHealth {
  /** `true` only when the ssh control master answers `ssh -O check` (the
   * AUTHORITATIVE liveness signal). The forwarded local port's TCP state is
   * deliberately NOT a fallback here — see {@link probeTunnel}. */
  alive: boolean
  /** Why the tunnel is judged dead (present only when `alive === false`). */
  reason?: string
}

/**
 * Probe whether a remote codebase's SSH tunnel is currently live — without
 * mutating anything. Liveness is derived from the AUTHORITATIVE signal only:
 *
 *  `ssh -O check -S <tunnelCtl> <host>` — asks the ssh control master directly.
 *  A 0 exit means the master process is alive; any other result (including a
 *  missing control socket) means the tunnel is down.
 *
 * The forwarded local port's TCP state is deliberately NOT used as a liveness
 * signal here: a listening port only proves *some* process holds `localPort`,
 * not that the ssh master is up, so it would both lie about status and make the
 * `findFreePort` reallocation in {@link ensureTunnelUp} unreachable. The bind
 * availability of `localPort` is checked separately, inside `ensureTunnelUp`,
 * purely to decide reuse-vs-reallocate. Treating `status:'up'` as "the master is
 * alive" is exactly the 问题1B truth-correction.
 *
 * Local (`type === 'local'`) entries have no tunnel and return
 * `{ alive: false, reason: 'not-remote' }` so callers treat them as "nothing to
 * heal" rather than "dead tunnel".
 *
 * @param entry - the remote entry to probe.
 * @param deps - injected ssh runner.
 */
export async function probeTunnel(entry: CodebaseEntry, deps: CodebaseDeps): Promise<TunnelHealth> {
  if (entry.type !== 'remote') return { alive: false, reason: 'not-remote' }
  if (entry.tunnelCtl === undefined && entry.localPort === undefined) {
    return { alive: false, reason: 'no-tunnel-config' }
  }
  // Authoritative: ask the ssh control master via its socket. A missing socket
  // (the real vnm_gui case) makes ssh exit non-zero -> tunnel down.
  if (entry.tunnelCtl !== undefined && entry.host !== undefined) {
    const check = deps.sshRunner(['-o', 'ConnectTimeout=5', '-O', 'check', '-S', entry.tunnelCtl, entry.host])
    const result = await check.promise
    if (result.code === 0) return { alive: true }
  }
  return { alive: false, reason: 'tunnel-down' }
}

/** Result of {@link ensureTunnelUp}. */
export interface EnsureTunnelResult {
  /** The (possibly updated) entry — `localPort`/`tunnelCtl`/`status` may change. */
  entry: CodebaseEntry
  /** `true` when a dead tunnel was actually reopened. */
  healed: boolean
  /** Diagnostic when the tunnel could not be brought up (and status was downgraded). */
  error?: string
}

/**
 * Ensure a remote codebase's SSH tunnel is up, reopening it when dead. This is
 * the self-healing fix for the "tunnel died, `status:'up'` lied" production
 * defect (问题1B):
 *
 *  - If {@link probeTunnel} reports the tunnel alive, return the entry unchanged
 *    (`healed: false`) — no churn.
 *  - If dead, reopen `ssh -f -N -M -S <ctl> -L 127.0.0.1:<localPort>:127.0.0.1:
 *    <remotePort> <host>` — the SAME `localPort` is reused when still free
 *    (so the persisted MCP endpoint URL stays stable), otherwise
 *    {@link findFreePort} allocates a fresh one and the meta is updated so every
 *    consumer (routes, binds) sees the new port.
 *  - On any reopen failure the persisted `status` is downgraded to `'error'`
 *    with a self-diagnosing `error` message instead of being left claiming
 *    `'up'` (no more lying). The same message is returned as `error` so callers
 *    (e.g. `testCodebase`) can surface it directly.
 *
 * Password-auth codebases resolve their secret from `credentialRef` so the
 * reopen feeds it back to the ssh runner (via sshpass) exactly like the initial
 * create. Key-auth entries pass `undefined` auth.
 *
 * NOTE (forwarding semantics): `localPort` is the LOCAL bind on this machine;
 * `remotePort` is the conan daemon port the tunnel forwards to. A local daemon
 * listening on 8767 does NOT conflict with a local tunnel bind on 8760 — they
 * are different addresses (ponytail: comment only, the ssh `-L` tuple is
 * authoritative).
 *
 * @param deps - injected runners / store.
 * @param metaPath - metadata file to persist status/port changes into.
 * @param entry - the (persisted) remote entry to bring up.
 */
export async function ensureTunnelUp(
  deps: CodebaseDeps,
  metaPath: string,
  entry: CodebaseEntry,
): Promise<EnsureTunnelResult> {
  if (entry.type !== 'remote') return { entry, healed: false }
  // Serialize concurrent heals for the same slug (A1): a second in-flight heal
  // is awaited and its result shared, so the loser gets the winner's
  // already-up entry instead of colliding on the bound localPort.
  const inFlight = healLocks.get(entry.slug)
  if (inFlight !== undefined) return inFlight
  const run = (async () => {
    try {
      return await healTunnelOnce(deps, metaPath, entry)
    } finally {
      healLocks.delete(entry.slug)
    }
  })()
  healLocks.set(entry.slug, run)
  return run
}

/**
 * Bring a single dead tunnel back up. No concurrency guard — callers go through
 * {@link ensureTunnelUp}, which serializes by slug. This worker does probe +
 * reopen + persist.
 */
async function healTunnelOnce(
  deps: CodebaseDeps,
  metaPath: string,
  entry: CodebaseEntry,
): Promise<EnsureTunnelResult> {
  // C1: reuse the authoritative {@link probeTunnel} instead of an inline
  // duplicate. Master liveness (问题1B) is the signal: when the same control
  // master answers `ssh -O check`, the tunnel is alive. BUT B1: a master can be
  // UP while its forwarded local port is DEAD (remote restarted; `-O check`
  // still 0 but the `-L` port is gone). So reuse only when masterUp AND the
  // forward port actually listens; otherwise tear the stale master down and
  // reopen (a dead forward bound to an agent is the silent-dead defect).
  const masterUp = (await probeTunnel(entry, deps)).alive
  if (masterUp) {
    if (entry.localPort !== undefined
      && await isPortListening('127.0.0.1', entry.localPort, DEFAULT_TUNNEL_PROBE_MS)) {
      return { entry, healed: false }
    }
    // Master up but the forward is dead: cleanly exit the stale master so the
    // reopen below binds a fresh one instead of colliding with the still-alive
    // process (which would otherwise refuse its socket / leak the old master).
    if (entry.tunnelCtl !== undefined && entry.host !== undefined) {
      try {
        await deps.sshRunner(['-o', 'ConnectTimeout=5', '-O', 'exit', '-S', entry.tunnelCtl, entry.host]).promise
      } catch {
        // best-effort; a missing control socket is exactly what we clear.
      }
    }
  }

  // Resolve auth (password hosts store the secret under credentialRef).
  let auth: SshAuthContext | undefined
  if (entry.credentialRef !== undefined) {
    const pw = await deps.credStore.get(entry.credentialRef)
    if (typeof pw === 'string' && pw.length > 0) auth = { password: pw }
  }
  const ssh = (args: string[]): SpawnHandle => deps.sshRunner(args, auth)

  if (entry.remotePort === undefined) {
    const msg = 'tunnel down: no remotePort recorded; cannot reopen forward'
    downgrade(metaPath, entry, msg)
    return { entry: { ...entry, status: 'error', error: msg }, healed: false, error: msg }
  }

  // B1: a tunnel forwards to a host; an undefined host would hand ssh a bogus
  // target and fail the reopen with a cryptic error instead of a clear one.
  if (entry.host === undefined) {
    const msg = 'tunnel down: no host recorded; cannot reopen forward'
    downgrade(metaPath, entry, msg)
    return { entry: { ...entry, status: 'error', error: msg }, healed: false, error: msg }
  }

  // Master is dead: clear any stale control socket so `-M -S` does not refuse
  // ("ControlSocket ... already exists") on a socket whose master is gone. C2:
  // only remove a socket we own under tmpdir — never an arbitrary path.
  if (entry.tunnelCtl !== undefined) {
    try {
      safeRemove(entry.tunnelCtl, tmpdir())
    } catch {
      // best-effort; a missing / already-gone / out-of-bounds socket is skipped.
    }
  }

  // Reuse the existing localPort when still free; otherwise allocate a fresh
  // one and record it so every consumer sees the new endpoint. The "port
  // occupied" trigger is gated on `!masterUp` (already true here) so a
  // healthy-but-listening localPort is never mistaken for a collision and
  // reallocated.
  let localPort = entry.localPort
  if (localPort === undefined || (!masterUp && await isPortListening('127.0.0.1', localPort, DEFAULT_TUNNEL_PROBE_MS))) {
    const fresh = await findFreePort(TUNNEL_PORT_MIN, TUNNEL_PORT_MAX, new Set([...inProgressLocalPorts, ...(localPort !== undefined ? [localPort] : [])]))
    if (fresh === undefined) {
      const msg = `tunnel down: no free local port in range ${TUNNEL_PORT_MIN}-${TUNNEL_PORT_MAX}`
      downgrade(metaPath, entry, msg)
      return { entry: { ...entry, status: 'error', error: msg }, healed: false, error: msg }
    }
    localPort = fresh
  }

  // Reserve the port for the duration of the reopen so a concurrent
  // heal/create in this process cannot probe-and-bind the same port (A1, TOCTOU
  // guard). Cleared in finally even when a downgrade path returns early.
  inProgressLocalPorts.add(localPort)
  try {
    const ctl = entry.tunnelCtl ?? join(tmpdir(), `vectr-tunnel-${entry.slug}-${process.pid}.sock`)
    const host = entry.host
    // A2: bound the reopen with ConnectTimeout (unreachable host fails fast
    // instead of hanging /test for minutes) and ExitOnForwardFailure (a failed
    // local bind surfaces as a non-zero exit rather than a silent dead master).
    const tunnel = ssh([
      '-o', 'ConnectTimeout=5', '-o', 'ExitOnForwardFailure=yes',
      '-f', '-N', '-M', '-S', ctl,
      '-L', `127.0.0.1:${localPort}:127.0.0.1:${entry.remotePort}`, host,
    ])
    const result = await tunnel.promise
    if (result.code !== 0) {
      const msg = `tunnel down: ssh tunnel open failed (exit ${result.code}): ${result.stderr || result.stdout}`
      downgrade(metaPath, entry, msg)
      return { entry: { ...entry, status: 'error', error: msg }, healed: false, error: msg }
    }

    // Confirm the master came up (it may not have finished the handshake the
    // instant `ssh -f` returned), capturing its PID for clean teardown later.
    let alive = false
    let tunnelPid: number | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      // A2: the confirm `ssh -O check` also gets ConnectTimeout so a dead
      // control socket fails fast instead of blocking.
      const check = ssh(['-o', 'ConnectTimeout=5', '-O', 'check', '-S', ctl, host])
      const checkResult = await check.promise
      const pid = tunnelPidFrom(checkResult.stdout)
      if (pid !== undefined) { tunnelPid = pid }
      if (checkResult.code === 0) { alive = true; break }
      if (attempt < 2) await new Promise((resolveBackoff) => setTimeout(resolveBackoff, 50 * (attempt + 1)))
    }
    if (!alive) {
      const msg = 'tunnel down: ssh master did not come up after reopen'
      downgrade(metaPath, entry, msg)
      return { entry: { ...entry, status: 'error', error: msg }, healed: false, error: msg }
    }

    // Capture the silent-dead case: the master answered `-O check` (so `alive`
    // is true) but the forwarded local port never actually bound. A lying 'up'
    // here would bind an agent to a dead endpoint. Verify the forward is really
    // listening before we persist 'up'.
    if (!await isPortListening('127.0.0.1', localPort, DEFAULT_TUNNEL_PROBE_MS)) {
      const msg = `tunnel down: forward on 127.0.0.1:${localPort} did not bind after reopen`
      downgrade(metaPath, entry, msg)
      return { entry: { ...entry, status: 'error', error: msg }, healed: false, error: msg }
    }

    // Drop any prior downgrade reason now that the tunnel is up again.
    const { error: _omit, ...entryWithoutError } = entry
    void _omit
    const updated: CodebaseEntry = {
      ...entryWithoutError,
      localPort,
      tunnelCtl: ctl,
      status: 'up',
      ...(tunnelPid !== undefined ? { tunnelPid } : {}),
    }
    persist(metaPath, updated)
    return { entry: updated, healed: true }
  } finally {
    inProgressLocalPorts.delete(localPort)
  }
}

/**
 * Downgrade a persisted entry's `status` to `'error'` with a diagnostic, but
 * NEVER let a persistence failure mask the real diagnostic (B3). The reopen
 * already failed; a `saveCodebases` throw must not turn the caller's
 * `try/catch` (testCodebase route has none) into a bare 500. We swallow the
 * persist error and still return the in-memory downgraded entry + diagnostic.
 */
function downgrade(metaPath: string, entry: CodebaseEntry, msg: string): void {
  try {
    persist(metaPath, { ...entry, status: 'error', error: msg })
  } catch {
    // Persistence failed, but the diagnostic is the return value's `error`;
    // do not rethrow (B3).
  }
}

/** Result of {@link migrateCodebases}. */
export interface MigrateResult {
  /** `true` when at least one entry was rewritten (persisted). */
  changed: boolean
  /** Number of entries rewritten this run. */
  migrated: number
}

/**
 * Idempotently backfill the `workspace` field and recompute the composite
 * `serverName` for entries written before per-workspace isolation existed.
 * Runs once at plugin apply (best-effort). Existing entries that already carry a
 * `workspace` matching their composite `serverName` are left untouched, so a
 * second run is a no-op (no rewrite, no churn).
 *
 * Inference for entries missing `workspace`:
 *  - local: reverse-lookup the workspace via `resolveInstance(instances, path)`
 *    (the daemon whose `instances.json` workspace equals `path`).
 *  - remote: match `host` against `instances[].host`.
 *  - either fails → {@link UNASSIGNED_WORKSPACE}.
 *
 * The on-disk envelope stays a bare `CodebaseEntry[]` (no schema change).
 * @param metaPath - absolute path of the codebase metadata file.
 * @param instances - parsed vectr daemon registry (for workspace inference).
 * @returns whether anything changed and how many entries were migrated.
 */
export function migrateCodebases(
  metaPath: string,
  instances: InstancesFile,
  logger?: { warn(message: string): void },
): MigrateResult {
  // A2: an empty/undefined registry cannot infer local workspaces; writing would
  // stamp every entry UNASSIGNED and poison the sticky "already defined" field so
  // the migration never retries. Skip (no write) until a real registry exists.
  if (instances == null || Object.keys(instances).length === 0) {
    return { changed: false, migrated: 0 }
  }
  const list = loadCodebases(metaPath)
  let changed = false
  let migrated = 0
  // B3: planned server names for THIS run, so two entries that collapse to the
  // same composite name (e.g. two remote entries both forced UNASSIGNED) are
  // de-duplicated instead of silently colliding in the MCP registry.
  const plannedNames = new Set<string>()
  for (const entry of list) {
    let workspace = entry.workspace
    if (workspace === undefined) {
      if (entry.type === 'local') {
        workspace = resolveInstance(instances, entry.path)?.workspace ?? UNASSIGNED_WORKSPACE
      } else {
        // A1: InstanceEntry.host is the daemon BIND address (default 127.0.0.1),
        // while entry.host is the SSH TARGET (e.g. 'conan'); the two never match,
        // so the old `e.host === entry.host` lookup always failed (and would have
        // mis-assigned a remote entry to a LOCAL workspace had it ever matched).
        // Remote migration cannot infer workspace — the old remote entry must be
        // rebuilt / manually re-assigned by the client (which reports its
        // workspace at create time, 阶段2). Force UNASSIGNED.
        workspace = UNASSIGNED_WORKSPACE
      }
    }
    let expectedName = deriveServerName(workspace, entry.slug)
    // B3: collision -> force UNASSIGNED and suffix the serverName so the MCP
    // registry stays unique (a duplicate serverName would clobber the bind).
    if (plannedNames.has(expectedName)) {
      logger?.warn(
        `vectr-client: migrate ${entry.slug}: serverName "${expectedName}" collides with another entry; `
        + 'leaving UNASSIGNED + disambiguation suffix',
      )
      workspace = UNASSIGNED_WORKSPACE
      expectedName = deriveServerName(workspace, `${entry.slug}-${plannedNames.size}`)
    }
    plannedNames.add(expectedName)
    if (workspace === UNASSIGNED_WORKSPACE) {
      // A2: stamping an entry UNASSIGNED is a real, actionable outcome, not a
      // silent success — the operator must rebuild / re-assign it.
      logger?.warn(`vectr-client: migrate ${entry.slug}: workspace could not be inferred; set to UNASSIGNED (rebuild or re-assign)`)
    }
    if (entry.workspace !== workspace || entry.serverName !== expectedName) {
      entry.workspace = workspace
      entry.serverName = expectedName
      changed = true
      migrated += 1
    }
  }
  if (changed) {
    saveCodebases(metaPath, list)
    // Re-hydrate the in-process uniqueness registry so a subsequent create in the
    // same process sees the recomputed composite server names.
    takenServerNames.clear()
    for (const e of list) takenServerNames.add(e.serverName)
  }
  return { changed, migrated }
}

/** Options for {@link testCodebase}. */
export interface TestCodebaseOpts {
  /** Injected runners/store — required when `heal` is set. */
  deps?: CodebaseDeps
  /** Metadata file path — required when `heal` is set (to persist any reopen). */
  metaPath?: string
  /** Self-heal the tunnel before probing (问题1B): a dead tunnel is reopened
   * rather than producing a bare ECONNREFUSED fetch error. Heal failure yields a
   * diagnostic `{ ok: false, error: 'tunnel down: ...' }`. */
  heal?: boolean
}

/**
 * Probe a codebase's local MCP endpoint for liveness. When `opts.heal` is set
 * and the entry is a remote whose tunnel is down, the tunnel is brought back up
 * first (see {@link ensureTunnelUp}); a heal that fails short-circuits with the
 * diagnostic instead of hitting `fetch`.
 * @param entry - the entry to test (uses `localPort`).
 * @param opts - optional self-heal / injection.
 * @returns `{ ok, status? }` on success or `{ ok: false, error }` on failure.
 */
export async function testCodebase(
  entry: CodebaseEntry,
  opts?: TestCodebaseOpts,
): Promise<{ ok: boolean; status?: unknown; error?: string }> {
  if (entry.localPort === undefined) {
    return { ok: false, error: 'no local port configured' }
  }
  // Self-heal the tunnel before probing (问题1B). A dead tunnel must not surface
  // as a bare fetch error — surface a diagnostic, or reopen and proceed.
  if (opts?.heal && opts.deps !== undefined && opts.metaPath !== undefined) {
    const res = await ensureTunnelUp(opts.deps, opts.metaPath, entry)
    if (!res.healed && res.error !== undefined) {
      return { ok: false, error: res.error }
    }
    entry = res.entry
    if (entry.localPort === undefined) return { ok: false, error: 'no local port configured' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(`http://127.0.0.1:${entry.localPort}/v1/status`, { signal: controller.signal })
    if (!res.ok) return { ok: false, error: `status ${res.status}` }
    const status = await res.json()
    return { ok: true, status }
  } catch (error) {
    return { ok: false, error: String(error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * File-backed secret store with atomic 0600 writes, used when no
 * `ctx.credentials` service is available. Secrets are stored as
 * `{ "<ref>": "<value>" }` — never in the codebase metadata file.
 */
export class FileCredentialStore implements CredentialStore {
  /** Absolute path of the secrets JSON file. */
  readonly path: string

  /** @param path - absolute secrets file path (defaults to `~/.dsh/vectr-secrets.json`). */
  constructor(path: string = join(homedir(), '.dsh', 'vectr-secrets.json')) {
    this.path = path
  }

  private readAll(): Record<string, string> {
    if (!existsSync(this.path)) return {}
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      return parsed as Record<string, string>
    } catch {
      return {}
    }
  }

  private writeAll(data: Record<string, string>): void {
    const dir = dirname(this.path)
    mkdirSync(dir, { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(tmp, this.path)
    try {
      writeFileSync(this.path, JSON.stringify(data, null, 2), { mode: 0o600 })
    } catch {
      // rename committed content; ignore.
    }
  }

  set(ref: string, value: string): void {
    const data = this.readAll()
    data[ref] = value
    this.writeAll(data)
  }

  get(ref: string): string | undefined {
    return this.readAll()[ref]
  }

  unset(ref: string): void {
    const data = this.readAll()
    if (!(ref in data)) return
    delete data[ref]
    this.writeAll(data)
  }
}

/** Remove a metadata file entirely (used in tests / reset). */
export function _removeMeta(metaPath: string): void {
  try {
    rmSync(metaPath)
  } catch {
    // ignore
  }
}

/**
 * Best-effort cleanup of stale tunnel control sockets left behind when a
 * previous plugin process crashed (the master ssh process is gone but its
 * `vectr-tunnel-*.sock` remains in tmpdir). A socket is considered stale when
 * the node process that created it (pid encoded in the filename) is no longer
 * alive; live tunnels of the current process are left untouched. Every error is
 * swallowed — this is a startup hygiene step, never fatal.
 *
 * ponytail: pid-based heuristic — it verifies only that the *owning node process*
 * is dead, not that the ssh master itself is gone. If a node process dies while
 * its ssh master somehow outlives it, the socket would be skipped. To tighten,
 * attempt `ssh -O check -S <sock> <host>` once host is known, but that needs the
 * remote host which this function does not have, so the pid heuristic is the
 * pragmatic default.
 */
export function cleanupStaleTunnelSockets(dir: string = tmpdir()): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  const re = /^vectr-tunnel-.*-(\d+)\.sock$/
  let removed = 0
  for (const name of names) {
    const m = re.exec(name)
    if (m === null || m[1] === undefined) continue
    const pid = Number(m[1])
    if (pid === process.pid) continue
    // Owning process alive -> its tunnel is still in use; leave it.
    try {
      process.kill(pid, 0)
      continue
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') continue // not ours to touch (e.g. EPERM)
    }
    // C2: only remove a socket resolved strictly inside `dir`; a meta-polluted
    // name with '..' is collapsed by resolve() and rejected by safeRemove.
    try {
      safeRemove(join(dir, name), dir)
      removed += 1
    } catch {
      // best-effort
    }
  }
  return removed
}
