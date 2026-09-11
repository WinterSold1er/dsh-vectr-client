window.__ModuleLoader__.load({ id: "dsh-vectr-client", factory: (require) => {
var exports = { exports: {} }.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/client/buttons.tsx
/** One global stylesheet carrying every vectr control class. Injected once. */
const VECTR_CSS = `
.vectr-btn { font: inherit; cursor: pointer; transition: background 120ms, border-color 120ms; border: 1px solid transparent; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.vectr-btn:disabled { opacity: .4; cursor: default; }
.vectr-btn:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.vectr-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.vectr-btn-dense { height: 28px; padding: 0 10px; border-radius: 14px; font-size: 12px; }
.vectr-btn-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.vectr-btn-secondary { border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }
.vectr-btn-danger { color: var(--dsw-alias-state-error-primary); }
.vectr-label { display: block; margin-bottom: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; }
.vectr-input, .vectr-select, .vectr-textarea { padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; box-sizing: border-box; font-size: 13px; }
.vectr-input, .vectr-select { height: 32px; }
.vectr-input:focus, .vectr-select:focus, .vectr-textarea:focus { border-color: var(--dsw-alias-brand-primary); outline: none; box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }
.vectr-input::placeholder, .vectr-textarea::placeholder { color: var(--dsw-alias-label-dimmed); }

.vectr-modal-backdrop {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: var(--dsw-alias-bg-overlay, rgba(0, 0, 0, 0.45));
  backdrop-filter: blur(2px);
  z-index: 10000;
  display: flex; align-items: center; justify-content: center;
  animation: vectr-fade-in 150ms ease-out;
}
.vectr-modal-card {
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  box-shadow: var(--dsw-alias-shadow-modal, 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04));
  width: 90vw; max-width: 840px; max-height: 88vh;
  display: flex; flex-direction: column; overflow: hidden;
  color: var(--dsw-alias-label-primary);
  animation: vectr-scale-up 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
.vectr-header-capsule {
  display: inline-flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 8px; border-radius: 13px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
  font-size: 11px; font-weight: 500; cursor: pointer;
  transition: all 140ms ease;
}
.vectr-header-capsule:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-brand-primary);
}
.vectr-indicator-dot {
  width: 7px; height: 7px; border-radius: 50%;
  display: inline-block; flex-shrink: 0;
}
.vectr-dot-live { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 4px var(--dsw-alias-state-success-primary); }
.vectr-dot-offline { background: var(--dsw-alias-label-tertiary); }
.vectr-dot-error { background: var(--dsw-alias-state-error-primary); }

.vectr-metric-card {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; padding: 10px 14px;
  display: flex; flex-direction: column; gap: 4px;
}
.vectr-tab-btn {
  padding: 8px 16px; border: none; background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px; font-weight: 500; cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 120ms;
}
.vectr-tab-btn.active {
  color: var(--dsw-alias-brand-primary);
  border-bottom-color: var(--dsw-alias-brand-primary);
  font-weight: 600;
}
.vectr-tab-btn:hover:not(.active) {
  color: var(--dsw-alias-label-primary);
}
.vectr-note-card {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; padding: 12px; margin-bottom: 8px;
  font-size: 13px; line-height: 1.5;
}

@keyframes vectr-fade-in {
  from { opacity: 0; } to { opacity: 1; }
}
@keyframes vectr-scale-up {
  from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); }
}
`;
/** Render the shared stylesheet once. Place inside the Vectr settings shell or topbar capsule. */
function VectrStyles() {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: VECTR_CSS });
}
/** className sets for the button variants used across the panels. */
const BTN = {
	/** Inline row action (re-index / test): dense capsule, no fill. */
	action: "vectr-btn vectr-btn-dense",
	/** Secondary action (refresh): bordered, transparent. */
	secondary: "vectr-btn vectr-btn-dense vectr-btn-secondary",
	/** Destructive action (delete): error-colored text. */
	danger: "vectr-btn vectr-btn-dense vectr-btn-danger",
	/** Primary action (create): filled. */
	primary: "vectr-btn vectr-btn-dense vectr-btn-primary"
};
//#endregion
//#region src/client/vectr-settings.tsx
/**
* Top-level **Settings → Vectr** section shell.
*
* 阶段2: the codebase manager is merged INTO the workspace console, so there is
* no longer a separate Codebases tab. This shell is now a thin single-panel host
* that injects the shared stylesheet and renders {@link WorkspaceConsole} (which
* owns both the workspace table and the per-workspace codebase sub-tables).
*
* @module dsh-vectr-client/client/vectr-settings
*/
/** Tab-bar + active-panel host for the Vectr settings section. */
function VectrSettings() {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VectrStyles, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspaceConsole, {})] });
}
//#endregion
//#region src/client/tableStyles.ts
/** Outer wrapper that enables horizontal scrolling when the table overflows. */
const scrollWrap = { overflowX: "auto" };
/** Collapsed-border + full-width base shared by every vectr table. */
const tableBase = {
	borderCollapse: "collapse",
	width: "100%"
};
/** Workspaces table: 13 columns, needs a wide minWidth or columns cram (<53px). */
const tableStyleWorkspaces = {
	...tableBase,
	minWidth: 1080
};
({ ...tableBase });
/** Header cell style: padding, bottom border, nowrap so headers stay readable. */
const thStyle = {
	padding: "6px 8px",
	borderBottom: "1px solid var(--dsw-alias-border-l2)",
	whiteSpace: "nowrap",
	textAlign: "left"
};
/** Body cell style: padding + bottom border, top-aligned for multi-line cells. */
const tdStyle = {
	padding: "6px 8px",
	borderBottom: "1px solid var(--dsw-alias-border-l2)",
	verticalAlign: "top"
};
/** Ellipsis wrapper style for long text cells: shows a tooltip (title) on hover
* while truncating the visible text so the column stays narrow. */
const ellipsisStyle = {
	display: "block",
	maxWidth: 220,
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap"
};
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
* Test whether a given sessionId represents an active, valid session.
* Absent values, undefined, null, empty strings, whitespace-only strings,
* string literals 'null'/'undefined', and non-finite numbers (NaN, Infinity)
* represent an inactive, blank, or invalid session.
*
* (Layer 1: Domain Core - Single Source of Truth for Session Activation)
*/
function hasActiveSession(sessionId) {
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
//#region src/client/dialogCoordinator.ts
var DialogCoordinator = class {
	listeners = /* @__PURE__ */ new Set();
	state = { isOpen: false };
	subscribe(listener) {
		this.listeners.add(listener);
		listener(this.state);
		return () => {
			this.listeners.delete(listener);
		};
	}
	open(workspace) {
		this.state = {
			isOpen: true,
			workspace
		};
		this.notify();
	}
	close() {
		this.state = {
			isOpen: false,
			workspace: void 0
		};
		this.notify();
	}
	getState() {
		return this.state;
	}
	notify() {
		for (const listener of this.listeners) try {
			listener(this.state);
		} catch {}
	}
};
const dialogCoordinator = new DialogCoordinator();
//#endregion
//#region src/client/SessionHeaderAction.tsx
/**
* Session Header Utility Action for Vectr.
*
* Mounted into the host slot `conversation.session.header.utilities`.
* Dynamically tracks the current active session's working directory (`session.cwd`)
* and displays live status, mode, port, and quick metrics.
* Acts as a pure trigger for `dialogCoordinator.open(workspace)`.
*
* (Layer 4: Presentation)
*
* @module dsh-vectr-client/client/SessionHeaderAction
*/
function ActiveSessionHeaderAction(props) {
	const { sessionId, useSessions } = props;
	const sessionCwd = useSessions ? useSessions((state) => sessionId ? state?.byId?.[String(sessionId)]?.cwd : void 0) : void 0;
	const [state, setState] = (0, react.useState)(null);
	const fetchStatus = async (cwd, signal) => {
		if (!cwd) return;
		try {
			const res = await fetch(`/api/vectr/session-status?workspace=${encodeURIComponent(cwd)}`, signal ? { signal } : void 0);
			if (res.ok) {
				const data = await res.json();
				setState(data);
			} else setState(null);
		} catch (err) {
			if (err?.name === "AbortError" || signal?.aborted) return;
			setState(null);
		}
	};
	(0, react.useEffect)(() => {
		if (!sessionCwd || typeof sessionCwd !== "string" || sessionCwd.trim().length === 0) {
			setState(null);
			return;
		}
		const controller = new AbortController();
		fetchStatus(sessionCwd.trim(), controller.signal);
		return () => {
			controller.abort();
		};
	}, [sessionCwd]);
	const unifiedStatus = resolveUnifiedStatus({
		live: state?.live,
		mode: state?.mode,
		status: state?.status,
		reason: state?.reason,
		error: state?.error
	});
	let badgeText = "Vectr";
	if (unifiedStatus.kind === "ready") badgeText = state?.port ? `Vectr [${state.port}]` : "Vectr";
	else if (unifiedStatus.kind === "memory_only") badgeText = state?.port ? `Vectr [mem:${state.port}]` : "Vectr [mem]";
	else if (unifiedStatus.kind === "indexing") badgeText = state?.port ? `Vectr [idx:${state.port}]` : "Vectr [indexing]";
	else if (unifiedStatus.kind === "initializing") badgeText = state?.port ? `Vectr [init:${state.port}]` : "Vectr [init]";
	else if (unifiedStatus.kind === "search_only") badgeText = state?.port ? `Vectr [search:${state.port}]` : "Vectr [search]";
	else if (unifiedStatus.label === "Error") badgeText = "Vectr [err]";
	else badgeText = "Vectr [off]";
	const dotClass = unifiedStatus.kind === "ready" || unifiedStatus.kind === "memory_only" || unifiedStatus.kind === "search_only" ? "vectr-dot-live" : unifiedStatus.isBusy ? "vectr-dot-live" : unifiedStatus.label === "Error" ? "vectr-dot-error" : "vectr-dot-offline";
	const handleOpen = () => {
		if (typeof sessionCwd === "string" && sessionCwd.trim().length > 0) dialogCoordinator.open(sessionCwd.trim());
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VectrStyles, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
		type: "button",
		className: "vectr-header-capsule",
		onClick: handleOpen,
		title: `Vectr Status: ${unifiedStatus.label}${unifiedStatus.description ? ` (${unifiedStatus.description})` : ""}${sessionCwd ? `\nWorkspace: ${sessionCwd}` : ""}`,
		"aria-label": "Vectr status and management",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `vectr-indicator-dot ${dotClass}` }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: badgeText })]
	})] });
}
function SessionHeaderAction(props) {
	if (!hasActiveSession(props.sessionId)) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActiveSessionHeaderAction, { ...props });
}
//#endregion
//#region src/client/VectrNavIcon.tsx
/**
* Dedicated Vectr Vector / Lightning Icon for navigation and toolbars.
*/
function VectrNavIcon(props) {
	const size = props.size ?? 16;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
		width: size,
		height: size,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: "2",
		strokeLinecap: "round",
		strokeLinejoin: "round",
		className: props.className,
		style: {
			display: "inline-block",
			verticalAlign: "middle",
			flexShrink: 0,
			...props.style
		},
		"aria-hidden": "true",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("polygon", { points: "13 2 3 14 12 14 11 22 21 10 12 10 13 2" })
	});
}
//#endregion
//#region src/client/ConversationInputRightAction.tsx
function ConversationInputRightAction(props) {
	const { sessionId } = props;
	if (hasActiveSession(sessionId)) return null;
	const effectiveWorkspace = typeof props.workspace === "string" && props.workspace ? props.workspace : ".";
	const handleOpen = () => {
		dialogCoordinator.open(effectiveWorkspace);
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VectrStyles, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
		type: "button",
		className: "vectr-btn vectr-btn-dense",
		style: {
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			height: 28,
			padding: "0 8px",
			borderRadius: 6,
			fontSize: 12,
			display: "inline-flex",
			alignItems: "center",
			gap: 5
		},
		onClick: handleOpen,
		title: "Vectr Search & Memory Console",
		"aria-label": "Vectr status and management",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VectrNavIcon, { size: 14 }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "Vectr" })]
	})] });
}
//#endregion
//#region src/client/CodebaseModal.tsx
/**
* Add Codebase dialog with regex validation, credential isolation, and workspace pre-binding.
*
* (Layer 4: Presentation)
*
* @module dsh-vectr-client/client/CodebaseModal
*/
const SLUG_REGEX = /^[A-Za-z0-9_-]{1,32}$/;
function CodebaseModal({ workspace, isOpen, onClose, onSuccess }) {
	const [type, setType] = (0, react.useState)("local");
	const [slug, setSlug] = (0, react.useState)("");
	const [path, setPath] = (0, react.useState)("");
	const [host, setHost] = (0, react.useState)("");
	const [remotePath, setRemotePath] = (0, react.useState)("");
	const [remotePort, setRemotePort] = (0, react.useState)("");
	const [authType, setAuthType] = (0, react.useState)("key");
	const [password, setPassword] = (0, react.useState)("");
	const [busy, setBusy] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)(null);
	if (!isOpen) return null;
	const isSlugValid = SLUG_REGEX.test(slug);
	const slugError = slug.length > 0 && !isSlugValid ? "Slug 仅支持 1-32 位字母、数字、下划线及短横线" : null;
	const handleSubmit = async (e) => {
		e.preventDefault();
		if (!isSlugValid) {
			setError("Slug 格式不符合要求");
			return;
		}
		setBusy(true);
		setError(null);
		const payload = {
			type,
			slug,
			workspace
		};
		if (type === "local") {
			if (!path.trim()) {
				setError("本地路径不可为空");
				setBusy(false);
				return;
			}
			payload.path = path.trim();
		} else {
			if (!host.trim() || !remotePath.trim()) {
				setError("远程主机与路径不可为空");
				setBusy(false);
				return;
			}
			payload.host = host.trim();
			payload.path = remotePath.trim();
			payload.remotePath = remotePath.trim();
			const portNum = remotePort.trim() ? parseInt(remotePort.trim(), 10) : void 0;
			if (portNum !== void 0 && !isNaN(portNum) && portNum > 0) payload.remotePort = portNum;
			payload.auth = authType;
			if (authType === "password") {
				if (!password) {
					setError("选择密码认证时必须输入密码");
					setBusy(false);
					return;
				}
				payload.password = password;
			}
		}
		try {
			const res = await fetch("/api/vectr/codebases", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			});
			const data = await res.json();
			if (!res.ok) setError(data.error ?? `创建失败 (${res.status})`);
			else {
				onSuccess(slug);
				onClose();
			}
		} catch (err) {
			setError(`网络异常: ${String(err)}`);
		} finally {
			setBusy(false);
		}
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: "vectr-modal-backdrop",
		onClick: onClose,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "vectr-modal-card",
			style: { maxWidth: 540 },
			onClick: (e) => e.stopPropagation(),
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: "16px 20px",
					borderBottom: "1px solid var(--dsw-alias-border-l2)",
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						fontWeight: 600,
						fontSize: 16
					},
					children: "添加 Codebase"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "vectr-btn",
					style: {
						fontSize: 18,
						color: "var(--dsw-alias-label-secondary)"
					},
					onClick: onClose,
					children: "✕"
				})]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
				onSubmit: handleSubmit,
				style: {
					padding: "20px",
					display: "flex",
					flexDirection: "column",
					gap: 14
				},
				children: [
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							padding: "8px 12px",
							borderRadius: 6,
							background: "var(--dsw-alias-interactive-bg-hover-danger)",
							color: "var(--dsw-alias-state-error-primary)",
							fontSize: 12
						},
						children: error
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "vectr-label",
							htmlFor: "codebase-slug",
							children: ["Slug 标识 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { color: "var(--dsw-alias-state-error-primary)" },
								children: "*"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							id: "codebase-slug",
							className: "vectr-input",
							style: { width: "100%" },
							value: slug,
							onChange: (e) => setSlug(e.target.value.trim()),
							placeholder: "e.g. backend-service, auth-api",
							required: true
						}),
						slugError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								color: "var(--dsw-alias-state-error-primary)",
								fontSize: 11,
								marginTop: 4
							},
							children: slugError
						})
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						children: "类型"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 16
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 6,
								fontSize: 13,
								cursor: "pointer"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: "cb-type",
								checked: type === "local",
								onChange: () => setType("local")
							}), "📁 本地代码库 (Local)"]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 6,
								fontSize: 13,
								cursor: "pointer"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: "cb-type",
								checked: type === "remote",
								onChange: () => setType("remote")
							}), "🌐 远程代码库 (Remote via SSH)"]
						})]
					})] }),
					type === "local" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: "vectr-label",
						htmlFor: "codebase-path",
						children: ["本地目录路径 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { color: "var(--dsw-alias-state-error-primary)" },
							children: "*"
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "codebase-path",
						className: "vectr-input",
						style: { width: "100%" },
						value: path,
						onChange: (e) => setPath(e.target.value),
						placeholder: "/path/to/local/project",
						required: true
					})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 12
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 10
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { flex: 2 },
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "vectr-label",
										htmlFor: "cb-host",
										children: ["远程主机 (Host) ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: { color: "var(--dsw-alias-state-error-primary)" },
											children: "*"
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "cb-host",
										className: "vectr-input",
										style: { width: "100%" },
										value: host,
										onChange: (e) => setHost(e.target.value.trim()),
										placeholder: "user@192.168.1.100",
										required: true
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { flex: 1 },
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "vectr-label",
										htmlFor: "cb-rport",
										children: "远程端口 (可选)"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "cb-rport",
										type: "number",
										className: "vectr-input",
										style: { width: "100%" },
										value: remotePort,
										placeholder: "留空自动解析",
										onChange: (e) => setRemotePort(e.target.value)
									})]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "vectr-label",
								htmlFor: "cb-rpath",
								children: ["远程工作区路径 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { color: "var(--dsw-alias-state-error-primary)" },
									children: "*"
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: "cb-rpath",
								className: "vectr-input",
								style: { width: "100%" },
								value: remotePath,
								onChange: (e) => setRemotePath(e.target.value.trim()),
								placeholder: "/home/user/project",
								required: true
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: "vectr-label",
									children: "认证凭据隔离"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										gap: 16,
										marginBottom: 8
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											display: "flex",
											alignItems: "center",
											gap: 6,
											fontSize: 12,
											cursor: "pointer"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "auth-type",
											checked: authType === "key",
											onChange: () => setAuthType("key")
										}), "SSH Key (免密 / 默认)"]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: {
											display: "flex",
											alignItems: "center",
											gap: 6,
											fontSize: 12,
											cursor: "pointer"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "auth-type",
											checked: authType === "password",
											onChange: () => setAuthType("password")
										}), "SSH 密码 (安全隔离存储)"]
									})]
								}),
								authType === "password" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "password",
									className: "vectr-input",
									style: { width: "100%" },
									value: password,
									onChange: (e) => setPassword(e.target.value),
									placeholder: "输入 SSH 密码（不会明文落盘到元数据）",
									required: true
								})
							] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							fontSize: 11,
							color: "var(--dsw-alias-label-tertiary)",
							paddingTop: 4
						},
						children: ["挂载归属工作区: ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: workspace })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							justifyContent: "flex-end",
							gap: 10,
							marginTop: 10,
							paddingTop: 14,
							borderTop: "1px solid var(--dsw-alias-border-l2)"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: BTN.secondary,
							onClick: onClose,
							disabled: busy,
							children: "取消"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "submit",
							className: BTN.primary,
							disabled: busy || !isSlugValid || (type === "local" ? !path.trim() : !host.trim() || !remotePath.trim()),
							children: busy ? "创建中…" : "创建 Codebase"
						})]
					})
				]
			})]
		})
	});
}
//#endregion
//#region src/client/MemoryViewer.tsx
/**
* Working Memory Viewer (Recall & Resume) for Vectr.
*
* (Layer 4: Presentation)
*
* @module dsh-vectr-client/client/MemoryViewer
*/
function MemoryViewer({ workspace, port, live }) {
	const [subTab, setSubTab] = (0, react.useState)("recall");
	const [query, setQuery] = (0, react.useState)("");
	const [kind, setKind] = (0, react.useState)("all");
	const [detail, setDetail] = (0, react.useState)("full");
	const [limit, setLimit] = (0, react.useState)(10);
	const [recallBusy, setRecallBusy] = (0, react.useState)(false);
	const [recalledText, setRecalledText] = (0, react.useState)(null);
	const [recallError, setRecallError] = (0, react.useState)(null);
	const [resumeBusy, setResumeBusy] = (0, react.useState)(false);
	const [resumeData, setResumeData] = (0, react.useState)(null);
	const [resumeError, setResumeError] = (0, react.useState)(null);
	const handleRecall = async () => {
		if (!live) return;
		setRecallBusy(true);
		setRecallError(null);
		try {
			const res = await fetch("/api/vectr/notes/recall", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					workspace,
					...port ? { port } : {},
					query: query.trim() || void 0,
					kind: kind !== "all" ? kind : void 0,
					detail,
					limit
				})
			});
			const data = await res.json();
			if (!res.ok || !data.ok) setRecallError(data.error ?? `检索失败 (${res.status})`);
			else setRecalledText(data.notes ?? "未找到相关工作记忆");
		} catch (err) {
			setRecallError(`网络异常: ${String(err)}`);
		} finally {
			setRecallBusy(false);
		}
	};
	const handleResume = async () => {
		if (!live) return;
		setResumeBusy(true);
		setResumeError(null);
		try {
			const params = new URLSearchParams();
			if (workspace) params.set("workspace", workspace);
			if (port) params.set("port", String(port));
			const res = await fetch(`/api/vectr/notes/resume?${params.toString()}`);
			const data = await res.json();
			if (!res.ok || !data.ok) setResumeError(data.error ?? `获取接续状态失败 (${res.status})`);
			else setResumeData(data.data ?? null);
		} catch (err) {
			setResumeError(`网络异常: ${String(err)}`);
		} finally {
			setResumeBusy(false);
		}
	};
	if (!live) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: {
			padding: "24px",
			textAlign: "center",
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: 13
		},
		children: "⚠️ Vectr 实例当前处于离线状态，启动后即可访问工作记忆（Recall & Resume）。"
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			display: "flex",
			flexDirection: "column",
			gap: 14
		},
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				display: "flex",
				gap: 8,
				borderBottom: "1px solid var(--dsw-alias-border-l2)",
				paddingBottom: 2
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: `vectr-tab-btn ${subTab === "recall" ? "active" : ""}`,
				onClick: () => setSubTab("recall"),
				children: "🔍 Note 记忆检索 (Recall)"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: `vectr-tab-btn ${subTab === "resume" ? "active" : ""}`,
				onClick: () => {
					setSubTab("resume");
					if (!resumeData && !resumeBusy) handleResume();
				},
				children: "⏱️ 任务接续 (Resume)"
			})]
		}), subTab === "recall" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				display: "flex",
				flexDirection: "column",
				gap: 12
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						gap: 8,
						alignItems: "center"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "vectr-input",
							style: { flex: 1 },
							value: query,
							onChange: (e) => setQuery(e.target.value),
							placeholder: "输入关键词检索 Note (如: architecture, lock, bug, schema)...",
							onKeyDown: (e) => {
								if (e.key === "Enter") handleRecall();
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "vectr-select",
							value: kind,
							onChange: (e) => setKind(e.target.value),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "all",
									children: "类型: 全部"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "directive",
									children: "directive (指令规范)"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "task",
									children: "task (当前任务)"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "gotcha",
									children: "gotcha (易踩坑点)"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "finding",
									children: "finding (发现记录)"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "decision",
									children: "decision (架构决策)"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "vectr-select",
							value: detail,
							onChange: (e) => setDetail(e.target.value),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "full",
								children: "详情: 完整内容"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "index",
								children: "详情: 单行摘要"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "vectr-select",
							value: limit,
							onChange: (e) => setLimit(parseInt(e.target.value, 10)),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: 5,
									children: "数量: 5"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: 10,
									children: "数量: 10"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: 20,
									children: "数量: 20"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: BTN.primary,
							onClick: () => void handleRecall(),
							disabled: recallBusy,
							children: recallBusy ? "检索中…" : "检索"
						})
					]
				}),
				recallError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						padding: "8px 12px",
						borderRadius: 6,
						background: "var(--dsw-alias-interactive-bg-hover-danger)",
						color: "var(--dsw-alias-state-error-primary)",
						fontSize: 12
					},
					children: recallError
				}),
				recalledText !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						maxHeight: "380px",
						overflowY: "auto",
						background: "var(--dsw-alias-bg-layer-1)",
						border: "1px solid var(--dsw-alias-border-l2)",
						borderRadius: 8,
						padding: "12px 16px",
						fontSize: 13,
						fontFamily: "monospace",
						whiteSpace: "pre-wrap",
						lineHeight: 1.5
					},
					children: recalledText
				})
			]
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				display: "flex",
				flexDirection: "column",
				gap: 12
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontSize: 13,
							color: "var(--dsw-alias-label-secondary)"
						},
						children: "Deterministic 'pick up where you left off' 状态视图 (上一次任务、快照与 Gotchas)"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: BTN.secondary,
						onClick: () => void handleResume(),
						disabled: resumeBusy,
						children: resumeBusy ? "刷新中…" : "刷新 Resume"
					})]
				}),
				resumeError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						padding: "8px 12px",
						borderRadius: 6,
						background: "var(--dsw-alias-interactive-bg-hover-danger)",
						color: "var(--dsw-alias-state-error-primary)",
						fontSize: 12
					},
					children: resumeError
				}),
				resumeData && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 10
					},
					children: [
						resumeData.last_task && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "vectr-note-card",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontWeight: 600,
									color: "var(--dsw-alias-brand-primary)",
									marginBottom: 4
								},
								children: "📌 最近任务 (Last Task)"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: { fontSize: 13 },
								children: resumeData.last_task.title || resumeData.last_task.content || JSON.stringify(resumeData.last_task)
							})]
						}),
						resumeData.gotchas && resumeData.gotchas.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "vectr-note-card",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontWeight: 600,
									color: "var(--dsw-alias-state-warn-primary)",
									marginBottom: 4
								},
								children: [
									"⚠️ 关联避坑项 (Gotchas: ",
									resumeData.gotchas.length,
									")"
								]
							}), resumeData.gotchas.map((g, idx) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									marginTop: 4,
									paddingLeft: 8,
									borderLeft: "2px solid var(--dsw-alias-state-warn-primary)"
								},
								children: [g.file_path && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", {
									style: { fontSize: 11 },
									children: [
										"[",
										g.file_path,
										"] "
									]
								}), g.content || g.title]
							}, idx))]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								maxHeight: "300px",
								overflowY: "auto",
								background: "var(--dsw-alias-bg-layer-1)",
								border: "1px solid var(--dsw-alias-border-l2)",
								borderRadius: 8,
								padding: "12px 16px",
								fontSize: 12,
								fontFamily: "monospace",
								whiteSpace: "pre-wrap"
							},
							children: resumeData.formatted
						})
					]
				})
			]
		})]
	});
}
//#endregion
//#region src/client/SessionDrawerModal.tsx
/**
* Session Drawer Modal for Vectr status, codebase management, init, and working memory.
*
* (Layer 4: Presentation)
*
* @module dsh-vectr-client/client/SessionDrawerModal
*/
function SessionDrawerModal({ workspace, state, loading, isOpen, onClose, onRefresh }) {
	const [activeTab, setActiveTab] = (0, react.useState)("codebases");
	const [showAddModal, setShowAddModal] = (0, react.useState)(false);
	const [reindexing, setReindexing] = (0, react.useState)(false);
	const [reindexMsg, setReindexMsg] = (0, react.useState)(null);
	const [initHooks, setInitHooks] = (0, react.useState)(true);
	const [initMemoryOnly, setInitMemoryOnly] = (0, react.useState)(false);
	const [initBusy, setInitBusy] = (0, react.useState)(false);
	const [initResult, setInitResult] = (0, react.useState)(null);
	const [busySlug, setBusySlug] = (0, react.useState)(null);
	const [codebaseMsg, setCodebaseMsg] = (0, react.useState)(null);
	const [confirmDeleteSlug, setConfirmDeleteSlug] = (0, react.useState)(null);
	if (!isOpen) return null;
	const live = state?.live === true;
	const mode = state?.mode ?? "unknown";
	const isMemoryOnly = mode === "memory_only";
	const status = state?.status;
	const unifiedStatus = resolveUnifiedStatus({
		live,
		mode,
		status,
		reason: state?.reason,
		error: state?.error
	});
	const handleReindex = async () => {
		setReindexing(true);
		setReindexMsg(null);
		try {
			const res = await fetch("/api/vectr/session-reindex", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ workspace })
			});
			const data = await res.json();
			if (res.ok && data.ok) setReindexMsg({
				ok: true,
				text: "重新索引已触发并开始后台构建"
			});
			else setReindexMsg({
				ok: false,
				text: data.error ?? `触发失败 (${res.status})`
			});
		} catch (err) {
			setReindexMsg({
				ok: false,
				text: `请求异常: ${String(err)}`
			});
		} finally {
			setReindexing(false);
		}
	};
	const handleInit = async () => {
		setInitBusy(true);
		setInitResult(null);
		try {
			const data = await (await fetch("/api/vectr/init", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					workspace,
					hooks: initHooks,
					memoryOnly: initMemoryOnly
				})
			})).json();
			if (data.ok) setInitResult({
				ok: true,
				text: `Vectr 工作区初始化完成！\n后续指引：如需启动语义检索与工作记忆守护进程，请在终端执行 vectr start（或配置后台守护进程拉起）。${data.stdout ? `\n\n${data.stdout}` : ""}`
			});
			else setInitResult({
				ok: false,
				text: `初始化失败: ${data.error || data.stderr || "未知错误"}`
			});
		} catch (err) {
			setInitResult({
				ok: false,
				text: `网络错误: ${String(err)}`
			});
		} finally {
			setInitBusy(false);
		}
	};
	const handleTestCodebase = async (slug) => {
		setBusySlug(slug);
		setCodebaseMsg(null);
		try {
			const res = await fetch(`/api/vectr/codebases/${encodeURIComponent(slug)}/test`, { method: "POST" });
			const data = await res.json();
			if (res.ok && data.ok) setCodebaseMsg({
				ok: true,
				text: `Codebase "${slug}" 连通性测试通过`
			});
			else setCodebaseMsg({
				ok: false,
				text: `Codebase "${slug}" 连通失败: ${data.error ?? res.status}`
			});
		} catch (err) {
			setCodebaseMsg({
				ok: false,
				text: `测试请求失败: ${String(err)}`
			});
		} finally {
			setBusySlug(null);
		}
	};
	const executeDeleteCodebase = async (slug) => {
		setBusySlug(slug);
		setConfirmDeleteSlug(null);
		setCodebaseMsg(null);
		try {
			const res = await fetch(`/api/vectr/codebases/${encodeURIComponent(slug)}`, { method: "DELETE" });
			if (res.ok) setCodebaseMsg({
				ok: true,
				text: `Codebase "${slug}" 已解绑删除`
			});
			else {
				const data = await res.json();
				setCodebaseMsg({
					ok: false,
					text: `删除失败: ${data.error ?? res.status}`
				});
			}
		} catch (err) {
			setCodebaseMsg({
				ok: false,
				text: `删除请求异常: ${String(err)}`
			});
		} finally {
			setBusySlug(null);
		}
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "vectr-modal-backdrop",
		onClick: onClose,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "vectr-modal-card",
			onClick: (e) => e.stopPropagation(),
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						padding: "16px 20px",
						borderBottom: "1px solid var(--dsw-alias-border-l2)",
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						background: "var(--dsw-alias-bg-layer-1)"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 10
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { fontSize: 18 },
							children: "⚡"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 8
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontWeight: 600,
										fontSize: 15
									},
									children: "Vectr 会话工作区面板"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										padding: "2px 8px",
										borderRadius: 10,
										fontSize: 11,
										fontWeight: 600,
										background: unifiedStatus.kind === "ready" || unifiedStatus.kind === "memory_only" ? "var(--dsw-alias-state-success-tertiary)" : unifiedStatus.isBusy ? "var(--dsw-alias-state-warn-tertiary)" : "var(--dsw-alias-interactive-bg-hover-danger)",
										color: unifiedStatus.kind === "ready" || unifiedStatus.kind === "memory_only" ? "var(--dsw-alias-state-success-primary)" : unifiedStatus.isBusy ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-state-error-primary)"
									},
									title: unifiedStatus.description,
									children: [unifiedStatus.kind === "offline" ? "○ " : "● ", unifiedStatus.label]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										padding: "2px 8px",
										borderRadius: 10,
										fontSize: 11,
										fontWeight: 500,
										background: isMemoryOnly ? "var(--dsw-alias-brand-tertiary)" : mode === "search_only" ? "var(--dsw-alias-state-warn-tertiary)" : "var(--dsw-alias-brand-tertiary)",
										color: isMemoryOnly ? "var(--dsw-alias-brand-primary)" : mode === "search_only" ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-brand-primary)"
									},
									children: mode
								}),
								state?.port && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										fontSize: 11,
										color: "var(--dsw-alias-label-tertiary)"
									},
									children: [
										"Port: ",
										state.port,
										" ",
										state.pid ? `(PID ${state.pid})` : ""
									]
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								fontSize: 12,
								color: "var(--dsw-alias-label-secondary)",
								marginTop: 3,
								fontFamily: "monospace"
							},
							title: workspace,
							children: ["📁 ", workspace]
						})] })]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: BTN.secondary,
							onClick: onRefresh,
							disabled: loading,
							title: "刷新状态",
							children: loading ? "…" : "🔄 刷新"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "vectr-btn",
							style: {
								fontSize: 18,
								color: "var(--dsw-alias-label-secondary)"
							},
							onClick: onClose,
							title: "关闭",
							children: "✕"
						})]
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "grid",
						gridTemplateColumns: "repeat(4, 1fr)",
						gap: 12,
						padding: "14px 20px",
						borderBottom: "1px solid var(--dsw-alias-border-l2)"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "vectr-metric-card",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 11,
										color: "var(--dsw-alias-label-secondary)"
									},
									children: "📁 索引文件数"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 18,
										fontWeight: 600
									},
									children: isMemoryOnly ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontSize: 13,
											color: "var(--dsw-alias-label-tertiary)"
										},
										children: "N/A (仅记忆)"
									}) : status?.indexed_files ?? (live ? 0 : "-")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 10,
										color: "var(--dsw-alias-label-tertiary)"
									},
									children: isMemoryOnly ? "无代码目录正常工作" : "已入库文件"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "vectr-metric-card",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 11,
										color: "var(--dsw-alias-label-secondary)"
									},
									children: "🧩 代码块数"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 18,
										fontWeight: 600
									},
									children: isMemoryOnly ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontSize: 13,
											color: "var(--dsw-alias-label-tertiary)"
										},
										children: "N/A"
									}) : status?.total_chunks ?? (live ? 0 : "-")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 10,
										color: "var(--dsw-alias-label-tertiary)"
									},
									children: isMemoryOnly ? "不建索引" : "语义向量切片"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "vectr-metric-card",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 11,
										color: "var(--dsw-alias-label-secondary)"
									},
									children: "🧠 记忆条目数"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 18,
										fontWeight: 600,
										color: "var(--dsw-alias-brand-primary)"
									},
									children: status?.notes_count ?? (live ? 0 : "-")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 10,
										color: "var(--dsw-alias-label-tertiary)"
									},
									children: "工作记忆 (Notes)"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "vectr-metric-card",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 11,
										color: "var(--dsw-alias-label-secondary)"
									},
									children: "⚡ 运行就绪"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 14,
										fontWeight: 600
									},
									children: live ? status?.fully_ready !== false ? "已就绪 (Ready)" : "构建中…" : "未运行 (Offline)"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 10,
										color: "var(--dsw-alias-label-tertiary)"
									},
									children: status?.embed_model ? status.embed_model.split("/").pop() : "嵌入模型未就绪"
								})
							]
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						gap: 12,
						padding: "0 20px",
						borderBottom: "1px solid var(--dsw-alias-border-l2)"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: `vectr-tab-btn ${activeTab === "codebases" ? "active" : ""}`,
							onClick: () => setActiveTab("codebases"),
							children: [
								"📁 挂载代码库 (",
								state?.codebases.length ?? 0,
								")"
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: `vectr-tab-btn ${activeTab === "memory" ? "active" : ""}`,
							onClick: () => setActiveTab("memory"),
							children: "🧠 工作记忆检索 (Memory)"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: `vectr-tab-btn ${activeTab === "ops" ? "active" : ""}`,
							onClick: () => setActiveTab("ops"),
							children: "⚙️ 维护与初始化 (Init)"
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						padding: "18px 20px",
						overflowY: "auto",
						flex: 1,
						minHeight: 320
					},
					children: [
						activeTab === "codebases" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 14
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontSize: 13,
											color: "var(--dsw-alias-label-secondary)"
										},
										children: "当前工作区已绑定的代码库列表："
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: BTN.primary,
										onClick: () => setShowAddModal(true),
										children: "+ 添加 Codebase"
									})]
								}),
								codebaseMsg && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										padding: "8px 12px",
										borderRadius: 6,
										background: codebaseMsg.ok ? "var(--dsw-alias-state-success-tertiary)" : "var(--dsw-alias-interactive-bg-hover-danger)",
										color: codebaseMsg.ok ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)",
										fontSize: 12
									},
									children: codebaseMsg.text
								}),
								!state?.codebases || state.codebases.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										padding: "30px",
										textAlign: "center",
										color: "var(--dsw-alias-label-tertiary)",
										fontSize: 13,
										border: "1px dashed var(--dsw-alias-border-l2)",
										borderRadius: 8
									},
									children: "当前工作区暂未挂载 Codebase，可点击上方“添加 Codebase”进行配置绑定。"
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
									style: {
										width: "100%",
										borderCollapse: "collapse",
										fontSize: 13
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
										style: {
											borderBottom: "1px solid var(--dsw-alias-border-l2)",
											textAlign: "left",
											color: "var(--dsw-alias-label-secondary)"
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: { padding: "8px 10px" },
												children: "Slug"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: { padding: "8px 10px" },
												children: "类型"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: { padding: "8px 10px" },
												children: "目标路径 / 主机"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: { padding: "8px 10px" },
												children: "状态"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
												style: {
													padding: "8px 10px",
													textAlign: "right"
												},
												children: "操作"
											})
										]
									}) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: state.codebases.map((cb) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
										style: { borderBottom: "1px solid var(--dsw-alias-border-l2)" },
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: {
													padding: "10px",
													fontWeight: 600
												},
												children: cb.slug
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: { padding: "10px" },
												children: cb.type === "remote" ? "🌐 Remote" : "📁 Local"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: {
													padding: "10px",
													fontFamily: "monospace",
													fontSize: 12
												},
												children: cb.target
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: { padding: "10px" },
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: {
														fontWeight: 600,
														color: cb.status === "up" ? "var(--dsw-alias-state-success-primary)" : cb.status === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-tertiary)"
													},
													title: cb.error || "",
													children: cb.status
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
												style: {
													padding: "10px",
													textAlign: "right"
												},
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													style: {
														display: "inline-flex",
														gap: 6,
														alignItems: "center"
													},
													children: confirmDeleteSlug === cb.slug ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: BTN.danger,
														onClick: () => void executeDeleteCodebase(cb.slug),
														disabled: busySlug === cb.slug,
														children: busySlug === cb.slug ? "删除中…" : "确认解绑？"
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: BTN.secondary,
														onClick: () => setConfirmDeleteSlug(null),
														disabled: busySlug === cb.slug,
														children: "取消"
													})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: BTN.action,
														onClick: () => void handleTestCodebase(cb.slug),
														disabled: busySlug === cb.slug,
														children: "测试连通性"
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: BTN.danger,
														onClick: () => setConfirmDeleteSlug(cb.slug),
														disabled: busySlug === cb.slug,
														children: "解绑/删除"
													})] })
												})
											})
										]
									}, cb.slug)) })]
								})
							]
						}),
						activeTab === "memory" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryViewer, {
							workspace,
							port: state?.port,
							live
						}),
						activeTab === "ops" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 20
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									padding: 16,
									border: "1px solid var(--dsw-alias-border-l2)",
									borderRadius: 8
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontWeight: 600,
											fontSize: 14,
											marginBottom: 4
										},
										children: "🔄 触发重新索引 (Re-index)"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											fontSize: 12,
											color: "var(--dsw-alias-label-secondary)",
											marginBottom: 12
										},
										children: [
											"向守护进程发送 ",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "POST /v1/index" }),
											"，更新代码符号与语义向量切片。"
										]
									}),
									isMemoryOnly ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											padding: "10px 12px",
											borderRadius: 6,
											background: "var(--dsw-alias-brand-tertiary)",
											color: "var(--dsw-alias-brand-primary)",
											fontSize: 12
										},
										children: [
											"ℹ️ 当前工作区运行在 ",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "memory_only" }),
											" 模式，禁止发起索引请求（原生支持仅工作记忆与 hooks，无需代码目录，不建索引）。"
										]
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: BTN.primary,
										disabled: !state?.canReindex || reindexing,
										onClick: () => void handleReindex(),
										children: reindexing ? "触发中…" : "立即触发 Re-index"
									}), !state?.canReindex && state?.reindexDisabledReason && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										style: {
											fontSize: 12,
											color: "var(--dsw-alias-label-tertiary)",
											marginLeft: 12
										},
										children: [
											"(",
											state.reindexDisabledReason,
											")"
										]
									})] }),
									reindexMsg && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											marginTop: 10,
											padding: "8px 12px",
											borderRadius: 6,
											background: reindexMsg.ok ? "var(--dsw-alias-state-success-tertiary)" : "var(--dsw-alias-interactive-bg-hover-danger)",
											color: reindexMsg.ok ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)",
											fontSize: 12
										},
										children: reindexMsg.text
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									padding: 16,
									border: "1px solid var(--dsw-alias-border-l2)",
									borderRadius: 8
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontWeight: 600,
											fontSize: 14,
											marginBottom: 4
										},
										children: "🚀 初始化工作区 (vectr init)"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 12,
											color: "var(--dsw-alias-label-secondary)",
											marginBottom: 12
										},
										children: "为当前工作区生成 IDE 规范文件（CLAUDE.md、.mcp.json、.vectrignore 等）并配置 Hooks。"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											flexDirection: "column",
											gap: 8,
											marginBottom: 14
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											style: {
												display: "flex",
												alignItems: "center",
												gap: 8,
												fontSize: 13,
												cursor: "pointer"
											},
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: initHooks,
													onChange: (e) => setInitHooks(e.target.checked)
												}),
												"写入 Claude Code Hooks (",
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "--hooks" }),
												", 自动注入 SessionStart / UserPrompt 记忆)"
											]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											style: {
												display: "flex",
												alignItems: "center",
												gap: 8,
												fontSize: 13,
												cursor: "pointer"
											},
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: initMemoryOnly,
													onChange: (e) => setInitMemoryOnly(e.target.checked)
												}),
												"仅工作记忆模式 (",
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "--memory-only" }),
												" / ",
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "--style memory-only" }),
												"，无代码目录正常工作)"
											]
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: BTN.primary,
										disabled: initBusy,
										onClick: () => void handleInit(),
										children: initBusy ? "初始化执行中…" : "执行 vectr init"
									}),
									initResult && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											marginTop: 10,
											padding: "10px 12px",
											borderRadius: 6,
											background: initResult.ok ? "var(--dsw-alias-state-success-tertiary)" : "var(--dsw-alias-interactive-bg-hover-danger)",
											color: initResult.ok ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)",
											fontSize: 12,
											fontFamily: "monospace",
											whiteSpace: "pre-wrap"
										},
										children: initResult.text
									})
								]
							})]
						})
					]
				})
			]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CodebaseModal, {
			workspace,
			isOpen: showAddModal,
			onClose: () => setShowAddModal(false),
			onSuccess: () => setCodebaseMsg({
				ok: true,
				text: "Codebase 添加成功"
			})
		})]
	});
}
//#endregion
//#region src/client/VectrDialogRoot.tsx
/**
* Global singleton modal root for Vectr.
*
* Subscribes to `dialogCoordinator` and renders a single instance of `SessionDrawerModal`.
* Avoids duplicate modals and overlapping backdrops across trigger slots.
*
* @module dsh-vectr-client/client/VectrDialogRoot
*/
function VectrDialogRoot() {
	const [isOpen, setIsOpen] = (0, react.useState)(false);
	const [workspace, setWorkspace] = (0, react.useState)(void 0);
	const [state, setState] = (0, react.useState)(null);
	const [loading, setLoading] = (0, react.useState)(false);
	(0, react.useEffect)(() => {
		return dialogCoordinator.subscribe((coordState) => {
			setIsOpen(coordState.isOpen);
			setWorkspace(coordState.workspace);
		});
	}, []);
	const fetchStatus = async (ws, signal) => {
		if (!ws) return;
		setLoading(true);
		try {
			const res = await fetch(`/api/vectr/session-status?workspace=${encodeURIComponent(ws)}`, signal ? { signal } : void 0);
			if (res.ok) {
				const data = await res.json();
				setState(data);
			} else setState(null);
		} catch (err) {
			if (err?.name === "AbortError" || signal?.aborted) return;
			setState(null);
		} finally {
			if (!signal?.aborted) setLoading(false);
		}
	};
	(0, react.useEffect)(() => {
		if (isOpen && workspace) {
			const controller = new AbortController();
			fetchStatus(workspace, controller.signal);
			return () => {
				controller.abort();
			};
		} else if (!isOpen) setState(null);
	}, [isOpen, workspace]);
	if (!isOpen || !workspace) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VectrStyles, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionDrawerModal, {
		workspace,
		state,
		loading,
		isOpen,
		onClose: () => dialogCoordinator.close(),
		onRefresh: () => {
			if (workspace) fetchStatus(workspace);
		}
	})] });
}
//#endregion
//#region src/client/index.tsx
/**
* Browser half of the vectr workspace console (feature A / C1) — **阶段2**: the
* multi-codebase manager is merged INTO this panel (no separate Codebases tab).
*
* A thin React view mounted as the top-level **Settings → Vectr** section via the
* `settings.section` slot (hosted by the VectrSettings shell). All data lives on
* the host: this half only fetches the same-origin relative endpoints the host
* registered (`/api/vectr/workspaces`, `/api/vectr/codebases`,
* `/api/vectr/trigger-index`) and renders:
*
*  - the workspace table (13 cols, unchanged from feature A),
*  - a per-row chevron that expands a **codebase sub-table** (5 cols: name /
*    type / target / status / actions) listing the codebases whose
*    `workspace` equals this row's workspace,
*  - an **Unassigned** pseudo-section for codebases with
*    `workspace === '__unassigned__'` (plus an inline assign action),
*  - a create form inside every expanded section, pre-bound to that section's
*    workspace (the 阶段2 "form reports workspace" requirement).
*
* The host serves this bundle from `lib/client.js` (the `dsh.client` dual-face
* declaration), so bare imports of `react` and the slot service resolve through
* the host's module table at runtime. Only `react` is imported as a value; the
* Cordis client context is typed structurally so the host build needs no extra
* type packages.
*
* @module dsh-vectr-client/client
*/
/** Sentinel workspace for entries that could not be inferred during migration. */
const UNASSIGNED_WORKSPACE = "__unassigned__";
/** Reason a row's re-index button is disabled, or undefined when enabled. */
function reindexDisabledReason(view) {
	if (!view.live) return view.error ?? "daemon offline";
	const mode = view.mode;
	if (mode === "memory_only" || mode === "search_only") return `daemon in '${mode}' mode cannot be re-indexed`;
	if (view.status?.reindex_in_progress) return "re-index already in progress";
	if (view.status?.fully_ready === false) return "daemon not fully_ready yet";
}
/** Single status pill: up=green, down=gray, error=red (title shows the message). */
function StatusPill(props) {
	const { status, error } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		style: {
			color: status === "up" ? "var(--dsw-alias-state-success-primary)" : status === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-secondary)",
			fontWeight: 600,
			whiteSpace: "nowrap"
		},
		title: error ?? "",
		children: status
	});
}
/** Compact type indicator: 📁 local / 🌐 remote. */
function TypeCell(props) {
	const { type } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		style: { whiteSpace: "nowrap" },
		children: type === "remote" ? "🌐 remote" : "📁 local"
	});
}
/** Render the `target` column: local → path; remote → `host:remotePort → 127.0.0.1:localPort`. */
function TargetCell(props) {
	const { view } = props;
	const text = view.type === "remote" ? `${view.host ?? "?"} → 127.0.0.1:${view.localPort ?? "?"} (remote ${view.remotePort ?? "?"})` : view.path;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
		style: tdStyle,
		title: text,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: {
				...ellipsisStyle,
				maxWidth: 260
			},
			children: text
		})
	});
}
/** One codebase sub-row: 5 columns (name / type / target / status / actions). */
function CodebaseSubRow(props) {
	const { view, onTest, onDelete, onAssign, busy, showAssign, knownWorkspaces } = props;
	const [assigning, setAssigning] = (0, react.useState)(false);
	const [target, setTarget] = (0, react.useState)(knownWorkspaces[0] ?? "");
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			title: view.slug,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: ellipsisStyle,
				children: view.slug
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TypeCell, { type: view.type })
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TargetCell, { view }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusPill, {
				status: view.status,
				error: view.error
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: {
				...tdStyle,
				whiteSpace: "nowrap"
			},
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 4,
					whiteSpace: "nowrap"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: BTN.action,
						disabled: busy,
						onClick: () => onTest(view.slug),
						children: "test"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: BTN.danger,
						disabled: busy,
						onClick: () => onDelete(view.slug),
						children: "delete"
					}),
					showAssign ? assigning ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "vectr-select",
							style: {
								height: 26,
								fontSize: 12
							},
							value: target,
							onChange: (e) => setTarget(e.target.value),
							children: [knownWorkspaces.map((ws) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: ws,
								children: ws.split("/").slice(-2).join("/")
							}, ws)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: UNASSIGNED_WORKSPACE,
								children: "__unassigned__"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: BTN.primary,
							disabled: busy,
							onClick: () => {
								setAssigning(false);
								onAssign(view.slug, target);
							},
							children: "apply"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: BTN.secondary,
							disabled: busy,
							onClick: () => setAssigning(false),
							children: "cancel"
						})
					] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: BTN.secondary,
						disabled: busy,
						onClick: () => setAssigning(true),
						children: "assign"
					}) : null
				]
			})
		})
	] });
}
/** The 5-column codebase sub-table for one workspace section (no large minWidth). */
function CodebaseSubTable(props) {
	const { entries, onTest, onDelete, onAssign, busySlug, showAssign, knownWorkspaces } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: { margin: "4px 0 8px 18px" },
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
			style: {
				borderCollapse: "collapse",
				width: "100%",
				minWidth: 460
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
					style: thStyle,
					children: "name"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
					style: thStyle,
					children: "type"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
					style: thStyle,
					children: "target"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
					style: thStyle,
					children: "status"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
					style: {
						...thStyle,
						minWidth: 130,
						whiteSpace: "nowrap"
					},
					children: "actions"
				})
			] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: entries.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
				style: tdStyle,
				colSpan: 5,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						color: "var(--dsw-alias-label-tertiary)",
						fontSize: 12
					},
					children: "no codebases in this workspace yet"
				})
			}) }) : entries.map((view) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CodebaseSubRow, {
				view,
				onTest,
				onDelete,
				onAssign,
				busy: busySlug === view.slug,
				showAssign,
				knownWorkspaces
			}, view.slug)) })]
		})
	});
}
/** Create form, pre-bound to a section workspace when `presetWorkspace` is given. */
function CodebaseCreateForm(props) {
	const { presetWorkspace, knownWorkspaces, onCreated } = props;
	const [type, setType] = (0, react.useState)("local");
	const [slug, setSlug] = (0, react.useState)("");
	const [path, setPath] = (0, react.useState)(presetWorkspace ?? "");
	const [host, setHost] = (0, react.useState)("");
	const [auth, setAuth] = (0, react.useState)("key");
	const [password, setPassword] = (0, react.useState)("");
	const [workspace, setWorkspace] = (0, react.useState)(presetWorkspace ?? knownWorkspaces[0] ?? UNASSIGNED_WORKSPACE);
	const [formError, setFormError] = (0, react.useState)(null);
	const [creating, setCreating] = (0, react.useState)(false);
	const submit = (e) => {
		e.preventDefault();
		setFormError(null);
		setCreating(true);
		const body = {
			type,
			slug,
			path,
			workspace: presetWorkspace ?? workspace
		};
		if (type === "remote") {
			body.host = host;
			body.auth = auth;
			if (auth === "password") body.password = password;
		}
		fetch("/api/vectr/codebases", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body)
		}).then((res) => res.json()).then((result) => {
			if (result.error !== void 0) setFormError(result.error);
			else {
				setSlug("");
				setPath("");
				setHost("");
				setPassword("");
				onCreated();
			}
		}).catch((err) => setFormError(`create request error: ${String(err)}`)).finally(() => setCreating(false));
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
		onSubmit: submit,
		style: {
			display: "flex",
			flexDirection: "column",
			gap: 6,
			margin: "6px 0 4px 18px",
			maxWidth: 520
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					gap: 8,
					flexWrap: "wrap"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						htmlFor: "cb-type",
						children: "type"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						id: "cb-type",
						className: "vectr-select",
						value: type,
						onChange: (e) => setType(e.target.value),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "local",
							children: "local"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "remote",
							children: "remote"
						})]
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						htmlFor: "cb-slug",
						children: "slug"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "cb-slug",
						className: "vectr-input",
						value: slug,
						onChange: (e) => setSlug(e.target.value),
						placeholder: "my-codebase",
						required: true
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						htmlFor: "cb-path",
						children: "path"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "cb-path",
						className: "vectr-input",
						value: path,
						onChange: (e) => setPath(e.target.value),
						placeholder: "/abs/path",
						required: true
					})] })
				]
			}),
			type === "remote" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					gap: 8,
					flexWrap: "wrap"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						htmlFor: "cb-host",
						children: "host"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "cb-host",
						className: "vectr-input",
						value: host,
						onChange: (e) => setHost(e.target.value),
						placeholder: "user@host",
						required: true
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						htmlFor: "cb-auth",
						children: "auth"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						id: "cb-auth",
						className: "vectr-select",
						value: auth,
						onChange: (e) => setAuth(e.target.value),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "key",
							children: "key"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "password",
							children: "password"
						})]
					})] }),
					auth === "password" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						htmlFor: "cb-password",
						children: "password"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "cb-password",
						className: "vectr-input",
						type: "password",
						value: password,
						onChange: (e) => setPassword(e.target.value),
						placeholder: "••••••"
					})] }) : null
				]
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					gap: 8,
					alignItems: "flex-end",
					flexWrap: "wrap"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						flex: presetWorkspace === void 0 ? "0 0 auto" : "1 1 240px",
						minWidth: 200
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						htmlFor: "cb-workspace",
						children: "workspace"
					}), presetWorkspace !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "cb-workspace",
						className: "vectr-input",
						value: presetWorkspace,
						disabled: true,
						title: "bound to this workspace section"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						id: "cb-workspace",
						className: "vectr-select",
						style: { width: "100%" },
						value: workspace,
						onChange: (e) => setWorkspace(e.target.value),
						children: [knownWorkspaces.map((ws) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: ws,
							children: ws
						}, ws)), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: UNASSIGNED_WORKSPACE,
							children: "__unassigned__"
						})]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "submit",
					className: BTN.primary,
					disabled: creating || slug.length === 0 || path.length === 0,
					children: creating ? "…" : "create"
				})]
			}),
			formError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: { color: "var(--dsw-alias-state-error-primary)" },
				children: formError
			}) : null
		]
	});
}
/** One workspace row + its expandable codebase sub-section. */
function WorkspaceRow(props) {
	const { view, entries, expanded, onToggle, onReindex, busyPort, onTest, onDelete, onAssign, busySlug, knownWorkspaces, onCreated } = props;
	const disabledReason = reindexDisabledReason(view);
	const disabled = disabledReason !== void 0 || busyPort;
	const s = view.status;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: {
				...tdStyle,
				cursor: "pointer",
				userSelect: "none"
			},
			onClick: onToggle,
			title: expanded ? "collapse codebases" : "expand codebases",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: {
					display: "inline-block",
					width: 12
				},
				children: expanded ? "▾" : "▸"
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			title: view.workspace,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: ellipsisStyle,
				children: view.workspace.split("/").slice(-2).join("/")
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: view.live ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: { color: "var(--dsw-alias-state-success-primary)" },
				children: "online"
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: { color: "var(--dsw-alias-state-error-primary)" },
				children: "offline"
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			title: view.error ?? "",
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: ellipsisStyle,
				children: view.reason ?? view.error ?? "—"
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: view.port
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: view.pid ?? "—"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: view.mode ?? "—"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: s?.indexed_files ?? "—"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: s?.total_chunks ?? "—"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: ellipsisStyle,
				children: s?.languages?.join(", ") ?? "—"
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: ellipsisStyle,
				children: s?.last_indexed ?? "—"
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: s?.notes_count ?? "—"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: s?.fully_ready ?? false ? "yes" : "no"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: BTN.action,
				disabled,
				title: disabledReason ?? "Re-index this workspace",
				onClick: () => onReindex(view.port),
				children: busyPort ? "…" : "re-index"
			})
		})
	] }), expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
		colSpan: 13,
		style: {
			padding: 0,
			borderBottom: "1px solid var(--dsw-alias-border-l2)"
		},
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CodebaseSubTable, {
			entries,
			onTest,
			onDelete,
			onAssign,
			busySlug,
			showAssign: false,
			knownWorkspaces
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CodebaseCreateForm, {
			presetWorkspace: view.workspace,
			knownWorkspaces,
			onCreated
		})]
	})] }) : null] });
}
/** The full merged console panel (workspaces + their codebases). */
function WorkspaceConsole() {
	const [wsViews, setWsViews] = (0, react.useState)(null);
	const [cbViews, setCbViews] = (0, react.useState)(null);
	const [wsError, setWsError] = (0, react.useState)(null);
	const [cbError, setCbError] = (0, react.useState)(null);
	const [loading, setLoading] = (0, react.useState)(false);
	const [busyPort, setBusyPort] = (0, react.useState)(null);
	const [busySlug, setBusySlug] = (0, react.useState)(null);
	const [flash, setFlash] = (0, react.useState)(null);
	const [expanded, setExpanded] = (0, react.useState)(/* @__PURE__ */ new Set());
	const refresh = () => {
		setLoading(true);
		setWsError(null);
		setCbError(null);
		const wsReq = fetch("/api/vectr/workspaces").then((res) => {
			if (!res.ok) throw new Error(`workspaces endpoint returned ${res.status}`);
			return res.json();
		}).then((data) => setWsViews(data)).catch((err) => setWsError(String(err)));
		const cbReq = fetch("/api/vectr/codebases").then((res) => {
			if (!res.ok) throw new Error(`codebases endpoint returned ${res.status}`);
			return res.json();
		}).then((data) => setCbViews(data)).catch((err) => setCbError(String(err)));
		Promise.allSettled([wsReq, cbReq]).finally(() => setLoading(false));
	};
	(0, react.useEffect)(() => {
		refresh();
	}, []);
	const reindex = (port) => {
		setBusyPort(port);
		setFlash(null);
		fetch("/api/vectr/trigger-index", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ port })
		}).then((res) => res.json()).then((result) => {
			if (result.ok) setFlash(`re-index triggered for port ${port}`);
			else setFlash(`re-index failed: ${result.error ?? "unknown error"}`);
			refresh();
		}).catch((err) => setFlash(`re-index request error: ${String(err)}`)).finally(() => setBusyPort(null));
	};
	const run = (slug, method, suffix, okFlash) => {
		setBusySlug(slug);
		setFlash(null);
		fetch(`/api/vectr/codebases/${encodeURIComponent(slug)}${suffix}`, { method }).then((res) => res.json()).then((result) => {
			if (result.ok === false) setFlash(`failed: ${result.error ?? "unknown error"}`);
			else {
				setFlash(okFlash);
				refresh();
			}
		}).catch((err) => setFlash(`request error: ${String(err)}`)).finally(() => setBusySlug(null));
	};
	const test = (slug) => run(slug, "POST", "/test", `tested ${slug}`);
	const del = (slug) => run(slug, "DELETE", "", `deleted ${slug}`);
	const assign = (slug, ws) => {
		setBusySlug(slug);
		setFlash(null);
		fetch(`/api/vectr/codebases/${encodeURIComponent(slug)}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ workspace: ws })
		}).then(async (res) => {
			const result = await res.json().catch(() => ({}));
			if (!res.ok || result.error !== void 0) setFlash(`assign failed: ${result.error ?? "unknown"}`);
			else {
				setFlash(`assigned "${slug}" → "${ws}"`);
				refresh();
			}
		}).catch((err) => setFlash(`assign request error: ${String(err)}`)).finally(() => setBusySlug(null));
	};
	const toggle = (key) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	const normWs = (w) => w.replace(/\/+$/, "");
	const knownWorkspaces = (wsViews ?? []).map((w) => normWs(w.workspace));
	const byWs = /* @__PURE__ */ new Map();
	const unassigned = [];
	for (const cb of cbViews ?? []) {
		const ws = cb.workspace;
		if (ws === void 0 || ws === UNASSIGNED_WORKSPACE) {
			unassigned.push(cb);
			continue;
		}
		const key = normWs(ws);
		const list = byWs.get(key);
		if (list === void 0) byWs.set(key, [cb]);
		else list.push(cb);
	}
	const orphans = [...byWs.keys()].filter((ws) => !knownWorkspaces.includes(ws));
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				marginBottom: 8
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: BTN.secondary,
					disabled: loading,
					onClick: refresh,
					children: "refresh"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: loading ? "loading…" : `${knownWorkspaces.length} workspace(s) · ${cbViews?.length ?? 0} codebase(s)` }),
				flash !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: { color: "var(--dsw-alias-label-tertiary)" },
					children: flash
				}) : null
			]
		}),
		wsError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
			style: { color: "var(--dsw-alias-state-error-primary)" },
			children: ["failed to load workspaces: ", wsError]
		}) : null,
		cbError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
			style: { color: "var(--dsw-alias-state-error-primary)" },
			children: ["failed to load codebases: ", cbError]
		}) : null,
		wsViews !== null && wsViews.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			style: {
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: 12
			},
			children: "暂无工作区"
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: scrollWrap,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
				style: tableStyleWorkspaces,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { style: thStyle }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "workspace"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "status"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "reason"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "port"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "pid"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "mode"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "files"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "chunks"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "languages"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "last indexed"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "notes"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "ready"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "action"
					})
				] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tbody", { children: [wsViews?.map((view) => {
					const affiliated = byWs.get(view.workspace) ?? [];
					const key = `ws:${view.workspace}`;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspaceRow, {
						view,
						entries: affiliated,
						expanded: expanded.has(key),
						onToggle: () => toggle(key),
						onReindex: reindex,
						busyPort: busyPort === view.port,
						onTest: test,
						onDelete: del,
						onAssign: assign,
						busySlug,
						knownWorkspaces,
						onCreated: refresh
					}, key);
				}), orphans.map((ws) => {
					const affiliated = byWs.get(ws) ?? [];
					const key = `orphan:${ws}`;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspaceRow, {
						view: {
							workspace: ws,
							port: 0,
							live: false,
							reason: "not a running vectr daemon"
						},
						entries: affiliated,
						expanded: expanded.has(key),
						onToggle: () => toggle(key),
						onReindex: () => {},
						busyPort: false,
						onTest: test,
						onDelete: del,
						onAssign: assign,
						busySlug,
						knownWorkspaces,
						onCreated: refresh
					}, key);
				})] })]
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: { marginTop: 14 },
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
					style: {
						margin: "0 0 6px",
						color: "var(--dsw-alias-label-secondary)"
					},
					children: "Unassigned codebases"
				}),
				unassigned.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: {
						color: "var(--dsw-alias-label-tertiary)",
						fontSize: 12
					},
					children: "none"
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CodebaseSubTable, {
					entries: unassigned,
					onTest: test,
					onDelete: del,
					onAssign: assign,
					busySlug,
					showAssign: true,
					knownWorkspaces
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CodebaseCreateForm, {
					knownWorkspaces,
					onCreated: refresh
				})
			]
		})
	] });
}
/** Services required by the client half (informational; host resolves them). */
const inject = ["slots"];
/** Order of the Vectr top-level Settings section in the host nav. The built-in
* General/Models/Presets sections use 0–20; 200 keeps Vectr after them. */
const VECTR_SECTION_ORDER = 200;
/** Mount the Vectr shell as a top-level **Settings → Vectr** section. The shell
* owns the single merged panel (workspaces + their codebases). `slots.inject`
* runs its callback as a Cordis effect, so the callback returns the disposer
* `slots.register` yields (not a plain descriptor) or the loader rejects it. */
/**
* Registers a slot injection wrapped inside ctx.effect so that Cordis HMR reload
* cleans up previous injections, avoiding duplicate modals and buttons.
*/
function effectInject(ctx, key, callback, name) {
	let executed = false;
	ctx.effect(() => {
		executed = true;
		return ctx.slots.inject(key, callback);
	}, name);
	if (!executed) ctx.slots.inject(key, callback);
}
/** Mount the Vectr shell as a top-level **Settings → Vectr** section. The shell
* owns the single merged panel (workspaces + their codebases). `slots.inject`
* runs its callback as a Cordis effect, so the callback returns the disposer
* `slots.register` yields (not a plain descriptor) or the loader rejects it. */
function apply(ctx) {
	effectInject(ctx, "settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "vectr",
		order: VECTR_SECTION_ORDER,
		label: () => "Vectr",
		icon: VectrNavIcon
	}, VectrSettings), "vectr: settings.section");
	effectInject(ctx, "conversation.session.header.utilities", () => ctx.slots.register({
		name: "conversation.session.header.utilities",
		id: "vectr-session-header-utility",
		order: 120,
		label: () => "Vectr"
	}, SessionHeaderAction), "vectr: conversation.session.header.utilities");
	effectInject(ctx, "conversation.input.right", () => ctx.slots.register({
		name: "conversation.input.right",
		id: "vectr-conversation-input-right",
		order: 120,
		label: () => "Vectr"
	}, ConversationInputRightAction), "vectr: conversation.input.right");
	effectInject(ctx, "shell.overlay", () => ctx.slots.register({
		name: "shell.overlay",
		id: "vectr-dialog-root",
		order: 100
	}, VectrDialogRoot), "vectr: shell.overlay");
}
//#endregion
exports.CodebaseModal = CodebaseModal;
exports.ConversationInputRightAction = ConversationInputRightAction;
exports.DialogCoordinator = DialogCoordinator;
exports.MemoryViewer = MemoryViewer;
exports.SessionDrawerModal = SessionDrawerModal;
exports.SessionHeaderAction = SessionHeaderAction;
exports.VectrDialogRoot = VectrDialogRoot;
exports.VectrNavIcon = VectrNavIcon;
exports.WorkspaceConsole = WorkspaceConsole;
exports.apply = apply;
exports.dialogCoordinator = dialogCoordinator;
exports.inject = inject;

return exports; } });
//# sourceMappingURL=client.js.map