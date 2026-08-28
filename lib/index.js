import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { resolveReconnectPolicy, startConnection } from "@deepseek-ai/dsh-mcp-client/src/connection.ts";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
/** Validation regex for a slug (also used to derive `serverName`). */
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
join(homedir(), ".dsh", "vectr-codebases.json");
/**
* In-process set of taken `serverName`s, enforcing global uniqueness across
* create calls within one process (per spec). Reset between logical sessions is
* the caller's responsibility; the registry is module-level by design.
*/
const takenServerNames = /* @__PURE__ */ new Set();
/**
* Derive the MCP server name from a slug.
* @param slug - the codebase slug.
* @returns `vectr_<slug>`.
*/
function deriveServerName(slug) {
	return `vectr_${slug}`;
}
/**
* Validate a slug and its derived server name, enforcing the format and the
* in-process uniqueness invariant.
* @param slug - candidate slug.
* @throws when the slug is malformed or its server name is already taken.
*/
function assertSlugAvailable(slug) {
	if (!SLUG_PATTERN.test(slug)) throw new Error(`invalid slug "${slug}": must match ${String(SLUG_PATTERN)}`);
	const serverName = deriveServerName(slug);
	if (takenServerNames.has(serverName)) throw new Error(`server name "${serverName}" is already in use (slug "${slug}" conflicts)`);
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
* @returns the first free port, or `undefined` when none are free.
*/
async function findFreePort(min = 8760, max = 8799) {
	const { createServer } = await import("node:net");
	for (let port = min; port <= max; port++) if (await new Promise((resolveFree) => {
		const server = createServer();
		server.once("error", () => resolveFree(false));
		server.listen(port, "127.0.0.1", () => {
			server.close(() => resolveFree(true));
		});
	})) return port;
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
	assertSlugAvailable(spec.slug);
	const serverName = deriveServerName(spec.slug);
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
	const installResult = await ssh([
		spec.host,
		"uv",
		"tool",
		"install",
		"vectr"
	]).promise;
	if (installResult.code !== 0) {
		takenServerNames.delete(serverName);
		if (credentialRef !== void 0) await deps.credStore.unset(credentialRef);
		throw new Error(`failed to install vectr on ${spec.host} (install manually): ${installResult.stderr}`);
	}
	const startResult = await ssh([
		spec.host,
		"vectr",
		"start",
		spec.path,
		"--host",
		"127.0.0.1"
	]).promise;
	if (startResult.code !== 0) {
		takenServerNames.delete(serverName);
		if (credentialRef !== void 0) await deps.credStore.unset(credentialRef);
		throw new Error(`failed to start vectr on ${spec.host}: ${startResult.stderr}`);
	}
	const remotePort = await resolveRemotePort(ssh, spec.host, spec.path) ?? parseRemotePort(startResult.stdout) ?? 8760;
	const localPort = await findFreePort();
	if (localPort === void 0) {
		takenServerNames.delete(serverName);
		if (credentialRef !== void 0) await deps.credStore.unset(credentialRef);
		throw new Error("no free local tunnel port in range 8760-8799");
	}
	const ctl = join(tmpdir(), `vectr-tunnel-${spec.slug}-${process.pid}.sock`);
	const tunnelResult = await ssh([
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
	const tunnelPid = tunnelPidFrom((await ssh([
		"-O",
		"check",
		"-S",
		ctl,
		spec.host
	]).promise).stdout) ?? tunnelPidFrom(tunnelResult.stdout);
	const entry = {
		id: spec.slug,
		slug: spec.slug,
		type: "remote",
		path: spec.path,
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
		join(homedir(), ".vectr", "instances.json")
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
		if (entry.localPort !== void 0) await deps.sshRunner([
			entry.host ?? "",
			"vectr",
			"stop",
			"--port",
			String(entry.localPort)
		]).promise;
		if (entry.tunnelPid !== void 0) {
			if (entry.tunnelCtl !== void 0) try {
				await deps.sshRunner([
					"-O",
					"exit",
					"-S",
					entry.tunnelCtl,
					entry.host ?? ""
				]).promise;
			} catch {}
			try {
				process.kill(entry.tunnelPid, "SIGTERM");
			} catch {}
		}
	}
	saveCodebases(metaPath, loadCodebases(metaPath).filter((e) => e.slug !== entry.slug));
	takenServerNames.delete(entry.serverName);
	if (entry.credentialRef !== void 0) await deps.credStore.unset(entry.credentialRef);
}
/**
* Probe a codebase's local MCP endpoint for liveness.
* @param entry - the entry to test (uses `localPort`).
* @returns `{ ok, status? }` on success or `{ ok: false, error }` on failure.
*/
async function testCodebase(entry) {
	if (entry.localPort === void 0) return {
		ok: false,
		error: "no local port configured"
	};
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
	daemonTcpTimeoutMs: z.number().min(1).default(DEFAULT_DAEMON_TCP_TIMEOUT_MS)
});
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
* @param instancesPath - absolute path of the vectr daemon registry.
* @param config - resolved plugin configuration.
* @param agent - the agent whose workspace resolves the daemon port.
*/
function install(ctx, handles, instancesPath, config, agent, codebasesPath) {
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
		handles.set(agent, conn);
	})();
	if (codebasesPath !== void 0) installCodebaseConnections(ctx, config, agent, codebasesPath);
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
async function installCodebaseConnections(ctx, config, agent, codebasesPath) {
	let entries;
	try {
		entries = loadCodebases(codebasesPath);
	} catch (error) {
		ctx.logger.warn(`vectr-client: cannot read codebase metadata at ${codebasesPath} (${String(error)}); skipping codebase binds for session ${agent.id}`);
		return;
	}
	const policy = resolveReconnectPolicy(config.reconnect, "vectr-client(codebase): reconnect");
	for (const entry of entries) {
		if (entry.status !== "up" || entry.localPort === void 0) continue;
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
		daemonTcpTimeoutMs: config.daemonTcpTimeoutMs ?? DEFAULT_DAEMON_TCP_TIMEOUT_MS
	};
	const instancesPath = isAbsolute(resolved.instancesPath) ? resolved.instancesPath : resolve(process.cwd(), resolved.instancesPath);
	const codebasesPath = isAbsolute(resolved.codebasesPath) ? resolved.codebasesPath : resolve(process.cwd(), resolved.codebasesPath);
	const handles = /* @__PURE__ */ new Map();
	for (const agent of ctx.agents.list()) install(ctx, handles, instancesPath, resolved, agent, codebasesPath);
	ctx.on("agent/created", ({ agent }) => {
		install(ctx, handles, instancesPath, resolved, agent, codebasesPath);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		handles.get(agent)?.dispose();
		handles.delete(agent);
	});
	ctx.effect(() => () => {
		for (const conn of handles.values()) conn.dispose();
		handles.clear();
		try {
			for (const entry of loadCodebases(codebasesPath)) if (entry.type === "remote" && entry.tunnelPid !== void 0) try {
				process.kill(entry.tunnelPid, "SIGTERM");
			} catch {}
		} catch {}
	}, "vectr-client.connections");
	registerManagementRoutes(ctx, instancesPath, resolved);
	registerCodebaseRoutes(ctx, codebasesPath, resolved.secretsPath);
}
/**
* Write a JSON body with the given status code.
* @param res - the node:http response.
* @param statusCode - HTTP status to send.
* @param body - value serialized as JSON.
*/
function sendJson(res, statusCode, body) {
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
async function readJsonBody(req, limitBytes = 1e6) {
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
				sendJson(res, 200, await scanWorkspaces(ctx, instancesPath, { statusTimeoutMs: config.daemonHttpTimeoutMs }));
			} catch (error) {
				sendJson(res, 500, { error: String(error) });
			}
		}
	}), "vectr-client: GET /api/vectr/workspaces");
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/api/vectr/trigger-index",
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson(res, 405, { error: "method not allowed" });
				return;
			}
			let body;
			try {
				body = await readJsonBody(req);
			} catch (error) {
				sendJson(res, 400, { error: String(error) });
				return;
			}
			const target = body;
			const instances = readInstancesFile(ctx, instancesPath);
			if (instances === void 0) {
				sendJson(res, 404, {
					ok: false,
					error: "no vectr daemon registry found"
				});
				return;
			}
			let entry = void 0;
			if (typeof target.port === "number") entry = Object.values(instances).find((e) => e.port === target.port);
			else if (typeof target.workspace === "string") entry = Object.values(instances).find((e) => e.workspace === target.workspace);
			if (entry === void 0) {
				sendJson(res, 404, {
					ok: false,
					error: "no daemon matches the requested port/workspace"
				});
				return;
			}
			const status = await fetchStatus(entry, config.daemonHttpTimeoutMs ?? 5e3);
			const result = await triggerIndex(entry, status !== void 0 ? { status } : {});
			sendJson(res, result.ok ? 200 : 409, result);
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
						stderr: `${stderr}\n${String(err)}`
					});
				});
				child.on("close", (code) => {
					resolveExit({
						code: code ?? 1,
						stdout,
						stderr
					});
				});
			}),
			kill() {
				child.kill("SIGTERM");
			}
		};
	};
	const sshRunner = (args, auth) => {
		if (auth?.password !== void 0) return spawnRunner("sshpass", [
			"-p",
			auth.password,
			"ssh",
			"-o",
			"PreferredAuthentications=password",
			"-o",
			"PubkeyAuthentication=no",
			...args
		]);
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
		instancesPath: DEFAULT_INSTANCES_FILE
	};
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
function registerCodebaseRoutes(ctx, codebasesPath, secretsPath) {
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
					sendJson(res, 200, loadCodebases(codebasesPath).map(stripSecret));
				} catch (error) {
					sendJson(res, 500, { error: String(error) });
				}
				return;
			}
			if (req.method === "POST") {
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					sendJson(res, 400, { error: String(error) });
					return;
				}
				const spec = body;
				try {
					sendJson(res, 201, stripSecret(await createCodebase(deps, codebasesPath, spec)));
				} catch (error) {
					sendJson(res, 400, { error: String(error) });
				}
				return;
			}
			sendJson(res, 405, { error: "method not allowed" });
		}
	}), "vectr-client: /api/vectr/codebases");
	ctx.effect(() => webServer.register({
		kind: "prefix",
		path: "/api/vectr/codebases/",
		handler: async (req, res) => {
			const url = new URL(req.url ?? "", "http://localhost");
			const slug = decodeURIComponent(url.pathname.replace("/api/vectr/codebases/", ""));
			if (slug.length === 0) {
				sendJson(res, 400, { error: "missing codebase slug" });
				return;
			}
			const list = () => loadCodebases(codebasesPath);
			const find = () => list().find((e) => e.slug === slug);
			if (req.method === "DELETE") {
				const entry = find();
				if (entry === void 0) {
					sendJson(res, 404, {
						ok: false,
						error: "no such codebase"
					});
					return;
				}
				try {
					await deleteCodebase(deps, codebasesPath, entry);
					sendJson(res, 200, { ok: true });
				} catch (error) {
					sendJson(res, 500, {
						ok: false,
						error: String(error)
					});
				}
				return;
			}
			if (req.method === "POST" && url.pathname.endsWith("/test")) {
				const entry = find();
				if (entry === void 0) {
					sendJson(res, 404, {
						ok: false,
						error: "no such codebase"
					});
					return;
				}
				const result = await testCodebase(entry);
				sendJson(res, result.ok ? 200 : 503, result);
				return;
			}
			sendJson(res, 405, { error: "method not allowed" });
		}
	}), "vectr-client: /api/vectr/codebases/:slug");
}
//#endregion
export { Config, DEFAULT_CODEBASES_FILE, DEFAULT_DAEMON_HTTP_TIMEOUT_MS, DEFAULT_DAEMON_TCP_TIMEOUT_MS, DEFAULT_INSTANCES_FILE, DEFAULT_SECRETS_FILE, DEFAULT_SERVER_NAME, DEFAULT_TOOL_CALL_TIMEOUT_MS, apply, buildCodebaseDeps, inject, install, isDaemonAlive, isPortListening, name, readInstancesFile, registerCodebaseRoutes, registerManagementRoutes, resolveInstance };

//# sourceMappingURL=index.js.map