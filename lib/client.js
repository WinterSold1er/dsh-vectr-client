window.__ModuleLoader__.load({ id: "dsh-vectr-client", factory: (require) => {
var exports = { exports: {} }.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
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