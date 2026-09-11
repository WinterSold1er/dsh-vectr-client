import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveReconnectPolicy, startConnection } from "@deepseek-ai/dsh-mcp-client/src/connection.ts";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { connect } from "node:net";
/** Default path of the vectr daemon registry, inside the user's home. */
const DEFAULT_INSTANCES_FILE = join(homedir(), ".vectr", "instances.json");
/**
* Resolve the vectr daemon record for one workspace, following the same
* registry conventions vectr writes: exact sha256(cwd)[:12] key first, then a
* prefix match (cwd inside a listed workspace directory), then a
* trailing-slash-tolerant string match on the stored workspace path.
* @param instances - parsed `instances.json` records.
* @param cwd - absolute workspace directory of the agent.
* @returns the matching daemon record, or `undefined` when no entry applies.
*/
function resolveInstance(instances, cwd) {
	const exact = instances[createHash("sha256").update(cwd).digest("hex").slice(0, 12)];
	if (exact !== void 0) return exact;
	const normalizedCwd = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
	const candidates = Object.values(instances);
	const prefix = candidates.find((entry) => {
		const stored = entry.workspace.endsWith("/") ? entry.workspace.slice(0, -1) : entry.workspace;
		return stored.length > 0 && (normalizedCwd === stored || normalizedCwd.startsWith(`${stored}/`));
	});
	if (prefix !== void 0) return prefix;
	return candidates.find((entry) => {
		return (entry.workspace.endsWith("/") ? entry.workspace.slice(0, -1) : entry.workspace) === normalizedCwd;
	});
}
/**
* Read and parse the vectr daemon registry file. A missing file means "no
* vectr daemons"; a present-but-unparseable file is a misconfiguration and
* fails loud (the caller decides whether to skip or throw).
* @param ctx - context carrying the logger (registry read diagnostics).
* @param instancesPath - absolute path of `instances.json`.
* @returns the parsed records, or `undefined` when the file does not exist.
*/
function readInstancesFile(ctx, instancesPath) {
	let text;
	try {
		text = readFileSync(instancesPath, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") {
			ctx.logger.info(`vectr-client: no daemon registry at ${instancesPath}, skipping`);
			return;
		}
		throw new Error(`vectr-client: failed to read ${instancesPath}: ${String(error)}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`vectr-client: failed to parse ${instancesPath}: ${String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`vectr-client: ${instancesPath} must be a JSON object mapping workspace keys to daemon records`);
	return parsed;
}
/**
* TCP liveness probe for a vectr daemon endpoint.
* @param host - bind host.
* @param port - TCP port of the daemon's endpoint.
* @param timeoutMs - connect timeout before declaring the port dead.
* @returns `true` when a TCP connection opens within the budget, else `false`.
*/
function isPortListening(host, port, timeoutMs = 300) {
	return new Promise((resolveAlive) => {
		const socket = connect(port, host, () => {
			socket.destroy();
			resolveAlive(true);
		});
		const onError = () => {
			socket.destroy();
			resolveAlive(false);
		};
		socket.once("error", onError);
		socket.setTimeout(timeoutMs, () => {
			socket.destroy();
			resolveAlive(false);
		});
	});
}
/**
* Fetch `/v1/status` from one daemon, returning `undefined` on any transport
* failure or non-2xx so the caller can decide how to render the row. This is
* the single HTTP probe reused by both the liveness gate (R3) and the console
* scan; do not re-implement the HTTP detection elsewhere.
* fetchStatus swallows *all* transport/parse errors and returns `undefined`, so in
* production it never throws — meaning a live daemon whose answer merely times
* out surfaces as `HTTP_PROBE_UNREACHABLE` (undefined), not `HTTP_PROBE_TIMEOUT`.
* The `HTTP_PROBE_TIMEOUT` reason (throw path) is only reached when an *injected*
* `httpProbe` throws (test seam), never by `fetchStatus` itself. This is a
* deliberate semantic boundary: production never emits HTTP_PROBE_TIMEOUT, but
* correctness is unaffected because both reasons yield `alive: false`.
* @param entry - the daemon registry record.
* @param timeoutMs - abort budget for the request.
* @returns the parsed status object, or `undefined` on failure.
*/
async function fetchStatus(entry, timeoutMs) {
	const host = entry.host ?? "127.0.0.1";
	const controller = new AbortController();
	const timer = setTimeout$1(timeoutMs).then(() => controller.abort());
	try {
		const res = await fetch(`http://${host}:${entry.port}/v1/status`, { signal: controller.signal });
		if (!res.ok) return void 0;
		return await res.json();
	} catch {
		return;
	} finally {
		timer.catch(() => {});
	}
}
/**
* Combined liveness diagnosis (requirement R3):
*
*   processLayer = (pid present AND kill(pid,0) succeeds)
*               OR (TCP port listening)
*   httpLayer    = httpProbe(entry, httpTimeoutMs) !== undefined
*   alive        = processLayer AND httpLayer
*
* A "pid alive + port listening but HTTP hung" daemon fails `httpLayer` and is
* judged dead. The injected `httpProbe` is wrapped so any throw is treated as a
* hang (the gate never propagates an exception, NFR4/R4).
*
* @param entry - the daemon record to validate.
* @param deps - injected probe + timeouts.
* @returns the diagnosis (alive flag + optional reason).
*/
async function diagnoseDaemon(entry, deps) {
	const host = entry.host ?? "127.0.0.1";
	if (typeof entry.pid === "number") try {
		process.kill(entry.pid, 0);
	} catch (error) {
		const code = error?.code;
		if (code === "ESRCH" || code === "ENOENT") return {
			alive: false,
			reason: "PROCESS_DEAD_ESRCH"
		};
	}
	else if (!await isPortListening(host, entry.port, deps.tcpTimeoutMs)) return {
		alive: false,
		reason: "PORT_CLOSED"
	};
	try {
		if (await deps.httpProbe(entry, deps.httpTimeoutMs) === void 0) return {
			alive: false,
			reason: "HTTP_PROBE_UNREACHABLE"
		};
		return { alive: true };
	} catch {
		return {
			alive: false,
			reason: "HTTP_PROBE_TIMEOUT"
		};
	}
}
/**
* Liveness gate boolean (requirement R3). Thin wrapper over
* {@link diagnoseDaemon} for callers that only need the verdict.
* @param entry - the daemon record to validate.
* @param deps - injected probe + timeouts.
* @returns `true` only when process layer AND HTTP layer both pass.
*/
async function isDaemonAlive(entry, deps) {
	return (await diagnoseDaemon(entry, deps)).alive;
}
/**
* Build the workspace console table: read the registry, liveness-probe each
* entry, then concurrently fetch `/v1/status` from every live daemon.
*
* A missing registry file yields an empty list (no daemons configured). A
* dead record still appears as a row with `live: false` and a reason, so the
* operator sees stale entries instead of a silent gap. One unresponsive daemon
* never blocks the others: the status fetch uses `Promise.allSettled` and
* tolerates a missing/partial status payload.
*
* @param ctx - plugin context carrying the logger (registry read diagnostics).
* @param instancesPath - absolute path of `instances.json`.
* @param opts - optional per-call tuning (`statusTimeoutMs`).
* @returns one {@link WorkspaceView} per registry entry, in registry order.
*/
async function scanWorkspaces(ctx, instancesPath, opts = {}) {
	const timeoutMs = opts.statusTimeoutMs ?? 3e3;
	let instances;
	try {
		instances = readInstancesFile(ctx, instancesPath);
	} catch (error) {
		throw error;
	}
	if (instances === void 0) return [];
	const entries = Object.values(instances);
	const liveness = await Promise.all(entries.map(async (entry) => diagnoseDaemon(entry, {
		httpProbe: (e, ms) => fetchStatus(e, ms),
		httpTimeoutMs: timeoutMs,
		tcpTimeoutMs: 300
	})));
	return (await Promise.allSettled(entries.map(async (entry, i) => {
		const diag = liveness[i];
		if (!diag.alive) return {
			workspace: entry.workspace,
			port: entry.port,
			...entry.pid !== void 0 ? { pid: entry.pid } : {},
			...entry.mode !== void 0 ? { mode: entry.mode } : {},
			live: false,
			...diag.reason !== void 0 ? { reason: diag.reason } : {},
			error: diag.reason !== void 0 ? `daemon not alive: ${diag.reason}` : "daemon not alive"
		};
		const status = await fetchStatus(entry, timeoutMs);
		return {
			workspace: entry.workspace,
			port: entry.port,
			...entry.pid !== void 0 ? { pid: entry.pid } : {},
			...entry.mode !== void 0 ? { mode: entry.mode } : {},
			live: true,
			...status !== void 0 ? { status } : {}
		};
	}))).map((settled, i) => {
		if (settled.status === "fulfilled") return settled.value;
		const entry = entries[i];
		return {
			workspace: entry.workspace,
			port: entry.port,
			...entry.pid !== void 0 ? { pid: entry.pid } : {},
			...entry.mode !== void 0 ? { mode: entry.mode } : {},
			live: false,
			error: `status probe failed: ${String(settled.reason)}`
		};
	});
}
/**
* Request a re-index from one daemon (`POST /v1/index` body `{"force":false}`).
*
* Pre-flight gates reject requests the daemon would refuse or that would be
* unsafe:
* - `memory_only` / `search_only` modes cannot be re-indexed (no persistent
*   index store) — returns a clear error without hitting the network.
* - A daemon reporting `fully_ready` false (initial index still settling) is
*   gated to avoid piling a second pass onto an in-flight one; the caller may
*   retry after it stabilizes.
*
* A daemon 503 ("reindex in progress") text is passed through verbatim so the
* operator sees the daemon's own words. Any other non-2xx becomes a generic
* error carrying the status code.
*
* @param entry - the daemon record to target.
* @param opts - optional tuning (`timeoutMs`, and an injected `status` to avoid
*   a second `/v1/status` round-trip when the caller already scanned).
* @returns the {@link TriggerResult}.
*/
async function triggerIndex(entry, opts = {}) {
	const timeoutMs = opts.timeoutMs ?? 3e4;
	const mode = entry.mode;
	if (mode === "memory_only" || mode === "search_only") return {
		ok: false,
		error: `cannot re-index daemon in '${mode}' mode (no persistent index store)`
	};
	const status = opts.status;
	if (status !== void 0 && status.fully_ready === false) return {
		ok: false,
		error: "daemon not fully_ready (initial index still settling); retry after it stabilizes"
	};
	const host = entry.host ?? "127.0.0.1";
	const controller = new AbortController();
	const timer = setTimeout$1(timeoutMs).then(() => controller.abort());
	try {
		const res = await fetch(`http://${host}:${entry.port}/v1/index`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ force: false }),
			signal: controller.signal
		});
		if (res.ok) return {
			ok: true,
			status: res.status
		};
		const text = await res.text().catch(() => "");
		if (res.status === 503) return {
			ok: false,
			error: text.trim() || "reindex already in progress (503)",
			status: 503
		};
		return {
			ok: false,
			error: `index request rejected: ${res.status}${text ? ` ${text}` : ""}`,
			status: res.status
		};
	} catch (error) {
		return {
			ok: false,
			error: `index request failed: ${String(error)}`
		};
	} finally {
		timer.catch(() => {});
	}
}
//#endregion
//#region src/codebases.ts
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
/** TCP connect budget for the `isPortListening` liveness check of the FORWARDED
* local port (ms) — used by `ensureTunnelUp` purely to decide
* reuse-vs-reallocate of `localPort`. This is NOT the ssh control-master
* liveness path: `ssh -O check` (the authoritative up/down signal) has its own
* `-o ConnectTimeout=5` and is independent of this budget. */
const DEFAULT_TUNNEL_PROBE_MS = 800;
/** Reserved local tunnel-bind port range (inclusive). Both `createCodebase` and
* `ensureTunnelUp` allocate from this same window so the forwarded
* Streamable-HTTP endpoints stay in one predictable band. Shared as a constant
* so the two call sites cannot drift apart. */
const TUNNEL_PORT_MIN = 8760;
const TUNNEL_PORT_MAX = 8799;
/** Validation regex for a slug (also used to derive `serverName`). */
const SLUG_PATTERN$1 = /^[A-Za-z0-9_-]{1,32}$/;
/** Default metadata file location. */
const DEFAULT_CODEBASES_FILE$1 = join(homedir(), ".dsh", "vectr-codebases.json");
/**
* In-process set of taken `serverName`s, enforcing global uniqueness across
* create calls within one process (per spec). Reset between logical sessions is
* the caller's responsibility; the registry is module-level by design.
*/
const takenServerNames = /* @__PURE__ */ new Set();
/** Clear the in-process server-name registry (test helper). */
function _resetServerNameRegistry() {
	takenServerNames.clear();
}
/**
* In-progress create locks keyed by slug. A second concurrent `createCodebase`
* for the same slug awaits the in-flight one and then re-validates the slug, so
* two simultaneous creates of the same slug cannot both register (which would
* collide on the derived `serverName` / daemon registration).
*/
const createLocks = /* @__PURE__ */ new Map();
/** Ports reserved by in-flight `createCodebase` calls (TOCTOU guard for `findFreePort`). */
const inProgressLocalPorts = /* @__PURE__ */ new Set();
/**
* Per-slug self-heal locks. A second concurrent `ensureTunnelUp` for the same
* slug awaits the in-flight one and returns its result, so a startup
* `void ensureTunnelUp` and a user-initiated `testCodebase` heal racing on the
* same slug cannot both reopen the tunnel and collide on the bound `localPort`
* (EADDRINUSE / ctl-exists -> spurious `'error'`). See {@link ensureTunnelUp}.
*/
const healLocks = /* @__PURE__ */ new Map();
/** Sentinel `workspace` for old entries that cannot be inferred during migration. */
const UNASSIGNED_WORKSPACE = "__unassigned__";
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
function safeRemove(path, base) {
	const safeBase = resolve(base);
	const target = resolve(path);
	if (!target.startsWith(`${safeBase}${sep}`)) throw new Error(`vectr-client: refusing to remove ${path}: outside controlled dir ${base}`);
	rmSync(target, { force: true });
}
function deriveServerName(workspace, slug) {
	return `vectr_${createHash("sha256").update(workspace).digest("hex").slice(0, 12)}_${slug}`;
}
/**
* Validate a slug and its derived server name, enforcing the format and the
* in-process uniqueness invariant (composite key: workspace + slug).
* @param workspace - absolute owning workspace path.
* @param slug - candidate slug.
* @throws when the slug is malformed or its composite server name is already taken.
*/
function assertServerNameAvailable(workspace, slug) {
	if (!SLUG_PATTERN$1.test(slug)) throw new Error(`invalid slug "${slug}": must match ${String(SLUG_PATTERN$1)}`);
	const serverName = deriveServerName(workspace, slug);
	if (takenServerNames.has(serverName)) throw new Error(`server name "${serverName}" is already in use (workspace "${workspace}" + slug "${slug}" conflicts)`);
}
/**
* Read the codebase metadata file. A missing file yields `[]`; a malformed file
* throws with a clear diagnostic (misconfiguration must fail loud).
* @param metaPath - absolute path of the metadata JSON.
* @returns the parsed entries.
*/
function loadCodebases(metaPath) {
	if (!existsSync(metaPath)) return [];
	let text;
	try {
		text = readFileSync(metaPath, "utf8");
	} catch (error) {
		throw new Error(`vectr-client: failed to read ${metaPath}: ${String(error)}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`vectr-client: failed to parse ${metaPath}: ${String(error)}`);
	}
	if (!Array.isArray(parsed)) throw new Error(`vectr-client: ${metaPath} must be a JSON array of codebase entries`);
	for (const entry of parsed) if (typeof entry.serverName === "string") takenServerNames.add(entry.serverName);
	return parsed;
}
/**
* Atomically write the codebase metadata file (tmp + rename, 0600). The secret
* value is never present in `list` — only `credentialRef`.
* @param metaPath - absolute path to write.
* @param list - entries to persist.
*/
function saveCodebases(metaPath, list) {
	const dir = dirname(metaPath);
	mkdirSync(dir, { recursive: true });
	const tmp = `${metaPath}.${process.pid}.tmp`;
	const payload = JSON.stringify(list, null, 2);
	writeFileSync(tmp, payload, { mode: 384 });
	renameSync(tmp, metaPath);
	try {
		writeFileSync(metaPath, payload, { mode: 384 });
	} catch {}
}
/**
* Find the first free TCP port in `[min, max]`. Implemented by attempting to
* `listen` and immediately `close`; the OS assigns a port when we pass 0, but
* here we bind the candidate to detect occupancy.
* @param min - first candidate port (inclusive).
* @param max - last candidate port (inclusive).
* @param exclude - ports to skip (e.g. reserved by an in-flight create / heal).
* @param warn - optional warn sink used to surface port migration (c). When the
*   preferred `min` port is occupied and a LATER port in the window is
*   selected, `warn(message)` is invoked with a self-diagnosing message so the
*   migration is visible in the host log. The preferred-port-available case
*   never warns (a silent hit would just be noise).
* @returns the first free port, or `undefined` when none are free.
*/
async function findFreePort(min = TUNNEL_PORT_MIN, max = TUNNEL_PORT_MAX, exclude, warn) {
	const { createServer } = await import("node:net");
	let firstAttempt = true;
	for (let port = min; port <= max; port++) {
		if (exclude?.has(port)) continue;
		if (await new Promise((resolveFree) => {
			const server = createServer();
			server.once("error", () => resolveFree(false));
			server.listen(port, "127.0.0.1", () => {
				server.close(() => resolveFree(true));
			});
		})) {
			if (!firstAttempt && warn !== void 0) warn(`vectr-client: preferred tunnel port ${min} occupied; using ${port} (range ${min}-${max}). MCP endpoint URL will reflect the new port.`);
			return port;
		}
		firstAttempt = false;
	}
}
/**
* Create a codebase: spawn (local) or ssh-provision + tunnel (remote), then
* persist the entry. Any partial failure cleans up what was already built.
* @param deps - injected runners / store.
* @param metaPath - metadata file path to persist into.
* @param spec - the codebase to create.
* @returns the created entry.
*/
async function createCodebase(deps, metaPath, spec) {
	const prev = createLocks.get(spec.slug);
	if (prev !== void 0) {
		await prev;
		assertServerNameAvailable(spec.workspace ?? spec.path, spec.slug);
	}
	const run = (async () => {
		try {
			return await createCodebaseCore(deps, metaPath, spec);
		} finally {
			createLocks.delete(spec.slug);
		}
	})();
	createLocks.set(spec.slug, run);
	return run;
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
function remoteShellCmd(host, command) {
	return [
		host,
		"export",
		"PATH=$HOME/.local/bin:$PATH",
		"&&",
		...command.split(" ")
	];
}
async function createCodebaseCore(deps, metaPath, spec) {
	const rawPath = spec.path || spec.remotePath;
	if (rawPath && typeof rawPath === "string") spec.path = rawPath.trim();
	if (!spec.auth && spec.password) spec.auth = "password";
	const workspace = spec.workspace ?? spec.path;
	if (spec.type === "remote" && spec.workspace === void 0) throw new Error("remote codebase requires an explicit workspace (the caller local cwd); server-side isolation cannot infer it");
	assertServerNameAvailable(workspace, spec.slug);
	const serverName = deriveServerName(workspace, spec.slug);
	if (spec.type === "local") {
		const result = await deps.spawnRunner("vectr", [
			"start",
			"--path",
			spec.path,
			"--json"
		]).promise;
		if (result.code !== 0) {
			takenServerNames.delete(serverName);
			throw new Error(`vectr start failed (exit ${result.code}): ${result.stderr}`);
		}
		let parsed;
		try {
			parsed = JSON.parse(result.stdout);
		} catch (error) {
			takenServerNames.delete(serverName);
			throw new Error(`vectr start returned non-JSON stdout: ${String(error)}`);
		}
		if (parsed.status === "failed") {
			takenServerNames.delete(serverName);
			throw new Error(`vectr start reported failed status: ${result.stderr}`);
		}
		if (typeof parsed.port !== "number") {
			takenServerNames.delete(serverName);
			throw new Error("vectr start did not report a port");
		}
		const entry = {
			id: spec.slug,
			slug: spec.slug,
			type: "local",
			path: spec.path,
			workspace,
			serverName,
			localPort: parsed.port,
			status: "up"
		};
		takenServerNames.add(serverName);
		persist(metaPath, entry);
		return entry;
	}
	if (spec.host === void 0) {
		takenServerNames.delete(serverName);
		throw new Error("remote codebase requires a host");
	}
	let credentialRef;
	let sshPassword;
	if (spec.auth === "password") {
		credentialRef = `VECTR_SSH_${spec.slug.toUpperCase()}`;
		if (spec.password !== void 0) await deps.credStore.set(credentialRef, spec.password);
		const resolved = await deps.credStore.get(credentialRef);
		sshPassword = typeof resolved === "string" ? resolved : spec.password;
	}
	if (spec.auth === "password" && sshPassword === void 0) {
		takenServerNames.delete(serverName);
		throw new Error(`password auth requested for ${spec.host ?? spec.slug} but no password was provided`);
	}
	const sshAuth = sshPassword !== void 0 ? { password: sshPassword } : void 0;
	const ssh = (args) => deps.sshRunner(args, sshAuth);
	const probeResult = await ssh(sshPassword !== void 0 ? [
		"-o",
		"ConnectTimeout=5",
		spec.host,
		"true"
	] : [
		"-o",
		"BatchMode=yes",
		"-o",
		"ConnectTimeout=5",
		spec.host,
		"true"
	]).promise;
	if (probeResult.code !== 0) {
		takenServerNames.delete(serverName);
		if (credentialRef !== void 0) await deps.credStore.unset(credentialRef);
		throw new Error(`cannot reach ${spec.host}: ${probeResult.stderr || `exit ${probeResult.code}`}`);
	}
	const listResult = await ssh(remoteShellCmd(spec.host, "uv tool list")).promise;
	if (!(listResult.code === 0 && /\bvectr\b/i.test(listResult.stdout))) {
		const installResult = await ssh(remoteShellCmd(spec.host, "uv tool install vectr")).promise;
		if (installResult.code !== 0) {
			const msg = `${installResult.stdout}\n${installResult.stderr}`;
			if (!/\balready installed\b|\bup to date\b|\brequirements already satisfied\b/i.test(msg)) {
				takenServerNames.delete(serverName);
				if (credentialRef !== void 0) await deps.credStore.unset(credentialRef);
				throw new Error(`failed to install vectr on ${spec.host} (install manually): ${installResult.stderr}`);
			}
		}
	}
	const startResult = await ssh(remoteShellCmd(spec.host, `vectr start ${spec.path} --host 127.0.0.1`)).promise;
	if (startResult.code !== 0) {
		takenServerNames.delete(serverName);
		if (credentialRef !== void 0) await deps.credStore.unset(credentialRef);
		throw new Error(`failed to start vectr on ${spec.host}: ${startResult.stderr}`);
	}
	const remotePort = (typeof spec.remotePort === "number" && spec.remotePort > 0 ? spec.remotePort : void 0) ?? await resolveRemotePort(ssh, spec.host, spec.path) ?? parseRemotePort(startResult.stdout);
	if (remotePort === void 0) {
		takenServerNames.delete(serverName);
		if (credentialRef !== void 0) await deps.credStore.unset(credentialRef);
		throw new Error(`could not resolve remote vectr daemon port on ${spec.host} for workspace ${spec.path}: ~/.vectr/instances.json had no matching entry and 'vectr start' reported no port. Verify the remote daemon is running and writing its registry.`);
	}
	const localPort = await findFreePort(TUNNEL_PORT_MIN, TUNNEL_PORT_MAX, inProgressLocalPorts, deps.warn);
	if (localPort === void 0) {
		takenServerNames.delete(serverName);
		if (credentialRef !== void 0) await deps.credStore.unset(credentialRef);
		throw new Error(`no free local tunnel port in range ${TUNNEL_PORT_MIN}-${TUNNEL_PORT_MAX}`);
	}
	inProgressLocalPorts.add(localPort);
	try {
		const ctl = join(tmpdir(), `vectr-tunnel-${spec.slug}-${process.pid}.sock`);
		const tunnelResult = await ssh([
			"-o",
			"ConnectTimeout=5",
			"-o",
			"ExitOnForwardFailure=yes",
			"-f",
			"-N",
			"-M",
			"-S",
			ctl,
			"-L",
			`127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
			spec.host
		]).promise;
		if (tunnelResult.code !== 0) {
			takenServerNames.delete(serverName);
			if (credentialRef !== void 0) await deps.credStore.unset(credentialRef);
			throw new Error(`failed to open tunnel to ${spec.host}: ${tunnelResult.stderr}`);
		}
		let tunnelPid;
		for (let attempt = 0; attempt < 3; attempt++) {
			const checkResult = await ssh([
				"-o",
				"ConnectTimeout=5",
				"-O",
				"check",
				"-S",
				ctl,
				spec.host
			]).promise;
			const pid = tunnelPidFrom(checkResult.stdout);
			if (pid !== void 0) {
				tunnelPid = pid;
				break;
			}
			if (checkResult.code !== 0 && attempt < 2) {
				await new Promise((resolveBackoff) => setTimeout(resolveBackoff, 50 * (attempt + 1)));
				continue;
			}
			tunnelPid = tunnelPidFrom(tunnelResult.stdout);
			break;
		}
		const entry = {
			id: spec.slug,
			slug: spec.slug,
			type: "remote",
			path: spec.path,
			workspace,
			host: spec.host,
			serverName,
			localPort,
			remotePort,
			...tunnelPid !== void 0 ? { tunnelPid } : {},
			...ctl !== void 0 ? { tunnelCtl: ctl } : {},
			...credentialRef !== void 0 ? { credentialRef } : {},
			status: "up"
		};
		takenServerNames.add(serverName);
		persist(metaPath, entry);
		return entry;
	} finally {
		inProgressLocalPorts.delete(localPort);
	}
}
/**
* Extract a tunnel master PID from ssh output. Preferred: `ssh -O check` prints
* `Master running (pid=<pid>)`. Fallback: some `ssh -f` builds print
* `Process ID <pid>` on fork — parsed defensively and never fails when absent.
*/
function tunnelPidFrom(stdout) {
	const master = /Master running \(pid=(\d+)\)/.exec(stdout);
	if (master !== null && master[1] !== void 0) return Number(master[1]);
	const legacy = /Process ID (\d+)/.exec(stdout);
	if (legacy !== null && legacy[1] !== void 0) return Number(legacy[1]);
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
async function resolveRemotePort(ssh, host, workspace) {
	const result = await ssh([
		host,
		"cat",
		"~/.vectr/instances.json"
	]).promise;
	if (result.code !== 0) return void 0;
	try {
		const registry = JSON.parse(result.stdout);
		const match = Object.values(registry).find((e) => e !== null && typeof e === "object" && e.workspace === workspace);
		if (match?.port !== void 0) return match.port;
	} catch {}
}
/** Best-effort parse of a remote `vectr start` port line. */
function parseRemotePort(stdout) {
	const match = /"port"\s*:\s*(\d+)/.exec(stdout);
	if (match !== null && match[1] !== void 0) return Number(match[1]);
	const m2 = /port[=:]\s*(\d+)/i.exec(stdout);
	if (m2 !== null && m2[1] !== void 0) return Number(m2[1]);
}
/**
* Append or replace an entry in the metadata file.
* @param metaPath - metadata file path.
* @param entry - entry to upsert (matched by `slug`).
*/
function persist(metaPath, entry) {
	const list = loadCodebases(metaPath).filter((e) => e.slug !== entry.slug);
	list.push(entry);
	saveCodebases(metaPath, list);
}
/**
* Delete a codebase: stop the daemon (local or remote), kill the tunnel, and
* remove the entry from metadata.
* @param deps - injected runners.
* @param metaPath - metadata file path.
* @param entry - the entry to delete.
*/
async function deleteCodebase(deps, metaPath, entry) {
	if (entry.type === "local") {
		if (entry.localPort !== void 0) await deps.spawnRunner("vectr", [
			"stop",
			"--port",
			String(entry.localPort)
		]).promise;
	} else {
		let recordedTeardownOk = false;
		if (entry.tunnelCtl !== void 0) try {
			const result = await deps.sshRunner([
				"-O",
				"exit",
				"-S",
				entry.tunnelCtl,
				entry.host ?? ""
			]).promise;
			recordedTeardownOk = result.code === 0 && result.signal === null;
		} catch {}
		if (entry.tunnelPid !== void 0) try {
			process.kill(entry.tunnelPid, "SIGTERM");
		} catch (err) {
			if (err.code !== "ESRCH") deps.warn?.(`deleteCodebase: cannot SIGTERM recorded tunnelPid ${entry.tunnelPid}: ${String(err)}`);
		}
		if (!recordedTeardownOk) await cleanupOrphanedTunnelBySlug(deps, entry);
		if (entry.remotePort !== void 0) await deps.sshRunner(remoteShellCmd(entry.host ?? "", `vectr stop --port ${entry.remotePort}`)).promise;
	}
	saveCodebases(metaPath, loadCodebases(metaPath).filter((e) => e.slug !== entry.slug));
	takenServerNames.delete(entry.serverName);
	if (entry.credentialRef !== void 0) await deps.credStore.unset(entry.credentialRef);
}
/**
* (d) Fallback orphan cleanup used by {@link deleteCodebase} when no recorded
* `tunnelCtl` / `tunnelPid` exists OR the recorded teardown failed silently.
* Scans tmpdir for any `vectr-tunnel-<slug>-*.sock` and asks ssh to exit each
* control master cleanly via `ssh -O exit -S <sock> <host>`. When ssh itself
* is unavailable, the socket file is simply unlinked (the underlying master
* will not answer to `-O exit` either way). Every error is swallowed — this is
* a best-effort hygiene step that must not veto the delete.
*
* Exported as `cleanupOrphanedTunnelsForCodebases` so the effect disposer in
* `index.ts` can sweep the same set of orphans when the host pid changes and
* the recorded `tunnelPid` / `tunnelCtl` no longer points at a live master.
* Entries that are not `type === 'remote'` or whose slug is empty are
* silently skipped.
*/
async function cleanupOrphanedTunnelsForCodebases(deps, entries) {
	for (const entry of entries) {
		if (entry.type !== "remote") continue;
		if (typeof entry.slug !== "string" || entry.slug.length === 0) continue;
		await cleanupOrphanedTunnelBySlug(deps, entry);
	}
}
async function cleanupOrphanedTunnelBySlug(deps, entry) {
	const dir = tmpdir();
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	const re = new RegExp(`^vectr-tunnel-${escapeRe(entry.slug)}-(\\d+)\\.sock$`);
	let auth;
	if (entry.credentialRef !== void 0) try {
		const pw = await deps.credStore.get(entry.credentialRef);
		if (typeof pw === "string" && pw.length > 0) auth = { password: pw };
	} catch {}
	for (const name of names) {
		const m = re.exec(name);
		if (m === null || m[1] === void 0) continue;
		const sock = join(dir, name);
		try {
			await deps.sshRunner([
				"-o",
				"ConnectTimeout=2",
				"-O",
				"exit",
				"-S",
				sock,
				entry.host ?? ""
			], auth).promise;
		} catch {}
		try {
			safeRemove(sock, dir);
		} catch {}
	}
}
/** Error carrying an HTTP status so the route layer can map it directly.
* Pure domain errors (missing slug, unregistered workspace, serverName
* collision) surface as {@link CodebaseError} from {@link patchCodebase}. */
var CodebaseError = class extends Error {
	/** HTTP status to respond with. */
	status;
	/** @param status - HTTP status. @param message - diagnostic. */
	constructor(status, message) {
		super(message);
		this.status = status;
	}
};
/**
* Reassign an existing codebase's owning `workspace` and recompute its
* composite `serverName` (`deriveServerName(workspace, slug)`), rejecting a
* serverName collision with another entry, then persist and re-hydrate the
* in-process uniqueness registry. Pure logic: no spawning, no HTTP, no body
* parsing — the route validates the request shape and reads the registry.
*
* The route's `assign` action calls this to move a (typically remote) codebase
* to a different owning workspace and keep `serverName` globally unique across
* workspaces. Local entries are not special-cased: the same recompute runs.
*
* @param metaPath - codebase metadata file.
* @param slug - entry slug to reassign.
* @param workspace - target absolute workspace path (route must validate this).
* @param options - optional parsed daemon registry for target validation.
* @returns the updated entry.
* @throws {CodebaseError} 404 when the slug is unknown; 409 when the target
*   workspace is unregistered, or the recomputed serverName collides.
*/
function patchCodebase(metaPath, slug, workspace, options = {}) {
	const list = loadCodebases(metaPath);
	const idx = list.findIndex((e) => e.slug === slug);
	if (idx === -1) throw new CodebaseError(404, `no such codebase: ${slug}`);
	const entry = list[idx];
	if (!(workspace === "__unassigned__") && (options.instances === void 0 || resolveInstance(options.instances, workspace) === void 0)) throw new CodebaseError(409, `workspace "${workspace}" is not registered with a vectr daemon`);
	const newServerName = deriveServerName(workspace, entry.slug);
	const collision = list.find((e, i) => i !== idx && e.serverName === newServerName);
	if (collision !== void 0) throw new CodebaseError(409, `server name "${newServerName}" already in use by "${collision.slug}"`);
	const updated = {
		...entry,
		workspace,
		serverName: newServerName
	};
	list[idx] = updated;
	saveCodebases(metaPath, list);
	_resetServerNameRegistry();
	loadCodebases(metaPath);
	return updated;
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
async function probeTunnel(entry, deps) {
	if (entry.type !== "remote") return {
		alive: false,
		reason: "not-remote"
	};
	if (entry.tunnelCtl === void 0 && entry.localPort === void 0) return {
		alive: false,
		reason: "no-tunnel-config"
	};
	if (entry.tunnelCtl !== void 0 && entry.host !== void 0) {
		if ((await deps.sshRunner([
			"-o",
			"ConnectTimeout=5",
			"-O",
			"check",
			"-S",
			entry.tunnelCtl,
			entry.host
		]).promise).code === 0) return { alive: true };
	}
	return {
		alive: false,
		reason: "tunnel-down"
	};
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
async function ensureTunnelUp(deps, metaPath, entry) {
	if (entry.type !== "remote") return {
		entry,
		healed: false
	};
	const inFlight = healLocks.get(entry.slug);
	if (inFlight !== void 0) return inFlight;
	const run = (async () => {
		try {
			return await healTunnelOnce(deps, metaPath, entry);
		} finally {
			healLocks.delete(entry.slug);
		}
	})();
	healLocks.set(entry.slug, run);
	return run;
}
/**
* Bring a single dead tunnel back up. No concurrency guard — callers go through
* {@link ensureTunnelUp}, which serializes by slug. This worker does probe +
* reopen + persist.
*/
async function healTunnelOnce(deps, metaPath, entry) {
	const masterUp = (await probeTunnel(entry, deps)).alive;
	if (masterUp) {
		if (entry.localPort !== void 0 && await isPortListening("127.0.0.1", entry.localPort, 800)) return {
			entry,
			healed: false
		};
		if (entry.tunnelCtl !== void 0 && entry.host !== void 0) try {
			await deps.sshRunner([
				"-o",
				"ConnectTimeout=5",
				"-O",
				"exit",
				"-S",
				entry.tunnelCtl,
				entry.host
			]).promise;
		} catch {}
	}
	let auth;
	if (entry.credentialRef !== void 0) {
		const pw = await deps.credStore.get(entry.credentialRef);
		if (typeof pw === "string" && pw.length > 0) auth = { password: pw };
	}
	const ssh = (args) => deps.sshRunner(args, auth);
	if (entry.remotePort === void 0) {
		const msg = "tunnel down: no remotePort recorded; cannot reopen forward";
		downgrade(metaPath, entry, msg);
		return {
			entry: {
				...entry,
				status: "error",
				error: msg
			},
			healed: false,
			error: msg
		};
	}
	if (entry.host === void 0) {
		const msg = "tunnel down: no host recorded; cannot reopen forward";
		downgrade(metaPath, entry, msg);
		return {
			entry: {
				...entry,
				status: "error",
				error: msg
			},
			healed: false,
			error: msg
		};
	}
	if (entry.tunnelPid !== void 0) try {
		process.kill(entry.tunnelPid, "SIGTERM");
	} catch (err) {
		if (err.code === "ESRCH") {} else deps.warn?.(`tunnel heal: cannot SIGTERM recorded tunnelPid ${entry.tunnelPid}: ${String(err)}`);
	}
	if (entry.tunnelCtl !== void 0) try {
		safeRemove(entry.tunnelCtl, tmpdir());
	} catch {}
	let localPort = entry.localPort;
	if (localPort === void 0 || !masterUp && await isPortListening("127.0.0.1", localPort, 800)) {
		const fresh = await findFreePort(TUNNEL_PORT_MIN, TUNNEL_PORT_MAX, /* @__PURE__ */ new Set([...inProgressLocalPorts, ...localPort !== void 0 ? [localPort] : []]), deps.warn);
		if (fresh === void 0) {
			const msg = `tunnel down: no free local port in range ${TUNNEL_PORT_MIN}-${TUNNEL_PORT_MAX}`;
			downgrade(metaPath, entry, msg);
			return {
				entry: {
					...entry,
					status: "error",
					error: msg
				},
				healed: false,
				error: msg
			};
		}
		localPort = fresh;
	}
	inProgressLocalPorts.add(localPort);
	try {
		const ctl = entry.tunnelCtl ?? join(tmpdir(), `vectr-tunnel-${entry.slug}-${process.pid}.sock`);
		const host = entry.host;
		const result = await ssh([
			"-o",
			"ConnectTimeout=5",
			"-o",
			"ExitOnForwardFailure=yes",
			"-f",
			"-N",
			"-M",
			"-S",
			ctl,
			"-L",
			`127.0.0.1:${localPort}:127.0.0.1:${entry.remotePort}`,
			host
		]).promise;
		if (result.code !== 0) {
			const msg = `tunnel down: ssh tunnel open failed (exit ${result.code}): ${result.stderr || result.stdout}`;
			downgrade(metaPath, entry, msg);
			return {
				entry: {
					...entry,
					status: "error",
					error: msg
				},
				healed: false,
				error: msg
			};
		}
		let alive = false;
		let tunnelPid;
		for (let attempt = 0; attempt < 3; attempt++) {
			const checkResult = await ssh([
				"-o",
				"ConnectTimeout=5",
				"-O",
				"check",
				"-S",
				ctl,
				host
			]).promise;
			const pid = tunnelPidFrom(checkResult.stdout);
			if (pid !== void 0) tunnelPid = pid;
			if (checkResult.code === 0) {
				alive = true;
				break;
			}
			if (attempt < 2) await new Promise((resolveBackoff) => setTimeout(resolveBackoff, 50 * (attempt + 1)));
		}
		if (!alive) {
			const msg = "tunnel down: ssh master did not come up after reopen";
			downgrade(metaPath, entry, msg);
			return {
				entry: {
					...entry,
					status: "error",
					error: msg
				},
				healed: false,
				error: msg
			};
		}
		if (!await isPortListening("127.0.0.1", localPort, 800)) {
			const msg = `tunnel down: forward on 127.0.0.1:${localPort} did not bind after reopen`;
			downgrade(metaPath, entry, msg);
			return {
				entry: {
					...entry,
					status: "error",
					error: msg
				},
				healed: false,
				error: msg
			};
		}
		const { error: _omit, ...entryWithoutError } = entry;
		const updated = {
			...entryWithoutError,
			localPort,
			tunnelCtl: ctl,
			status: "up",
			...tunnelPid !== void 0 ? { tunnelPid } : {}
		};
		persist(metaPath, updated);
		return {
			entry: updated,
			healed: true
		};
	} finally {
		inProgressLocalPorts.delete(localPort);
	}
}
/**
* Downgrade a persisted entry's `status` to `'error'` with a diagnostic, but
* NEVER let a persistence failure mask the real diagnostic (B3). The reopen
* already failed; a `saveCodebases` throw must not turn the caller's
* `try/catch` (testCodebase route has none) into a bare 500. We swallow the
* persist error and still return the in-memory downgraded entry + diagnostic.
*/
function downgrade(metaPath, entry, msg) {
	try {
		persist(metaPath, {
			...entry,
			status: "error",
			error: msg
		});
	} catch {}
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
function migrateCodebases(metaPath, instances, logger) {
	if (instances == null || Object.keys(instances).length === 0) return {
		changed: false,
		migrated: 0
	};
	const list = loadCodebases(metaPath);
	let changed = false;
	let migrated = 0;
	const plannedNames = /* @__PURE__ */ new Set();
	for (const entry of list) {
		let workspace = entry.workspace;
		if (workspace === void 0) {
			if (entry.type === "local") workspace = resolveInstance(instances, entry.path)?.workspace ?? "__unassigned__";
			else workspace = UNASSIGNED_WORKSPACE;
		}
		let expectedName = deriveServerName(workspace, entry.slug);
		if (plannedNames.has(expectedName)) {
			logger?.warn(`vectr-client: migrate ${entry.slug}: serverName "${expectedName}" collides with another entry; leaving UNASSIGNED + disambiguation suffix`);
			workspace = UNASSIGNED_WORKSPACE;
			expectedName = deriveServerName(workspace, `${entry.slug}-${plannedNames.size}`);
		}
		plannedNames.add(expectedName);
		if (workspace === "__unassigned__") logger?.warn(`vectr-client: migrate ${entry.slug}: workspace could not be inferred; set to UNASSIGNED (rebuild or re-assign)`);
		if (entry.workspace !== workspace || entry.serverName !== expectedName) {
			entry.workspace = workspace;
			entry.serverName = expectedName;
			changed = true;
			migrated += 1;
		}
	}
	if (changed) {
		saveCodebases(metaPath, list);
		takenServerNames.clear();
		for (const e of list) takenServerNames.add(e.serverName);
	}
	return {
		changed,
		migrated
	};
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
async function testCodebase(entry, opts) {
	if (entry.localPort === void 0) return {
		ok: false,
		error: "no local port configured"
	};
	if (opts?.heal && opts.deps !== void 0 && opts.metaPath !== void 0) {
		const res = await ensureTunnelUp(opts.deps, opts.metaPath, entry);
		if (!res.healed && res.error !== void 0) return {
			ok: false,
			error: res.error
		};
		entry = res.entry;
		if (entry.localPort === void 0) return {
			ok: false,
			error: "no local port configured"
		};
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 3e3);
	try {
		const res = await fetch(`http://127.0.0.1:${entry.localPort}/v1/status`, { signal: controller.signal });
		if (!res.ok) return {
			ok: false,
			error: `status ${res.status}`
		};
		return {
			ok: true,
			status: await res.json()
		};
	} catch (error) {
		return {
			ok: false,
			error: String(error)
		};
	} finally {
		clearTimeout(timer);
	}
}
/**
* File-backed secret store with atomic 0600 writes, used when no
* `ctx.credentials` service is available. Secrets are stored as
* `{ "<ref>": "<value>" }` — never in the codebase metadata file.
*/
var FileCredentialStore = class {
	/** Absolute path of the secrets JSON file. */
	path;
	/** @param path - absolute secrets file path (defaults to `~/.dsh/vectr-secrets.json`). */
	constructor(path = join(homedir(), ".dsh", "vectr-secrets.json")) {
		this.path = path;
	}
	readAll() {
		if (!existsSync(this.path)) return {};
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8"));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
			return parsed;
		} catch {
			return {};
		}
	}
	writeAll(data) {
		const dir = dirname(this.path);
		mkdirSync(dir, { recursive: true });
		const tmp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 384 });
		renameSync(tmp, this.path);
		try {
			writeFileSync(this.path, JSON.stringify(data, null, 2), { mode: 384 });
		} catch {}
	}
	set(ref, value) {
		const data = this.readAll();
		data[ref] = value;
		this.writeAll(data);
	}
	get(ref) {
		return this.readAll()[ref];
	}
	unset(ref) {
		const data = this.readAll();
		if (!(ref in data)) return;
		delete data[ref];
		this.writeAll(data);
	}
};
/**
* Best-effort cleanup of stale tunnel control sockets left behind when a
* previous plugin process crashed (the master ssh process is gone but its
* `vectr-tunnel-*.sock` remains in tmpdir). A socket is considered stale when
* the node process that created it (pid encoded in the filename) is no longer
* alive; live tunnels of the current process are left untouched. Every error is
* swallowed — this is a startup hygiene step, never fatal.
*
* (a) Host-restart case: when the host process restarts with a DIFFERENT pid
* the old socket's encoded pid is no longer alive, so the pid heuristic still
* removes the stale socket — but only if its slug prefix matches one of OUR
* codebases. Without the slug-prefix filter the function also touches unrelated
* plugins/users on the same host. The new `slugs` argument narrows the scope
* to OUR codebases, fixing the false-positive problem the survey flagged.
*
* @param dir - directory to scan (defaults to tmpdir).
* @param slugs - optional whitelist of codebase slugs whose prefix-matched
*   sockets should be cleaned. When omitted, the legacy pid-only heuristic
*   runs across every `vectr-tunnel-*.sock` (kept for back-compat with the
*   pre-isolate startup hygiene path).
* @returns the number of sockets removed.
*/
function cleanupStaleTunnelSockets(dir = tmpdir(), slugs) {
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	const slugSet = slugs !== void 0 ? new Set(slugs) : void 0;
	const reSlug = slugSet !== void 0 ? new RegExp(`^vectr-tunnel-(${Array.from(slugSet).map(escapeRe).join("|")})-(\\d+)\\.sock$`) : null;
	const reLegacy = /^vectr-tunnel-.*-(\d+)\.sock$/;
	let removed = 0;
	for (const name of names) {
		let m;
		let pid;
		if (reSlug !== null) {
			m = reSlug.exec(name);
			if (m === null || m[1] === void 0 || m[2] === void 0) continue;
			pid = Number(m[2]);
		} else {
			m = reLegacy.exec(name);
			if (m === null || m[1] === void 0) continue;
			pid = Number(m[1]);
		}
		if (pid === void 0) continue;
		if (pid === process.pid) continue;
		try {
			process.kill(pid, 0);
			continue;
		} catch (err) {
			if (err.code !== "ESRCH") continue;
		}
		try {
			safeRemove(join(dir, name), dir);
			removed += 1;
		} catch {}
	}
	return removed;
}
/** Escape a literal for use inside a RegExp. */
function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
//#endregion
//#region src/domain/rules.ts
/**
* Domain rules and invariants for Vectr client.
*
* Implements pure validation logic, mode guards, and re-indexing capability checks
* without side-effects or network calls (Layer 1: Domain Core).
*
* @module dsh-vectr-client/domain/rules
*/
/**
* Validation pattern for codebase slugs: alphanumeric, underscores, hyphens, 1-32 chars.
*/
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/**
* Validate a codebase slug.
* @param slug - input slug string.
* @returns validation result with error message if invalid.
*/
function validateSlug(slug) {
	if (!slug || typeof slug !== "string") return {
		valid: false,
		error: "Slug must be a non-empty string"
	};
	if (!SLUG_PATTERN.test(slug)) return {
		valid: false,
		error: `Invalid slug "${slug}": must match ${String(SLUG_PATTERN)} (1-32 alphanumeric, underscores, or hyphens)`
	};
	return { valid: true };
}
/**
* Validate a target workspace directory.
* @param workspace - workspace directory path.
* @returns validation result with error message if invalid.
*/
function validateWorkspace(workspace) {
	if (!workspace || typeof workspace !== "string" || workspace.trim().length === 0) return {
		valid: false,
		error: "Workspace path must be a non-empty string"
	};
	if (workspace.includes("\0")) return {
		valid: false,
		error: "Workspace path must not contain null bytes"
	};
	if (workspace === "__unassigned__") return {
		valid: false,
		error: "Workspace cannot be the unassigned sentinel"
	};
	if (!(isAbsolute(workspace) || /^[a-zA-Z]:[\\/]/.test(workspace))) return {
		valid: false,
		error: "Workspace path must be an absolute path"
	};
	return { valid: true };
}
/**
* Test whether a mode string indicates memory_only mode.
*/
function isMemoryOnly(mode) {
	return mode === "memory_only" || mode === "memory-only";
}
/**
* Test whether a given sessionId represents an active, valid session.
* Absent values, undefined, null, empty strings, whitespace-only strings,
* string literals 'null'/'undefined', and non-finite numbers (NaN, Infinity)
* represent an inactive, blank, or invalid session.
*
* If blank is explicitly true, always returns false (blank session page).
* If blank is explicitly false, verifies valid session ID.
* If blank is undefined, preserves legacy backward-compatible behavior.
*
* (Layer 1: Domain Core - Single Source of Truth for Session Activation)
*/
function hasActiveSession(sessionId, blank) {
	if (blank === true) return false;
	if (sessionId === null || sessionId === void 0) return false;
	if (typeof sessionId === "string") {
		const trimmed = sessionId.trim();
		const lower = trimmed.toLowerCase();
		if (trimmed.length === 0 || lower === "null" || lower === "undefined") return false;
		return true;
	}
	if (typeof sessionId === "number") return Number.isFinite(sessionId);
	return false;
}
/**
* Single source of truth for whether a session is in an activated (non-blank, engaged) state.
*/
function isSessionActivated(state, options) {
	if (!state || typeof state !== "object") return hasActiveSession(state);
	const { sessionId, blank } = state;
	if (blank === true) return false;
	if (blank === false) return hasActiveSession(sessionId, false);
	if (options?.fallbackWhenBlankUndefined === false) return false;
	return hasActiveSession(sessionId, void 0);
}
/**
* Resolve slot visibility across conversation.input.right and conversation.session.header.utilities.
*/
function resolveSessionSlotVisibility(state, options) {
	const isActivated = isSessionActivated(state, options);
	return {
		shouldRenderInputRight: !isActivated,
		shouldRenderHeaderUtility: isActivated
	};
}
/**
* Test whether a mode string indicates search_only mode.
*/
function isSearchOnly(mode) {
	return mode === "search_only";
}
/**
* Determine whether a daemon instance can be re-indexed.
*
* Invariant: memory_only and search_only modes MUST NOT trigger indexing requests.
* Offline daemons and busy daemons are also rejected before hitting the network.
*/
function canReindex(live, mode, status) {
	if (!live) return {
		canReindex: false,
		reason: "Daemon offline"
	};
	if (mode === "memory_only" || mode === "memory-only") return {
		canReindex: false,
		reason: "Daemon in 'memory_only' mode cannot be re-indexed (no persistent index store)"
	};
	if (mode === "search_only") return {
		canReindex: false,
		reason: "Daemon in 'search_only' mode cannot be re-indexed (no persistent index store)"
	};
	if (status?.reindex_in_progress === true) return {
		canReindex: false,
		reason: "Re-index already in progress"
	};
	if (status?.fully_ready === false) return {
		canReindex: false,
		reason: "Daemon not fully_ready (initial index still settling)"
	};
	return { canReindex: true };
}
/**
* Normalize raw mode string and liveness state into typed VectrMode.
*/
function formatMode(mode, live) {
	if (live === false) return "offline";
	if (!mode) return "unknown";
	if (mode === "memory-only" || mode === "memory_only") return "memory_only";
	if (mode === "full" || mode === "search_only" || mode === "lite") return mode;
	return "unknown";
}
/**
* Resolve unified lifecycle and operational status across settings and modals.
*/
function resolveUnifiedStatus(input) {
	if (input?.error) return {
		kind: "offline",
		label: "Error",
		isBusy: false,
		description: input.error
	};
	if (!input || input.live !== true) return {
		kind: "offline",
		label: input?.live === void 0 ? "Unknown" : "Offline",
		isBusy: false,
		description: input?.reason ?? (input?.live === void 0 ? "Daemon status unknown" : "Daemon offline or unreachable")
	};
	if (!input.status) return {
		kind: "initializing",
		label: "Initializing",
		isBusy: true,
		description: input.reason ?? "Starting daemon or waiting for status"
	};
	const normalizedMode = formatMode(input.mode, input.live);
	if (normalizedMode === "memory_only") return {
		kind: "memory_only",
		label: "Memory Only",
		isBusy: false,
		description: "Running in working memory mode without persistent index"
	};
	if (input.status?.reindex_in_progress === true) return {
		kind: "indexing",
		label: "Indexing",
		isBusy: true,
		description: "Re-indexing codebase files and embedding vectors"
	};
	if (input.status?.fully_ready === false) return {
		kind: "initializing",
		label: "Initializing",
		isBusy: true,
		description: "Daemon starting or warming up initial index"
	};
	if (normalizedMode === "search_only") return {
		kind: "search_only",
		label: "Search Only",
		isBusy: false,
		description: "Semantic search active without working memory"
	};
	if (normalizedMode === "full" || normalizedMode === "lite") return {
		kind: "ready",
		label: "Ready",
		isBusy: false,
		description: "Daemon fully ready and synchronized"
	};
	return {
		kind: "unknown",
		label: "Unknown",
		isBusy: false,
		description: "Unknown daemon status"
	};
}
//#endregion
//#region src/infra/cli-runner.ts
/**
* Infrastructure CLI runner for Vectr commands.
*
* Implements {@link IVectrCliRunner} (Layer 2: Infrastructure).
* Resolves CLI executable dynamically from Config -> Environment variables -> PATH.
* Absolute paths are strictly injected, never hardcoded.
*
* @module dsh-vectr-client/infra/cli-runner
*/
/**
* Default fallback CLI executable name (resolved via system PATH).
*/
const DEFAULT_CLI_NAME = "vectr";
/** Delay before escalating from SIGTERM to SIGKILL on process kill (ms). */
const SIGKILL_ESCALATION_DELAY_MS = 1500;
/**
* Resolve the CLI binary path in priority order:
* 1. Explicit configuration (`opts.cliPath`)
* 2. Environment variable `VECTR_CLI_PATH`
* 3. Environment variable `VECTR_PATH`
* 4. System PATH executable `vectr`
*/
function resolveCliExecutable(cliPath) {
	if (cliPath && cliPath.trim().length > 0) return cliPath.trim();
	const envPath = process.env.VECTR_CLI_PATH || process.env.VECTR_PATH;
	if (envPath && envPath.trim().length > 0) return envPath.trim();
	return DEFAULT_CLI_NAME;
}
var VectrCliRunner = class {
	cliExecutable;
	spawnFn;
	defaultTimeoutMs;
	constructor(options = {}) {
		this.cliExecutable = resolveCliExecutable(options.cliPath);
		this.spawnFn = options.spawnFn ?? spawn;
		const envTimeout = process.env.VECTR_CLI_TIMEOUT_MS ? parseInt(process.env.VECTR_CLI_TIMEOUT_MS, 10) : NaN;
		this.defaultTimeoutMs = !isNaN(envTimeout) && envTimeout > 0 ? envTimeout : options.timeoutMs ?? 3e4;
	}
	async init(options) {
		const wsCheck = validateWorkspace(options.workspace);
		if (!wsCheck.valid) return {
			ok: false,
			error: wsCheck.error
		};
		const args = [
			"init",
			"--path",
			options.workspace
		];
		if (options.hooks === true) args.push("--hooks");
		if (options.memoryOnly === true) args.push("--style", "memory-only");
		else if (options.style && options.style.trim().length > 0) args.push("--style", options.style.trim());
		return new Promise((resolveResult) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			let child;
			try {
				child = this.spawnFn(this.cliExecutable, args);
			} catch (err) {
				resolveResult({
					ok: false,
					error: `Failed to spawn ${this.cliExecutable}: ${String(err)}`
				});
				return;
			}
			let killTimer;
			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					try {
						child.kill("SIGTERM");
					} catch {}
					killTimer = setTimeout(() => {
						if (child.exitCode === null && child.signalCode === null) try {
							child.kill("SIGKILL");
						} catch {}
					}, SIGKILL_ESCALATION_DELAY_MS);
					killTimer.unref?.();
					resolveResult({
						ok: false,
						stdout,
						stderr,
						error: `Command timed out after ${this.defaultTimeoutMs}ms`
					});
				}
			}, this.defaultTimeoutMs);
			child.stdout?.on("data", (d) => {
				stdout += d.toString();
			});
			child.stderr?.on("data", (d) => {
				stderr += d.toString();
			});
			child.on("error", (err) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					if (killTimer) clearTimeout(killTimer);
					resolveResult({
						ok: false,
						stdout,
						stderr: `${stderr}\n${String(err)}`.trim(),
						error: `Execution error: ${String(err)}`
					});
				}
			});
			child.on("close", (code, signal) => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					if (killTimer) clearTimeout(killTimer);
					const success = code === 0 && signal === null;
					resolveResult({
						ok: success,
						stdout: stdout.trim(),
						stderr: stderr.trim(),
						...success ? {} : { error: stderr.trim() || `Process exited with code ${code ?? "null"}${signal ? ` (signal ${signal})` : ""}` }
					});
				}
			});
		});
	}
};
//#endregion
//#region src/infra/api-client.ts
/**
* Infrastructure HTTP API client for Vectr daemon.
*
* Implements {@link IVectrApiClient} (Layer 2: Infrastructure).
* Handles HTTP requests to `/v1/status`, `/v1/index`, `/v1/recall`, `/v1/resume`
* with AbortController timeouts and structured error handling.
*
* @module dsh-vectr-client/infra/api-client
*/
var VectrApiClient = class {
	customFetch;
	constructor(options = {}) {
		this.customFetch = options.fetchFn;
	}
	get doFetch() {
		return this.customFetch ?? fetch;
	}
	async getStatus(host, port, timeoutMs) {
		if (this.customFetch) {
			const controller = new AbortController();
			const timer = setTimeout$1(timeoutMs).then(() => controller.abort());
			try {
				const res = await this.doFetch(`http://${host}:${port}/v1/status`, { signal: controller.signal });
				if (!res.ok) return void 0;
				return await res.json();
			} catch {
				return;
			} finally {
				timer.catch(() => {});
			}
		}
		return fetchStatus({
			workspace: "",
			port,
			host
		}, timeoutMs);
	}
	async triggerIndex(host, port, timeoutMs) {
		const controller = new AbortController();
		const timer = setTimeout$1(timeoutMs).then(() => controller.abort());
		try {
			const res = await this.doFetch(`http://${host}:${port}/v1/index`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ force: false }),
				signal: controller.signal
			});
			if (res.ok) return {
				ok: true,
				status: res.status
			};
			const text = await res.text().catch(() => "");
			if (res.status === 503) return {
				ok: false,
				error: text.trim() || "reindex already in progress (503)",
				status: 503
			};
			return {
				ok: false,
				error: `index request rejected: ${res.status}${text ? ` ${text}` : ""}`,
				status: res.status
			};
		} catch (error) {
			return {
				ok: false,
				error: `index request failed: ${String(error)}`
			};
		} finally {
			timer.catch(() => {});
		}
	}
	async recall(host, port, options, timeoutMs) {
		const controller = new AbortController();
		const timer = setTimeout$1(timeoutMs).then(() => controller.abort());
		try {
			const payload = {
				limit: options.limit ?? 10,
				detail: options.detail ?? "full"
			};
			if (options.query !== void 0 && options.query.trim().length > 0) payload.query = options.query.trim();
			if (options.kind !== void 0 && options.kind !== "all") payload.kind = options.kind;
			if (options.priority !== void 0) payload.priority = options.priority;
			if (options.tags !== void 0 && options.tags.length > 0) payload.tags = options.tags;
			if (options.sort_by !== void 0) payload.sort_by = options.sort_by;
			const res = await this.doFetch(`http://${host}:${port}/v1/recall`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: controller.signal
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				return {
					ok: false,
					error: `recall failed with HTTP ${res.status}: ${text}`
				};
			}
			const data = await res.json();
			return {
				ok: true,
				notes: data.notes ?? "",
				...data.processing_ms !== void 0 ? { processing_ms: data.processing_ms } : {}
			};
		} catch (error) {
			return {
				ok: false,
				error: `recall request failed: ${String(error)}`
			};
		} finally {
			timer.catch(() => {});
		}
	}
	async resume(host, port, timeoutMs) {
		const controller = new AbortController();
		const timer = setTimeout$1(timeoutMs).then(() => controller.abort());
		try {
			const res = await this.doFetch(`http://${host}:${port}/v1/resume`, {
				method: "GET",
				headers: { accept: "application/json" },
				signal: controller.signal
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				return {
					ok: false,
					error: `resume failed with HTTP ${res.status}: ${text}`
				};
			}
			return {
				ok: true,
				data: await res.json()
			};
		} catch (error) {
			return {
				ok: false,
				error: `resume request failed: ${String(error)}`
			};
		} finally {
			timer.catch(() => {});
		}
	}
};
//#endregion
//#region src/infra/instance-resolver.ts
const NOOP_LOGGER = { logger: {
	info: () => {},
	warn: () => {}
} };
var InstanceResolver = class {
	ctx;
	instancesPath;
	constructor(instancesPath = DEFAULT_INSTANCES_FILE, ctx) {
		this.instancesPath = instancesPath;
		this.ctx = ctx ?? NOOP_LOGGER;
	}
	async resolveForWorkspace(workspace) {
		try {
			const instances = readInstancesFile(this.ctx, this.instancesPath);
			if (!instances) return void 0;
			return resolveInstance(instances, workspace);
		} catch {
			return;
		}
	}
	async getAll() {
		try {
			return readInstancesFile(this.ctx, this.instancesPath) ?? {};
		} catch {
			return {};
		}
	}
};
//#endregion
//#region src/infra/codebase-service.ts
var CodebaseService = class {
	metaPath;
	constructor(metaPath = DEFAULT_CODEBASES_FILE$1) {
		this.metaPath = metaPath;
	}
	async listForWorkspace(workspace) {
		try {
			return loadCodebases(this.metaPath).filter((entry) => entry.workspace === workspace);
		} catch {
			return [];
		}
	}
};
//#endregion
//#region src/bridge/session-service.ts
/**
* Application service for session-scoped Vectr status and operations.
*
* Implements {@link ISessionStatusService} (Layer 3: Host RPC Bridge).
* Coordinates domain policies, instance discovery, codebase querying,
* daemon HTTP calls, and CLI execution.
*
* @module dsh-vectr-client/bridge/session-service
*/
var SessionVectrService = class {
	instanceResolver;
	apiClient;
	codebaseService;
	cliRunner;
	statusTimeoutMs;
	recallTimeoutMs;
	defaultHost;
	constructor(options) {
		this.instanceResolver = options.instanceResolver;
		this.apiClient = options.apiClient;
		this.codebaseService = options.codebaseService;
		this.cliRunner = options.cliRunner;
		this.statusTimeoutMs = options.statusTimeoutMs ?? 5e3;
		this.recallTimeoutMs = options.recallTimeoutMs ?? 1e4;
		this.defaultHost = options.defaultHost ?? "127.0.0.1";
	}
	async getSessionStatus(workspace) {
		const wsCheck = validateWorkspace(workspace);
		if (!wsCheck.valid) return {
			workspace,
			live: false,
			mode: "offline",
			codebases: [],
			canReindex: false,
			...wsCheck.error ? {
				error: wsCheck.error,
				reindexDisabledReason: wsCheck.error
			} : {}
		};
		const codebases = (await this.codebaseService.listForWorkspace(workspace)).map((cb) => ({
			slug: cb.slug,
			type: cb.type,
			target: cb.type === "remote" ? `${cb.host ?? ""}:${cb.remotePort ?? ""}` : cb.path,
			status: cb.status,
			...cb.error ? { error: cb.error } : {},
			...cb.workspace ? { workspace: cb.workspace } : {}
		}));
		const instance = await this.instanceResolver.resolveForWorkspace(workspace);
		if (!instance) return {
			workspace,
			live: false,
			mode: "offline",
			codebases,
			canReindex: false,
			reindexDisabledReason: "No Vectr daemon registered for this workspace",
			reason: "no_instance_registered"
		};
		const host = instance.host ?? this.defaultHost;
		const status = await this.apiClient.getStatus(host, instance.port, this.statusTimeoutMs);
		const live = status !== void 0;
		const mode = formatMode(typeof instance.mode === "string" ? instance.mode : typeof status?.mode === "string" ? status.mode : "full", live);
		const reindexRule = canReindex(live, mode, status);
		return {
			workspace,
			live,
			mode,
			port: instance.port,
			...instance.pid !== void 0 ? { pid: instance.pid } : {},
			host,
			...status !== void 0 ? { status } : {},
			codebases,
			canReindex: reindexRule.canReindex,
			...reindexRule.reason ? { reindexDisabledReason: reindexRule.reason } : {},
			...!live ? { reason: "daemon_unresponsive_or_offline" } : {}
		};
	}
	async triggerIndex(workspace) {
		const wsCheck = validateWorkspace(workspace);
		if (!wsCheck.valid) return {
			ok: false,
			error: wsCheck.error
		};
		const instance = await this.instanceResolver.resolveForWorkspace(workspace);
		if (!instance) return {
			ok: false,
			error: "No Vectr daemon registered for this workspace"
		};
		const host = instance.host ?? this.defaultHost;
		const status = await this.apiClient.getStatus(host, instance.port, this.statusTimeoutMs);
		const live = status !== void 0;
		const reindexRule = canReindex(live, formatMode(typeof instance.mode === "string" ? instance.mode : typeof status?.mode === "string" ? status.mode : "full", live), status);
		if (!reindexRule.canReindex) return {
			ok: false,
			error: reindexRule.reason ?? "Re-index rejected by domain policy"
		};
		return this.apiClient.triggerIndex(host, instance.port, this.statusTimeoutMs);
	}
	async initWorkspace(options) {
		return this.cliRunner.init(options);
	}
	async recallNotes(target, options) {
		let port = target.port;
		let host = this.defaultHost;
		if (port === void 0 && target.workspace) {
			const inst = await this.instanceResolver.resolveForWorkspace(target.workspace);
			if (inst) {
				port = inst.port;
				if (inst.host) host = inst.host;
			}
		}
		if (port === void 0) return {
			ok: false,
			error: "No active Vectr instance found for recall"
		};
		return this.apiClient.recall(host, port, options, this.recallTimeoutMs);
	}
	async getResume(target) {
		let port = target.port;
		let host = this.defaultHost;
		if (port === void 0 && target.workspace) {
			const inst = await this.instanceResolver.resolveForWorkspace(target.workspace);
			if (inst) {
				port = inst.port;
				if (inst.host) host = inst.host;
			}
		}
		if (port === void 0) return {
			ok: false,
			error: "No active Vectr instance found for resume"
		};
		return this.apiClient.resume(host, port, this.recallTimeoutMs);
	}
};
//#endregion
//#region src/bridge/routes.ts
/**
* Write a JSON HTTP response.
*/
function sendJson(res, statusCode, body) {
	const payload = JSON.stringify(body);
	res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
	res.end(payload);
}
/**
* Read and parse JSON request body with size protection.
*/
async function readJsonBody(req, limitBytes = 1e6) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > limitBytes) throw new Error("Request body too large");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8");
	return JSON.parse(text);
}
/**
* Register session-scoped management routes on the webServer service.
*
* - `GET  /api/vectr/session-status?workspace=<path>`
* - `POST /api/vectr/session-reindex`
* - `POST /api/vectr/init`
* - `POST /api/vectr/notes/recall`
* - `GET  /api/vectr/notes/resume?workspace=<path>`
*
* @param ctx - plugin context carrying `webServer`.
* @param sessionService - application service implementing {@link ISessionStatusService}.
*/
function registerSessionRoutes(ctx, sessionService) {
	const webServer = ctx.get("webServer");
	if (webServer === void 0) {
		ctx.logger?.warn?.("vectr-client: webServer service unavailable; skipping /api/vectr/session-* routes");
		return;
	}
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/api/vectr/session-status",
		handler: async (req, res) => {
			if (req.method !== "GET") {
				sendJson(res, 405, { error: "Method not allowed" });
				return;
			}
			try {
				const workspace = new URL(req.url ?? "", "http://localhost").searchParams.get("workspace");
				if (!workspace || workspace.trim().length === 0) {
					sendJson(res, 400, { error: "Missing required query parameter \"workspace\"" });
					return;
				}
				sendJson(res, 200, await sessionService.getSessionStatus(workspace.trim()));
			} catch (error) {
				sendJson(res, 500, { error: String(error) });
			}
		}
	}), "vectr-client: GET /api/vectr/session-status");
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/api/vectr/init",
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { error: "Method not allowed" });
				return;
			}
			let body;
			try {
				body = await readJsonBody(req);
			} catch (error) {
				sendJson(res, 400, { error: `Invalid JSON body: ${String(error)}` });
				return;
			}
			const opts = body;
			if (!opts || typeof opts.workspace !== "string" || opts.workspace.trim().length === 0) {
				sendJson(res, 400, { error: "Missing required field \"workspace\" in request body" });
				return;
			}
			try {
				const initOpts = {
					workspace: opts.workspace.trim(),
					hooks: opts.hooks === true,
					memoryOnly: opts.memoryOnly === true,
					...opts.style && typeof opts.style === "string" ? { style: opts.style.trim() } : {}
				};
				const result = await sessionService.initWorkspace(initOpts);
				sendJson(res, result.ok ? 200 : 400, result);
			} catch (error) {
				sendJson(res, 500, {
					ok: false,
					error: String(error)
				});
			}
		}
	}), "vectr-client: POST /api/vectr/init");
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/api/vectr/notes/recall",
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { error: "Method not allowed" });
				return;
			}
			let body;
			try {
				body = await readJsonBody(req);
			} catch (error) {
				sendJson(res, 400, { error: `Invalid JSON body: ${String(error)}` });
				return;
			}
			const params = body;
			const target = {
				...params.workspace ? { workspace: params.workspace.trim() } : {},
				...typeof params.port === "number" ? { port: params.port } : {}
			};
			const recallOpts = {
				...params.query ? { query: params.query } : {},
				...params.limit ? { limit: params.limit } : {},
				...params.detail ? { detail: params.detail } : {},
				...params.kind ? { kind: params.kind } : {},
				...params.priority ? { priority: params.priority } : {},
				...params.sort_by ? { sort_by: params.sort_by } : {},
				...params.tags ? { tags: params.tags } : {}
			};
			try {
				const result = await sessionService.recallNotes(target, recallOpts);
				sendJson(res, result.ok ? 200 : 400, result);
			} catch (error) {
				sendJson(res, 500, {
					ok: false,
					error: String(error)
				});
			}
		}
	}), "vectr-client: POST /api/vectr/notes/recall");
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/api/vectr/notes/resume",
		handler: async (req, res) => {
			if (req.method !== "GET") {
				sendJson(res, 405, { error: "Method not allowed" });
				return;
			}
			try {
				const url = new URL(req.url ?? "", "http://localhost");
				const workspace = url.searchParams.get("workspace") ?? void 0;
				const portRaw = url.searchParams.get("port");
				const port = portRaw ? parseInt(portRaw, 10) : void 0;
				const target = {
					...workspace ? { workspace: workspace.trim() } : {},
					...typeof port === "number" && !isNaN(port) ? { port } : {}
				};
				const result = await sessionService.getResume(target);
				sendJson(res, result.ok ? 200 : 400, result);
			} catch (error) {
				sendJson(res, 500, {
					ok: false,
					error: String(error)
				});
			}
		}
	}), "vectr-client: GET /api/vectr/notes/resume");
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/api/vectr/session-reindex",
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { error: "Method not allowed" });
				return;
			}
			let body;
			try {
				body = await readJsonBody(req);
			} catch (error) {
				sendJson(res, 400, { error: `Invalid JSON body: ${String(error)}` });
				return;
			}
			const params = body;
			if (!params || typeof params.workspace !== "string" || params.workspace.trim().length === 0) {
				sendJson(res, 400, { error: "Missing required field \"workspace\" in request body" });
				return;
			}
			try {
				const result = await sessionService.triggerIndex(params.workspace.trim());
				sendJson(res, result.ok ? 200 : 400, result);
			} catch (error) {
				sendJson(res, 500, {
					ok: false,
					error: String(error)
				});
			}
		}
	}), "vectr-client: POST /api/vectr/session-reindex");
}
//#endregion
//#region src/index.ts
/**
* Per-workspace vectr MCP binding plugin: on every `agent/created` (and for
* already-live agents at startup) it resolves the agent's workspace (session
* cwd), looks up that workspace's vectr daemon port in
* `~/.vectr/instances.json`, connects a Streamable HTTP MCP client to
* `http://localhost:<port>/mcp` through the shared mcp-client supervisor, and
* registers the vectr tools (`mcp__vectr__*`) scoped to that agent only.
* `agent/disposed` closes the HTTP connection; the agent scope unwinds the
* tool registrations on its own.
*
* Each workspace directory has its own vectr daemon (and port), so the binding
* is entirely derived from the agent's workspace — no global MCP config.
*
* Namespace plugin (named exports, no default export). Lifecycle is
* effect-scoped: disposal closes every live connection.
*
* @module dsh-vectr-client
*/
/** Return a shallow copy with the credential ref omitted (no secret leaks). */
function stripSecret(entry) {
	const { credentialRef: _credentialRef, ...rest } = entry;
	return rest;
}
/** Cordis plugin name used by loader diagnostics. */
const name = "vectr-client";
/** Services required by this plugin. `webServer` is consumed optionally via
* `ctx.get` (see {@link registerManagementRoutes}) so the plugin also loads in
* harness compositions that do not boot the web server; the host provides it. */
const inject = ["agents"];
/** Default per-tool-call timeout for vectr MCP calls (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 6e4;
/** Default local namespace for vectr tools (`mcp__vectr__*`). */
const DEFAULT_SERVER_NAME = "vectr";
/** Default path of the multi-codebase metadata file (feature B). */
const DEFAULT_CODEBASES_FILE = join(homedir(), ".dsh", "vectr-codebases.json");
/** Default path of the file-backed secret store (used when no host credentials service). */
const DEFAULT_SECRETS_FILE = join(homedir(), ".dsh", "vectr-secrets.json");
/** Default HTTP `/v1/status` liveness-probe budget (ms); below the known hang window. */
const DEFAULT_DAEMON_HTTP_TIMEOUT_MS = 5e3;
/** Default TCP port-listening probe budget (ms). */
const DEFAULT_DAEMON_TCP_TIMEOUT_MS = 300;
/** Default Vectr CLI execution timeout in ms (default 30,000). */
const DEFAULT_CLI_TIMEOUT_MS = 3e4;
/** Default working memory note recall / resume timeout in ms (default 10,000). */
const DEFAULT_RECALL_TIMEOUT_MS = 1e4;
/** (b) Minimum interval between startup-time heal attempts for the same slug.
* Prevents a persistently-unreachable host from being hammered on every host
* restart while still leaving room for transient blips to recover. */
const STARTUP_HEAL_COOLDOWN_MS = 3e4;
/** Per-slug timestamp of the last startup-heal attempt. Process-local — a
* restart resets the map (one fresh attempt per slug per host lifetime). */
const startupHealCooldown = /* @__PURE__ */ new Map();
/** (b) Startup-heal scope: which persisted entries get an automatic
* `ensureTunnelUp` attempt at host startup. `up` keeps its legacy behavior;
* `down` and `error` are the previously-deadlocked states that were only
* surfaced to the user and never automatically recovered. `local` entries
* have no tunnel to heal. */
function startupHealEligible(entry) {
	return entry.type === "remote" && (entry.status === "up" || entry.status === "down" || entry.status === "error");
}
const Reconnect = z.object({
	enabled: z.boolean().default(false),
	initialDelayMs: z.number().min(1).default(500),
	maxDelayMs: z.number().min(1).default(3e4),
	maxAttempts: z.number().step(1).min(1).default(10)
});
const Config = z.object({
	instancesPath: z.string().default(DEFAULT_INSTANCES_FILE),
	serverName: z.string().default(DEFAULT_SERVER_NAME),
	toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
	reconnect: Reconnect.default({ enabled: false }),
	codebasesPath: z.string().default(DEFAULT_CODEBASES_FILE),
	secretsPath: z.string().default(DEFAULT_SECRETS_FILE),
	daemonHttpTimeoutMs: z.number().min(1).default(DEFAULT_DAEMON_HTTP_TIMEOUT_MS),
	daemonTcpTimeoutMs: z.number().min(1).default(DEFAULT_DAEMON_TCP_TIMEOUT_MS),
	cliPath: z.string().default(""),
	cliTimeoutMs: z.number().min(1).default(DEFAULT_CLI_TIMEOUT_MS),
	recallTimeoutMs: z.number().min(1).default(DEFAULT_RECALL_TIMEOUT_MS)
});
/**
* System-prompt section contributed to each agent when its vectr daemon is
* verified alive: nudges the agent to prioritize vectr MCP tools for code queries
* and codebase navigation over grep and blind file reads. Static English text
* (matches the official prompt style). Order 95 sits after the deployment
* persona (0) and before the tool-guidance band (100–199); see
* `@deepseek-ai/dsh-system-prompt`.
*/
const VECTR_GUIDANCE_SECTION_NAME = "vectr:mcp-guidance";
const VECTR_GUIDANCE_SECTION_ORDER = 95;
const VECTR_GUIDANCE_SECTION_TEXT = "When answering code-query or codebase-navigation questions, prioritize the vectr MCP tools (mcp__vectr__*) over grep and blind file reads. Search, retrieve, and reason over the indexed workspace using vectr first; fall back to grep only if vectr query fails or returns no matches.";
/**
* Scoped prompt section that shadows the global `tool:grep` section for agents
* in a verified vectr workspace. Instead of directly telling the model to use
* grep to search file contents, it instructs the model to prioritize vectr tools
* and only use grep as a fallback if vectr fails.
*/
const VECTR_GREP_SECTION_NAME = "tool:grep";
const VECTR_GREP_SECTION_ORDER = 1500;
const VECTR_GREP_SECTION_TEXT = "Prioritize querying code via vectr tools (mcp__vectr__*). If vectr query fails or yields no results, use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.";
/**
* @see ./registry.ts for `resolveInstance` / `readInstancesFile`.
* @see ./probe.ts for `isPortListening` / `isDaemonAlive` / `diagnoseDaemon`.
* These were migrated out of this file; it re-exports them above and only
* wires the plugin together.
*/
/**
* Install the vectr MCP connection for one agent. Re-reads the registry on
* every call so a daemon restart (new port / new pid) is picked up by the next
* `agent/created` or seed without a Host reload.
* @param ctx - plugin context (the loader fiber) providing agents and logger.
* @param handles - live connection handles keyed by agent.
* @param promptFibers - live system-prompt injection fibers keyed by agent.
* @param instancesPath - absolute path of the vectr daemon registry.
* @param config - resolved plugin configuration.
* @param agent - the agent whose workspace resolves the daemon port.
*/
function install(ctx, handles, promptFibers, instancesPath, config, agent, codebasesPath, disposed = /* @__PURE__ */ new Set()) {
	if (handles.has(agent)) return;
	const cwd = agent.session.header.cwd;
	if (cwd === void 0) {
		ctx.logger.warn(`vectr-client: no cwd on session ${agent.id}, skipping vectr binding`);
		return;
	}
	let instances;
	try {
		instances = readInstancesFile(ctx, instancesPath);
	} catch (error) {
		ctx.logger.warn(`vectr-client: cannot read daemon registry at ${instancesPath} (${String(error)}); skipping bind for session ${agent.id}`);
		return;
	}
	if (instances === void 0) return;
	const entry = resolveInstance(instances, cwd);
	if (entry === void 0) {
		ctx.logger.info(`vectr-client: no vectr daemon for ${cwd}, skipping`);
		return;
	}
	(async () => {
		const diagnosis = await diagnoseDaemon(entry, {
			httpProbe: (e, ms) => fetchStatus(e, ms),
			httpTimeoutMs: config.daemonHttpTimeoutMs ?? 5e3,
			tcpTimeoutMs: config.daemonTcpTimeoutMs ?? DEFAULT_DAEMON_TCP_TIMEOUT_MS
		});
		if (!diagnosis.alive) {
			const pid = entry.pid === void 0 ? "n/a" : String(entry.pid);
			const reason = diagnosis.reason ?? "HTTP_PROBE_UNREACHABLE";
			ctx.logger.warn(`vectr-client: vectr daemon not alive, skipping bind for session ${agent.id} (cwd=${cwd}, workspace=${entry.workspace}, port=${entry.port}, pid=${pid}, reason=${reason})`);
			return;
		}
		const host = entry.host ?? "127.0.0.1";
		const port = entry.port;
		const policy = resolveReconnectPolicy(config.reconnect, `vectr-client(${config.serverName}): reconnect`);
		const conn = startConnection(agent.ctx, {
			transport: "streamable-http",
			serverName: config.serverName,
			url: `http://${host}:${port}/mcp`,
			headers: {},
			toolCallTimeoutMs: config.toolCallTimeoutMs,
			failOnStartupError: false
		}, policy);
		conn.ready.then((outcome) => {
			if (outcome.error !== void 0) {
				const message = `vectr-client: vectr connection failed for session ${agent.id} (cwd=${cwd}, port=${port}): ${String(outcome.error)}`;
				if (agent.ctx?.logger !== void 0) agent.ctx.logger.warn(message);
				else ctx.logger.warn(message);
			}
		});
		if (disposed.has(agent)) conn.dispose().catch(() => {});
		else handles.set(agent, conn);
		if (!promptFibers.has(agent)) {
			const fiber = agent.ctx.inject(["systemPrompt"], (scope) => {
				scope.systemPrompt.section({
					name: VECTR_GUIDANCE_SECTION_NAME,
					order: 95,
					text: VECTR_GUIDANCE_SECTION_TEXT
				});
				scope.systemPrompt.section({
					name: VECTR_GREP_SECTION_NAME,
					order: scope.systemPrompt.getSectionOrder?.("TOOL_GREP") ?? 1500,
					text: VECTR_GREP_SECTION_TEXT
				});
			});
			if (disposed.has(agent)) fiber.dispose().catch(() => {});
			else promptFibers.set(agent, fiber);
		}
		disposed.delete(agent);
	})();
	if (codebasesPath !== void 0) installCodebaseConnections(ctx, config, agent, codebasesPath, instances, cwd);
}
/**
* Connect the agent to every persisted codebase entry with `status === 'up'`.
* Each entry exposes a Streamable HTTP MCP endpoint at
* `http://127.0.0.1:<localPort>/mcp`; registration uses the entry's
* `serverName` (globally unique). A bind failure only logs a warning and never
* blocks the main workspace connection.
* @param ctx - plugin context providing the logger.
* @param config - resolved plugin configuration.
* @param agent - the agent to bind the codebase tools to.
* @param codebasesPath - absolute path of the codebase metadata file.
*/
async function installCodebaseConnections(ctx, config, agent, codebasesPath, instances, cwd) {
	let entries;
	try {
		entries = loadCodebases(codebasesPath);
	} catch (error) {
		ctx.logger.warn(`vectr-client: cannot read codebase metadata at ${codebasesPath} (${String(error)}); skipping codebase binds for session ${agent.id}`);
		return;
	}
	const agentWs = cwd !== void 0 && instances !== void 0 ? resolveInstance(instances, cwd)?.workspace : void 0;
	const knownWorkspaces = new Set(Object.values(instances ?? {}).map((e) => e.workspace));
	const policy = resolveReconnectPolicy(config.reconnect, "vectr-client(codebase): reconnect");
	for (const entry of entries) {
		if (entry.status !== "up" || entry.localPort === void 0) continue;
		if (agentWs !== void 0) {
			if (entry.workspace !== agentWs) continue;
		} else if (entry.workspace === void 0 || !knownWorkspaces.has(entry.workspace)) continue;
		try {
			startConnection(agent.ctx, {
				transport: "streamable-http",
				serverName: entry.serverName,
				url: `http://127.0.0.1:${entry.localPort}/mcp`,
				headers: {},
				toolCallTimeoutMs: config.toolCallTimeoutMs,
				failOnStartupError: false
			}, policy).ready.then((outcome) => {
				if (outcome.error !== void 0) {
					const message = `vectr-client: codebase connection failed for session ${agent.id} (serverName=${entry.serverName}, port=${entry.localPort}): ${String(outcome.error)}`;
					if (agent.ctx?.logger !== void 0) agent.ctx.logger.warn(message);
					else ctx.logger.warn(message);
				}
			});
		} catch (error) {
			ctx.logger.warn(`vectr-client: codebase bind threw for ${entry.serverName} (session ${agent.id}): ${String(error)}`);
		}
	}
}
/**
* The vectr-client plugin entry: seed already-live agents, watch
* `agent/created` / `agent/disposed`, and close every connection on teardown.
* @param ctx - plugin context whose fiber owns the listeners and handles.
* @param config - resolved plugin configuration.
*/
function apply(ctx, config = {}) {
	const resolved = {
		instancesPath: config.instancesPath ?? DEFAULT_INSTANCES_FILE,
		serverName: config.serverName ?? "vectr",
		toolCallTimeoutMs: config.toolCallTimeoutMs ?? 6e4,
		reconnect: config.reconnect ?? { enabled: false },
		codebasesPath: config.codebasesPath ?? DEFAULT_CODEBASES_FILE,
		secretsPath: config.secretsPath ?? DEFAULT_SECRETS_FILE,
		daemonHttpTimeoutMs: config.daemonHttpTimeoutMs ?? 5e3,
		daemonTcpTimeoutMs: config.daemonTcpTimeoutMs ?? DEFAULT_DAEMON_TCP_TIMEOUT_MS,
		cliPath: config.cliPath ?? "",
		cliTimeoutMs: config.cliTimeoutMs ?? 3e4,
		recallTimeoutMs: config.recallTimeoutMs ?? 1e4
	};
	const instancesPath = isAbsolute(resolved.instancesPath) ? resolved.instancesPath : resolve(process.cwd(), resolved.instancesPath);
	const codebasesPath = isAbsolute(resolved.codebasesPath) ? resolved.codebasesPath : resolve(process.cwd(), resolved.codebasesPath);
	try {
		cleanupStaleTunnelSockets(void 0, loadCodebases(codebasesPath).filter((e) => e.type === "remote" && typeof e.slug === "string").map((e) => e.slug));
	} catch {}
	try {
		const instances = readInstancesFile(ctx, instancesPath);
		if (instances !== void 0) migrateCodebases(codebasesPath, instances, ctx.logger);
	} catch (err) {
		ctx.logger.warn(`vectr-client: startup codebase migration skipped: ${String(err)}`);
	}
	try {
		const deps = buildCodebaseDeps(ctx, resolved.secretsPath);
		const now = Date.now();
		for (const entry of loadCodebases(codebasesPath)) {
			if (!startupHealEligible(entry)) continue;
			const lastAttempt = startupHealCooldown.get(entry.slug);
			if (lastAttempt !== void 0 && now - lastAttempt < 3e4) continue;
			startupHealCooldown.set(entry.slug, now);
			ensureTunnelUp(deps, codebasesPath, entry).catch((err) => {
				ctx.logger.warn(`vectr-client: could not re-establish tunnel for ${entry.slug}: ${String(err)}`);
			});
		}
	} catch (err) {
		ctx.logger.warn(`vectr-client: startup tunnel heal skipped: ${String(err)}`);
	}
	const handles = /* @__PURE__ */ new Map();
	const promptFibers = /* @__PURE__ */ new Map();
	const disposed = /* @__PURE__ */ new Set();
	for (const agent of ctx.agents.list()) install(ctx, handles, promptFibers, instancesPath, resolved, agent, codebasesPath, disposed);
	ctx.on("agent/created", ({ agent }) => {
		install(ctx, handles, promptFibers, instancesPath, resolved, agent, codebasesPath, disposed);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		disposed.add(agent);
		handles.get(agent)?.dispose();
		handles.delete(agent);
		const fiber = promptFibers.get(agent);
		if (fiber !== void 0) {
			fiber.dispose().catch((error) => {
				ctx.logger.warn(`vectr-client: prompt-section cleanup failed for ${agent.id}: ${error instanceof Error ? error.message : String(error)}`);
			});
			promptFibers.delete(agent);
		}
	});
	ctx.effect(() => async () => {
		for (const conn of handles.values()) conn.dispose();
		handles.clear();
		for (const fiber of promptFibers.values()) fiber.dispose().catch(() => {});
		promptFibers.clear();
		let fallbackNeeded = [];
		try {
			for (const entry of loadCodebases(codebasesPath)) {
				if (entry.type !== "remote") continue;
				if (!(entry.tunnelPid !== void 0 || entry.tunnelCtl !== void 0)) continue;
				let recordedOk = false;
				if (entry.tunnelCtl !== void 0 && entry.host !== void 0) {
					const ctl = entry.tunnelCtl;
					const host = entry.host;
					try {
						const result = await new Promise((resolveExit) => {
							const child = spawn("ssh", [
								"-O",
								"exit",
								"-S",
								ctl,
								host
							]);
							child.on("error", () => {
								resolveExit({
									code: 1,
									signal: null
								});
							});
							child.on("close", (code, signal) => {
								resolveExit({
									code: code ?? 1,
									signal
								});
							});
						});
						recordedOk = result.code === 0 && result.signal === null;
					} catch {}
				}
				if (entry.tunnelPid !== void 0) try {
					process.kill(entry.tunnelPid, "SIGTERM");
				} catch (err) {
					if (err.code !== "ESRCH") ctx.logger.warn(`vectr-client: teardown cannot SIGTERM recorded tunnelPid ${entry.tunnelPid}: ${String(err)}`);
				}
				if (!recordedOk) fallbackNeeded.push(entry);
			}
		} catch {}
		if (fallbackNeeded.length > 0) try {
			await cleanupOrphanedTunnelsForCodebases(buildCodebaseDeps(ctx, resolved.secretsPath), fallbackNeeded);
		} catch {}
	}, "vectr-client.connections");
	registerManagementRoutes(ctx, instancesPath, resolved);
	registerCodebaseRoutes(ctx, codebasesPath, resolved.secretsPath, instancesPath);
	registerSessionRoutes(ctx, new SessionVectrService({
		instanceResolver: new InstanceResolver(instancesPath, ctx),
		apiClient: new VectrApiClient(),
		codebaseService: new CodebaseService(codebasesPath),
		cliRunner: new VectrCliRunner({
			cliPath: resolved.cliPath || void 0,
			timeoutMs: resolved.cliTimeoutMs
		}),
		statusTimeoutMs: resolved.daemonHttpTimeoutMs,
		recallTimeoutMs: resolved.recallTimeoutMs
	}));
}
/**
* Write a JSON body with the given status code.
* @param res - the node:http response.
* @param statusCode - HTTP status to send.
* @param body - value serialized as JSON.
*/
function sendJson$1(res, statusCode, body) {
	const payload = JSON.stringify(body);
	res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
	res.end(payload);
}
/**
* Read a JSON request body with a size cap (defense against unbounded reads).
* @param req - the incoming request.
* @param limitBytes - maximum accepted bytes.
* @returns the parsed body, or a thrown Error on over-length / bad JSON.
*/
async function readJsonBody$1(req, limitBytes = 1e6) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > limitBytes) throw new Error("request body too large");
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	const text = Buffer.concat(chunks).toString("utf8");
	return JSON.parse(text);
}
/**
* Register the two workspace-console HTTP routes on the injected webServer:
*
* - `GET /api/vectr/workspaces` → {@link scanWorkspaces} result (JSON array of
*   {@link WorkspaceView}).
* - `POST /api/vectr/trigger-index` body `{ "port": number }` (or
*   `{ "workspace": string }`) → resolve the single matching registry entry and
*   call {@link triggerIndex}; returns the {@link TriggerResult}.
*
* Both handlers are Cordis effects (the disposer from `webServer.register`),
* so they vanish with the plugin fiber. A registry read failure on either
* route answers 500 with the diagnostic rather than crashing the request.
*
* @param ctx - plugin context carrying the webServer service.
* @param instancesPath - absolute path of `instances.json`.
* @param config - resolved plugin configuration (supplies `daemonHttpTimeoutMs`).
*/
function registerManagementRoutes(ctx, instancesPath, config) {
	const webServer = ctx.get("webServer");
	if (webServer === void 0) {
		ctx.logger.warn("vectr-client: webServer service unavailable; skipping /api/vectr/* management routes");
		return;
	}
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/api/vectr/workspaces",
		handler: async (_req, res) => {
			try {
				sendJson$1(res, 200, await scanWorkspaces(ctx, instancesPath, { statusTimeoutMs: config.daemonHttpTimeoutMs }));
			} catch (error) {
				sendJson$1(res, 500, { error: String(error) });
			}
		}
	}), "vectr-client: GET /api/vectr/workspaces");
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/api/vectr/trigger-index",
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson$1(res, 405, { error: "method not allowed" });
				return;
			}
			let body;
			try {
				body = await readJsonBody$1(req);
			} catch (error) {
				sendJson$1(res, 400, { error: String(error) });
				return;
			}
			const target = body;
			const instances = readInstancesFile(ctx, instancesPath);
			if (instances === void 0) {
				sendJson$1(res, 404, {
					ok: false,
					error: "no vectr daemon registry found"
				});
				return;
			}
			let entry = void 0;
			if (typeof target.port === "number") entry = Object.values(instances).find((e) => e.port === target.port);
			else if (typeof target.workspace === "string") entry = Object.values(instances).find((e) => e.workspace === target.workspace);
			if (entry === void 0) {
				sendJson$1(res, 404, {
					ok: false,
					error: "no daemon matches the requested port/workspace"
				});
				return;
			}
			const status = await fetchStatus(entry, config.daemonHttpTimeoutMs ?? 5e3);
			const result = await triggerIndex(entry, status !== void 0 ? { status } : {});
			sendJson$1(res, result.ok ? 200 : 409, result);
		}
	}), "vectr-client: POST /api/vectr/trigger-index");
}
/**
* Build the runtime dependencies for the codebase manager from the host
* environment. `spawnRunner` wraps `node:child_process spawn`; `sshRunner`
* wraps `spawn('ssh', args)` and, for password-auth codebases, injects the
* password via `sshpass` (`-o PreferredAuthentications=password`); `credStore` prefers the host `credentials`
* service (when present) and otherwise falls back to a file-backed store.
*
* When the host `credentials` service exists, its async `set`/`unset` are
* adapted to the sync-friendly {@link CredentialStore} shape by awaiting; `get`
* resolves via `resolve(ref)`. Ref names follow `VECTR_SSH_<SLUG>`.
*
* @param ctx - plugin context (for `credentials` lookup + logger).
* @param secretsPath - fallback secret file path.
* @returns the assembled {@link CodebaseDeps}-compatible runners + store.
*/
function buildCodebaseDeps(ctx, secretsPath) {
	const spawnRunner = (command, args) => {
		const child = spawn(command, args, { stdio: [
			"ignore",
			"pipe",
			"pipe"
		] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		return {
			promise: new Promise((resolveExit) => {
				child.on("error", (err) => {
					resolveExit({
						code: 1,
						stdout,
						stderr: `${stderr}\n${String(err)}`,
						signal: null
					});
				});
				child.on("close", (code, signal) => {
					resolveExit({
						code: code ?? 1,
						stdout,
						stderr,
						signal
					});
				});
			}),
			kill() {
				child.kill("SIGTERM");
			}
		};
	};
	const sshRunner = (args, auth) => {
		if (auth?.password !== void 0) {
			const passFile = join(tmpdir(), `vectr-sshpass-${process.pid}-${randomBytes(6).toString("hex")}`);
			writeFileSync(passFile, auth.password, { mode: 384 });
			try {
				const handle = spawnRunner("sshpass", [
					"-f",
					passFile,
					"-o",
					"PreferredAuthentications=password",
					"-o",
					"PubkeyAuthentication=no",
					...args
				]);
				handle.promise.finally(() => {
					try {
						rmSync(passFile);
					} catch {}
				});
				return handle;
			} catch (err) {
				try {
					rmSync(passFile);
				} catch {}
				throw err;
			}
		}
		return spawnRunner("ssh", args);
	};
	const hostCreds = ctx.get("credentials");
	let credStore;
	if (hostCreds !== void 0) credStore = {
		set: (ref, value) => hostCreds.set(ref, value),
		get: (ref) => hostCreds.resolve(ref).then((r) => r?.value),
		unset: (ref) => hostCreds.unset(ref)
	};
	else credStore = new FileCredentialStore(secretsPath);
	return {
		spawnRunner,
		sshRunner,
		credStore,
		warn: (message) => {
			ctx.logger.warn(message);
		}
	};
}
/**
* Extract the codebase slug from a request pathname. Strips the codebase route
* prefix and keeps only the first path segment, so `/api/vectr/codebases/demo`
* and `/api/vectr/codebases/demo/test` both yield `demo` — the `/test` suffix is
* an action, not part of the slug. This was the root cause of
* `POST /api/vectr/codebases/:slug/test` returning 404: the slug was derived as
* `demo/test` and never matched a persisted entry (改动3).
* @param pathname - request pathname (e.g. `/api/vectr/codebases/demo/test`).
* @returns the bare slug, or `''` when the pathname carries no slug segment.
*/
function slugFromPathname(pathname) {
	return decodeURIComponent(pathname.replace("/api/vectr/codebases/", "")).split("/")[0] ?? "";
}
/**
* Register the feature-B codebase management HTTP routes:
*
* - `GET  /api/vectr/codebases` → list persisted entries (no secrets).
* - `POST /api/vectr/codebases` body {@link CodebaseSpec} → create (password
*   only forwarded to the store; never echoed in the response).
* - `DELETE /api/vectr/codebases/:slug` → delete.
* - `POST /api/vectr/codebases/:slug/test` → liveness probe.
*
* The routes are Cordis effects so they vanish with the plugin fiber. A host
* without `webServer` skips them (logged once).
*
* @param ctx - plugin context carrying `webServer` + `credentials`.
* @param codebasesPath - absolute path of the codebase metadata file.
* @param secretsPath - fallback secret file path.
*/
function registerCodebaseRoutes(ctx, codebasesPath, secretsPath, instancesPath = DEFAULT_INSTANCES_FILE) {
	const webServer = ctx.get("webServer");
	if (webServer === void 0) {
		ctx.logger.warn("vectr-client: webServer service unavailable; skipping /api/vectr/codebases* routes");
		return;
	}
	const deps = buildCodebaseDeps(ctx, secretsPath);
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/api/vectr/codebases",
		handler: async (req, res) => {
			if (req.method === "GET") {
				try {
					const wsFilter = new URL(req.url ?? "", "http://localhost").searchParams.get("workspace") ?? void 0;
					let list = loadCodebases(codebasesPath).map(stripSecret);
					if (wsFilter !== void 0) list = list.filter((e) => e.workspace === wsFilter);
					sendJson$1(res, 200, list);
				} catch (error) {
					sendJson$1(res, 500, { error: String(error) });
				}
				return;
			}
			if (req.method === "POST") {
				let body;
				try {
					body = await readJsonBody$1(req);
				} catch (error) {
					sendJson$1(res, 400, { error: String(error) });
					return;
				}
				const spec = body;
				if (spec && typeof spec === "object") {
					const rawPath = spec.path || spec.remotePath;
					if (rawPath && typeof rawPath === "string") spec.path = rawPath.trim();
					if (!spec.auth && spec.password) spec.auth = "password";
				}
				try {
					sendJson$1(res, 201, stripSecret(await createCodebase(deps, codebasesPath, spec)));
				} catch (error) {
					sendJson$1(res, 400, { error: String(error) });
				}
				return;
			}
			sendJson$1(res, 405, { error: "method not allowed" });
		}
	}), "vectr-client: /api/vectr/codebases");
	ctx.effect(() => webServer.register({
		kind: "prefix",
		path: "/api/vectr/codebases",
		handler: async (req, res) => {
			const url = new URL(req.url ?? "", "http://localhost");
			const slug = slugFromPathname(url.pathname);
			if (slug.length === 0) {
				sendJson$1(res, 400, { error: "missing codebase slug" });
				return;
			}
			const list = () => loadCodebases(codebasesPath);
			const find = () => list().find((e) => e.slug === slug);
			if (req.method === "DELETE") {
				const entry = find();
				if (entry === void 0) {
					sendJson$1(res, 404, {
						ok: false,
						error: "no such codebase"
					});
					return;
				}
				try {
					await deleteCodebase(deps, codebasesPath, entry);
					sendJson$1(res, 200, { ok: true });
				} catch (error) {
					sendJson$1(res, 500, {
						ok: false,
						error: String(error)
					});
				}
				return;
			}
			if (req.method === "POST" && url.pathname.endsWith("/test")) {
				const entry = find();
				if (entry === void 0) {
					sendJson$1(res, 404, {
						ok: false,
						error: "no such codebase"
					});
					return;
				}
				const result = await testCodebase(entry, {
					deps,
					metaPath: codebasesPath,
					heal: true
				});
				sendJson$1(res, result.ok ? 200 : 503, result);
				return;
			}
			if (req.method === "PATCH") {
				const entry = find();
				if (entry === void 0) {
					sendJson$1(res, 404, {
						ok: false,
						error: "no such codebase"
					});
					return;
				}
				let body;
				try {
					body = await readJsonBody$1(req);
				} catch (error) {
					sendJson$1(res, 400, { error: String(error) });
					return;
				}
				const { workspace } = body ?? {};
				if (!(typeof workspace === "string" && workspace.length > 0 && (workspace === "__unassigned__" || isAbsolute(workspace)))) {
					sendJson$1(res, 400, { error: "PATCH body must include an absolute \"workspace\" path (or the \"__unassigned__\" sentinel)" });
					return;
				}
				let instances;
				try {
					instances = readInstancesFile(ctx, instancesPath);
				} catch (error) {
					sendJson$1(res, 500, { error: String(error) });
					return;
				}
				try {
					sendJson$1(res, 200, {
						ok: true,
						...stripSecret(patchCodebase(codebasesPath, entry.slug, workspace, instances === void 0 ? {} : { instances }))
					});
				} catch (error) {
					if (error instanceof CodebaseError) sendJson$1(res, error.status, {
						ok: false,
						error: error.message
					});
					else sendJson$1(res, 500, {
						ok: false,
						error: String(error)
					});
				}
				return;
			}
			sendJson$1(res, 405, { error: "method not allowed" });
		}
	}), "vectr-client: /api/vectr/codebases/:slug");
}
//#endregion
export { CodebaseService, Config, DEFAULT_CLI_NAME, DEFAULT_CLI_TIMEOUT_MS, DEFAULT_CODEBASES_FILE, DEFAULT_DAEMON_HTTP_TIMEOUT_MS, DEFAULT_DAEMON_TCP_TIMEOUT_MS, DEFAULT_INSTANCES_FILE, DEFAULT_RECALL_TIMEOUT_MS, DEFAULT_SECRETS_FILE, DEFAULT_SERVER_NAME, DEFAULT_TOOL_CALL_TIMEOUT_MS, DEFAULT_TUNNEL_PROBE_MS, InstanceResolver, SIGKILL_ESCALATION_DELAY_MS, SLUG_PATTERN, STARTUP_HEAL_COOLDOWN_MS, SessionVectrService, VECTR_GREP_SECTION_NAME, VECTR_GREP_SECTION_ORDER, VECTR_GREP_SECTION_TEXT, VECTR_GUIDANCE_SECTION_NAME, VECTR_GUIDANCE_SECTION_ORDER, VECTR_GUIDANCE_SECTION_TEXT, VectrApiClient, VectrCliRunner, apply, buildCodebaseDeps, canReindex, ensureTunnelUp, formatMode, hasActiveSession, inject, install, installCodebaseConnections, isDaemonAlive, isMemoryOnly, isPortListening, isSearchOnly, isSessionActivated, name, probeTunnel, readInstancesFile, readJsonBody, registerCodebaseRoutes, registerManagementRoutes, registerSessionRoutes, resolveCliExecutable, resolveInstance, resolveSessionSlotVisibility, resolveUnifiedStatus, sendJson, slugFromPathname, startupHealEligible, validateSlug, validateWorkspace };

//# sourceMappingURL=index.js.map