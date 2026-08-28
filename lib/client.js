window.__ModuleLoader__.load({ id: "dsh-vectr-client", factory: (require) => {
var exports = { exports: {} }.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
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
/** Codebases table: 8 columns, narrower minWidth so it does not scroll needlessly. */
const tableStyleCodebases = {
	...tableBase,
	minWidth: 620
};
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
//#region src/client/buttons.tsx
/** One global stylesheet carrying every vectr control class. Injected once. */
const VECTR_CSS = `
.vectr-btn { font: inherit; cursor: pointer; transition: background 120ms; border: 1px solid transparent; }
.vectr-btn:disabled { opacity: .4; cursor: default; }
.vectr-btn:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.vectr-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.vectr-btn-dense { height: 28px; padding: 0 10px; border-radius: 14px; font-size: 12px; }
.vectr-btn-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.vectr-btn-secondary { border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }
.vectr-btn-danger { color: var(--dsw-alias-state-error-primary); }
.vectr-label { display: block; margin-bottom: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.vectr-input, .vectr-select { height: 32px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; box-sizing: border-box; }
.vectr-input:focus, .vectr-select:focus { border-color: var(--dsw-alias-brand-primary); outline: none; }
.vectr-input::placeholder { color: var(--dsw-alias-label-dimmed); }
`;
/** Render the shared stylesheet once. Place inside the Vectr settings shell. */
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
//#region src/client/codebases.tsx
/**
* Browser half of the multi-codebase manager (feature B).
*
* Rendered inside the top-level **Settings → Vectr** section (alongside the
* workspace console) under a tab bar; this component only fetches and renders
* its own data. It fetches the host's `/api/vectr/codebases` endpoints and renders a create
* form plus a table with per-row test / delete actions. Secrets (passwords)
* are submitted on create but never read back or shown.
*
* @module dsh-vectr-client/client/codebases
*/
/** One table row with test / delete actions. Exported for layout-regression tests. */
function CodebaseRow(props) {
	const { view, onTest, onDelete, busy } = props;
	const address = view.type === "remote" ? `${view.host ?? "?"} → 127.0.0.1:${view.localPort ?? "?"}` : `127.0.0.1:${view.localPort ?? "?"}`;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: view.slug
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: view.type
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			title: view.path,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: ellipsisStyle,
				children: view.path
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: ellipsisStyle,
				children: address
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: view.localPort ?? "—"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: view.status === "up" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: { color: "var(--dsw-alias-state-success-primary)" },
				children: "up"
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: { color: "var(--dsw-alias-state-error-primary)" },
				children: [view.status, view.error ? ` (${view.error})` : ""]
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: view.tunnelPid !== void 0 ? String(view.tunnelPid) : "—"
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
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: BTN.action,
					disabled: busy,
					onClick: () => onTest(view.slug),
					children: "test"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: BTN.danger,
					disabled: busy,
					onClick: () => onDelete(view.slug),
					children: "delete"
				})]
			})
		})
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
				display: "flex",
				flexDirection: "column",
				gap: 6,
				marginBottom: 10,
				maxWidth: 520
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
				})] }),
				type === "remote" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
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
				] }) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "submit",
					className: BTN.primary,
					disabled: creating || slug.length === 0 || path.length === 0,
					children: creating ? "…" : "create"
				}),
				formError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: { color: "var(--dsw-alias-state-error-primary)" },
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
					className: BTN.secondary,
					disabled: loading,
					onClick: refresh,
					children: "refresh"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: loading ? "loading…" : views === null ? "" : `${views.length} codebase(s)` }),
				flash !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: { color: "var(--dsw-alias-label-tertiary)" },
					children: flash
				}) : null
			]
		}),
		error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
			style: { color: "var(--dsw-alias-state-error-primary)" },
			children: ["failed to load codebases: ", error]
		}) : null,
		views !== null && views.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			style: {
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: 12
			},
			children: "暂无代码库"
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: scrollWrap,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
				style: tableStyleCodebases,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "slug"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "type"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "path"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "address"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "local port"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "status"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: thStyle,
						children: "tunnel"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
						style: {
							...thStyle,
							minWidth: 110,
							whiteSpace: "nowrap"
						},
						children: "actions"
					})
				] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: views?.map((view) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CodebaseRow, {
					view,
					onTest: test,
					onDelete: del,
					busy: busySlug === view.slug
				}, view.slug)) })]
			})
		})
	] });
}
//#endregion
//#region src/client/vectr-settings.tsx
/**
* Top-level **Settings → Vectr** section shell (改动1).
*
* Replaces the old `settings.plugins.tab` injection that mounted the workspace
* console and the codebase manager as two separate Plugins-tab panels. Now a
* single top-level `settings.section` (id `vectr`) hosts both panels behind a
* tab bar: `Workspaces` and `Codebases`. Each panel keeps fetching its own data
* from the host; this shell only owns which tab is active.
*
* Both panels stay MOUNTED at all times; the inactive one is hidden with
* `display:none` (review B1). This preserves each panel's local form/fetch
* state across tab switches and avoids re-fetching + unmounted-setState warnings.
*
* @module dsh-vectr-client/client/vectr-settings
*/
/** Selected color tracks the host business-primary token (deepseek-500), so it
* follows light/dark automatically instead of a hardcoded `#2b6cb0`. */
const ACTIVE_COLOR = "var(--dsw-alias-state-business-primary)";
const INACTIVE_COLOR = "var(--dsw-alias-label-secondary)";
const tabButtonStyle = (active) => ({
	padding: "4px 10px",
	marginRight: 4,
	cursor: "pointer",
	border: "none",
	borderBottom: active ? `2px solid ${ACTIVE_COLOR}` : "2px solid transparent",
	background: "none",
	color: active ? ACTIVE_COLOR : INACTIVE_COLOR,
	fontWeight: active ? 600 : 400,
	font: "inherit"
});
/** Tab-bar + active-panel host for the Vectr settings section. */
function VectrSettings() {
	const [tab, setTab] = (0, react.useState)("workspaces");
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VectrStyles, {}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				display: "flex",
				marginBottom: 10
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				style: tabButtonStyle(tab === "workspaces"),
				onClick: () => setTab("workspaces"),
				children: "Workspaces"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				style: tabButtonStyle(tab === "codebases"),
				onClick: () => setTab("codebases"),
				children: "Codebases"
			})]
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: { display: tab === "workspaces" ? "block" : "none" },
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspaceConsole, {})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: { display: tab === "codebases" ? "block" : "none" },
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CodebaseManager, {})
		})
	] });
}
//#endregion
//#region src/client/index.tsx
/**
* Browser half of the vectr workspace console (feature A / C1).
*
* A thin React view mounted as the top-level **Settings → Vectr** section via the
* `settings.section` slot (hosted by the VectrSettings shell, which also renders the
* codebase manager under a tab bar). All data lives on the host: this half only
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
				children: busy ? "…" : "re-index"
			})
		})
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
					className: BTN.secondary,
					disabled: loading,
					onClick: refresh,
					children: "refresh"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: loading ? "loading…" : views === null ? "" : `${views.length} workspace(s)` }),
				flash !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: { color: "var(--dsw-alias-label-tertiary)" },
					children: flash
				}) : null
			]
		}),
		error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
			style: { color: "var(--dsw-alias-state-error-primary)" },
			children: ["failed to load workspaces: ", error]
		}) : null,
		views !== null && views.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
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
				] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: views?.map((view) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspaceRow, {
					view,
					onReindex: reindex,
					busy: busyPort === view.port
				}, `${view.workspace}:${view.port}`)) })]
			})
		})
	] });
}
/** Services required by the client half (informational; host resolves them). */
const inject = ["slots"];
/** Order of the Vectr top-level Settings section in the host nav. The built-in
* General/Models/Presets sections use 0–20; 200 keeps Vectr after them. */
const VECTR_SECTION_ORDER = 200;
/** Mount the Vectr shell as a top-level **Settings → Vectr** section. The shell
* owns the Workspaces/Codebases tab bar and renders {@link WorkspaceConsole} and
* the codebase manager; neither panel self-registers anymore. `slots.inject`
* runs its callback as a Cordis effect, so the callback returns the disposer
* `slots.register` yields (not a plain descriptor) or the loader rejects it. */
function apply(ctx) {
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "vectr",
		order: VECTR_SECTION_ORDER,
		label: () => "Vectr"
	}, VectrSettings));
}
//#endregion
exports.WorkspaceConsole = WorkspaceConsole;
exports.apply = apply;
exports.inject = inject;

return exports; } });
//# sourceMappingURL=client.js.map