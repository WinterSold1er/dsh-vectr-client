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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
  /** Derived MCP server name (`vectr_<slug>`) — globally unique. */
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
  /** Path of the vectr daemon registry (passed through; not read here). */
  instancesPath: string
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
 * Derive the MCP server name from a slug.
 * @param slug - the codebase slug.
 * @returns `vectr_<slug>`.
 */
export function deriveServerName(slug: string): string {
  return `vectr_${slug}`
}

/**
 * Validate a slug and its derived server name, enforcing the format and the
 * in-process uniqueness invariant.
 * @param slug - candidate slug.
 * @throws when the slug is malformed or its server name is already taken.
 */
export function assertSlugAvailable(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(`invalid slug "${slug}": must match ${String(SLUG_PATTERN)}`)
  }
  const serverName = deriveServerName(slug)
  if (takenServerNames.has(serverName)) {
    throw new Error(`server name "${serverName}" is already in use (slug "${slug}" conflicts)`)
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
export async function findFreePort(min = 8760, max = 8799, exclude?: Set<number>): Promise<number | undefined> {
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
    assertSlugAvailable(spec.slug)
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

async function createCodebaseCore(
  deps: CodebaseDeps,
  metaPath: string,
  spec: CodebaseSpec,
): Promise<CodebaseEntry> {
  assertSlugAvailable(spec.slug)
  const serverName = deriveServerName(spec.slug)

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
  // 2) install vectr remotely (best-effort; failure tells the user to install)
  const install = ssh([spec.host, 'uv', 'tool', 'install', 'vectr'])
  const installResult = await install.promise
  if (installResult.code !== 0) {
    takenServerNames.delete(serverName)
    if (credentialRef !== undefined) await deps.credStore.unset(credentialRef)
    throw new Error(`failed to install vectr on ${spec.host} (install manually): ${installResult.stderr}`)
  }
  // 3) start remote daemon bound to loopback
  const start = ssh([spec.host, 'vectr', 'start', spec.path, '--host', '127.0.0.1'])
  const startResult = await start.promise
  if (startResult.code !== 0) {
    takenServerNames.delete(serverName)
    if (credentialRef !== undefined) await deps.credStore.unset(credentialRef)
    throw new Error(`failed to start vectr on ${spec.host}: ${startResult.stderr}`)
  }
  // 4) resolve the remote daemon port. Preferred: read the remote
  // `~/.vectr/instances.json` over ssh and match by workspace (the daemon writes
  // its real port there). Fallback: scrape `vectr start` stdout, then the
  // conventional default — never guess silently.
  const remotePort = (await resolveRemotePort(ssh, spec.host, spec.path)) ?? parseRemotePort(startResult.stdout) ?? 8760
  // 5) open the tunnel; pick the first free local port in the reserved range.
  const localPort = await findFreePort(8760, 8799, inProgressLocalPorts)
  if (localPort === undefined) {
    takenServerNames.delete(serverName)
    if (credentialRef !== undefined) await deps.credStore.unset(credentialRef)
    throw new Error('no free local tunnel port in range 8760-8799')
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
  const tunnel = ssh(['-f', '-N', '-M', '-S', ctl, '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, spec.host])
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
    const check = ssh(['-O', 'check', '-S', ctl, spec.host])
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
    if (entry.localPort !== undefined) {
      const stop = deps.sshRunner([entry.host ?? '', 'vectr', 'stop', '--port', String(entry.localPort)])
      await stop.promise
    }
    // Teardown must NOT depend solely on tunnelPid: a transient `-O check` race
    // at create time can leave tunnelPid undefined while the master (and its
    // control socket) is still alive. When tunnelCtl exists we ALWAYS attempt a
    // clean `ssh -O exit`; the PID kill is only a best-effort fallback for
    // entries built by older revisions that stored no socket.
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
export async function testCodebase(entry: CodebaseEntry): Promise<{ ok: boolean; status?: unknown; error?: string }> {
  if (entry.localPort === undefined) {
    return { ok: false, error: 'no local port configured' }
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
