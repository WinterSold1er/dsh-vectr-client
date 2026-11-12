import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import z from "@deepseek-ai/schemastery";
import { Client, StreamableHTTPClientTransport, specTypeSchemas } from "@modelcontextprotocol/client";
import { assertNever, deepEqualJson } from "@deepseek-ai/dsh-util-values";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import { isDeepStrictEqual } from "node:util";
import { isImageAdmissionError } from "@deepseek-ai/dsh-attachment";
import { assertSupportedJsonSchema } from "@deepseek-ai/dsh-tools";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { connect } from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region ../../installer/deepseek-harness-0.2.2-rc.2/packages/mcp/mcp-client/src/diagnostic.ts
/**
* Connection diagnostics retain cause chains. Configurations that resolve
* secrets replace every known secret value before text leaves the instance.
*/
/** Local failure whose message contains no expanded configuration or upstream text. */
var McpLocalError = class extends Error {};
/** Placeholder written in place of a known secret value. */
const REDACTED = "[redacted]";
/**
* Replace every occurrence of known secret values, longest first so a secret
* that contains another is replaced whole.
* @param text - diagnostic or upstream text.
* @param secrets - non-empty secret values known to the instance.
* @returns the text with each occurrence replaced by `[redacted]`.
*/
function redactSecrets(text, secrets) {
	let out = text;
	for (const secret of [...secrets].sort((left, right) => right.length - left.length)) out = out.replaceAll(secret, REDACTED);
	return out;
}
/** One readable segment of the chain; generic `Error` names are noise and dropped. */
function segmentOf(value) {
	if (!(value instanceof Error)) return String(value);
	const base = value.name === "Error" || value.message === "" ? value.message === "" ? value.name : value.message : `${value.name}: ${value.message}`;
	if (base !== "" && base !== "Error") return base;
	const code = value.code;
	return typeof code === "string" ? code : value.name;
}
/**
* Flatten an error and its `cause` chain into `outer, cause: inner, …`.
* @param error - the caught value; non-Errors stringify as-is.
* @returns the joined diagnostic line.
*/
function describeError(error) {
	const seen = /* @__PURE__ */ new Set();
	const segments = [];
	let current = error;
	while (current !== void 0 && current !== null && !seen.has(current)) {
		seen.add(current);
		segments.push(segments.length === 0 && current instanceof Error ? String(current) : segmentOf(current));
		current = current instanceof Error ? current.cause : void 0;
	}
	const head = segments[0];
	if (head === void 0) return String(error);
	return head + segments.slice(1).map((segment) => `, cause: ${segment}`).join("");
}
//#endregion
//#region ../../installer/deepseek-harness-0.2.2-rc.2/packages/mcp/mcp-client/src/deadline.ts
/** Shared settlement deadline for the startup and probe budgets. */
/**
* Settle with `promise`, or reject with `timeoutMessage` once `remainingMs`
* elapses first. The timer never holds the process open, and a non-Error
* rejection is wrapped so callers always observe an Error.
* @param promise - operation the deadline bounds.
* @param remainingMs - remaining budget in milliseconds (clamped to at least 1).
* @param timeoutMessage - diagnostic carried by the deadline rejection.
* @returns the operation's value; rejects with the deadline or the operation's failure.
*/
function withDeadline(promise, remainingMs, timeoutMessage) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new McpLocalError(timeoutMessage));
		}, Math.max(1, remainingMs));
		timer.unref();
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}
//#endregion
//#region ../../installer/deepseek-harness-0.2.2-rc.2/packages/mcp/mcp-client/src/transport.ts
/**
* The subprocess seam's scrubbed parent env (credential-shaped and stale
* `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
* actual spawn, so this transport shares the scrub definition rather than the
* spawn path.
*/
function buildChildEnv(extra) {
	return {
		...scrubbedParentEnv(),
		...extra
	};
}
/**
* Create an MCP transport from the resolved plugin config.
*
* @param config - Resolved plugin config discriminated on `transport`.
* @returns an unstarted MCP transport (stdio or Streamable HTTP).
*/
function createTransport(config) {
	switch (config.transport) {
		case "stdio": return new StdioClientTransport({
			command: config.command,
			args: config.args,
			env: buildChildEnv(config.env),
			cwd: config.cwd
		});
		case "streamable-http": return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
	}
}
//#endregion
//#region ../../installer/deepseek-harness-0.2.2-rc.2/packages/mcp/mcp-client/src/generation.ts
/** Tracks actual tasks separately from their interruptible callers. */
var McpGeneration = class {
	client;
	closeTimeoutMs;
	diagnostic;
	/** Cancellation shared by the transport and all work owned by this generation. */
	lifetime = new AbortController();
	pending = /* @__PURE__ */ new Set();
	closed = Promise.withResolvers();
	transport;
	started = false;
	closeObserved = false;
	closing;
	constructor(client, closeTimeoutMs, diagnostic) {
		this.client = client;
		this.closeTimeoutMs = closeTimeoutMs;
		this.diagnostic = diagnostic;
	}
	/**
	* Connect within the caller's remaining startup or probe budget.
	* @param config - resolved transport configuration.
	* @param timeoutMs - remaining operation budget; undefined leaves the SDK default.
	* @returns completion of negotiation, or cancellation/deadline rejection.
	*/
	connect(config, timeoutMs) {
		this.lifetime.signal.throwIfAborted();
		const transport = this.transport = createTransport(config);
		const close = transport.close.bind(transport);
		let closing;
		transport.close = () => closing ??= close();
		const start = transport.start.bind(transport);
		transport.start = () => {
			this.lifetime.signal.throwIfAborted();
			this.started = true;
			return start();
		};
		transport.onclose = () => {
			this.closeObserved = true;
			this.closed.resolve();
		};
		return this.run(async (signal) => {
			await this.client.connect(transport, {
				signal,
				...timeoutMs === void 0 ? {} : { timeout: Math.max(1, timeoutMs) }
			});
			this.assertOpen();
		}, timeoutMs);
	}
	/** Reject when this generation was cancelled or its transport reported closure. */
	assertOpen() {
		this.lifetime.signal.throwIfAborted();
		if (this.closeObserved) throw new McpLocalError("MCP transport closed");
	}
	/**
	* Track work through settlement, even when its caller times out or is cancelled.
	* @param operation - work receiving this generation's cancellation signal.
	* @param timeoutMs - optional caller deadline in milliseconds; does not cancel the work.
	* @returns the operation's result, or a cancellation/deadline rejection.
	*/
	run(operation, timeoutMs) {
		const signal = this.lifetime.signal;
		const task = Promise.resolve().then(() => {
			signal.throwIfAborted();
			return operation(signal);
		});
		this.pending.add(task);
		task.then(() => this.pending.delete(task), () => this.pending.delete(task));
		const interrupted = new Promise((resolve, reject) => {
			const abort = () => {
				reject(signal.reason);
			};
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			task.then(resolve, reject).finally(() => {
				signal.removeEventListener("abort", abort);
			});
		});
		return timeoutMs === void 0 ? interrupted : withDeadline(interrupted, timeoutMs, "MCP operation timed out");
	}
	/**
	* Cancel callers, close the transport, and await owned work within the cleanup budget.
	* @returns the shared cleanup result, distinguishing transport closure from cleanup failure.
	*/
	close() {
		return this.closing ??= this.finish();
	}
	async finish() {
		this.lifetime.abort(new McpLocalError("MCP connection closed"));
		let cleanupError;
		const work = async () => {
			try {
				await (this.client.transport === void 0 ? this.transport?.close() : this.client.close());
			} catch (error) {
				cleanupError = this.diagnostic(error);
			}
			await Promise.allSettled([...this.pending]);
			if (this.started && !this.closeObserved) await this.closed.promise;
		};
		try {
			await withDeadline(work(), this.closeTimeoutMs, "MCP cleanup did not settle");
			return {
				closeConfirmed: true,
				...cleanupError === void 0 ? {} : { cleanupError }
			};
		} catch (error) {
			return {
				closeConfirmed: this.transport === void 0 || this.closeObserved,
				cleanupError: cleanupError ?? this.diagnostic(error)
			};
		}
	}
};
//#endregion
//#region ../../installer/deepseek-harness-0.2.2-rc.2/packages/mcp/mcp-client/src/templates.ts
/**
* `${credential:REF}` syntax and substitution for MCP transport strings.
* Managers validate syntax at configuration writes; the client resolves values
* at runtime without changing the stored configuration.
*
* @module
*/
/** A referenced credential has no configured value. */
var MissingTemplateValue = class extends McpLocalError {};
const TOKEN = /\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** One whole occurrence must BE a token; containment is not enough. */
const TOKEN_EXACT = /^\$\{credential:[A-Za-z_][A-Za-z0-9_]*\}$/;
/** Any `${…}` occurrence, well-formed or not, for fail-loud validation. */
const SUSPECT = /\$\{[^}]*\}/g;
/**
* The credential references one configured string names, read statically. A
* rotation observer uses this over the raw configuration so a server whose
* earlier resolution failed — a credential configured only now — is still
* recognized as affected.
* @param value - the configured string.
* @returns the referenced credential names, in template order.
*/
function credentialRefsIn(value) {
	return [...value.matchAll(TOKEN)].map((token) => token[1]);
}
/**
* Reject a string whose `${…}` occurrences are not all well-formed template
* tokens, naming the offending occurrence and where it sits.
* @param value - the configured string.
* @param where - configuration path used in the thrown message.
*/
function assertTemplateSyntax(value, where) {
	for (const occurrence of value.matchAll(SUSPECT)) if (!TOKEN_EXACT.test(occurrence[0])) throw new Error(`${where}: "${occurrence[0]}" is not a template token — use \${credential:REF}`);
}
/**
* Resolve every template token in one string.
* @param value - the configured string.
* @param where - configuration path used in thrown messages.
* @param credential - credential-reference lookup returning `undefined` while unconfigured.
* @returns the substituted string.
* @throws when a referenced credential is unconfigured.
*/
async function resolveTemplateString(value, where, credential) {
	let out = "";
	let cursor = 0;
	for (const token of value.matchAll(TOKEN)) {
		const name = token[1];
		const resolved = await credential(name);
		if (resolved === void 0) throw new MissingTemplateValue(`${where}: credential "${name}" is not configured — store it through the credential seam or remove the \${credential:${name}} template`);
		out += value.slice(cursor, token.index) + resolved;
		cursor = token.index + token[0].length;
	}
	return out + value.slice(cursor);
}
//#endregion
//#region ../../installer/deepseek-harness-0.2.2-rc.2/packages/mcp/mcp-client/src/credentials.ts
/** Resolves raw configuration through the current credential provider and redacts every value it resolved. */
var McpTemplateBinding = class {
	ctx;
	config;
	/** Enabled credential references from raw configuration, including currently unconfigured references. */
	refs;
	/** Resolved values and their URL-encoded forms, retained for the instance lifetime. */
	secrets = /* @__PURE__ */ new Set();
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
		const strings = config.transport === "stdio" ? [
			config.command,
			...config.args,
			...Object.values(config.env),
			config.cwd
		] : [config.url, ...Object.values(config.headers)];
		this.refs = new Set(config.expandTemplates ? strings.flatMap(credentialRefsIn) : []);
		if (config.expandTemplates) {
			for (const value of strings) assertTemplateSyntax(value, `mcp-client(${config.serverName})`);
			if (this.refs.size > 0 && ctx.get("credentials") === void 0) throw new McpLocalError("MCP credential templates require a credentials provider");
		}
	}
	/**
	* Replace every value this binding resolved, including earlier rotations.
	* @param text - diagnostic or upstream text.
	* @returns the text with resolved values replaced by `[redacted]`.
	*/
	redact(text) {
		return redactSecrets(text, this.secrets);
	}
	/**
	* Format a failure, naming the operation and redacting resolved values when templates are enabled.
	* @param error - caught operation failure.
	* @param operation - local operation name for the diagnostic.
	* @returns diagnostic text safe for the configured template mode.
	*/
	diagnostic(error, operation) {
		if (!this.config.expandTemplates) return describeError(error);
		return `mcp-client(${this.config.serverName}): ${operation}: ${this.redact(describeError(error))}`;
	}
	/**
	* Resolve transport strings without changing the plugin's raw configuration.
	* @param signal - cancellation checked before and after template resolution.
	* @returns resolved transport configuration, or the raw configuration when expansion is disabled.
	* @throws when a credential or the credentials provider is unavailable.
	*/
	async resolve(signal) {
		signal.throwIfAborted();
		if (!this.config.expandTemplates) return this.config;
		const values = /* @__PURE__ */ new Map();
		const credential = (ref) => {
			let value = values.get(ref);
			if (value === void 0) {
				const provider = this.ctx.get("credentials");
				if (provider === void 0) throw new McpLocalError("MCP credential templates require a credentials provider");
				value = provider.resolve(ref).then((result) => {
					if (result !== void 0 && result.value !== "") this.secrets.add(result.value).add(encodeURIComponent(result.value));
					return result?.value;
				});
				values.set(ref, value);
			}
			return value;
		};
		const resolve = async (value, path) => {
			const result = await resolveTemplateString(value, path, credential);
			signal.throwIfAborted();
			return result;
		};
		const record = async (value, path) => {
			const resolved = [];
			for (const [key, entry] of Object.entries(value)) resolved.push([key, await resolve(entry, `${path}.${key}`)]);
			return Object.fromEntries(resolved);
		};
		const config = this.config;
		if (config.transport === "stdio") {
			const args = [];
			for (const [index, arg] of config.args.entries()) args.push(await resolve(arg, `args[${index}]`));
			return {
				...config,
				command: await resolve(config.command, "command"),
				args,
				env: await record(config.env, "env"),
				cwd: await resolve(config.cwd, "cwd")
			};
		}
		return {
			...config,
			url: await resolve(config.url, "url"),
			headers: await record(config.headers, "headers")
		};
	}
};
//#endregion
//#region ../../installer/deepseek-harness-0.2.2-rc.2/packages/mcp/mcp-client/src/tools.ts
/**
* Tool bridge: discovers MCP tools, registers them on the harness ToolRuntime
* under deterministic server-qualified public names, and handles re-sync when
* the server's tool list changes.
*
* Naming contract (see the mcp-client Agent Note "Naming invariants"): every MCP tool
* has the stable identity `(serverName, rawName)`; the model-facing public name
* is `mcp__<serverName>__<rawName>`, normalized to the DeepSeek function-name
* constraints. The raw name is only ever sent on the wire (`tools/call`); the
* public name is never parsed to recover it.
*
* @module
*/
/** Registration failed after the prior generation was removed and partial registrations were rolled back. */
var McpToolRegistrationError = class extends McpLocalError {};
/**
* DeepSeek function-name contract: at most 64 characters. Wire-protocol
* constant, not configuration.
*/
const MAX_PUBLIC_NAME_LENGTH = 64;
/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12;
/** Raster formats supported by the durable attachment vocabulary. */
const IMAGE_MEDIA_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
];
/** Canonical RFC 4648 base64, excluding whitespace and URL-safe aliases. */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/**
* Derive the model-facing public name for one MCP tool.
*
* Deterministic pure function of `(serverName, rawName)`: the clean case is
* `mcp__<serverName>__<rawName>` verbatim. When character replacement or
* truncation to the DeepSeek function-name contract (64 chars,
* `[A-Za-z0-9_-]`) changes the name, a 12-hex-char SHA-256 hash of the
* identity is appended so distinct MCP identities never collapse into the
* same public name.
*
* @param serverName - Stable local namespace from plugin config.
* @param rawName - The MCP server's own tool name.
* @returns The globally unique, model-facing ToolRuntime name.
*/
function publicToolName(serverName, rawName) {
	const joined = `mcp__${serverName}__${rawName}`;
	const normalized = joined.replace(INVALID_NAME_CHARS, "_");
	if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
	const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
	return `${normalized.slice(0, 51)}_${hash}`;
}
/**
* Sync the MCP server's tool list into the harness ToolRuntime.
*
* Two phases keep the swap safe:
*
* 1. Fetch: let the SDK aggregate `tools/list` and build the full next
*    generation of `ToolDefinition`s under public names. Any failure here
*    (network error or duplicate raw name) rejects
*    and leaves the previous generation registered untouched.
* 2. Swap: dispose the previous generation, register the new one. A registry
*    conflict here can only mean a foreign registration squats on this
*    server's `mcp__<serverName>__` namespace — the partial generation is
*    rolled back (zero tools from this server), logged, and rejected so the
*    supervisor closes the failed connection generation.
*
* @param client - Connected MCP Client instance used to list and call tools.
* @param ctx - Cordis context providing the `tools` service for registration.
* @param opts - server namespace, call timeout, generation signal, and optional error formatter.
* @param previous - Disposer map from the prior sync generation; disposed
*   during the swap phase (only after the fetch phase succeeded).
* @param eligible - Judged again at the commit point, after the listing
*   settled: a sync whose generation was abandoned meanwhile (startup budget
*   elapsed, connection closed) publishes nothing and leaves `previous`
*   untouched.
* @returns A map of registered public tool names to their unregister
*   disposers — the exact set of live registrations owned by this server.
*/
async function syncTools(client, ctx, opts, previous, eligible = () => true) {
	const definitions = /* @__PURE__ */ new Map();
	const response = client.getServerCapabilities()?.tools === void 0 ? { tools: [] } : await client.listTools(void 0, {
		cacheMode: "refresh",
		signal: opts.signal
	});
	for (const tool of response.tools) {
		const publicName = publicToolName(opts.serverName, tool.name);
		if (definitions.has(publicName)) throw new Error(`mcp-client(${opts.serverName}): server listed tool "${tool.name}" more than once — invalid tool list`);
		definitions.set(publicName, createMcpToolDefinition(ctx, {
			name: publicName,
			rawName: tool.name,
			description: tool.description ?? "",
			inputSchema: tool.inputSchema,
			outputSchema: tool.outputSchema,
			taskRequired: tool.execution?.taskSupport === "required",
			call: async (args, execution) => {
				try {
					const result = await client.callTool({
						name: tool.name,
						arguments: args
					}, {
						signal: AbortSignal.any([execution.signal, opts.signal]),
						timeout: opts.toolCallTimeoutMs,
						toolDefinition: tool
					});
					if (result.isError !== true || opts.redact === void 0) return result;
					return {
						isError: true,
						content: [{
							type: "text",
							text: opts.redact(extractText(result.content, tool.name))
						}]
					};
				} catch (error) {
					if (opts.redact === void 0) throw error;
					throw new Error(opts.redact(describeError(error)));
				}
			}
		}));
	}
	if (!eligible()) return previous;
	for (const dispose of previous.values()) dispose();
	const disposers = /* @__PURE__ */ new Map();
	try {
		for (const [publicName, definition] of definitions) disposers.set(publicName, ctx.tools.register(definition));
	} catch (error) {
		for (const dispose of disposers.values()) dispose();
		ctx.logger.error(`mcp-client(${opts.serverName}): tool registration failed, no tools registered: ${String(error)}`);
		throw new McpToolRegistrationError("MCP tool registration failed", { cause: error });
	}
	return disposers;
}
/** Keep a supported advertised schema; unsupported MCP vocabulary falls back to JsonValue. */
function supportedOutputSchema(candidate) {
	if (candidate === void 0) return void 0;
	try {
		assertSupportedJsonSchema(candidate);
		return candidate;
	} catch {
		return;
	}
}
/**
* Adapt an upstream MCP tool to canonical values and durable image content.
* Registration, provider lifetime, deadlines, and transport belong to the caller.
* @param ctx - plugin context carrying optional attachment and model services.
* @param options - upstream tool fields and its raw-result callback.
* @returns the unregistered ToolRuntime definition.
*/
function createMcpToolDefinition(ctx, options) {
	const { name, rawName, description, inputSchema } = options;
	const projections = /* @__PURE__ */ new WeakMap();
	return {
		name,
		description,
		parameters: inputSchema,
		output: createOutput(rawName, supportedOutputSchema(options.outputSchema)),
		execute: createExecutor(ctx, options, projections),
		projectContent(exec, result) {
			const projection = projections.get(exec);
			if (projection === void 0) return void 0;
			projections.delete(exec);
			if (result.isError) return void 0;
			if (!isDeepStrictEqual(result.value, projection.value)) return void 0;
			if (!isDeepStrictEqual(result.content, projection.fallback)) return void 0;
			return projection.content;
		}
	};
}
/** Build the canonical result schema and existing Native text projection. */
function createOutput(rawName, structuredSchema) {
	return {
		schema: {
			type: "object",
			properties: {
				content: {
					type: "array",
					items: {}
				},
				structuredContent: structuredSchema ?? {}
			},
			required: structuredSchema === void 0 ? ["content"] : ["content", "structuredContent"],
			additionalProperties: false
		},
		render(_args, value) {
			return [{
				type: "text",
				text: extractText(value.content, rawName)
			}];
		}
	};
}
/**
* Invoke the caller-owned raw-result callback and prepare canonical content.
* MCP isError results reject before image storage so ToolRuntime records failure.
*/
function createExecutor(ctx, options, projections) {
	const { rawName, taskRequired } = options;
	return async (args, exec) => {
		if (taskRequired) throw new Error(`Tool "${rawName}" requires task-based execution, which this bridge does not support`);
		const argsObj = typeof args === "object" && args !== null ? args : {};
		const parsed = specTypeSchemas.CallToolResult["~standard"].validate(await options.call(argsObj, exec));
		if (parsed.issues !== void 0) throw new Error(`Tool "${rawName}" returned an invalid MCP result: ${parsed.issues.map((issue) => issue.message).join("; ")}`);
		const result = parsed.value;
		const content = result.content;
		const text = extractText(content, rawName);
		if (result.isError === true) throw new Error(text);
		const value = {
			content,
			...result.structuredContent !== void 0 ? { structuredContent: result.structuredContent } : {}
		};
		if (containsImage(content)) {
			const fallback = [{
				type: "text",
				text: extractText(content, rawName)
			}];
			const projected = await prepareImageProjection(ctx, exec, content, rawName);
			projections.set(exec, {
				value,
				fallback,
				content: projected
			});
		}
		return value;
	};
}
/** Whether an untrusted MCP content array contains a declared image block. */
function containsImage(content) {
	return content.some((value) => isRecord(value) && value.type === "image");
}
/** Narrow one JSON value to a string-keyed object. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Narrow a declared MIME string to the durable image vocabulary. */
function isImageMediaType(value) {
	return IMAGE_MEDIA_TYPES.includes(value);
}
/** Decode one projected image without accepting base64 aliases. */
function decodeImage(block) {
	if (!isImageMediaType(block.mimeType)) throw new Error("the declared media type is not PNG, JPEG, WebP, or GIF");
	if (!CANONICAL_BASE64.test(block.data)) throw new Error("the image data is not canonical base64");
	const data = Buffer.from(block.data, "base64");
	if (data.toString("base64") !== block.data) throw new Error("the image data is not canonical base64");
	return {
		data,
		mediaType: block.mimeType
	};
}
/**
* Resolve the active model route and durable store for an image-bearing result.
* @param ctx - plugin context with optional services.
* @param exec - exact tool execution whose agent supplies the latest route.
* @returns the attachment store after exact positive image-capability proof.
*/
async function resolveImageAdmission(ctx, exec) {
	const attachments = ctx.get("attachments");
	if (attachments === void 0) throw new Error("no attachment store is mounted");
	const routed = exec.agent?.session.requestHeader()?.config;
	const provider = routed?.provider ?? exec.agent?.options.provider;
	const model = routed?.model ?? exec.agent?.options.model;
	const llm = ctx.get("llm");
	if (provider === void 0 || model === void 0 || llm === void 0) throw new Error("the current model route could not be resolved");
	let info;
	try {
		info = await llm.resolveModelInfo(provider, model, exec.signal);
	} catch {
		throw new Error("the current model route could not be verified");
	}
	if (info.inputModalities === void 0 || !info.inputModalities.includes("image")) throw new Error(`model "${model}" does not declare image input`);
	if (exec.signal.aborted) throw new Error("the tool call was canceled before image storage");
	return attachments;
}
/** Stable diagnostic text for an image block that was not admitted. */
function imageDiagnostic(block, reason) {
	return `[image unavailable: ${block.mimeType ?? "unknown media type"}; ${reason}; raw image data remains available to programmatic callers]`;
}
/**
* Decode, preflight, and durably save one MCP result's ordered image batch.
* Any refusal projects every image as text while retaining the canonical raw
* value for programmatic callers.
*/
async function prepareImageProjection(ctx, exec, content, toolName) {
	const decoded = [];
	const validationErrors = /* @__PURE__ */ new Map();
	const imageIndexes = [];
	for (const [index, value] of content.entries()) {
		if (!isRecord(value) || value.type !== "image") continue;
		imageIndexes.push(index);
		try {
			decoded.push(decodeImage(value));
		} catch (error) {
			validationErrors.set(index, error.message);
		}
	}
	if (validationErrors.size > 0) return projectContent(content, toolName, (block, index) => ({
		type: "text",
		text: imageDiagnostic(block, validationErrors.get(index) ?? "another image in the same result was invalid")
	}));
	let attachments;
	try {
		attachments = await resolveImageAdmission(ctx, exec);
	} catch (error) {
		const reason = error.message;
		return projectContent(content, toolName, (block) => ({
			type: "text",
			text: imageDiagnostic(block, reason)
		}));
	}
	try {
		const refs = await attachments.saveImages(decoded);
		const byIndex = new Map(imageIndexes.map((index, offset) => [index, refs[offset]]));
		return projectContent(content, toolName, (_block, index) => ({
			type: "image",
			attachment: byIndex.get(index)
		}));
	} catch (error) {
		const reason = isImageAdmissionError(error) ? `image admission rejected the result: ${error.message}` : "durable image storage rejected the result";
		return projectContent(content, toolName, (block) => ({
			type: "text",
			text: imageDiagnostic(block, reason)
		}));
	}
}
/**
* Extract text from an MCP content array into a single string.
* - text blocks: join with '\n'
* - image/audio/resource blocks: replaced with a placeholder
*
* Policy-owned canonical-value replacements may omit fields required on the MCP wire.
*/
function extractText(mcpContent, toolName) {
	return projectContent(mcpContent, toolName).map((block) => block.text).join("\n");
}
/**
* Project ordered MCP blocks into the core content vocabulary.
* Text-like runs are newline-coalesced; admitted images split those runs at
* their original position.
*/
function projectContent(mcpContent, toolName, image = (block) => ({
	type: "text",
	text: imageDiagnostic(block, "this result was not admitted to durable model context")
})) {
	const projected = [];
	const text = [];
	const flushText = () => {
		if (text.length === 0) return;
		projected.push({
			type: "text",
			text: text.splice(0).join("\n")
		});
	};
	for (const [index, value] of mcpContent.entries()) {
		if (!isRecord(value)) {
			text.push("[unsupported MCP content block: expected an object]");
			continue;
		}
		const block = value;
		switch (block.type) {
			case "text":
				if (block.text !== void 0) text.push(block.text);
				break;
			case "image":
				flushText();
				projected.push(image(block, index));
				break;
			case "resource_link":
				if (block.name === void 0 || block.uri === void 0) text.push("[resource link unavailable: the MCP block is missing its name or URI]");
				else text.push(`Resource link: ${block.name} (${block.uri})`);
				break;
			case "audio":
				text.push(`[audio result unsupported: ${block.mimeType ?? "unknown media type"}; raw audio data remains available to programmatic callers]`);
				break;
			case "resource":
				text.push("[embedded resource unsupported; raw resource data remains available to programmatic callers]");
				break;
			default: text.push(`[unsupported MCP content type: ${block.type}]`);
		}
	}
	flushText();
	return projected.length > 0 ? projected : [{
		type: "text",
		text: `(${toolName} returned no model-visible content)`
	}];
}
//#endregion
//#region ../../installer/deepseek-harness-0.2.2-rc.2/packages/mcp/mcp-client/src/connection.ts
/**
* Connection supervisor: owns the MCP client/transport generations for one
* plugin instance, keeps the harness tool registry in sync with the live
* generation, and — when the connection drops — restarts the configured
* server with bounded exponential backoff.
*
* One outage shares one attempt budget (`maxAttempts` consecutive failed
* attempts, delays doubling from `initialDelayMs` up to `maxDelayMs`). A
* connection that stays up past the stability window closes the outage, so
* the next disconnect starts a fresh budget while a crash-looping server —
* even one whose connects briefly succeed — still exhausts the cap instead of
* restarting forever. Exhaustion unregisters the server's tools and stops;
* a changed credential binding or a fresh instance resets that budget.
*
* @module
*/
/** Defaults shared by the Config schema and {@link resolveReconnectPolicy}. */
const RECONNECT_DEFAULTS = Object.freeze({
	enabled: true,
	initialDelayMs: 500,
	maxDelayMs: 3e4,
	maxAttempts: 10
});
/**
* The one explicit resolve step from raw reconnect config to the policy the
* supervisor runs. Programmatic construction may bypass Schemastery
* normalization, so every default and bound is re-judged here — misconfiguration
* fails the plugin instance at load.
*
* @param config - Raw `reconnect` config; omission uses the defaults.
* @param path - Diagnostic prefix naming the config location in thrown messages.
* @returns The frozen resolved policy.
*/
function resolveReconnectPolicy(config, path) {
	if (config !== void 0) {
		for (const key of Object.keys(config)) if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`${path}.${key} is not a reconnect option`);
	}
	const enabled = config?.enabled ?? RECONNECT_DEFAULTS.enabled;
	const initialDelayMs = config?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs;
	const maxDelayMs = config?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs;
	const maxAttempts = config?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts;
	if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (initialDelayMs > maxDelayMs) throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`);
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error(`${path}.maxAttempts must be a positive integer`);
	return Object.freeze({
		enabled,
		initialDelayMs,
		maxDelayMs,
		maxAttempts
	});
}
/**
* Start the supervised connection for one MCP server and keep it alive per
* the reconnect policy. The first attempt starts in a microtask; the caller
* must register disposal before yielding.
*
* @param ctx - Cordis context providing the `tools` registry and logger.
* @param config - Resolved plugin config selecting the transport and server identity.
* @param policy - Resolved reconnect policy from {@link resolveReconnectPolicy}.
* @param status - Instance status cell this supervisor publishes transitions to.
* @returns Handle with a `ready` promise for startup-await and a `dispose` for teardown.
*/
function startConnection(ctx, config, policy, status) {
	const label = `mcp-client(${config.serverName})`;
	const binding = new McpTemplateBinding(ctx, config);
	const diagnostic = (error, operation) => binding.diagnostic(error, operation);
	const lifetime = new AbortController();
	const readiness = Promise.withResolvers();
	let current;
	let bindingValue;
	let disposed = false;
	let serverInstructions = "";
	let disposers = /* @__PURE__ */ new Map();
	let syncChain = Promise.resolve();
	let settling = Promise.resolve();
	let reconnectTimer;
	let failedAttempts = 0;
	let closureFailure;
	let checkingCredentials;
	let credentialsDirty = false;
	const isCurrent = (record) => !disposed && current === record && !record.wire.lifetime.signal.aborted;
	function stopTimers() {
		clearTimeout(reconnectTimer);
		reconnectTimer = void 0;
	}
	function clearTools() {
		for (const dispose of disposers.values()) try {
			dispose();
		} catch (error) {
			closureFailure = {
				...status.closure(),
				cleanupError: diagnostic(error, "tool cleanup")
			};
			status.recordClosure(closureFailure);
			ctx.logger.error(`${label}: tool cleanup failed: ${diagnostic(error, "tool cleanup")}`);
		}
		disposers = /* @__PURE__ */ new Map();
		serverInstructions = "";
	}
	async function close(record) {
		const result = await record.wire.close();
		if (!result.closeConfirmed || result.cleanupError !== void 0) closureFailure ??= result;
		status.recordClosure(closureFailure ?? result);
		if (closureFailure !== void 0 && !disposed) {
			const error = new Error(closureFailure.cleanupError);
			status.update({
				state: "failed",
				reason: "unclosed-generation",
				lastError: error.message
			});
			readiness.resolve({ error });
		}
		return closureFailure === void 0;
	}
	function enqueueSync(record) {
		const run = syncChain.then(async () => {
			if (!isCurrent(record)) return;
			await record.wire.run(async (signal) => {
				disposers = await syncTools(record.wire.client, ctx, {
					serverName: config.serverName,
					toolCallTimeoutMs: config.toolCallTimeoutMs,
					signal,
					...config.expandTemplates ? { redact: (text) => binding.redact(text) } : {}
				}, disposers, () => isCurrent(record));
			});
		});
		syncChain = run.then(() => void 0, () => void 0);
		return run;
	}
	function scheduleReconnect(error, connectedAt) {
		if (disposed || closureFailure !== void 0) return;
		if (!policy.enabled) {
			const message = connectedAt !== void 0 ? "connection lost and reconnect is disabled — registered tools will fail until an HMR reload or Host restart" : "connection failed and reconnect is disabled — no tools were registered; reload the plugin or restart the Host to connect";
			status.update({
				state: "failed",
				reason: "reconnect-disabled",
				lastError: error
			});
			ctx.logger.error(`${label}: ${message}`);
			return;
		}
		if (connectedAt !== void 0 && Date.now() - connectedAt >= policy.maxDelayMs) failedAttempts = 0;
		failedAttempts++;
		if (failedAttempts > policy.maxAttempts) {
			syncChain = syncChain.then(clearTools);
			status.update({
				state: "failed",
				reason: "gave-up",
				lastError: error
			});
			ctx.logger.error(`${label}: giving up after ${policy.maxAttempts} consecutive failed reconnect attempts — tools unregistered; reload the plugin or restart the Host to reconnect`);
			return;
		}
		const delayMs = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (failedAttempts - 1));
		const action = connectedAt !== void 0 ? "connection lost; reconnecting" : "connection failed; retrying";
		ctx.logger.warn(`${label}: ${action} in ${delayMs}ms (attempt ${failedAttempts}/${policy.maxAttempts})`);
		status.update({
			state: "reconnecting",
			attempt: failedAttempts,
			maxAttempts: policy.maxAttempts,
			nextRetryAtMs: Date.now() + delayMs,
			lastError: error
		});
		reconnectTimer = setTimeout(() => {
			reconnectTimer = void 0;
			settling = connectGeneration();
		}, delayMs);
		reconnectTimer.unref();
	}
	function lost(record, error) {
		if (!isCurrent(record)) return;
		current = void 0;
		settling = close(record).then((confirmed) => {
			readiness.resolve({ error: new Error(error) });
			if (confirmed) scheduleReconnect(error, record.connectedAt);
		});
	}
	function isStopped() {
		return disposed || closureFailure !== void 0;
	}
	function requestCredentialRefresh() {
		if (isStopped()) return;
		credentialsDirty = true;
		checkingCredentials ??= (async () => {
			while (credentialsDirty && !isStopped()) {
				credentialsDirty = false;
				let next;
				try {
					next = await binding.resolve(lifetime.signal);
				} catch (error) {
					if (!(error instanceof MissingTemplateValue)) throw error;
				}
				if (disposed || bindingValue !== void 0 && deepEqualJson(next, bindingValue.config)) continue;
				stopTimers();
				const record = current;
				const attempt = settling;
				current = void 0;
				if (record !== void 0) await close(record);
				await attempt;
				await syncChain;
				stopTimers();
				clearTools();
				if (isStopped()) {
					readiness.resolve({ error: /* @__PURE__ */ new Error("MCP credential refresh cleanup is incomplete") });
					return;
				}
				failedAttempts = 0;
				bindingValue = next === void 0 ? {} : { config: next };
				settling = connectGeneration();
			}
		})().catch((error) => {
			if (!disposed) ctx.logger.error(`${label}: credential refresh failed: ${diagnostic(error, "credential refresh")}`);
		}).finally(() => {
			checkingCredentials = void 0;
			if (credentialsDirty) requestCredentialRefresh();
		});
	}
	if (binding.refs.size > 0) ctx.on("credentials/reference-updated", (ref) => {
		if (binding.refs.has(String(ref))) requestCredentialRefresh();
	});
	async function connectGeneration() {
		if (isStopped()) return;
		const client = new Client({
			name: "dsh-mcp-client",
			version: "0.0.1"
		}, {
			capabilities: {},
			versionNegotiation: { mode: "auto" },
			listChanged: { tools: {
				autoRefresh: false,
				debounceMs: 0,
				onChanged: () => {
					refreshTools();
				}
			} }
		});
		const record = { wire: new McpGeneration(client, config.closeTimeoutMs, (error) => diagnostic(error, "cleanup")) };
		current = record;
		status.opened();
		status.update({
			state: "connecting",
			attempt: failedAttempts
		});
		client.onclose = () => {
			if (record.connectedAt !== void 0) lost(record, "connection closed");
		};
		async function refreshTools() {
			if (!isCurrent(record)) return;
			ctx.logger.info(`${label}: tool list changed, re-syncing`);
			try {
				await enqueueSync(record);
				if (isCurrent(record) && record.connectedAt !== void 0) status.update({
					state: "connected",
					toolCount: disposers.size,
					connectedAt: record.connectedAt
				});
			} catch (error) {
				if (error instanceof McpToolRegistrationError) lost(record, diagnostic(error, "tool synchronization"));
				else if (isCurrent(record)) ctx.logger.error(`${label}: tool re-sync failed: ${diagnostic(error, "tool synchronization")}`);
			}
		}
		try {
			const startedAt = Date.now();
			const remaining = () => config.startupTimeoutMs === void 0 ? void 0 : config.startupTimeoutMs - (Date.now() - startedAt);
			const resolved = await record.wire.run((signal) => binding.resolve(signal), remaining());
			bindingValue = { config: resolved };
			await record.wire.connect(resolved, remaining());
			if (!isCurrent(record)) return;
			const text = client.getInstructions()?.trimEnd() ?? "";
			const instructions = text ? `### MCP server: ${config.serverName}\n\n${text}` : "";
			const maxInstructionBytes = config.maxInstructionBytes ?? 32768;
			if (Buffer.byteLength(instructions) > maxInstructionBytes) throw new McpLocalError(`${label}: server instructions exceed maxInstructionBytes (${maxInstructionBytes})`);
			const sync = enqueueSync(record);
			const budget = remaining();
			await (budget === void 0 ? sync : withDeadline(sync, budget, `${label}: startup timed out`));
			if (!isCurrent(record)) return;
			record.wire.assertOpen();
			serverInstructions = instructions;
			record.connectedAt = Date.now();
			status.update({
				state: "connected",
				toolCount: disposers.size,
				connectedAt: record.connectedAt
			});
			readiness.resolve({});
			if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${policy.maxAttempts})`);
		} catch (error) {
			if (current !== record) return;
			current = void 0;
			const confirmed = await close(record);
			readiness.resolve({ error: config.expandTemplates ? new Error(diagnostic(error, "startup")) : error });
			if (disposed || !confirmed) return;
			if (error instanceof MissingTemplateValue) {
				bindingValue = {};
				status.update({
					state: "waiting-credentials",
					lastError: diagnostic(error, "credential resolution")
				});
				return;
			}
			ctx.logger.warn(`${label}: connection attempt failed: ${diagnostic(error, "startup")}`);
			scheduleReconnect(diagnostic(error, "startup"));
		}
	}
	settling = Promise.resolve().then(connectGeneration);
	return {
		ready: readiness.promise,
		instructions: () => serverInstructions,
		resources: { async request(request, exec) {
			const record = current;
			if (record?.connectedAt === void 0) throw new Error(`${label}: server is disconnected`);
			try {
				return await record.wire.run(async (signal) => {
					const options = {
						signal: AbortSignal.any([signal, exec.signal]),
						timeout: config.toolCallTimeoutMs
					};
					const generation = record.wire.client;
					const listable = generation.getServerCapabilities()?.resources !== void 0;
					switch (request.method) {
						case "resources/list": return listable ? await generation.listResources(request.cursor === void 0 ? void 0 : { cursor: request.cursor }, options) : { resources: [] };
						case "resources/templates/list": return listable ? await generation.listResourceTemplates(request.cursor === void 0 ? void 0 : { cursor: request.cursor }, options) : { resourceTemplates: [] };
						case "resources/read": return await generation.readResource({ uri: request.uri }, options);
						/* v8 ignore next -- exhaustive over the closed resource request union */
						default: return assertNever(request);
					}
				});
			} catch (error) {
				if (config.expandTemplates) throw new Error(diagnostic(error, request.method));
				throw error;
			}
		} },
		async dispose() {
			disposed = true;
			readiness.resolve({ error: /* @__PURE__ */ new Error("MCP client disposed") });
			lifetime.abort(/* @__PURE__ */ new Error("MCP client disposed"));
			stopTimers();
			const record = current;
			current = void 0;
			if (record !== void 0) await close(record);
			try {
				await withDeadline(Promise.all([
					settling,
					syncChain,
					checkingCredentials
				]), config.closeTimeoutMs, "MCP cleanup did not settle");
			} catch (error) {
				closureFailure ??= {
					...status.closure(),
					cleanupError: diagnostic(error, "cleanup")
				};
			}
			clearTools();
			const result = closureFailure ?? status.closure();
			status.recordClosure(result);
			status.update({
				state: "closed",
				result
			});
			if (!result.closeConfirmed || result.cleanupError !== void 0) ctx.logger.error(`${label}: cleanup incomplete`);
		}
	};
}
//#endregion
//#region ../../installer/deepseek-harness-0.2.2-rc.2/packages/mcp/mcp-client/src/status.ts
/** Writable status cell retained across supervisors on the same Fiber. */
var McpStatusCell = class {
	warn;
	value = {
		state: "connecting",
		attempt: 0
	};
	closeResult = { closeConfirmed: true };
	closure() {
		return this.closeResult;
	}
	/** Mark the next generation's closure as unconfirmed. */
	opened() {
		this.closeResult = { closeConfirmed: false };
	}
	/**
	* Record cleanup without publishing a connection-status transition.
	* @param result - independently observed transport and local cleanup outcome.
	*/
	recordClosure(result) {
		this.closeResult = result;
	}
	/** Remove existing observers without discarding the readable status or cleanup result. */
	detach() {
		this.listeners.clear();
	}
	listeners = /* @__PURE__ */ new Set();
	/**
	* @param warn - contained-listener diagnostic sink (the owning plugin's logger).
	*/
	constructor(warn) {
		this.warn = warn;
	}
	/**
	* Associate observer diagnostics with the Fiber's current supervisor.
	* @param warn - contained-listener diagnostic sink.
	*/
	setWarningSink(warn) {
		this.warn = warn;
	}
	/**
	* The current status.
	* @returns the latest published status.
	*/
	current() {
		return this.value;
	}
	/**
	* Observe status transitions; see {@link McpConnectionStatusHandle.onChange}.
	* @param callback - invoked with each published status.
	* @returns the disposer removing this observer.
	*/
	onChange(callback) {
		this.listeners.add(callback);
		return () => void this.listeners.delete(callback);
	}
	/**
	* Publish the next status and notify observers. A throwing observer is
	* contained so a broken consumer cannot wedge the supervisor's transition.
	* @param next - the status to publish.
	*/
	update(next) {
		this.value = next;
		for (const listener of [...this.listeners]) try {
			const returned = listener(next);
			if (typeof returned?.then === "function") Promise.resolve(returned).catch((error) => {
				this.warn("an onChange status observer failed", error);
			});
		} catch (error) {
			this.warn("an onChange status observer failed", error);
		}
	}
};
//#endregion
//#region src/registry.ts
/**
* Registry layer for the vectr-client plugin (leaf module).
*
* Owns the on-disk `instances.json` shape and the cwd→daemon-record resolution.
* Intentionally free of Cordis, config parsing, and HTTP probing so it can be
* unit-tested against a temp file with no live daemon and no plugin context.
*
* @module dsh-vectr-client/registry
*/
/** Default bind host used only when an `InstanceEntry.host` is absent. */
const DEFAULT_HOST = "127.0.0.1";
/** Hex-char length of the sha256 workspace key prefix vectr stores per instance. */
const WORKSPACE_KEY_LENGTH = 12;
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
	const exactWorkspace = candidates.find((entry) => {
		return (entry.workspace.endsWith("/") ? entry.workspace.slice(0, -1) : entry.workspace) === normalizedCwd;
	});
	if (exactWorkspace !== void 0) return exactWorkspace;
	const home = homedir();
	const normalizedHome = home.endsWith("/") ? home.slice(0, -1) : home;
	const prefixMatch = candidates.map((entry) => ({
		entry,
		stored: entry.workspace.endsWith("/") ? entry.workspace.slice(0, -1) : entry.workspace
	})).filter(({ stored }) => stored.length > 0 && stored !== normalizedHome).sort((a, b) => b.stored.length - a.stored.length).find(({ stored }) => normalizedCwd.startsWith(`${stored}/`));
	if (prefixMatch !== void 0) return prefixMatch.entry;
}
/**
* EXACT-match instance lookup: the sha256(workspace)[:12] key first, then a
* trailing-slash-tolerant EQUALITY match on the stored workspace path.
*
* Deliberately not {@link resolveInstance}: that one also accepts a cwd nested
* inside a recorded workspace (prefix match), which is right for binding an
* agent but catastrophic for port reconciliation — a codebase with no record of
* its own would be silently rewritten to the enclosing `/home/csy` daemon's port
* and then bind to the wrong workspace's index.
*
* @param instances - parsed `instances.json` records.
* @param workspace - absolute workspace path to match exactly.
* @returns the exactly matching daemon record, or `undefined`.
*/
function resolveInstanceExact(instances, workspace) {
	const exact = instances[createHash("sha256").update(workspace).digest("hex").slice(0, 12)];
	if (exact !== void 0) return exact;
	const normalized = workspace.endsWith("/") ? workspace.slice(0, -1) : workspace;
	return Object.values(instances).find((entry) => {
		return (entry.workspace.endsWith("/") ? entry.workspace.slice(0, -1) : entry.workspace) === normalized;
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
* Pattern matching reserved primary codebase slug prefixes and names.
* Any slug equal to "primary" or prefixed with "primary-" is reserved for
* system-generated primary codebases and cannot be used for user codebases.
*/
const PRIMARY_RESERVED_PREFIX_PATTERN = /^primary(-.*)?$/i;
/**
* Pattern matching system-generated primary codebase slugs:
* 'primary', legacy 8-char hex keys, current 12-char hex keys
* (WORKSPACE_KEY_LENGTH), or standard 8-16 hex key ranges.
*/
const SYSTEM_PRIMARY_SLUG_PATTERN = /^primary(-[0-9a-f]{8,16})?$/i;
/**
* Test whether a slug uses the reserved primary codebase prefix or name.
* Slugs that match this pattern cannot be created or registered by users.
*/
function isReservedPrimarySlug(slug) {
	if (!slug || typeof slug !== "string") return false;
	return PRIMARY_RESERVED_PREFIX_PATTERN.test(slug.trim());
}
/**
* Canonical directory path (browser-safe: no node:path, this module is also
* bundled into the web client): trimmed, backslashes and duplicate separators
* collapsed, trailing slashes dropped, so `/x/two`, `/x/two//` and `/x\two\`
* all yield one key. Empty input yields ''; the root stays '/'.
*/
function normalizePath(p) {
	if (!p || typeof p !== "string") return "";
	const trimmed = p.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
	if (trimmed === "") return "";
	const stripped = trimmed.replace(/\/+$/, "");
	return stripped === "" ? "/" : stripped;
}
/**
* Check if an active workspace matches a target codebase path or workspace.
* Supports exact match and subdirectory workspace match (e.g. workspace is
* a subfolder of the target codebase root).
*/
function isWorkspaceMatch(ws, target) {
	if (!target || typeof target !== "string") return false;
	const normTarget = normalizePath(target);
	if (!normTarget || normTarget === "__unassigned__") return false;
	if (normTarget === "/") return ws.startsWith("/");
	return ws === normTarget || ws.startsWith(normTarget + "/");
}
/**
* Validate that an InstanceEntry possesses valid structural types and runtime values.
*/
function isValidInstanceEntry(entry) {
	if (!entry || typeof entry !== "object") return false;
	const e = entry;
	if (typeof e.port !== "number" || !Number.isFinite(e.port) || !Number.isInteger(e.port) || e.port <= 0 || e.port > 65535) return false;
	if (typeof e.workspace !== "string" || e.workspace.trim().length === 0) return false;
	return true;
}
/**
* Pure domain rule to determine whether a workspace is associated with a codebase.
*
* Rules:
* - If workspace is empty/null/undefined, returns false.
* - Normalizes paths with trailing slash tolerance (trim().replace(/\/+$/, '')).
* - Supports subdirectory workspace match (ws === target || ws.startsWith(target + '/')).
* - Validates entry type safety and matches entry.workspace against workspace.
* - Checks codebases array matching against either item.path or item.workspace.
* - Otherwise returns false.
*/
function hasCodebase(input) {
	const ws = normalizePath(input.workspace);
	if (ws.length === 0) return false;
	if (isValidInstanceEntry(input.entry)) {
		if (isWorkspaceMatch(ws, input.entry.workspace)) return true;
	}
	if (Array.isArray(input.codebases)) return input.codebases.some((item) => {
		if (!item || typeof item !== "object") return false;
		return isWorkspaceMatch(ws, item.path) || isWorkspaceMatch(ws, item.workspace);
	});
	return false;
}
/**
* Test whether a workspace has an active, indexed codebase (non-memory-only primary
* or at least one mounted external codebase).
*
* Used to gate codebase-specific prompt guidance (code retrieval policies, grep shadowing)
* so that memory-only projects do not receive misleading code search restrictions.
*/
function hasIndexedCodebase(input) {
	const ws = normalizePath(input.workspace);
	if (ws.length === 0) return false;
	if (isValidInstanceEntry(input.entry) && isWorkspaceMatch(ws, input.entry.workspace)) {
		if (!isMemoryOnly(input.entry.mode)) return true;
	}
	if (Array.isArray(input.codebases)) return input.codebases.some((item) => {
		if (!item || typeof item !== "object") return false;
		if (item.isPrimary && input.entry && isMemoryOnly(input.entry.mode)) return false;
		return isWorkspaceMatch(ws, item.workspace) || isWorkspaceMatch(ws, item.path);
	});
	return false;
}
/**
* Test whether a slug represents a system-generated Primary codebase.
* Matches the reserved 'primary' name, legacy 8-char hex keys, current
* WORKSPACE_KEY_LENGTH (12-char hex) keys, and standard 8-16 hex key ranges.
*/
function isSystemPrimarySlug(slug) {
	if (!slug || typeof slug !== "string") return false;
	return SYSTEM_PRIMARY_SLUG_PATTERN.test(slug.trim());
}
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
	return normalizeMode(mode) === "memory_only";
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
* Canonicalize a raw mode string at any trust boundary (registry file -> API -> UI).
*
* The vectr CLI writes both spellings ("memory-only" in instances.json, but the
* daemon's `/v1/status` reports "memory_only"), so every consumer must agree on
* one spelling. Hyphens become underscores, case is folded, whitespace trimmed.
*
* A non-string, empty, or whitespace-only input has no mode to report and yields
* `undefined`; anything else is returned normalized rather than dropped, so an
* unrecognized future mode still reaches callers intact.
*/
function normalizeMode(mode) {
	if (typeof mode !== "string") return void 0;
	const normalized = mode.trim().toLowerCase().replace(/-/g, "_");
	return normalized === "" ? void 0 : normalized;
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
	if (normalizedMode === "search_only") return {
		kind: "search_only",
		label: "Search Only",
		isBusy: false,
		description: "Semantic search active without working memory"
	};
	if (input.status?.fully_ready === true) return {
		kind: "ready",
		label: "Ready",
		isBusy: false,
		description: "Daemon fully ready and synchronized",
		background: input.status.reindex_in_progress === true ? "Background re-index in progress" : void 0
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
/**
* Normalize workspace path by trimming whitespace, normalizing slashes,
* deduplicating slashes, and removing trailing slashes (preserves '/' for root).
*/
function normalizeWorkspacePath$2(p) {
	if (!p || typeof p !== "string") return "";
	const stripped = p.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "");
	return stripped === "" ? "/" : stripped;
}
/**
* Determine if entry.workspace represents a real workspace directory path
* rather than a host placeholder or unassigned sentinel.
*/
function isEffectiveWorkspacePath(workspace, host) {
	if (!workspace || typeof workspace !== "string") return false;
	const trimmed = workspace.trim();
	if (trimmed.length === 0) return false;
	if (trimmed === "__unassigned__" || trimmed.startsWith("__")) return false;
	if (host && trimmed === host.trim()) return false;
	if (trimmed === "127.0.0.1" || trimmed === "localhost") return false;
	return true;
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
		const status = await deps.httpProbe(entry, deps.httpTimeoutMs);
		if (status === void 0) return {
			alive: false,
			reason: "HTTP_PROBE_UNREACHABLE"
		};
		if (isEffectiveWorkspacePath(entry.workspace, host) && typeof status.workspace_root === "string" && status.workspace_root.trim().length > 0) {
			if (normalizeWorkspacePath$2(entry.workspace) !== normalizeWorkspacePath$2(status.workspace_root)) return {
				alive: false,
				reason: "WORKSPACE_MISMATCH"
			};
		}
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
const TUNNEL_PORT_MIN = (process.env.VECTR_TUNNEL_PORT_MIN ? parseInt(process.env.VECTR_TUNNEL_PORT_MIN, 10) : void 0) || 8900;
const TUNNEL_PORT_MAX = (process.env.VECTR_TUNNEL_PORT_MAX ? parseInt(process.env.VECTR_TUNNEL_PORT_MAX, 10) : void 0) || 8999;
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
/**
* AsyncLocalStorage context tracking whether the current async execution context
* already holds the local daemon startup lock. Provides re-entrancy so
* `healLocalCodebase` can safely invoke `startLocalDaemon` without self-deadlocking.
*/
const localDaemonLockStorage = new AsyncLocalStorage();
/**
* Promise-chain queue ensuring all local daemon startup and heal operations
* within the process run strictly serialized, one after another.
* Prevents multiple daemons from concurrently probing and starting at the exact
* same instant, which would otherwise race on free port discovery and fail
* with EADDRINUSE.
*/
let localDaemonQueue = Promise.resolve();
/**
* Execute a local daemon operation under the process-wide startup mutex.
* Reentrant: if already holding the lock in the current async context, runs immediately.
* Fault-tolerant: failure of one queued operation does not reject or stall the queue.
*/
function withLocalDaemonLock(fn) {
	if (localDaemonLockStorage.getStore()) return fn();
	const run = () => localDaemonLockStorage.run(true, fn);
	const next = localDaemonQueue.then(run, run);
	localDaemonQueue = next.catch(() => {});
	return next;
}
/** Test seam to reset the local daemon lock queue. */
function _resetLocalDaemonLockForTests() {
	localDaemonQueue = Promise.resolve();
}
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
		assertServerNameAvailable(normalizeWorkspacePath$1(spec.workspace ?? spec.path), spec.slug);
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
	if (rawPath && typeof rawPath === "string") spec.path = normalizeWorkspacePath$1(rawPath);
	if (spec.workspace && typeof spec.workspace === "string") spec.workspace = normalizeWorkspacePath$1(spec.workspace);
	if (!spec.auth && spec.password) spec.auth = "password";
	if (typeof spec.slug === "string" && isReservedPrimarySlug(spec.slug)) throw new CodebaseError(400, "Slug \"primary\" is reserved for the primary codebase");
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
	let startResult = await ssh(remoteShellCmd(spec.host, `vectr start ${spec.path} --host 127.0.0.1`)).promise;
	if (startResult.code !== 0) {
		takenServerNames.delete(serverName);
		if (credentialRef !== void 0) await deps.credStore.unset(credentialRef);
		throw new Error(`failed to start vectr on ${spec.host}: ${startResult.stderr}`);
	}
	let remotePort = typeof spec.remotePort === "number" && spec.remotePort > 0 ? spec.remotePort : void 0;
	if (remotePort === void 0) {
		const resolvedPort = await resolveRemotePort(ssh, spec.host, spec.path);
		if (resolvedPort !== void 0) {
			if (await checkRemoteDaemonAlive(ssh, spec.host, resolvedPort)) remotePort = resolvedPort;
			else {
				await ssh(remoteShellCmd(spec.host, `vectr stop --port ${resolvedPort}`)).promise.catch(() => {});
				startResult = await ssh(remoteShellCmd(spec.host, `vectr start ${spec.path} --host 127.0.0.1`)).promise;
				if (startResult.code !== 0) {
					takenServerNames.delete(serverName);
					if (credentialRef !== void 0) await deps.credStore.unset(credentialRef);
					throw new Error(`failed to start vectr on ${spec.host}: ${startResult.stderr}`);
				}
				const combinedOutput = `${startResult.stdout}\n${startResult.stderr}`;
				remotePort = await resolveRemotePort(ssh, spec.host, spec.path) ?? parseRemotePort(combinedOutput);
			}
		}
	}
	if (remotePort === void 0) remotePort = parseRemotePort(`${startResult.stdout}\n${startResult.stderr}`);
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
		for (let attempt = 0; attempt < 5; attempt++) {
			const checkResult = await ssh([
				"-o",
				"ConnectTimeout=5",
				"-O",
				"check",
				"-S",
				ctl,
				spec.host
			]).promise;
			const pid = tunnelPidFrom(`${checkResult.stdout}\n${checkResult.stderr}`);
			if (pid !== void 0) {
				tunnelPid = pid;
				break;
			}
			if (checkResult.code !== 0 && attempt < 4) {
				await new Promise((resolveBackoff) => setTimeout(resolveBackoff, 100 * (attempt + 1)));
				continue;
			}
			tunnelPid = tunnelPidFrom(`${tunnelResult.stdout}\n${tunnelResult.stderr}`);
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
/** Normalize a workspace path by trimming whitespace and trailing slashes (preserves '/' for root). */
function normalizeWorkspacePath$1(p) {
	if (typeof p !== "string") return "";
	const trimmed = p.trim().replace(/\/+$/, "");
	return trimmed === "" ? "/" : trimmed;
}
/**
* Probe whether a remote vectr daemon is alive on loopback port `port`.
* Returns true if the daemon responds on /v1/status, false if dead/stale or unreachable.
*/
async function checkRemoteDaemonAlive(ssh, host, port) {
	const result = await ssh(remoteShellCmd(host, `curl -s -f http://127.0.0.1:${port}/v1/status || true`)).promise;
	if (result.code !== 0) return false;
	return result.stdout.trim().length > 0;
}
/**
* Read the remote host's `~/.vectr/instances.json` and resolve the port mapped to
* `workspace`.
* @param ssh - injected ssh runner (already carrying auth context).
* @param host - `user@host` remote target.
* @param workspace - absolute workspace path the remote daemon serves.
*/
async function resolveRemotePort(ssh, host, workspace) {
	const normWorkspace = normalizeWorkspacePath$1(workspace);
	const result = await ssh([
		host,
		"cat",
		"~/.vectr/instances.json"
	]).promise;
	if (result.code !== 0) return void 0;
	try {
		const registry = JSON.parse(result.stdout);
		const match = Object.values(registry).find((e) => e !== null && typeof e === "object" && typeof e.workspace === "string" && normalizeWorkspacePath$1(e.workspace) === normWorkspace);
		if (match?.port !== void 0) return match.port;
	} catch {}
}
/** Best-effort parse of a remote `vectr start` port line from stdout or combined output. */
function parseRemotePort(output) {
	if (typeof output !== "string" || !output) return void 0;
	const matchA = /"port"\s*:\s*(\d+)/i.exec(output);
	if (matchA !== null && matchA[1] !== void 0) return Number(matchA[1]);
	const matchB = /\bport\s*[=:]\s*(\d+)/i.exec(output);
	if (matchB !== null && matchB[1] !== void 0) return Number(matchB[1]);
	const matchC = /(?:started|running).*?on port\s+(\d+)/i.exec(output);
	if (matchC !== null && matchC[1] !== void 0) return Number(matchC[1]);
	const matchD = /\bPort\s*:\s*(\d+)/i.exec(output);
	if (matchD !== null && matchD[1] !== void 0) return Number(matchD[1]);
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
	const isPrimaryByPath = Boolean(entry.workspace && entry.path && resolve(entry.path) === resolve(entry.workspace));
	if (entry.isPrimary || isSystemPrimarySlug(entry.slug) || isPrimaryByPath) throw new CodebaseError(403, "Cannot delete primary codebase of the workspace");
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
* Host-startup self-heal for ONE local codebase: make its recorded endpoint both
* CORRECT and ALIVE. This is the fix for the defect where a host restart
* SIGTERMs every daemon in its cgroup and nothing ever started them again — the
* metadata kept claiming `status:'up'` while the port stayed closed forever.
*
* Two ordered steps:
*
*  1. RECONCILE (only when `recordedPort` is injected). `vectr-codebases.json`
*     can drift from `~/.vectr/instances.json` — a codebase created when the
*     daemon bound port A keeps saying A after vectr has since rebound that
*     workspace to port B, and port A may by then host a DIFFERENT workspace's
*     daemon (observed: `demo_twoplus` recorded 8765 while 8765 served
*     `/home/csy`). Binding that URL points the codebase MCP at the wrong
*     index, so the registry wins and the metadata is rewritten. No daemon is
*     restarted here.
*  2. LIVENESS. If the (now correct) endpoint answers, return without touching
*     it — restarting a live daemon would steal the port from the sessions using
*     it. Only a dead endpoint is started, through {@link startLocalDaemon},
*     which reuses the recorded port.
*
* @param deps - injected runners / warn sink.
* @param metaPath - metadata file to persist a corrected port or a restart into.
* @param entry - the persisted LOCAL entry to check.
* @param probe - injected liveness probe (see {@link DaemonAliveProbe}).
* @param recordedPort - injected exact-match registry lookup (see
*   {@link RecordedPortLookup}); omit to skip reconciliation entirely.
* @returns `'alive'`, `'reconciled'`, or `'started'`.
* @throws when the daemon was dead and could not be started; metadata is
*   untouched by the failed start (a completed reconciliation still persists).
*/
async function healLocalCodebase(deps, metaPath, entry, probe, recordedPort) {
	if (entry.type !== "local") throw new Error(`healLocalCodebase: ${entry.slug} is not a local codebase`);
	return withLocalDaemonLock(async () => {
		const host = DEFAULT_HOST;
		const truth = recordedPort?.(entry.workspace ?? entry.path);
		let target = entry;
		let reconciled = false;
		if (typeof truth === "number" && truth !== entry.localPort) {
			deps.warn?.(`vectr-client: codebase ${entry.slug} metadata port ${entry.localPort ?? "unset"} disagrees with the daemon registry (${truth}); using ${truth}`);
			target = {
				...entry,
				localPort: truth
			};
			persist(metaPath, target);
			reconciled = true;
		}
		const workspace = entry.workspace ?? entry.path;
		if (typeof target.localPort === "number" && await probe({
			host,
			port: target.localPort,
			workspace
		})) return reconciled ? "reconciled" : "alive";
		await startLocalDaemon(deps, metaPath, target);
		return "started";
	});
}
/**
* (Re)start one LOCAL vectr daemon and record the port it bound.
*
* PORT STABILITY IS THE WHOLE POINT (the reason an existing session keeps
* working across a host restart): `vectr start` runs WITHOUT `--port` and
* WITHOUT `--strict-port`, so vectr's own `find_free_port(ws_hash, …)` can
* reuse the port the dead registry entry still records for this workspace
* (UPG-RESTART-PORT-WALK-BREAKS-MCP). The already-published MCP URL
* (`http://127.0.0.1:<localPort>/mcp`) therefore survives; only a port that is
* genuinely held by some OTHER process makes the daemon walk to a new one — and
* that case is reported through `deps.warn` because sessions bound to the old
* port cannot follow it.
*
* `status` is moved back to `'up'` and `error` cleared only AFTER `vectr start`
* reports a bound port; a failure throws with the child's stderr and leaves the
* metadata file untouched (no lying status).
*
* @param deps - injected runners (a `spawnRunner` that executes `vectr`).
* @param metaPath - metadata file to persist the new port/status into.
* @param entry - the persisted LOCAL entry to (re)start.
* @returns the bound port plus whether it drifted from the recorded one.
* @throws when the entry is not local, has no path, or `vectr start` fails.
*/
async function startLocalDaemon(deps, metaPath, entry) {
	if (entry.type !== "local") throw new Error(`startLocalDaemon: ${entry.slug} is not a local codebase`);
	if (typeof entry.path !== "string" || entry.path.length === 0) throw new Error(`startLocalDaemon: ${entry.slug} has no path to start`);
	return withLocalDaemonLock(async () => {
		const result = await deps.spawnRunner("vectr", [
			"start",
			"--path",
			entry.path,
			"--json"
		]).promise;
		if (result.signal !== null) throw new Error(`vectr start for ${entry.slug} was killed (${result.signal})`);
		if (result.code !== 0) throw new Error(`vectr start failed for ${entry.slug} (exit ${result.code}): ${result.stderr}`);
		let parsed;
		try {
			parsed = JSON.parse(result.stdout);
		} catch (error) {
			throw new Error(`vectr start returned non-JSON stdout for ${entry.slug}: ${String(error)}`);
		}
		if (parsed.status === "failed") throw new Error(`vectr start reported failed status for ${entry.slug}: ${result.stderr}`);
		if (typeof parsed.port !== "number") throw new Error(`vectr start did not report a port for ${entry.slug}`);
		const previousPort = entry.localPort;
		const portChanged = previousPort !== void 0 && previousPort !== parsed.port;
		if (portChanged) deps.warn?.(`vectr-client: codebase ${entry.slug} rebound to port ${parsed.port} (was ${previousPort}); sessions bound to the old port must open a new session to pick the new endpoint up`);
		const next = {
			...entry,
			localPort: parsed.port,
			status: "up"
		};
		delete next.error;
		persist(metaPath, next);
		return {
			slug: entry.slug,
			port: parsed.port,
			portChanged,
			previousPort
		};
	});
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
		if (entry.localPort !== void 0 && entry.localPort >= TUNNEL_PORT_MIN && entry.localPort <= TUNNEL_PORT_MAX && await isPortListening("127.0.0.1", entry.localPort, 800)) return {
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
	if (localPort === void 0 || localPort < TUNNEL_PORT_MIN || localPort > TUNNEL_PORT_MAX || !masterUp && await isPortListening("127.0.0.1", localPort, 800)) {
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
* Start or restart the remote vectr daemon and ensure the local SSH tunnel forwards to it.
*
* 1. Invokes `vectr start <path> --host 127.0.0.1` on the remote host over SSH.
* 2. Resolves the remote daemon port (via instances.json or stdout scrape).
* 3. Tears down stale tunnel if remotePort changed.
* 4. Ensures SSH tunnel is alive (via ensureTunnelUp).
* 5. Probes HTTP /v1/status through the forwarded port.
* 6. Persists status: 'up' and clears any error.
*/
async function startRemoteDaemon(deps, metaPath, entry) {
	if (entry.type !== "remote") throw new Error(`startRemoteDaemon: ${entry.slug} is not a remote codebase`);
	if (typeof entry.host !== "string" || entry.host.length === 0) throw new Error(`startRemoteDaemon: ${entry.slug} has no host configured`);
	if (typeof entry.path !== "string" || entry.path.length === 0) throw new Error(`startRemoteDaemon: ${entry.slug} has no path configured`);
	let auth;
	if (entry.credentialRef !== void 0) {
		const pw = await deps.credStore.get(entry.credentialRef);
		if (typeof pw === "string" && pw.length > 0) auth = { password: pw };
	}
	const ssh = (args) => deps.sshRunner(args, auth);
	const startResult = await ssh(remoteShellCmd(entry.host, `vectr start ${entry.path} --host 127.0.0.1`)).promise;
	if (startResult.signal !== null) {
		const msg = `vectr start on ${entry.host} was killed (${startResult.signal})`;
		downgrade(metaPath, entry, msg);
		throw new Error(msg);
	}
	if (startResult.code !== 0) {
		const msg = `failed to start vectr on ${entry.host}: ${startResult.stderr || startResult.stdout}`;
		downgrade(metaPath, entry, msg);
		throw new Error(msg);
	}
	const previousRemotePort = entry.remotePort;
	const combinedStartOutput = `${startResult.stdout}\n${startResult.stderr}`;
	const resolvedRemotePort = await resolveRemotePort(ssh, entry.host, entry.path) ?? parseRemotePort(combinedStartOutput) ?? previousRemotePort;
	if (resolvedRemotePort === void 0) {
		const msg = `could not resolve remote vectr daemon port on ${entry.host} for ${entry.path}`;
		downgrade(metaPath, entry, msg);
		throw new Error(msg);
	}
	const remotePortChanged = previousRemotePort !== void 0 && previousRemotePort !== resolvedRemotePort;
	if (remotePortChanged && entry.tunnelCtl !== void 0 && entry.host !== void 0) try {
		await deps.sshRunner([
			"-o",
			"ConnectTimeout=5",
			"-O",
			"exit",
			"-S",
			entry.tunnelCtl,
			entry.host
		], auth).promise;
	} catch {}
	entry = {
		...entry,
		remotePort: resolvedRemotePort
	};
	const tunnelRes = await ensureTunnelUp(deps, metaPath, entry);
	if (!tunnelRes.healed && tunnelRes.error !== void 0) throw new Error(tunnelRes.error);
	entry = tunnelRes.entry;
	if (entry.localPort === void 0) {
		const msg = "tunnel down: no local port configured after tunnel setup";
		downgrade(metaPath, entry, msg);
		throw new Error(msg);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 4e3);
	try {
		const res = await fetch(`http://127.0.0.1:${entry.localPort}/v1/status`, { signal: controller.signal });
		if (!res.ok) {
			const msg = `remote daemon status check returned status ${res.status}`;
			downgrade(metaPath, entry, msg);
			throw new Error(msg);
		}
	} catch (err) {
		const msg = `remote daemon status check failed: ${String(err)}`;
		downgrade(metaPath, entry, msg);
		throw new Error(msg);
	} finally {
		clearTimeout(timer);
	}
	const next = {
		...entry,
		status: "up"
	};
	delete next.error;
	persist(metaPath, next);
	return {
		slug: entry.slug,
		localPort: entry.localPort,
		remotePort: resolvedRemotePort,
		portChanged: remotePortChanged,
		previousPort: previousRemotePort
	};
}
/**
* Start/heal daemon for any codebase (local or remote).
*/
async function startCodebaseDaemon(deps, metaPath, entry) {
	try {
		if (entry.type === "remote") {
			const result = await startRemoteDaemon(deps, metaPath, entry);
			return {
				ok: true,
				slug: result.slug,
				localPort: result.localPort
			};
		} else if (entry.type === "local") {
			const result = await startLocalDaemon(deps, metaPath, entry);
			return {
				ok: true,
				slug: result.slug,
				localPort: result.port
			};
		} else throw new Error(`unsupported codebase type: ${entry.type}`);
	} catch (error) {
		return {
			ok: false,
			slug: entry.slug,
			localPort: entry.localPort ?? 0,
			error: String(error)
		};
	}
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
	if (entry.localPort === void 0) {
		if (opts?.metaPath !== void 0) downgrade(opts.metaPath, entry, "no local port configured");
		return {
			ok: false,
			error: "no local port configured"
		};
	}
	if (opts?.heal && opts.deps !== void 0 && opts.metaPath !== void 0) {
		const res = await ensureTunnelUp(opts.deps, opts.metaPath, entry);
		if (!res.healed && res.error !== void 0) return {
			ok: false,
			error: res.error
		};
		entry = res.entry;
		if (entry.localPort === void 0) {
			if (opts.metaPath !== void 0) downgrade(opts.metaPath, entry, "no local port configured");
			return {
				ok: false,
				error: "no local port configured"
			};
		}
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 3e3);
	try {
		const res = await fetch(`http://127.0.0.1:${entry.localPort}/v1/status`, { signal: controller.signal });
		if (!res.ok) {
			const msg = `status ${res.status}`;
			if (opts?.metaPath !== void 0) downgrade(opts.metaPath, entry, msg);
			return {
				ok: false,
				error: msg
			};
		}
		const status = await res.json();
		if (opts?.metaPath !== void 0) {
			const next = {
				...entry,
				status: "up"
			};
			delete next.error;
			persist(opts.metaPath, next);
		}
		return {
			ok: true,
			status
		};
	} catch (error) {
		const msg = String(error);
		if (opts?.metaPath !== void 0) downgrade(opts.metaPath, entry, msg);
		return {
			ok: false,
			error: msg
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
/** DSH's own workspace registry (`$DSH_HOME/storages/workspace.json`, `~/.dsh` fallback). */
const DEFAULT_DSH_WORKSPACE_FILE = join(process.env["DSH_HOME"] ?? join(homedir(), ".dsh"), "storages", "workspace.json");
/**
* Dedupe key for a workspace path: absolute, trailing separators dropped.
*
* The two discovery sources spell the same directory differently (`/a/b`,
* `/a/b/`, `/a/./b`); without one canonical spelling the union would list a
* workspace twice.
*/
function normalizeWorkspacePath(workspace) {
	return normalizePath(resolve(workspace));
}
/**
* Read every workspace root DSH records, best-effort.
*
* The source is the DSH unit store `{ tables: { workspaces: { <id>: { path,
* title } } } }`. Discovery is decoration for the console, never a blocker: a
* missing, unreadable or unparseable file degrades to an empty list and reports
* through `onError` (production: the logger) instead of throwing. A workspace
* whose `path` is absent, empty or relative is skipped — it cannot be served by
* a daemon.
*
* @param filePath - absolute path of DSH's `workspace.json`.
* @param onError - diagnostic sink for the degradation paths.
* @returns discovered roots in file order, deduped by {@link normalizeWorkspacePath}.
*/
function discoverWorkspaceRoots(filePath, onError) {
	let text;
	try {
		text = readFileSync(filePath, "utf8");
	} catch (error) {
		onError?.(error);
		return [];
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		onError?.(error);
		return [];
	}
	const table = parsed?.tables?.workspaces;
	if (typeof table !== "object" || table === null || Array.isArray(table)) return [];
	const roots = [];
	const seen = /* @__PURE__ */ new Set();
	for (const record of Object.values(table)) {
		const path = record?.path;
		if (typeof path !== "string" || path === "" || !isAbsolute(path)) continue;
		const key = normalizeWorkspacePath(path);
		if (seen.has(key)) continue;
		seen.add(key);
		const title = record.title;
		roots.push({
			workspace: path,
			...typeof title === "string" && title.trim() !== "" ? { title: title.trim() } : {}
		});
	}
	return roots;
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
* @param opts - optional per-call tuning (`statusTimeoutMs`) and the workspace
*   discovery source (`discover`, production: {@link discoverWorkspaceRoots}).
* @returns registry rows in registry order, then not-started rows for every
* discovered workspace the registry does not already describe.
*/
async function scanWorkspaces(ctx, instancesPath, opts = {}) {
	const timeoutMs = opts.statusTimeoutMs ?? 3e3;
	const codebasesPath = opts.codebasesPath ?? DEFAULT_CODEBASES_FILE$1;
	const registeredPaths = /* @__PURE__ */ new Set();
	try {
		for (const entry of loadCodebases(codebasesPath)) for (const p of [entry.path, entry.workspace]) if (typeof p === "string" && p !== "") registeredPaths.add(normalizeWorkspacePath(p));
	} catch (error) {
		ctx.logger.warn(`vectr-client: cannot read codebase metadata at ${codebasesPath} (${String(error)}); workspace rows report registered: false`);
	}
	const isRegistered = (workspace) => registeredPaths.has(normalizeWorkspacePath(workspace));
	let instances;
	try {
		instances = readInstancesFile(ctx, instancesPath);
	} catch (error) {
		throw error;
	}
	const entries = instances === void 0 ? [] : Object.values(instances);
	const liveness = await Promise.all(entries.map(async (entry) => diagnoseDaemon(entry, {
		httpProbe: (e, ms) => fetchStatus(e, ms),
		httpTimeoutMs: timeoutMs,
		tcpTimeoutMs: 300
	})));
	const views = (await Promise.allSettled(entries.map(async (entry, i) => {
		const diag = liveness[i];
		const mode = normalizeMode(entry.mode);
		if (!diag.alive) return {
			workspace: entry.workspace,
			port: entry.port,
			...entry.pid !== void 0 ? { pid: entry.pid } : {},
			...mode !== void 0 ? { mode } : {},
			live: false,
			registered: isRegistered(entry.workspace),
			...diag.reason !== void 0 ? { reason: diag.reason } : {},
			error: diag.reason !== void 0 ? `daemon not alive: ${diag.reason}` : "daemon not alive"
		};
		const status = await fetchStatus(entry, timeoutMs);
		return {
			workspace: entry.workspace,
			port: entry.port,
			...entry.pid !== void 0 ? { pid: entry.pid } : {},
			...mode !== void 0 ? { mode } : {},
			live: true,
			registered: isRegistered(entry.workspace),
			...status !== void 0 ? { status } : {}
		};
	}))).map((settled, i) => {
		if (settled.status === "fulfilled") return settled.value;
		const entry = entries[i];
		const mode = normalizeMode(entry.mode);
		return {
			workspace: entry.workspace,
			port: entry.port,
			...entry.pid !== void 0 ? { pid: entry.pid } : {},
			...mode !== void 0 ? { mode } : {},
			live: false,
			registered: isRegistered(entry.workspace),
			error: `status probe failed: ${String(settled.reason)}`
		};
	});
	const discovered = opts.discover?.() ?? [];
	if (discovered.length === 0) return views;
	const titleByPath = /* @__PURE__ */ new Map();
	for (const root of discovered) if (root.title !== void 0) titleByPath.set(normalizeWorkspacePath(root.workspace), root.title);
	const titled = views.map((view) => {
		const title = titleByPath.get(normalizeWorkspacePath(view.workspace));
		return title === void 0 ? view : {
			...view,
			title
		};
	});
	const seen = new Set(entries.map((entry) => normalizeWorkspacePath(entry.workspace)));
	for (const root of discovered) {
		const key = normalizeWorkspacePath(root.workspace);
		if (seen.has(key)) continue;
		seen.add(key);
		titled.push({
			workspace: root.workspace,
			...root.title !== void 0 ? { title: root.title } : {},
			live: false,
			registered: isRegistered(root.workspace),
			reason: "not started",
			error: "daemon not started"
		});
	}
	return titled;
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
	const mode = normalizeMode(entry.mode);
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
		return this.executeCommand(args);
	}
	async start(options) {
		const wsCheck = validateWorkspace(options.workspace);
		if (!wsCheck.valid) return {
			ok: false,
			error: wsCheck.error
		};
		const args = [
			"start",
			"--path",
			options.workspace
		];
		if (options.memoryOnly === true) args.push("--memory-only");
		if (options.extraRoots && options.extraRoots.length > 0) for (const root of options.extraRoots) args.push("--extra-root", root);
		return this.executeCommand(args);
	}
	async restart(workspace, options) {
		const wsCheck = validateWorkspace(workspace);
		if (!wsCheck.valid) return {
			ok: false,
			error: wsCheck.error
		};
		if (options?.full === true && options.memoryOnly === true) return {
			ok: false,
			error: "restart: full and memoryOnly are mutually exclusive"
		};
		const args = ["restart", workspace];
		if (options?.full === true) args.push("--full");
		if (options?.memoryOnly === true) args.push("--memory-only");
		return this.executeCommand(args);
	}
	executeCommand(args) {
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
			if (options.boot === true) payload.boot = true;
			if (options.events !== void 0 && options.events.length > 0) payload.events = options.events;
			if (options.hook_event !== void 0) payload.hook_event = options.hook_event;
			if (options.session_id !== void 0) payload.session_id = options.session_id;
			if (options.min_similarity !== void 0) payload.min_similarity = options.min_similarity;
			if (options.max_age_days !== void 0) payload.max_age_days = options.max_age_days;
			if (options.note_id !== void 0) payload.note_id = options.note_id;
			if (options.surface !== void 0) payload.surface = options.surface;
			if (options.file_path !== void 0) payload.file_path = options.file_path;
			if (options.command !== void 0) payload.command = options.command;
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
	upgradeTimeoutMs;
	defaultHost;
	inFlightUpgrades = /* @__PURE__ */ new Map();
	constructor(options) {
		this.instanceResolver = options.instanceResolver;
		this.apiClient = options.apiClient;
		this.codebaseService = options.codebaseService;
		this.cliRunner = options.cliRunner;
		this.statusTimeoutMs = options.statusTimeoutMs ?? 5e3;
		this.recallTimeoutMs = options.recallTimeoutMs ?? 1e4;
		const envTimeout = process.env.VECTR_UPGRADE_TIMEOUT_MS ? parseInt(process.env.VECTR_UPGRADE_TIMEOUT_MS.trim(), 10) : void 0;
		const parsedEnvTimeout = typeof envTimeout === "number" && !isNaN(envTimeout) && envTimeout > 0 ? envTimeout : void 0;
		this.upgradeTimeoutMs = parsedEnvTimeout ?? (typeof options.upgradeTimeoutMs === "number" && options.upgradeTimeoutMs > 0 ? options.upgradeTimeoutMs : void 0) ?? 15e3;
		this.defaultHost = options.defaultHost ?? "127.0.0.1";
	}
	buildCodebases(workspace, codebasesRaw, mode, live) {
		const codebases = [];
		if (codebasesRaw.length > 0 && mode !== "memory_only") codebases.push({
			slug: "primary",
			type: "local",
			target: workspace,
			status: live ? "up" : "down",
			workspace,
			isPrimary: true,
			deletable: false
		});
		for (const cb of codebasesRaw) {
			const isPrimarySlug = typeof cb.slug === "string" && isSystemPrimarySlug(cb.slug);
			const isSamePath = cb.type === "local" && cb.path && resolve(cb.path) === resolve(workspace);
			if (isPrimarySlug || isSamePath) continue;
			codebases.push({
				slug: cb.slug,
				type: cb.type,
				target: cb.type === "remote" ? `${cb.host ?? ""}:${cb.remotePort ?? ""}` : cb.path,
				status: cb.status,
				isPrimary: false,
				deletable: true,
				...cb.error ? { error: cb.error } : {},
				...cb.workspace ? { workspace: cb.workspace } : {}
			});
		}
		return codebases;
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
		const codebasesRaw = await this.codebaseService.listForWorkspace(workspace);
		const instance = await this.instanceResolver.resolveForWorkspace(workspace);
		if (!instance) return {
			workspace,
			live: false,
			mode: "offline",
			codebases: this.buildCodebases(workspace, codebasesRaw, "offline", false),
			canReindex: false,
			reindexDisabledReason: "No Vectr daemon registered for this workspace",
			reason: "no_instance_registered"
		};
		const host = instance.host ?? this.defaultHost;
		const status = await this.apiClient.getStatus(host, instance.port, this.statusTimeoutMs);
		let live = status !== void 0;
		let reason;
		if (!live) reason = "daemon_unresponsive_or_offline";
		else if (typeof status?.workspace_root === "string" && status.workspace_root.trim().length > 0) {
			if (normalizeWorkspacePath$2(workspace) !== normalizeWorkspacePath$2(status.workspace_root)) {
				live = false;
				reason = "workspace_mismatch";
			}
		}
		const mode = formatMode(typeof instance.mode === "string" ? instance.mode : typeof status?.mode === "string" ? status.mode : "full", live);
		const reindexRule = canReindex(live, mode, status);
		const codebases = this.buildCodebases(workspace, codebasesRaw, mode, live);
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
			...reason ? { reason } : {}
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
	async startWorkspace(options) {
		const wsCheck = validateWorkspace(options.workspace);
		if (!wsCheck.valid) return {
			ok: false,
			error: wsCheck.error
		};
		const normWs = resolve(options.workspace);
		const startRes = await this.cliRunner.start({
			workspace: normWs,
			memoryOnly: options.memoryOnly,
			extraRoots: options.extraRoots
		});
		if (!startRes.ok) return {
			ok: false,
			error: startRes.error ?? "Failed to start Vectr daemon",
			stdout: startRes.stdout,
			stderr: startRes.stderr
		};
		const probeDeadline = Date.now() + 1e4;
		let readyInstance;
		let readyStatus;
		while (Date.now() < probeDeadline) {
			const inst = await this.instanceResolver.resolveForWorkspace(normWs);
			if (inst && inst.port) {
				const host = inst.host ?? this.defaultHost;
				const st = await this.apiClient.getStatus(host, inst.port, 1e3);
				if (st !== void 0) {
					readyInstance = inst;
					readyStatus = st;
					break;
				}
			}
			await setTimeout$1(200);
		}
		if (!readyInstance) {
			const fallbackInst = await this.instanceResolver.resolveForWorkspace(normWs);
			return {
				ok: fallbackInst !== void 0,
				port: fallbackInst?.port,
				pid: fallbackInst?.pid,
				stdout: startRes.stdout,
				stderr: startRes.stderr,
				...fallbackInst ? {} : { error: "Daemon process started but endpoint did not become ready in time" }
			};
		}
		const finalMode = formatMode(typeof readyInstance.mode === "string" ? readyInstance.mode : typeof readyStatus?.mode === "string" ? readyStatus.mode : "full", true);
		return {
			ok: true,
			port: readyInstance.port,
			pid: readyInstance.pid,
			mode: finalMode,
			stdout: startRes.stdout,
			stderr: startRes.stderr
		};
	}
	async upgradeWorkspace(workspace) {
		const wsCheck = validateWorkspace(workspace);
		if (!wsCheck.valid) return {
			ok: false,
			error: wsCheck.error
		};
		const normWs = resolve(workspace);
		const inFlight = this.inFlightUpgrades.get(normWs);
		if (inFlight) return inFlight;
		const task = this.doUpgradeWorkspace(normWs);
		this.inFlightUpgrades.set(normWs, task);
		try {
			return await task;
		} finally {
			this.inFlightUpgrades.delete(normWs);
		}
	}
	async doUpgradeWorkspace(workspace) {
		const initRes = await this.cliRunner.init({
			workspace,
			hooks: true,
			memoryOnly: false
		});
		if (!initRes.ok) return {
			ok: false,
			error: initRes.error ?? "Failed to initialize workspace for upgrade",
			stdout: initRes.stdout,
			stderr: initRes.stderr
		};
		const restartResult = await this.cliRunner.restart(workspace, { full: true });
		if (!restartResult.ok) return {
			ok: false,
			error: restartResult.error ?? "Failed to restart Vectr in full mode",
			stdout: restartResult.stdout,
			stderr: restartResult.stderr
		};
		const probeDeadline = Date.now() + this.upgradeTimeoutMs;
		let readyInstance;
		let readyStatus;
		while (Date.now() < probeDeadline) {
			const inst = await this.instanceResolver.resolveForWorkspace(workspace);
			if (inst && inst.port) {
				const host = inst.host ?? this.defaultHost;
				const st = await this.apiClient.getStatus(host, inst.port, 1e3);
				if (st !== void 0) {
					const rawStMode = typeof st.mode === "string" ? st.mode : void 0;
					if (formatMode(inst.mode ?? rawStMode, true) !== "memory_only") {
						readyInstance = inst;
						readyStatus = st;
						break;
					}
				}
			}
			await setTimeout$1(200);
		}
		if (!readyInstance) {
			const finalInst = await this.instanceResolver.resolveForWorkspace(workspace);
			let finalStatus;
			if (finalInst && finalInst.port) finalStatus = await this.apiClient.getStatus(finalInst.host ?? this.defaultHost, finalInst.port, 1e3);
			const rawMode = typeof finalInst?.mode === "string" ? finalInst.mode : typeof finalStatus?.mode === "string" ? finalStatus.mode : void 0;
			const finalMode = formatMode(rawMode, finalStatus !== void 0);
			return {
				ok: false,
				error: finalMode === "memory_only" || rawMode === "memory_only" || rawMode === "memory-only" ? `Vectr daemon is still in memory_only mode after upgrade restart (timeout: ${this.upgradeTimeoutMs}ms)` : `Timed out waiting for Vectr instance to become ready in full mode (timeout: ${this.upgradeTimeoutMs}ms)`,
				mode: finalMode,
				port: finalInst?.port,
				stdout: restartResult.stdout,
				stderr: restartResult.stderr
			};
		}
		const finalMode = formatMode(typeof readyInstance.mode === "string" ? readyInstance.mode : typeof readyStatus?.mode === "string" ? readyStatus.mode : "full", true);
		if (finalMode === "memory_only") return {
			ok: false,
			error: "Vectr daemon is still in memory_only mode after upgrade restart",
			mode: finalMode,
			port: readyInstance.port,
			stdout: restartResult.stdout,
			stderr: restartResult.stderr
		};
		return {
			ok: true,
			mode: finalMode,
			port: readyInstance.port,
			stdout: restartResult.stdout,
			stderr: restartResult.stderr
		};
	}
	async downgradeWorkspace(workspace) {
		const wsCheck = validateWorkspace(workspace);
		if (!wsCheck.valid) return {
			ok: false,
			error: wsCheck.error
		};
		const normWs = resolve(workspace);
		const inFlight = this.inFlightUpgrades.get(normWs);
		if (inFlight) return inFlight;
		const task = this.doDowngradeWorkspace(normWs);
		this.inFlightUpgrades.set(normWs, task);
		try {
			return await task;
		} finally {
			this.inFlightUpgrades.delete(normWs);
		}
	}
	async doDowngradeWorkspace(workspace) {
		const initRes = await this.cliRunner.init({
			workspace,
			hooks: true,
			memoryOnly: true
		});
		if (!initRes.ok) return {
			ok: false,
			error: initRes.error ?? "Failed to initialize workspace for downgrade",
			stdout: initRes.stdout,
			stderr: initRes.stderr
		};
		const restartResult = await this.cliRunner.restart(workspace, { memoryOnly: true });
		if (!restartResult.ok) return {
			ok: false,
			error: restartResult.error ?? "Failed to restart Vectr in memory-only mode",
			stdout: restartResult.stdout,
			stderr: restartResult.stderr
		};
		const probeDeadline = Date.now() + this.upgradeTimeoutMs;
		let readyInstance;
		let readyStatus;
		while (Date.now() < probeDeadline) {
			const inst = await this.instanceResolver.resolveForWorkspace(workspace);
			if (inst && inst.port) {
				const host = inst.host ?? this.defaultHost;
				const st = await this.apiClient.getStatus(host, inst.port, 1e3);
				if (st !== void 0) {
					const rawStMode = typeof st.mode === "string" ? st.mode : void 0;
					if (formatMode(inst.mode ?? rawStMode, true) === "memory_only") {
						readyInstance = inst;
						readyStatus = st;
						break;
					}
				}
			}
			await setTimeout$1(200);
		}
		if (!readyInstance) {
			const finalInst = await this.instanceResolver.resolveForWorkspace(workspace);
			let finalStatus;
			if (finalInst && finalInst.port) finalStatus = await this.apiClient.getStatus(finalInst.host ?? this.defaultHost, finalInst.port, 1e3);
			const rawMode = typeof finalInst?.mode === "string" ? finalInst.mode : typeof finalStatus?.mode === "string" ? finalStatus.mode : void 0;
			const finalMode = formatMode(rawMode, finalStatus !== void 0);
			return {
				ok: false,
				error: normalizeMode(rawMode) === "full" ? `Vectr daemon is still in full mode after downgrade restart (timeout: ${this.upgradeTimeoutMs}ms)` : `Timed out waiting for Vectr instance to switch to memory-only mode (timeout: ${this.upgradeTimeoutMs}ms)`,
				mode: finalMode,
				port: finalInst?.port,
				stdout: restartResult.stdout,
				stderr: restartResult.stderr
			};
		}
		const rawFinalMode = typeof readyInstance.mode === "string" ? readyInstance.mode : typeof readyStatus?.mode === "string" ? readyStatus.mode : "memory-only";
		const finalMode = formatMode(rawFinalMode, true);
		if (normalizeMode(rawFinalMode) !== "memory_only") return {
			ok: false,
			error: `Vectr daemon is in ${finalMode} mode after downgrade restart`,
			mode: finalMode,
			port: readyInstance.port,
			stdout: restartResult.stdout,
			stderr: restartResult.stderr
		};
		return {
			ok: true,
			mode: finalMode,
			port: readyInstance.port,
			stdout: restartResult.stdout,
			stderr: restartResult.stderr
		};
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
* - `POST /api/vectr/upgrade`
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
		path: "/api/vectr/upgrade",
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
				const result = await sessionService.upgradeWorkspace(opts.workspace.trim());
				sendJson(res, result.ok ? 200 : 400, result);
			} catch (error) {
				sendJson(res, 500, {
					ok: false,
					error: String(error)
				});
			}
		}
	}), "vectr-client: POST /api/vectr/upgrade");
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/api/vectr/downgrade",
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
				const result = await sessionService.downgradeWorkspace(opts.workspace.trim());
				sendJson(res, result.ok ? 200 : 400, result);
			} catch (error) {
				sendJson(res, 500, {
					ok: false,
					error: String(error)
				});
			}
		}
	}), "vectr-client: POST /api/vectr/downgrade");
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/api/vectr/session-start",
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
				const result = await sessionService.startWorkspace({
					workspace: opts.workspace.trim(),
					memoryOnly: opts.memoryOnly === true,
					...Array.isArray(opts.extraRoots) ? { extraRoots: opts.extraRoots } : {}
				});
				sendJson(res, result.ok ? 200 : 400, result);
			} catch (error) {
				sendJson(res, 500, {
					ok: false,
					error: String(error)
				});
			}
		}
	}), "vectr-client: POST /api/vectr/session-start");
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
/** Note-id marker rendered by recall output, e.g. `[#12]`. */
const NOTE_ID_PATTERN = /\[#(\d+)\]/g;
/** Open duration of the first breaker strike. */
const BREAKER_OPEN_MS = 6e4;
/** Budget for compaction snapshot/reset calls (fire-and-forget). */
const COMPACTION_TIMEOUT_MS = 800;
/** Bound on the per-session tool-probe dedupe ledger. */
const PROBED_KEY_LIMIT = 512;
const BOOT_HEADER = "Vectr working memory (auto-injected at session start) — do not call vectr_recall to re-fetch these; call it only for something not shown here.";
const PROMPT_HEADER = "Vectr working memory relevant to this prompt:";
const TOOL_HEADER = "Vectr working memory for the tool call that just ran:";
/**
* Filter out note lines whose ids were already delivered this session.
* Lines without an id are kept as-is (headers, continuation text). Mutates
* `delivered` with the ids of the lines it keeps.
* @param text - recall output.
* @param delivered - session-wide set of note ids already shown to the model.
* @returns the de-duplicated text; `''` when every note was a repeat.
*/
function dedupeNotes(text, delivered) {
	const kept = [];
	for (const line of text.split(/\r?\n/)) {
		const ids = [...line.matchAll(NOTE_ID_PATTERN)].map((match) => Number(match[1])).filter((id) => Number.isInteger(id));
		if (ids.some((id) => delivered.has(id))) continue;
		for (const id of ids) delivered.add(id);
		kept.push(line);
	}
	return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
/**
* Last genuine human message in the claimed step batch. Injected context
* messages carry a non-`user` source kind, so they never become a recall
* query.
* @param messages - messages claimed by the step.
* @returns the prompt text, or `undefined` when the batch has no human prompt.
*/
function lastHumanPrompt(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === void 0 || message.role !== "user" || message.source.kind !== "user") continue;
		const text = message.content.map((block) => block.type === "text" ? block.text : "").join("").trim();
		if (text !== "") return text;
	}
}
/**
* Map one tool call onto upstream's `PreToolUse` payload shape. DSH's built-in
* `edit`/`write` use `file_path` and `bash` uses `command`, exactly like the
* upstream payload, so no field renaming is needed.
* @param name - tool name.
* @param args - parsed tool arguments.
* @returns the probe, or `undefined` when the call is not injectable.
*/
function toolProbe(name, args) {
	if (typeof args !== "object" || args === null) return void 0;
	const record = args;
	if (name === "edit" || name === "write") {
		const filePath = record.file_path;
		if (typeof filePath !== "string" || filePath === "") return void 0;
		return {
			key: `file:${filePath}`,
			options: {
				file_path: filePath,
				kind: "gotcha",
				hook_event: "PreToolUse"
			}
		};
	}
	if (name === "bash") {
		const command = record.command;
		if (typeof command !== "string" || command.trim() === "") return void 0;
		return {
			key: `command:${command.trim().split(/\s+/)[0] ?? command.trim()}`,
			options: {
				command,
				hook_event: "PreToolUse"
			}
		};
	}
}
function defaultPostRequest(host, port, path, body, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	return fetch(`http://${host}:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: controller.signal
	}).then((response) => {
		if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}`);
	}).finally(() => {
		clearTimeout(timer);
	});
}
/**
* Owns all dynamic working-memory injection for one plugin instance.
* Agents are keyed weakly; state dies with the agent.
*/
var HostInjector = class {
	states = /* @__PURE__ */ new WeakMap();
	bySession = /* @__PURE__ */ new WeakMap();
	logger;
	config;
	client;
	now;
	post;
	createMessage;
	constructor(deps) {
		this.logger = deps.logger;
		this.config = deps.config;
		this.client = deps.client ?? new VectrApiClient();
		this.now = deps.now ?? (() => Date.now());
		this.post = deps.post ?? defaultPostRequest;
		this.createMessage = deps.createMessage ?? ((text, label) => createUserMessage({
			content: [{
				type: "text",
				text
			}],
			source: {
				kind: "vectr",
				form: "notice",
				summary: `vectr working memory (${label})`
			}
		}));
	}
	/**
	* Attach injection state to an agent whose workspace resolved a live daemon.
	* Idempotent; a rebind after daemon restart refreshes the endpoint but keeps
	* the session's delivery ledger.
	* @param agent - the agent whose turns receive injections.
	* @param target - resolved daemon endpoint and whether an indexed codebase is bound.
	*/
	bind(agent, target) {
		const existing = this.states.get(agent);
		if (existing !== void 0) {
			existing.host = target.host;
			existing.port = target.port;
			existing.hasCode = target.hasCode;
			return;
		}
		const state = {
			host: target.host,
			port: target.port,
			hasCode: target.hasCode,
			sessionId: agent.id,
			session: agent.session,
			boot: void 0,
			bootDelivered: false,
			reBootPending: false,
			lastTurn: 0,
			turnForBudget: 0,
			turnSpentTokens: 0,
			delivered: /* @__PURE__ */ new Set(),
			probed: /* @__PURE__ */ new Set(),
			spentTokens: 0,
			failures: 0,
			breakerTrips: 0,
			disabledUntil: 0,
			warned: /* @__PURE__ */ new Set()
		};
		this.states.set(agent, state);
		this.bySession.set(agent.session, state);
	}
	/**
	* A `compact` session source means the conversation was compressed: the next
	* boot recall must carry `post-compaction` and re-deliver notes.
	* @param agent - the agent whose session source changed.
	* @param source - session start source.
	*/
	markSource(agent, source) {
		if (source !== "compact") return;
		const state = this.states.get(agent);
		if (state === void 0) return;
		state.reBootPending = true;
		state.boot = void 0;
		state.delivered.clear();
	}
	/**
	* Start the boot recall once for the session (or once after compaction).
	* The promise is stored so the first pre-step awaits it instead of issuing
	* a second request.
	* @param agent - the agent to prefetch for.
	*/
	prefetchBoot(agent) {
		const state = this.states.get(agent);
		if (state === void 0 || state.boot !== void 0 || this.isDisabled(state)) return;
		const events = state.reBootPending ? ["session-start", "post-compaction"] : ["session-start"];
		state.reBootPending = false;
		state.boot = this.fetchNotes(state, {
			boot: true,
			hook_event: "SessionStart",
			session_id: state.sessionId,
			events
		}, this.config.bootRecallTimeoutMs);
	}
	/**
	* Inject the boot pack on the first step and prompt-relevant notes on the
	* first step of every later turn. The step is never blocked beyond the
	* configured bounds, and any thrown error leaves the decision untouched.
	* @param payload - step payload from the host.
	* @param next - downstream pre-step waterfall.
	* @returns the possibly extended step decision.
	*/
	async onPreStep(payload, next) {
		const decision = await next();
		if (decision.kind === "reject" || payload.signal.aborted) return decision;
		const state = this.states.get(payload.agent);
		if (state === void 0 || this.isDisabled(state)) return decision;
		if (payload.turn !== state.turnForBudget) {
			state.turnForBudget = payload.turn;
			state.turnSpentTokens = 0;
		}
		try {
			const parts = [];
			if (!state.bootDelivered || state.reBootPending) {
				this.prefetchBoot(payload.agent);
				const text = state.boot === void 0 ? "" : await this.withTimeout(state.boot, this.config.bootRecallTimeoutMs, state, "boot recall");
				state.boot = void 0;
				state.bootDelivered = true;
				const fresh = this.accept(state, text, BOOT_HEADER);
				if (fresh !== void 0) parts.push(fresh);
			}
			if (payload.step === 1 && payload.turn !== state.lastTurn) {
				state.lastTurn = payload.turn;
				const prompt = lastHumanPrompt(decision.messages);
				if (prompt !== void 0) {
					const text = await this.withTimeout(this.fetchNotes(state, {
						query: prompt,
						limit: this.config.promptRecallLimit,
						detail: "index",
						hook_event: "UserPromptSubmit",
						events: ["prompt-submit"],
						session_id: state.sessionId
					}, this.config.promptRecallTimeoutMs), this.config.promptRecallTimeoutMs + 100, state, "prompt recall");
					const fresh = this.accept(state, text, PROMPT_HEADER);
					if (fresh !== void 0) parts.push(fresh);
				}
			}
			if (parts.length === 0) return decision;
			return {
				...decision,
				messages: [...decision.messages, this.message(parts.join("\n\n"), "session")]
			};
		} catch (error) {
			this.degrade(payload.agent, error);
			return decision;
		}
	}
	/**
	* Attach a tool-anchored gotcha pack to the next request. Only `accept`
	* decisions are extended; the tool result itself is passed through by
	* reference (never re-wrapped).
	* @param exec - the tool call that just ran.
	* @param next - downstream post-execute waterfall.
	* @returns the possibly extended post-execute decision.
	*/
	async onPostExecute(exec, next) {
		const decision = await next();
		if (decision.kind !== "accept") return decision;
		const state = exec.agent === void 0 ? void 0 : this.states.get(exec.agent);
		try {
			if (state === void 0 || !state.hasCode || this.isDisabled(state)) return decision;
			const probe = toolProbe(exec.name, exec.arguments);
			if (probe === void 0 || state.probed.has(probe.key)) return decision;
			state.probed.add(probe.key);
			if (state.probed.size > PROBED_KEY_LIMIT) state.probed.clear();
			const text = await this.fetchNotes(state, probe.options, this.config.toolRecallTimeoutMs);
			const fresh = this.accept(state, text, TOOL_HEADER);
			if (fresh === void 0) return decision;
			return {
				...decision,
				additionalContexts: [...decision.additionalContexts ?? [], this.message(fresh, "tool")]
			};
		} catch (error) {
			if (exec.agent !== void 0) this.degrade(exec.agent, error);
			return decision;
		}
	}
	/**
	* Consume compaction lifecycle events: snapshot + reset the trigger ledger
	* before compaction, and mark the next boot for re-delivery after it.
	* @param session - the session that appended the event.
	* @param event - the appended session event.
	*/
	onSessionEvent(session, event) {
		const state = this.bySession.get(session);
		if (state === void 0 || this.isDisabled(state)) return;
		if (event.type === "compaction/start") {
			if (this.config.injectCompactionSnapshot) {
				const label = `pre-compact-auto-${new Date(this.now()).toISOString()}`;
				this.post(state.host, state.port, "/v1/snapshot", {
					label,
					session_id: state.sessionId
				}, COMPACTION_TIMEOUT_MS).catch((error) => {
					this.degradeState(state, error);
				});
			}
			this.post(state.host, state.port, "/v1/trigger/reset", { session_id: state.sessionId }, COMPACTION_TIMEOUT_MS).catch((error) => {
				this.degradeState(state, error);
			});
			return;
		}
		if (event.type === "compaction/end") {
			state.reBootPending = true;
			state.boot = void 0;
			state.delivered.clear();
		}
	}
	/**
	* Drop all state for a disposed agent.
	* @param agent - the agent being torn down.
	*/
	dispose(agent) {
		const state = this.states.get(agent);
		if (state !== void 0) this.bySession.delete(state.session);
		this.states.delete(agent);
	}
	async fetchNotes(state, options, timeoutMs) {
		try {
			const result = await this.client.recall(state.host, state.port, options, timeoutMs);
			if (!result.ok || result.notes === void 0) {
				this.noteFailure(state, result.error ?? "recall returned no notes");
				return "";
			}
			state.failures = 0;
			return result.notes;
		} catch (error) {
			this.noteFailure(state, String(error));
			return "";
		}
	}
	async withTimeout(promise, timeoutMs, state, label) {
		let timer;
		try {
			const timeout = new Promise((resolve) => {
				timer = setTimeout(() => {
					this.warnOnce(state, `timeout:${label}`, `vectr-client: ${label} timed out after ${timeoutMs}ms; injecting nothing`);
					resolve("");
				}, timeoutMs);
			});
			return await Promise.race([promise, timeout]);
		} finally {
			if (timer !== void 0) clearTimeout(timer);
		}
	}
	/**
	* De-duplicate on a staged copy, clamp, then charge the budget. Note ids are
	* committed to the session ledger only after the text is actually injected
	* and only for notes that survive clamping, so neither a budget-rejected nor
	* a truncated-out note is permanently suppressed.
	*/
	accept(state, text, header) {
		const fresh = dedupeNotes(text, new Set(state.delivered));
		if (fresh === "") return void 0;
		const wrapped = this.clamp(`${header}\n\n${fresh}`);
		if (!this.spend(state, wrapped)) return void 0;
		for (const match of wrapped.matchAll(NOTE_ID_PATTERN)) {
			const id = Number(match[1]);
			if (Number.isInteger(id)) state.delivered.add(id);
		}
		return wrapped;
	}
	/** Cumulative per-turn and per-session token gate (1 token = 4 chars). */
	spend(state, text) {
		const cost = Math.ceil(text.length / 4);
		if (state.turnSpentTokens + cost > this.config.perTurnTokenCap) return false;
		if (state.spentTokens + cost > this.config.perSessionTokenCap) return false;
		state.turnSpentTokens += cost;
		state.spentTokens += cost;
		return true;
	}
	clamp(text) {
		const cap = this.config.maxInjectionChars;
		return text.length <= cap ? text : `${text.slice(0, cap)}\n… (truncated)`;
	}
	message(text, label) {
		return this.createMessage(text, label);
	}
	isDisabled(state) {
		return this.now() < state.disabledUntil;
	}
	noteFailure(state, reason) {
		state.failures += 1;
		if (state.failures < 3) return;
		state.failures = 0;
		state.breakerTrips += 1;
		state.disabledUntil = state.breakerTrips >= 2 ? Number.POSITIVE_INFINITY : this.now() + BREAKER_OPEN_MS;
		this.warnOnce(state, "breaker", `vectr-client: memory injection paused after 3 failures (${reason})`);
	}
	degrade(agent, error) {
		const state = this.states.get(agent);
		if (state === void 0) return;
		this.degradeState(state, error);
	}
	degradeState(state, error) {
		this.warnOnce(state, "degrade", `vectr-client: memory injection degraded: ${error instanceof Error ? error.message : String(error)}`);
	}
	warnOnce(state, key, message) {
		if (state.warned.has(key)) return;
		state.warned.add(key);
		this.logger.warn(message);
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
const DEFAULT_HTTP_TIMEOUT_MS = DEFAULT_DAEMON_HTTP_TIMEOUT_MS;
/** Default TCP port-listening probe budget (ms). */
const DEFAULT_DAEMON_TCP_TIMEOUT_MS = 300;
/** Default Vectr CLI execution timeout in ms (default 30,000). */
const DEFAULT_CLI_TIMEOUT_MS = 3e4;
/** Default working memory note recall / resume timeout in ms (default 10,000). */
const DEFAULT_RECALL_TIMEOUT_MS = 1e4;
/** Default Vectr workspace upgrade timeout in ms (default 15,000). */
const DEFAULT_UPGRADE_TIMEOUT_MS = 15e3;
/** (b) Minimum interval between startup-time heal attempts for the same slug.
* Prevents a persistently-unreachable host from being hammered on every host
* restart while still leaving room for transient blips to recover. */
const STARTUP_HEAL_COOLDOWN_MS = 3e4;
/** Per-slug timestamp of the last startup-heal attempt. Process-local — a
* restart resets the map (one fresh attempt per slug per host lifetime). */
const startupHealCooldown = /* @__PURE__ */ new Map();
/** Test seam to reset the startup-heal cooldown map. */
function _resetStartupHealCooldownForTests() {
	startupHealCooldown.clear();
}
/** (b) Startup-heal scope: which persisted entries get an automatic heal attempt
* at host startup. `up` keeps its legacy behavior — the daemon/tunnel can die
* while the host stays up and the meta keeps claiming `up`; `down` and `error`
* are the previously-deadlocked states that were only surfaced to the user and
* never automatically recovered. Both shapes are healable now:
*
*  - `remote` → {@link ensureTunnelUp} reopens the ssh tunnel.
*  - `local`  → {@link healLocalCodebase} restarts the vectr daemon when its
*    port is dead. A host restart SIGTERMs every daemon inside the service
*    cgroup, and previously nothing ever started them again.
*/
function startupHealEligible(entry) {
	return entry.status === "up" || entry.status === "down" || entry.status === "error";
}
/**
* Liveness probe handed to {@link healLocalCodebase} at host startup. Reuses the
* same process+HTTP diagnosis as the console scan (`diagnoseDaemon`), so a daemon
* that holds its port but hangs on HTTP counts as dead and gets restarted
* instead of shadowing a broken endpoint. A probe that throws is reported and
* treated as dead — the restart path, not silence.
* @param ctx - plugin context (logger).
* @param config - resolved plugin configuration (probe budgets).
* @returns the injected {@link DaemonAliveProbe}.
*/
function daemonAliveProbe(ctx, config) {
	return async ({ host, port, workspace }) => {
		try {
			const { alive } = await diagnoseDaemon({
				workspace: workspace ?? host,
				port,
				host
			}, {
				httpProbe: fetchStatus,
				httpTimeoutMs: config.daemonHttpTimeoutMs,
				tcpTimeoutMs: config.daemonTcpTimeoutMs
			});
			return alive;
		} catch (error) {
			ctx.logger.warn(`vectr-client: local daemon probe failed for ${host}:${port}: ${String(error)}`);
			return false;
		}
	};
}
const Reconnect = z.object({
	enabled: z.boolean().default(true),
	initialDelayMs: z.number().min(1).default(500),
	maxDelayMs: z.number().min(1).default(3e4),
	maxAttempts: z.number().step(1).min(1).default(10)
});
const Config = z.object({
	instancesPath: z.string().default(DEFAULT_INSTANCES_FILE),
	serverName: z.string().default(DEFAULT_SERVER_NAME),
	toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
	reconnect: Reconnect.default({ enabled: true }),
	codebasesPath: z.string().default(DEFAULT_CODEBASES_FILE),
	secretsPath: z.string().default(DEFAULT_SECRETS_FILE),
	daemonHttpTimeoutMs: z.number().min(1).default(DEFAULT_DAEMON_HTTP_TIMEOUT_MS),
	daemonTcpTimeoutMs: z.number().min(1).default(DEFAULT_DAEMON_TCP_TIMEOUT_MS),
	cliPath: z.string().default(""),
	cliTimeoutMs: z.number().min(1).default(DEFAULT_CLI_TIMEOUT_MS),
	recallTimeoutMs: z.number().min(1).default(DEFAULT_RECALL_TIMEOUT_MS),
	upgradeTimeoutMs: z.number().min(1).default(DEFAULT_UPGRADE_TIMEOUT_MS),
	autoStartDaemons: z.boolean().default(true),
	bootRecallTimeoutMs: z.number().min(1).default(1500),
	promptRecallTimeoutMs: z.number().min(1).default(400),
	toolRecallTimeoutMs: z.number().min(1).default(300),
	promptRecallLimit: z.number().step(1).min(1).default(3),
	perTurnTokenCap: z.number().min(0).default(500),
	perSessionTokenCap: z.number().min(0).default(8e3),
	maxInjectionChars: z.number().min(0).default(4e3),
	injectCompactionSnapshot: z.boolean().default(true)
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
/**
* Generate guidance prompt text dynamically adapted to `serverName` (defaults to `vectr`).
*/
function getVectrGuidanceText(serverName = DEFAULT_SERVER_NAME) {
	return `CRITICAL CODE RETRIEVAL POLICY (ABSOLUTE NEGATIVE CONSTRAINT & MANDATORY FALLBACK CHAIN):
1. ABSOLUTE NEGATIVE CONSTRAINT: DO NOT invoke grep, glob, or bash search commands (such as find or rg) as your first attempt to locate code, definitions, or architectural concepts. Initial exploration starting with grep or blind file reads without attempting vectr is strictly prohibited.
2. PREEMPTIVE RESTRICTION: Do NOT bypass or skip vectr tools under the assumption that target files are "already known" or that you are merely "executing a step-by-step implementation plan". Vectr indexes full architectural dependencies, cross-file symbol definitions, call hierarchies, and live working notes that blind file reads or grep cannot provide.
3. MANDATORY FIRST ATTEMPT: You MUST ALWAYS prioritize the vectr MCP tools (mcp__${serverName}*) when available over grep and blind file reads. Query, locate, and reason over the indexed workspace using vectr first:
   - Concepts, features, patterns, or behaviors: call mcp__${serverName}__vectr_search(query="...")
   - Symbol definitions (function, class, struct, type): call mcp__${serverName}__vectr_locate(name="...")
   - Call hierarchy & callers/callees: call mcp__${serverName}__vectr_trace(name="...")
4. MANDATORY FALLBACK CHAIN: ONLY fall back to grep if vectr tools are not available, query fails, or yields no results. When falling back to grep, you MUST explicitly state the reason in your reasoning (e.g. "Vectr search yielded no results, degrading to grep").
5. SUBAGENT & TEAM PROPAGATION: This code retrieval policy applies to YOU and to EVERY subagent, teammate, or child agent you spawn. You MUST explicitly forward and include this retrieval constraint in any subagent or teammate prompt that involves codebase exploration or navigation.`;
}
const VECTR_GUIDANCE_SECTION_TEXT = getVectrGuidanceText(DEFAULT_SERVER_NAME);
/**
* Working-memory doctrine section. Always contributed when a vectr daemon is
* bound, including memory-only workspaces with no indexed codebase: working
* memory is orthogonal to code retrieval, so this section must NOT inherit the
* `hasCode` gate that guards the retrieval/grep sections.
*/
const VECTR_MEMORY_SECTION_NAME = "vectr:working-memory";
const VECTR_MEMORY_SECTION_ORDER = 96;
/**
* Static English text: only the delta that is not already implied by the MCP
* tool descriptions (which the host passes through verbatim). No tool table.
*/
function getVectrMemoryText() {
	return `Working memory lives in vectr, not in files: store findings with \`vectr_remember\`, never in scratch notes or an editor memory directory — only vectr notes are re-injected after compaction and immediately visible to every session and teammate.

Relevant notes are injected automatically at session start and on each user prompt. Do not call \`vectr_recall\` just to re-fetch them; call it for a targeted query the injection did not cover, or for one specific note (\`note_id=\`).

\`kind\` decides when a note comes back: \`directive\` = standing rule (every session start and after compaction); \`task\` = current-work checkpoint (newest first; supersede it when the work moves on); \`gotcha\` = file-anchored caveat (resurfaces when that file is edited); \`finding\` = relevance-ranked learning; \`reference\` = URL/ticket pointer; \`decision\` = design decision plus why (recall with kind="decision", sort_by="chronological"); \`operational\` = build/env/process fact. Store the code or the finding itself, not a file pointer.

Correct memory that lags reality instead of rewriting it or leaving it wrong: \`vectr_remember(..., supersedes=<old id>)\` replaces a note; \`contradicts=<old id>\` replaces a note proven wrong and revokes the old one. Age alone never retires a task checkpoint describing finished work — supersede it.

\`triggers\` is optional; each kind already has sensible defaults. Add triggers only when a note must also surface on a path glob, a lifecycle event, a symbol, a command family, or prompt similarity.

Multi-agent: working memory is shared workspace-wide. Subagents must \`vectr_remember(..., agent="<name>")\` before finishing; orchestrators must \`vectr_recall\` after a subagent completes instead of parsing its transcript.`;
}
const VECTR_MEMORY_SECTION_TEXT = getVectrMemoryText();
/**
* Scoped prompt section that shadows the global `tool:grep` section for agents
* in a verified vectr workspace. Instead of directly telling the model to use
* grep to search file contents, it instructs the model to prioritize vectr tools
* and only use grep as a fallback if vectr fails.
*/
const VECTR_GREP_SECTION_NAME = "tool:grep";
const VECTR_GREP_SECTION_ORDER = 1500;
/**
* Generate grep shadow prompt text dynamically adapted to `serverName` (defaults to `vectr`).
*/
function getVectrGrepText(serverName = DEFAULT_SERVER_NAME) {
	return `CRITICAL RESTRICTION ON GREP: Prioritize querying code via vectr tools (mcp__${serverName}*) when available. DO NOT invoke grep as your initial tool for code exploration or symbol lookup.
PREEMPTIVE RESTRICTION: Do NOT bypass vectr tools because files are "already known" or when executing an implementation plan.
MANDATORY FALLBACK RULE: If vectr tools are not available, query fails, or yields no results, use the grep tool — not shell grep or rg — to search file contents. Use read on a matched file when you need surrounding context.
SUBAGENT & TEAM PROPAGATION: Forward this grep restriction to all spawned subagents or teammates.`;
}
const VECTR_GREP_SECTION_TEXT = getVectrGrepText(DEFAULT_SERVER_NAME);
/**
* @see ./registry.ts for `resolveInstance` / `readInstancesFile`.
* @see ./probe.ts for `isPortListening` / `isDaemonAlive` / `diagnoseDaemon`.
* These were migrated out of this file; it re-exports them above and only
* wires the plugin together.
*/
/**
* Build the per-connection status cell rc.2's `startConnection` requires.
*
* rc.2 takes the writable status cell as an explicit fourth argument instead of
* creating one per server fiber. Each vectr connection gets its own cell so
* concurrent agent and codebase connections never overwrite one another's
* status; contained observer failures go to the plugin logger.
*
* @param ctx - plugin context whose logger receives observer failures.
* @param label - connection label included in the diagnostic prefix.
* @returns a fresh writable status cell for one connection.
*/
function createConnectionStatusCell(ctx, label) {
	return new McpStatusCell((message, error) => ctx.logger.warn(`vectr-client(${label}): ${message}`, error));
}
/**
* Transport-closure budget handed to `startConnection`, matching rc.2's
* `DEFAULT_CLOSE_TIMEOUT_MS` (the `mcp-client` schema default). Vectr has no
* config knob for it; the value must stay finite because rc.2 rejects a
* missing budget at the type level.
*/
const MCP_CLOSE_TIMEOUT_MS = 5e3;
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
function install(ctx, handles, promptFibers, instancesPath, config, agent, codebasesPath, disposed = /* @__PURE__ */ new WeakSet(), codebaseBoundAgents = /* @__PURE__ */ new WeakSet(), codebaseHandles, injector) {
	if (disposed.has(agent)) return;
	if (handles.has(agent) && promptFibers.has(agent)) return;
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
	}
	let codebases;
	if (codebasesPath !== void 0) try {
		codebases = loadCodebases(codebasesPath);
	} catch (error) {
		ctx.logger.warn(`vectr-client: cannot read codebase metadata at ${codebasesPath} (${String(error)}); skipping codebase binds for session ${agent.id}`);
	}
	const entry = instances !== void 0 ? resolveInstance(instances, cwd) : void 0;
	if (entry !== void 0 && !isValidInstanceEntry(entry)) ctx.logger.warn(`vectr-client: invalid instance entry for session ${agent.id} (cwd=${cwd}): ${JSON.stringify(entry)}, skipping connection`);
	const validEntry = entry !== void 0 && isValidInstanceEntry(entry) ? entry : void 0;
	if (!hasCodebase({
		workspace: cwd,
		entry: validEntry,
		codebases
	})) {
		ctx.logger.info(`vectr-client: no vectr daemon for ${cwd}, skipping`);
		return;
	}
	const hasCode = hasIndexedCodebase({
		workspace: cwd,
		entry: validEntry,
		codebases
	});
	const serverName = config.serverName || "vectr";
	if (!promptFibers.has(agent)) {
		const fiber = agent.ctx.inject(["systemPrompt"], (scope) => {
			scope.systemPrompt.section({
				name: VECTR_MEMORY_SECTION_NAME,
				order: 96,
				text: getVectrMemoryText()
			});
			if (!hasCode) return;
			scope.systemPrompt.section({
				name: VECTR_GUIDANCE_SECTION_NAME,
				order: 95,
				text: getVectrGuidanceText(serverName)
			});
			scope.systemPrompt.section({
				name: VECTR_GREP_SECTION_NAME,
				order: scope.systemPrompt.getSectionOrder?.("TOOL_GREP") ?? 1500,
				text: getVectrGrepText(serverName)
			});
		});
		if (disposed.has(agent)) fiber.dispose().catch(() => {});
		else promptFibers.set(agent, fiber);
	}
	if (validEntry !== void 0 && !handles.has(agent)) {
		try {
			const host = validEntry.host ?? "127.0.0.1";
			const port = validEntry.port;
			injector?.bind(agent, {
				host,
				port,
				hasCode
			});
			const policy = resolveReconnectPolicy(config.reconnect, `vectr-client(${config.serverName}): reconnect`);
			const conn = startConnection(agent.ctx, {
				transport: "streamable-http",
				serverName: config.serverName,
				url: `http://${host}:${port}/mcp`,
				headers: {},
				toolCallTimeoutMs: config.toolCallTimeoutMs,
				closeTimeoutMs: MCP_CLOSE_TIMEOUT_MS,
				expandTemplates: false,
				failOnStartupError: false
			}, policy, createConnectionStatusCell(ctx, `session ${agent.id}`));
			conn.ready.then((outcome) => {
				if (outcome.error !== void 0) {
					const message = `vectr-client: vectr connection failed for session ${agent.id} (cwd=${cwd}, port=${port}): ${String(outcome.error)}`;
					if (agent.ctx?.logger !== void 0) agent.ctx.logger.warn(message);
					else ctx.logger.warn(message);
				}
			});
			if (disposed.has(agent)) conn.dispose().catch(() => {});
			else handles.set(agent, conn);
		} catch (error) {
			ctx.logger.warn(`vectr-client: failed to initialize main connection for session ${agent.id} (cwd=${cwd}): ${String(error)}`);
		}
		(async () => {
			try {
				const diagnosis = await diagnoseDaemon(validEntry, {
					httpProbe: (e, ms) => fetchStatus(e, ms),
					httpTimeoutMs: config.daemonHttpTimeoutMs ?? 5e3,
					tcpTimeoutMs: config.daemonTcpTimeoutMs ?? DEFAULT_DAEMON_TCP_TIMEOUT_MS
				});
				if (!diagnosis.alive) {
					const pid = validEntry.pid === void 0 ? "n/a" : String(validEntry.pid);
					const reason = diagnosis.reason ?? "HTTP_PROBE_UNREACHABLE";
					ctx.logger.warn(`vectr-client: vectr daemon not alive, advisory telemetry warning for session ${agent.id} (cwd=${cwd}, workspace=${validEntry.workspace}, port=${validEntry.port}, pid=${pid}, reason=${reason})`);
				}
			} catch (err) {
				ctx.logger.warn(`vectr-client: daemon probe error for session ${agent.id}: ${String(err)}`);
			}
		})();
	}
	if (codebasesPath !== void 0 && !codebaseBoundAgents.has(agent)) {
		codebaseBoundAgents.add(agent);
		installCodebaseConnections(ctx, config, agent, codebasesPath, instances, cwd, disposed, codebaseHandles);
	}
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
async function installCodebaseConnections(ctx, config, agent, codebasesPath, instances, cwd, disposed = /* @__PURE__ */ new WeakSet(), codebaseHandles) {
	if (disposed.has(agent)) return;
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
		if (disposed.has(agent)) return;
		if (entry.status !== "up" || entry.localPort === void 0) continue;
		if (agentWs !== void 0) {
			if (entry.workspace !== agentWs) continue;
		} else if (entry.workspace === void 0 || !knownWorkspaces.has(entry.workspace)) continue;
		try {
			const conn = startConnection(agent.ctx, {
				transport: "streamable-http",
				serverName: entry.serverName,
				url: `http://127.0.0.1:${entry.localPort}/mcp`,
				headers: {},
				toolCallTimeoutMs: config.toolCallTimeoutMs,
				closeTimeoutMs: MCP_CLOSE_TIMEOUT_MS,
				expandTemplates: false,
				failOnStartupError: false
			}, policy, createConnectionStatusCell(ctx, `codebase ${entry.serverName}`));
			conn.ready.then((outcome) => {
				if (outcome.error !== void 0) {
					const message = `vectr-client: codebase connection failed for session ${agent.id} (serverName=${entry.serverName}, port=${entry.localPort}): ${String(outcome.error)}`;
					if (agent.ctx?.logger !== void 0) agent.ctx.logger.warn(message);
					else ctx.logger.warn(message);
				}
			});
			if (disposed.has(agent)) conn.dispose().catch(() => {});
			else if (codebaseHandles !== void 0) {
				let list = codebaseHandles.get(agent);
				if (list === void 0) {
					list = [];
					codebaseHandles.set(agent, list);
				}
				list.push(conn);
			}
		} catch (error) {
			ctx.logger.warn(`vectr-client: codebase bind threw for ${entry.serverName} (session ${agent.id}): ${String(error)}`);
		}
	}
}
/**
* Run the startup heal across all eligible codebases in the metadata registry.
* Local codebases are processed strictly sequentially (`for ... of` with `await`),
* so that projects don't all storm the local port allocator concurrently at boot.
* Remote codebase tunnels continue to be kicked off in the background.
*/
async function startupHeal(deps, codebasesPath, instancesPath, ctx, config) {
	const now = Date.now();
	let startupInstances;
	try {
		startupInstances = readInstancesFile(ctx, instancesPath);
	} catch (error) {
		ctx.logger.warn(`vectr-client: cannot read daemon registry at ${instancesPath} (${String(error)}); local codebase ports will not be reconciled`);
	}
	const recordedPortOf = (workspace) => {
		if (startupInstances === void 0) return void 0;
		const live = resolveInstanceExact(startupInstances, workspace);
		return typeof live?.port === "number" ? live.port : void 0;
	};
	const probe = daemonAliveProbe(ctx, config);
	for (const entry of loadCodebases(codebasesPath)) {
		if (!startupHealEligible(entry)) continue;
		const lastAttempt = startupHealCooldown.get(entry.slug);
		if (lastAttempt !== void 0 && now - lastAttempt < 3e4) continue;
		startupHealCooldown.set(entry.slug, now);
		if (entry.type === "remote") ensureTunnelUp(deps, codebasesPath, entry).catch((err) => {
			ctx.logger.warn(`vectr-client: could not re-establish tunnel for ${entry.slug}: ${String(err)}`);
		});
		else try {
			const result = await healLocalCodebase(deps, codebasesPath, entry, probe, recordedPortOf);
			if (result === "reconciled") ctx.logger.info(`vectr-client: corrected stale port for local codebase ${entry.slug} from the daemon registry`);
			if (result === "started") ctx.logger.info(`vectr-client: restarted local vectr daemon for ${entry.slug}`);
		} catch (err) {
			ctx.logger.warn(`vectr-client: could not restart local vectr daemon for ${entry.slug}: ${String(err)}`);
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
		reconnect: {
			enabled: config.reconnect?.enabled ?? true,
			initialDelayMs: config.reconnect?.initialDelayMs ?? 500,
			maxDelayMs: config.reconnect?.maxDelayMs ?? 3e4,
			maxAttempts: config.reconnect?.maxAttempts ?? 10
		},
		codebasesPath: config.codebasesPath ?? DEFAULT_CODEBASES_FILE,
		secretsPath: config.secretsPath ?? DEFAULT_SECRETS_FILE,
		daemonHttpTimeoutMs: config.daemonHttpTimeoutMs ?? 5e3,
		daemonTcpTimeoutMs: config.daemonTcpTimeoutMs ?? DEFAULT_DAEMON_TCP_TIMEOUT_MS,
		cliPath: config.cliPath ?? "",
		cliTimeoutMs: config.cliTimeoutMs ?? 3e4,
		recallTimeoutMs: config.recallTimeoutMs ?? 1e4,
		upgradeTimeoutMs: (() => {
			const envVal = process.env.VECTR_UPGRADE_TIMEOUT_MS ? parseInt(process.env.VECTR_UPGRADE_TIMEOUT_MS.trim(), 10) : void 0;
			if (typeof envVal === "number" && !isNaN(envVal) && envVal > 0) return envVal;
			return config.upgradeTimeoutMs ?? 15e3;
		})(),
		autoStartDaemons: config.autoStartDaemons ?? true,
		bootRecallTimeoutMs: config.bootRecallTimeoutMs ?? 1500,
		promptRecallTimeoutMs: config.promptRecallTimeoutMs ?? 400,
		toolRecallTimeoutMs: config.toolRecallTimeoutMs ?? 300,
		promptRecallLimit: config.promptRecallLimit ?? 3,
		perTurnTokenCap: config.perTurnTokenCap ?? 500,
		perSessionTokenCap: config.perSessionTokenCap ?? 8e3,
		maxInjectionChars: config.maxInjectionChars ?? 4e3,
		injectCompactionSnapshot: config.injectCompactionSnapshot ?? true
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
		startupHeal(buildCodebaseDeps(ctx, resolved.secretsPath), codebasesPath, instancesPath, ctx, resolved).catch((err) => {
			ctx.logger.warn(`vectr-client: startup heal failed: ${String(err)}`);
		});
	} catch (err) {
		ctx.logger.warn(`vectr-client: startup codebase heal skipped: ${String(err)}`);
	}
	if (resolved.autoStartDaemons) withLocalDaemonLock(() => startAllDaemons(buildStartAllDeps(ctx, instancesPath, resolved), {})).then((sweep) => {
		ctx.logger.info(`vectr-client: auto-start daemons: ${sweep.started} started, ${sweep.alreadyRunning} already running, ${sweep.failed} failed`);
	}).catch((err) => {
		ctx.logger.warn(`vectr-client: auto-start daemons failed: ${String(err)}`);
	});
	const handles = /* @__PURE__ */ new Map();
	const codebaseHandles = /* @__PURE__ */ new Map();
	const promptFibers = /* @__PURE__ */ new Map();
	const disposed = /* @__PURE__ */ new WeakSet();
	const codebaseBoundAgents = /* @__PURE__ */ new WeakSet();
	const injectionConfig = {
		bootRecallTimeoutMs: resolved.bootRecallTimeoutMs,
		promptRecallTimeoutMs: resolved.promptRecallTimeoutMs,
		toolRecallTimeoutMs: resolved.toolRecallTimeoutMs,
		promptRecallLimit: resolved.promptRecallLimit,
		perTurnTokenCap: resolved.perTurnTokenCap,
		perSessionTokenCap: resolved.perSessionTokenCap,
		maxInjectionChars: resolved.maxInjectionChars,
		injectCompactionSnapshot: resolved.injectCompactionSnapshot
	};
	const injector = new HostInjector({
		logger: ctx.logger,
		config: injectionConfig
	});
	ctx.on("agent/pre-step", (payload, next) => injector.onPreStep(payload, next), { prepend: true });
	ctx.on("agent/disposed", ({ agent }) => {
		injector.dispose(agent);
	});
	ctx.on("session/event", (session, event) => {
		injector.onSessionEvent(session, event);
	});
	if (typeof ctx.inject === "function") ctx.inject(["tools"], (scope) => {
		scope.on("tools/post-execute", (exec, _result, next) => injector.onPostExecute(exec, next));
	});
	for (const agent of ctx.agents.list()) {
		install(ctx, handles, promptFibers, instancesPath, resolved, agent, codebasesPath, disposed, codebaseBoundAgents, codebaseHandles, injector);
		injector.markSource(agent, "startup");
		injector.prefetchBoot(agent);
	}
	ctx.on("agent/created", ({ agent, source }) => {
		install(ctx, handles, promptFibers, instancesPath, resolved, agent, codebasesPath, disposed, codebaseBoundAgents, codebaseHandles, injector);
		injector.markSource(agent, source);
		injector.prefetchBoot(agent);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		disposed.add(agent);
		codebaseBoundAgents.delete(agent);
		handles.get(agent)?.dispose();
		handles.delete(agent);
		const list = codebaseHandles.get(agent);
		if (list !== void 0) {
			for (const conn of list) conn.dispose().catch(() => {});
			codebaseHandles.delete(agent);
		}
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
		for (const list of codebaseHandles.values()) for (const conn of list) conn.dispose().catch(() => {});
		codebaseHandles.clear();
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
	registerCodebaseRoutes(ctx, codebasesPath, resolved.secretsPath, instancesPath, resolved);
	registerSessionRoutes(ctx, new SessionVectrService({
		instanceResolver: new InstanceResolver(instancesPath, ctx),
		apiClient: new VectrApiClient(),
		codebaseService: new CodebaseService(codebasesPath),
		cliRunner: new VectrCliRunner({
			cliPath: resolved.cliPath || void 0,
			timeoutMs: resolved.cliTimeoutMs
		}),
		statusTimeoutMs: resolved.daemonHttpTimeoutMs,
		recallTimeoutMs: resolved.recallTimeoutMs,
		upgradeTimeoutMs: resolved.upgradeTimeoutMs
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
* Start the vectr daemon for every known workspace — registry entries plus
* `deps.discover()` entries that have no registry record — strictly one at a
* time (deterministic order: registry by port ascending then workspace path,
* then discovered-only by path ascending — `instances.json` is keyed by sha256
* hash, so its own key order carries no meaning). Sequential by construction:
* concurrent `vectr start` runs race on free-port discovery and on the
* lock-guarded `instances.json` write.
*
* A workspace whose daemon already answers the probe is reported
* `already-running` and is NOT spawned again (a second daemon would fight the
* first over the same registry port). A spawn is followed by exactly ONE
* bounded re-probe of the (possibly rewritten) registry record; an endpoint
* that never answers is reported `failed`, never `started`. A discovered-only
* workspace whose directory is gone is `failed` (`no such workspace
* directory:`), never skipped — a known workspace must not read as "nothing to
* do".
*
* A per-workspace failure is recorded in `results[].error`, counted in `failed`,
* and forces `ok:false` — the sweep never reports success over a failed spawn.
* A throwing `deps.discover()` is the one exception: it degrades to an empty
* discovery list (reported through `deps.warn`) and the registry sweep carries
* on.
*
* @param deps - registry/probe/spawn/discovery seams (see {@link StartAllDeps}).
* @param body - parsed JSON request body; `{ memoryOnly?: boolean }` is honored.
* @returns the aggregated {@link StartAllResponse}.
*/
async function startAllDaemons(deps, body) {
	const requested = body?.memoryOnly;
	const forcedMemoryOnly = typeof requested === "boolean" ? requested : void 0;
	let discovered = [];
	try {
		discovered = deps.discover();
	} catch (error) {
		deps.warn?.(`vectr-client: workspace discovery failed: ${String(error)}`);
	}
	const raw = Object.values(deps.readInstances() ?? {});
	const valid = raw.filter(isValidInstanceEntry);
	const sorted = valid.sort((a, b) => a.port - b.port || a.workspace.localeCompare(b.workspace));
	const results = [];
	for (const entry of sorted) {
		const entryMemoryOnly = entry.mode === "memory_only" || entry.mode === "memory-only";
		const memoryOnly = forcedMemoryOnly ?? entryMemoryOnly;
		const extraRoots = entry.extra_roots;
		try {
			if ((await deps.probe(entry)).alive) {
				results.push({
					workspace: entry.workspace,
					port: entry.port,
					status: "already-running"
				});
				continue;
			}
			const started = await deps.start({
				workspace: entry.workspace,
				memoryOnly,
				...extraRoots !== void 0 && extraRoots.length > 0 ? { extraRoots } : {}
			});
			if (!started.ok) {
				results.push({
					workspace: entry.workspace,
					port: null,
					status: "failed",
					error: started.error ?? `vectr start failed: ${started.stderr ?? "no diagnostic"}`
				});
				continue;
			}
			const refreshed = resolveInstanceExact(deps.readInstances() ?? {}, entry.workspace) ?? entry;
			const after = await deps.probe(refreshed);
			results.push(after.alive ? {
				workspace: entry.workspace,
				port: refreshed.port,
				status: "started"
			} : {
				workspace: entry.workspace,
				port: refreshed.port ?? null,
				status: "failed",
				error: `daemon did not answer the post-start probe (${after.reason ?? "no reason reported"})`
			});
		} catch (error) {
			results.push({
				workspace: entry.workspace,
				port: null,
				status: "failed",
				error: String(error)
			});
		}
	}
	for (const entry of raw.filter((e) => !isValidInstanceEntry(e))) results.push({
		workspace: typeof entry.workspace === "string" ? String(entry.workspace) : "(invalid registry entry)",
		port: null,
		status: "failed",
		error: "invalid registry entry: missing a non-empty workspace and a valid port"
	});
	const known = new Set(valid.map((entry) => normalizeWorkspacePath(entry.workspace)));
	const extras = discovered.filter((root) => typeof root?.workspace === "string" && root.workspace.trim() !== "").map((root) => normalizeWorkspacePath(root.workspace)).filter((workspace) => {
		if (known.has(workspace)) return false;
		known.add(workspace);
		return true;
	}).sort((a, b) => a.localeCompare(b));
	for (const workspace of extras) {
		const memoryOnly = forcedMemoryOnly ?? false;
		try {
			const stat = statSync(workspace, { throwIfNoEntry: false });
			if (stat === void 0 || !stat.isDirectory()) {
				results.push({
					workspace,
					port: null,
					status: "failed",
					error: `no such workspace directory: ${workspace}`
				});
				continue;
			}
		} catch (error) {
			results.push({
				workspace,
				port: null,
				status: "failed",
				error: `no such workspace directory: ${workspace} (${String(error)})`
			});
			continue;
		}
		try {
			const started = await deps.start({
				workspace,
				memoryOnly
			});
			if (!started.ok) {
				results.push({
					workspace,
					port: null,
					status: "failed",
					error: started.error ?? `vectr start failed: ${started.stderr ?? "no diagnostic"}`
				});
				continue;
			}
			const refreshed = resolveInstanceExact(deps.readInstances() ?? {}, workspace);
			if (refreshed === void 0) {
				results.push({
					workspace,
					port: null,
					status: "failed",
					error: "daemon started but no registry entry was recorded for the workspace"
				});
				continue;
			}
			const after = await deps.probe(refreshed);
			results.push(after.alive ? {
				workspace,
				port: refreshed.port,
				status: "started"
			} : {
				workspace,
				port: refreshed.port,
				status: "failed",
				error: `daemon did not answer the post-start probe (${after.reason ?? "no reason reported"})`
			});
		} catch (error) {
			results.push({
				workspace,
				port: null,
				status: "failed",
				error: String(error)
			});
		}
	}
	const started = results.filter((r) => r.status === "started").length;
	const alreadyRunning = results.filter((r) => r.status === "already-running").length;
	const failed = results.filter((r) => r.status === "failed").length;
	return {
		ok: failed === 0,
		started,
		alreadyRunning,
		failed,
		results
	};
}
/**
* Start the vectr daemon of a single workspace (`POST /api/vectr/daemons/start`
* body `{ workspace }`).
*
* Shares the spawn/probe path with {@link startAllDaemons} — same injected
* {@link StartAllDeps}, no second spawner — and returns HTTP-shaped outcomes so
* the route stays a thin shell:
*
* - `400` — no usable `workspace` in the body, a relative path, or a directory
*   that does not exist (an unknown workspace is a client error).
* - `409` — a registry record for the workspace is already alive: no spawn, no
*   port churn, the body carries the live port.
* - `200` — spawned and re-probed; `{ ok: true, port, pid? }` from the refreshed
*   registry record (a successful `vectr start` may pick a different free port).
* - `500` — the spawn failed, no registry entry was recorded, or the daemon never
*   answered the post-start probe.
*/
async function startDaemonForWorkspace(deps, body) {
	const requested = body?.workspace;
	if (typeof requested !== "string" || requested.trim() === "") return {
		status: 400,
		body: {
			ok: false,
			error: "workspace must be a non-empty absolute path"
		}
	};
	const workspace = requested.trim();
	if (!isAbsolute(workspace)) return {
		status: 400,
		body: {
			ok: false,
			error: "workspace must be a non-empty absolute path"
		}
	};
	try {
		if (!statSync(workspace).isDirectory()) return {
			status: 400,
			body: {
				ok: false,
				error: `no such workspace directory: ${workspace}`
			}
		};
	} catch (error) {
		return {
			status: 400,
			body: {
				ok: false,
				error: `no such workspace directory: ${workspace} (${String(error)})`
			}
		};
	}
	try {
		const existing = resolveInstanceExact(deps.readInstances() ?? {}, workspace);
		if (existing !== void 0 && (await deps.probe(existing)).alive) return {
			status: 409,
			body: {
				ok: false,
				error: `daemon already running for ${workspace}`,
				port: existing.port
			}
		};
		const memoryOnly = existing?.mode === "memory_only" || existing?.mode === "memory-only";
		const started = await deps.start({
			workspace,
			...memoryOnly ? { memoryOnly: true } : {}
		});
		if (!started.ok) return {
			status: 500,
			body: {
				ok: false,
				error: started.error ?? `vectr start failed: ${started.stderr ?? "no diagnostic"}`
			}
		};
		const refreshed = resolveInstanceExact(deps.readInstances() ?? {}, workspace);
		if (refreshed === void 0) return {
			status: 500,
			body: {
				ok: false,
				error: "daemon started but no registry entry was recorded for the workspace"
			}
		};
		const after = await deps.probe(refreshed);
		if (!after.alive) return {
			status: 500,
			body: {
				ok: false,
				error: `daemon did not answer the post-start probe (${after.reason ?? "no reason reported"})`
			}
		};
		return {
			status: 200,
			body: {
				ok: true,
				port: refreshed.port,
				...refreshed.pid !== void 0 ? { pid: refreshed.pid } : {}
			}
		};
	} catch (error) {
		return {
			status: 500,
			body: {
				ok: false,
				error: String(error)
			}
		};
	}
}
/**
* Production workspace discovery: DSH's own registry file, read best-effort.
* One construction for both consumers (management table + start-all sweep) so
* the two can never disagree about which workspaces exist.
*/
function defaultWorkspaceDiscovery(ctx) {
	return () => discoverWorkspaceRoots(DEFAULT_DSH_WORKSPACE_FILE, (error) => ctx.logger.warn(`vectr-client: workspace discovery failed: ${String(error)}`));
}
/**
* Build the production {@link StartAllDeps}: the shared registry reader, the
* shared probe layer with the plugin's configured budgets, and the same
* {@link VectrCliRunner} the session service uses (one CLI path, one timeout).
*
* @param ctx - plugin context (registry read diagnostics).
* @param instancesPath - absolute path of `instances.json`.
* @param config - resolved plugin configuration (timeouts + CLI path).
* @returns the assembled {@link StartAllDeps}.
*/
function buildStartAllDeps(ctx, instancesPath, config) {
	const cliRunner = new VectrCliRunner({
		cliPath: config.cliPath || void 0,
		timeoutMs: config.cliTimeoutMs
	});
	return {
		readInstances: () => readInstancesFile(ctx, instancesPath),
		probe: (entry) => diagnoseDaemon(entry, {
			httpProbe: fetchStatus,
			httpTimeoutMs: config.daemonHttpTimeoutMs ?? 5e3,
			tcpTimeoutMs: config.daemonTcpTimeoutMs ?? 300
		}),
		start: (options) => cliRunner.start(options),
		discover: defaultWorkspaceDiscovery(ctx),
		warn: (message) => ctx.logger.warn(message)
	};
}
function registerManagementRoutes(ctx, instancesPath, config, startAllDeps, discover = defaultWorkspaceDiscovery(ctx)) {
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
				sendJson$1(res, 200, await scanWorkspaces(ctx, instancesPath, {
					statusTimeoutMs: config.daemonHttpTimeoutMs,
					discover,
					codebasesPath: config.codebasesPath
				}));
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
	const deps = startAllDeps ?? {
		...buildStartAllDeps(ctx, instancesPath, config),
		discover
	};
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/api/vectr/daemons/start-all",
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson$1(res, 405, { error: "method not allowed" });
				return;
			}
			let body;
			try {
				body = await readJsonBody$1(req);
			} catch (error) {
				sendJson$1(res, 400, {
					ok: false,
					error: `Invalid JSON body: ${String(error)}`
				});
				return;
			}
			try {
				sendJson$1(res, 200, await withLocalDaemonLock(() => startAllDaemons(deps, body)));
			} catch (error) {
				sendJson$1(res, 500, {
					ok: false,
					error: String(error)
				});
			}
		}
	}), "vectr-client: POST /api/vectr/daemons/start-all");
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/api/vectr/daemons/start",
		handler: async (req, res) => {
			if (req.method !== "POST") {
				sendJson$1(res, 405, { error: "method not allowed" });
				return;
			}
			let body;
			try {
				body = await readJsonBody$1(req);
			} catch (error) {
				sendJson$1(res, 400, {
					ok: false,
					error: `Invalid JSON body: ${String(error)}`
				});
				return;
			}
			try {
				const result = await withLocalDaemonLock(() => startDaemonForWorkspace(deps, body));
				sendJson$1(res, result.status, result.body);
			} catch (error) {
				sendJson$1(res, 500, {
					ok: false,
					error: String(error)
				});
			}
		}
	}), "vectr-client: POST /api/vectr/daemons/start");
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
					"ssh",
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
			ctx.logger?.warn?.(message);
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
* @param instancesPath - instances JSON file path.
* @param config - optional configuration override (e.g. daemonHttpTimeoutMs).
*/
function registerCodebaseRoutes(ctx, codebasesPath, secretsPath, instancesPath = DEFAULT_INSTANCES_FILE, config) {
	const webServer = ctx.get("webServer");
	if (webServer === void 0) {
		ctx.logger.warn("vectr-client: webServer service unavailable; skipping /api/vectr/codebases* routes");
		return;
	}
	const deps = buildCodebaseDeps(ctx, secretsPath);
	const httpTimeoutMs = config?.daemonHttpTimeoutMs ?? 5e3;
	ctx.effect(() => webServer.register({
		kind: "exact",
		path: "/api/vectr/codebases",
		handler: async (req, res) => {
			if (req.method === "GET") {
				try {
					const wsFilter = new URL(req.url ?? "", "http://localhost").searchParams.get("workspace") ?? void 0;
					let list = loadCodebases(codebasesPath).map(stripSecret);
					if (wsFilter !== void 0) list = list.filter((e) => e.workspace === wsFilter);
					let instances;
					try {
						instances = readInstancesFile(ctx, instancesPath);
					} catch {}
					if (wsFilter !== void 0) {
						const inst = instances ? resolveInstance(instances, wsFilter) : void 0;
						if (!(inst ? inst.mode === "memory_only" || inst.mode === "memory-only" : false) && list.length > 0 && !list.some((e) => e.isPrimary || isSystemPrimarySlug(e.slug))) {
							const isListening = inst?.port ? await isPortListening(inst.host ?? "127.0.0.1", inst.port, 300) : false;
							list = [{
								id: `primary:${wsFilter}`,
								slug: "primary",
								type: "local",
								path: wsFilter,
								workspace: wsFilter,
								serverName: `primary_${wsFilter}`,
								status: isListening ? "up" : "down",
								isPrimary: true
							}, ...list];
						}
					} else {
						const workspacesWithEntries = /* @__PURE__ */ new Set();
						for (const item of list) if (item.workspace && item.workspace !== "__unassigned__") workspacesWithEntries.add(item.workspace);
						const primaries = [];
						for (const ws of workspacesWithEntries) {
							const inst = instances ? resolveInstance(instances, ws) : void 0;
							const isMemoryOnly = inst ? inst.mode === "memory_only" || inst.mode === "memory-only" : false;
							const alreadyHasPrimary = list.some((e) => e.workspace === ws && (e.isPrimary || isSystemPrimarySlug(e.slug)));
							if (!isMemoryOnly && !alreadyHasPrimary) {
								const wsKey = createHash("sha256").update(ws).digest("hex").slice(0, 12);
								const slug = workspacesWithEntries.size > 1 ? `primary-${wsKey}` : "primary";
								const isListening = inst?.port ? await isPortListening(inst.host ?? "127.0.0.1", inst.port, 300) : false;
								primaries.push({
									id: `primary:${ws}`,
									slug,
									type: "local",
									path: ws,
									workspace: ws,
									serverName: `primary_${wsKey}`,
									status: isListening ? "up" : "down",
									isPrimary: true
								});
							}
						}
						if (primaries.length > 0) list = [...primaries, ...list];
					}
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
			const normSlug = slug.trim().toLowerCase();
			const list = () => loadCodebases(codebasesPath);
			const find = () => list().find((e) => e.slug.trim().toLowerCase() === normSlug);
			if (req.method === "DELETE") {
				if (isSystemPrimarySlug(normSlug)) {
					sendJson$1(res, 403, {
						ok: false,
						error: "Cannot delete primary codebase of the workspace"
					});
					return;
				}
				const entry = find();
				if (entry === void 0) {
					sendJson$1(res, 404, {
						ok: false,
						error: "no such codebase"
					});
					return;
				}
				const isPrimaryByPath = Boolean(entry.workspace && entry.path && resolve(entry.path) === resolve(entry.workspace));
				const isPrimaryBySlug = typeof entry.slug === "string" && isSystemPrimarySlug(entry.slug);
				if (entry.isPrimary || isPrimaryBySlug || isPrimaryByPath) {
					sendJson$1(res, 403, {
						ok: false,
						error: "Cannot delete primary codebase of the workspace"
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
				if (isSystemPrimarySlug(normSlug)) {
					let instances;
					try {
						instances = readInstancesFile(ctx, instancesPath);
					} catch {}
					if (!instances) {
						sendJson$1(res, 503, {
							ok: false,
							error: "Instance registry unavailable"
						});
						return;
					}
					let targetWs = url.searchParams.get("workspace") ?? void 0;
					if (!targetWs && isSystemPrimarySlug(normSlug) && normSlug !== "primary") {
						const key = normSlug.replace(/^primary-/i, "");
						for (const [k, inst] of Object.entries(instances)) if (k.startsWith(key) || key.startsWith(k) || inst?.workspace && createHash("sha256").update(inst.workspace).digest("hex").startsWith(key)) {
							targetWs = inst?.workspace;
							break;
						}
					}
					if (!targetWs) {
						const codebases = loadCodebases(codebasesPath);
						const wsSet = new Set(codebases.map((c) => c.workspace).filter((w) => w && w !== "__unassigned__"));
						if (wsSet.size === 1) targetWs = [...wsSet][0];
						else {
							const allInstWorkspaces = Object.values(instances).map((i) => i.workspace).filter(Boolean);
							if (allInstWorkspaces.length === 1) targetWs = allInstWorkspaces[0];
						}
					}
					if (!targetWs) {
						sendJson$1(res, 400, {
							ok: false,
							error: "Ambiguous primary codebase: please specify ?workspace="
						});
						return;
					}
					const inst = resolveInstance(instances, targetWs);
					if (!inst || !inst.port) {
						sendJson$1(res, 503, {
							ok: false,
							error: `No Vectr daemon registered for workspace ${targetWs}`
						});
						return;
					}
					const host = inst.host || "127.0.0.1";
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), httpTimeoutMs);
					try {
						const probeRes = await fetch(`http://${host}:${inst.port}/v1/status`, { signal: controller.signal });
						if (!probeRes.ok) {
							sendJson$1(res, 503, {
								ok: false,
								error: `Primary daemon returned status ${probeRes.status}`
							});
							return;
						}
						sendJson$1(res, 200, {
							ok: true,
							status: await probeRes.json()
						});
					} catch (err) {
						sendJson$1(res, 503, {
							ok: false,
							error: `Primary daemon probe failed: ${String(err)}`
						});
					} finally {
						clearTimeout(timer);
					}
					return;
				}
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
			if (req.method === "POST" && (url.pathname.endsWith("/start") || url.pathname.endsWith("/start-daemon"))) {
				if (isSystemPrimarySlug(normSlug)) {
					const targetWs = url.searchParams.get("workspace");
					if (!targetWs) {
						sendJson$1(res, 400, {
							ok: false,
							error: "Query parameter \"workspace\" required to start primary codebase daemon"
						});
						return;
					}
					const startRes = await deps.spawnRunner("vectr", [
						"start",
						"--path",
						targetWs,
						"--json"
					]).promise;
					if (startRes.signal !== null) {
						sendJson$1(res, 500, {
							ok: false,
							error: `vectr start for primary codebase was killed (${startRes.signal})`
						});
						return;
					}
					if (startRes.code !== 0) {
						sendJson$1(res, 500, {
							ok: false,
							error: `vectr start failed for primary codebase: ${startRes.stderr}`
						});
						return;
					}
					let parsed = {};
					try {
						parsed = JSON.parse(startRes.stdout);
					} catch (e) {
						sendJson$1(res, 500, {
							ok: false,
							error: `vectr start returned non-JSON: ${String(e)}`
						});
						return;
					}
					sendJson$1(res, 200, {
						ok: true,
						slug: "primary",
						localPort: parsed.port ?? 0
					});
					return;
				}
				const entry = find();
				if (entry === void 0) {
					sendJson$1(res, 404, {
						ok: false,
						error: "no such codebase"
					});
					return;
				}
				const result = await startCodebaseDaemon(deps, codebasesPath, entry);
				sendJson$1(res, result.ok ? 200 : 500, result);
				return;
			}
			if (req.method === "PATCH") {
				if (isSystemPrimarySlug(normSlug)) {
					sendJson$1(res, 403, {
						ok: false,
						error: "Cannot reassign primary codebase of the workspace"
					});
					return;
				}
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
export { CodebaseService, Config, DEFAULT_CLI_NAME, DEFAULT_CLI_TIMEOUT_MS, DEFAULT_CODEBASES_FILE, DEFAULT_DAEMON_HTTP_TIMEOUT_MS, DEFAULT_DAEMON_TCP_TIMEOUT_MS, DEFAULT_HTTP_TIMEOUT_MS, DEFAULT_INSTANCES_FILE, DEFAULT_RECALL_TIMEOUT_MS, DEFAULT_SECRETS_FILE, DEFAULT_SERVER_NAME, DEFAULT_TOOL_CALL_TIMEOUT_MS, DEFAULT_TUNNEL_PROBE_MS, DEFAULT_UPGRADE_TIMEOUT_MS, InstanceResolver, PRIMARY_RESERVED_PREFIX_PATTERN, SIGKILL_ESCALATION_DELAY_MS, SLUG_PATTERN, STARTUP_HEAL_COOLDOWN_MS, SYSTEM_PRIMARY_SLUG_PATTERN, SessionVectrService, VECTR_GREP_SECTION_NAME, VECTR_GREP_SECTION_ORDER, VECTR_GREP_SECTION_TEXT, VECTR_GUIDANCE_SECTION_NAME, VECTR_GUIDANCE_SECTION_ORDER, VECTR_GUIDANCE_SECTION_TEXT, VECTR_MEMORY_SECTION_NAME, VECTR_MEMORY_SECTION_ORDER, VECTR_MEMORY_SECTION_TEXT, VectrApiClient, VectrCliRunner, WORKSPACE_KEY_LENGTH, _resetLocalDaemonLockForTests, _resetStartupHealCooldownForTests, apply, buildCodebaseDeps, buildStartAllDeps, canReindex, daemonAliveProbe, ensureTunnelUp, formatMode, getVectrGrepText, getVectrGuidanceText, getVectrMemoryText, hasActiveSession, hasCodebase, hasIndexedCodebase, healLocalCodebase, inject, install, installCodebaseConnections, isDaemonAlive, isMemoryOnly, isPortListening, isReservedPrimarySlug, isSearchOnly, isSessionActivated, isSystemPrimarySlug, isValidInstanceEntry, isWorkspaceMatch, name, normalizeMode, normalizePath, probeTunnel, readInstancesFile, readJsonBody, registerCodebaseRoutes, registerManagementRoutes, registerSessionRoutes, resolveCliExecutable, resolveInstance, resolveInstanceExact, resolveSessionSlotVisibility, resolveUnifiedStatus, sendJson, slugFromPathname, startAllDaemons, startCodebaseDaemon, startDaemonForWorkspace, startLocalDaemon, startRemoteDaemon, startupHeal, startupHealEligible, validateSlug, validateWorkspace, withLocalDaemonLock };

//# sourceMappingURL=index.js.map