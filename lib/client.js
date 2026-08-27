window.__ModuleLoader__.load({ id: "dsh-vectr-client", factory: (require) => {
var exports = { exports: {} }.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/client/codebases.tsx
/**
* Browser half of the multi-codebase manager (feature B).
*
* Mounted into the same Settings → Plugins tab as the workspace console. It
* fetches the host's `/api/vectr/codebases` endpoints and renders a create
* form plus a table with per-row test / delete actions. Secrets (passwords)
* are submitted on create but never read back or shown.
*
* @module dsh-vectr-client/client/codebases
*/
/** One table row with test / delete actions. */
function CodebaseRow(props) {
	const { view, onTest, onDelete, busy } = props;
	const address = view.type === "remote" ? `${view.host ?? "?"} → 127.0.0.1:${view.localPort ?? "?"}` : `127.0.0.1:${view.localPort ?? "?"}`;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: view.slug }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: view.type }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			title: view.path,
			children: view.path
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: address }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: view.localPort ?? "—" }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: view.status === "up" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: { color: "green" },
			children: "up"
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			style: { color: "red" },
			children: [view.status, view.error ? ` (${view.error})` : ""]
		}) }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: view.tunnelPid !== void 0 ? String(view.tunnelPid) : "—" }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			disabled: busy,
			onClick: () => onTest(view.slug),
			children: "test"
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			disabled: busy,
			onClick: () => onDelete(view.slug),
			style: { marginLeft: 4 },
			children: "delete"
		})] })
	] });
}
/** The full codebase manager panel. */
function CodebaseManager() {
	const [views, setViews] = (0, react.useState)(null);
	const [error, setError] = (0, react.useState)(null);
	const [loading, setLoading] = (0, react.useState)(false);
	const [busySlug, setBusySlug] = (0, react.useState)(null);
	const [flash, setFlash] = (0, react.useState)(null);
	const [type, setType] = (0, react.useState)("local");
	const [slug, setSlug] = (0, react.useState)("");
	const [path, setPath] = (0, react.useState)("");
	const [host, setHost] = (0, react.useState)("");
	const [auth, setAuth] = (0, react.useState)("key");
	const [password, setPassword] = (0, react.useState)("");
	const [formError, setFormError] = (0, react.useState)(null);
	const [creating, setCreating] = (0, react.useState)(false);
	const refresh = () => {
		setLoading(true);
		setError(null);
		fetch("/api/vectr/codebases").then((res) => {
			if (!res.ok) throw new Error(`codebases endpoint returned ${res.status}`);
			return res.json();
		}).then((data) => setViews(data)).catch((err) => setError(String(err))).finally(() => setLoading(false));
	};
	(0, react.useEffect)(() => {
		refresh();
	}, []);
	const submit = (e) => {
		e.preventDefault();
		setFormError(null);
		setCreating(true);
		const body = {
			type,
			slug,
			path
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
			if (result.error !== void 0) setFormError(result.error ?? "create failed");
			else {
				setFlash(`codebase "${slug}" created`);
				setSlug("");
				setPath("");
				setHost("");
				setPassword("");
				refresh();
			}
		}).catch((err) => setFormError(`create request error: ${String(err)}`)).finally(() => setCreating(false));
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
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
			style: { margin: "12px 0 6px" },
			children: "Codebases"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
			onSubmit: submit,
			style: {
				display: "grid",
				gridTemplateColumns: "max-content 1fr",
				gap: 6,
				marginBottom: 10,
				maxWidth: 520
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "type" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
					value: type,
					onChange: (e) => setType(e.target.value),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "local",
						children: "local"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "remote",
						children: "remote"
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "slug" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					value: slug,
					onChange: (e) => setSlug(e.target.value),
					placeholder: "my-codebase",
					required: true
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "path" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					value: path,
					onChange: (e) => setPath(e.target.value),
					placeholder: "/abs/path",
					required: true
				}),
				type === "remote" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "host" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						value: host,
						onChange: (e) => setHost(e.target.value),
						placeholder: "user@host",
						required: true
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "auth" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						value: auth,
						onChange: (e) => setAuth(e.target.value),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "key",
							children: "key"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "password",
							children: "password"
						})]
					}),
					auth === "password" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "password" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "password",
						value: password,
						onChange: (e) => setPassword(e.target.value),
						placeholder: "••••••"
					})] }) : null
				] }) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "submit",
					disabled: creating || slug.length === 0 || path.length === 0,
					children: creating ? "…" : "create"
				}),
				formError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						color: "red",
						gridColumn: "1 / span 2"
					},
					children: formError
				}) : null
			]
		}),
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
					disabled: loading,
					onClick: refresh,
					children: "refresh"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: loading ? "loading…" : views === null ? "" : `${views.length} codebase(s)` }),
				flash !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: { color: "gray" },
					children: flash
				}) : null
			]
		}),
		error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
			style: { color: "red" },
			children: ["failed to load codebases: ", error]
		}) : null,
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
			style: {
				borderCollapse: "collapse",
				width: "100%"
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "slug" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "type" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "path" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "address" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "local port" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "status" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "tunnel" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "actions" })
			] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: views?.map((view) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CodebaseRow, {
				view,
				onTest: test,
				onDelete: del,
				busy: busySlug === view.slug
			}, view.slug)) })]
		})
	] });
}
/** Mount the codebase manager into the Settings → Plugins tab (alongside the workspace console). */
function apply$1(ctx) {
	ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
		name: "settings.plugins.tab",
		id: "vectr-codebases",
		order: 21,
		label: () => "Vectr Codebases"
	}, CodebaseManager));
}
//#endregion
//#region src/client/index.tsx
/**
* Browser half of the vectr workspace console (feature A / C1).
*
* A thin React view mounted into the Settings → Plugins tab via the shared
* `settings.plugins.tab` slot. All data lives on the host: this half only
* fetches the same-origin relative endpoints the host registered
* (`/api/vectr/workspaces`, `/api/vectr/trigger-index`) and renders the table
* plus a per-row "re-index" action and a global "refresh".
*
* The host serves this bundle from `lib/client.js` (the `dsh.client` dual-face
* declaration), so bare imports of `react` and the slot service resolve through
* the host's module table at runtime. Only `react` is imported as a value; the
* Cordis client context is typed structurally so the host build needs no extra
* type packages.
*
* @module dsh-vectr-client/client
*/
/** Reason a row's re-index button is disabled, or undefined when enabled. */
function reindexDisabledReason(view) {
	if (!view.live) return view.error ?? "daemon offline";
	const mode = view.mode;
	if (mode === "memory_only" || mode === "search_only") return `daemon in '${mode}' mode cannot be re-indexed`;
	if (view.status?.reindex_in_progress) return "re-index already in progress";
	if (view.status?.fully_ready === false) return "daemon not fully_ready yet";
}
/** One table row. */
function WorkspaceRow(props) {
	const { view, onReindex, busy } = props;
	const disabledReason = reindexDisabledReason(view);
	const disabled = disabledReason !== void 0 || busy;
	const s = view.status;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			title: view.workspace,
			children: view.workspace.split("/").slice(-2).join("/")
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: view.live ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: { color: "green" },
			children: "online"
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: { color: "red" },
			children: "offline"
		}) }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			title: view.error ?? "",
			children: view.reason ?? view.error ?? "—"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: view.port }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: view.pid ?? "—" }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: view.mode ?? "—" }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: s?.indexed_files ?? "—" }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: s?.total_chunks ?? "—" }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: s?.languages?.join(", ") ?? "—" }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: s?.last_indexed ?? "—" }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: s?.notes_count ?? "—" }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: s?.fully_ready ?? false ? "yes" : "no" }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			disabled,
			title: disabledReason ?? "Re-index this workspace",
			onClick: () => onReindex(view.port),
			children: busy ? "…" : "re-index"
		}) })
	] });
}
/** The full console panel. */
function WorkspaceConsole() {
	const [views, setViews] = (0, react.useState)(null);
	const [error, setError] = (0, react.useState)(null);
	const [loading, setLoading] = (0, react.useState)(false);
	const [busyPort, setBusyPort] = (0, react.useState)(null);
	const [flash, setFlash] = (0, react.useState)(null);
	const refresh = () => {
		setLoading(true);
		setError(null);
		fetch("/api/vectr/workspaces").then((res) => {
			if (!res.ok) throw new Error(`workspaces endpoint returned ${res.status}`);
			return res.json();
		}).then((data) => setViews(data)).catch((err) => setError(String(err))).finally(() => setLoading(false));
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
					disabled: loading,
					onClick: refresh,
					children: "refresh"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: loading ? "loading…" : views === null ? "" : `${views.length} workspace(s)` }),
				flash !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: { color: "gray" },
					children: flash
				}) : null
			]
		}),
		error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
			style: { color: "red" },
			children: ["failed to load workspaces: ", error]
		}) : null,
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
			style: {
				borderCollapse: "collapse",
				width: "100%"
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "workspace" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "status" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "reason" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "port" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "pid" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "mode" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "files" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "chunks" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "languages" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "last indexed" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "notes" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "ready" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "action" })
			] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: views?.map((view) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspaceRow, {
				view,
				onReindex: reindex,
				busy: busyPort === view.port
			}, `${view.workspace}:${view.port}`)) })]
		})
	] });
}
/** Services required by the client half (informational; host resolves them). */
const inject = ["slots"];
/** Mount the workspace console into the Settings → Plugins tab. */
function apply(ctx) {
	ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
		name: "settings.plugins.tab",
		id: "vectr-workspaces",
		order: 20,
		label: () => "Vectr Workspaces"
	}, WorkspaceConsole));
	apply$1(ctx);
}
//#endregion
exports.apply = apply;
exports.inject = inject;

return exports; } });
//# sourceMappingURL=client.js.map