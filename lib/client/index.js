import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
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
import { useEffect, useState } from 'react';
/** Reason a row's re-index button is disabled, or undefined when enabled. */
function reindexDisabledReason(view) {
    if (!view.live)
        return view.error ?? 'daemon offline';
    const mode = view.mode;
    if (mode === 'memory_only' || mode === 'search_only')
        return `daemon in '${mode}' mode cannot be re-indexed`;
    if (view.status?.reindex_in_progress)
        return 're-index already in progress';
    if (view.status?.fully_ready === false)
        return 'daemon not fully_ready yet';
    return undefined;
}
/** One table row. */
function WorkspaceRow(props) {
    const { view, onReindex, busy } = props;
    const disabledReason = reindexDisabledReason(view);
    const disabled = disabledReason !== undefined || busy;
    const s = view.status;
    return (_jsxs("tr", { children: [_jsx("td", { title: view.workspace, children: view.workspace.split('/').slice(-2).join('/') }), _jsx("td", { children: view.live
                    ? _jsx("span", { style: { color: 'green' }, children: "online" })
                    : _jsxs("span", { style: { color: 'red' }, children: ["offline", view.error ? ` (${view.error})` : ''] }) }), _jsx("td", { children: view.port }), _jsx("td", { children: view.pid ?? '—' }), _jsx("td", { children: view.mode ?? '—' }), _jsx("td", { children: s?.indexed_files ?? '—' }), _jsx("td", { children: s?.total_chunks ?? '—' }), _jsx("td", { children: s?.languages?.join(', ') ?? '—' }), _jsx("td", { children: s?.last_indexed ?? '—' }), _jsx("td", { children: s?.notes_count ?? '—' }), _jsx("td", { children: (s?.fully_ready ?? false) ? 'yes' : 'no' }), _jsx("td", { children: _jsx("button", { type: "button", disabled: disabled, title: disabledReason ?? 'Re-index this workspace', onClick: () => onReindex(view.port), children: busy ? '…' : 're-index' }) })] }));
}
/** The full console panel. */
function WorkspaceConsole() {
    const [views, setViews] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [busyPort, setBusyPort] = useState(null);
    const [flash, setFlash] = useState(null);
    const refresh = () => {
        setLoading(true);
        setError(null);
        fetch('/api/vectr/workspaces')
            .then((res) => {
            if (!res.ok)
                throw new Error(`workspaces endpoint returned ${res.status}`);
            return res.json();
        })
            .then((data) => setViews(data))
            .catch((err) => setError(String(err)))
            .finally(() => setLoading(false));
    };
    useEffect(() => { refresh(); }, []);
    const reindex = (port) => {
        setBusyPort(port);
        setFlash(null);
        fetch('/api/vectr/trigger-index', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ port }),
        })
            .then((res) => res.json())
            .then((result) => {
            if (result.ok)
                setFlash(`re-index triggered for port ${port}`);
            else
                setFlash(`re-index failed: ${result.error ?? 'unknown error'}`);
            refresh();
        })
            .catch((err) => setFlash(`re-index request error: ${String(err)}`))
            .finally(() => setBusyPort(null));
    };
    return (_jsxs("div", { children: [_jsxs("div", { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }, children: [_jsx("button", { type: "button", disabled: loading, onClick: refresh, children: "refresh" }), _jsx("span", { children: loading ? 'loading…' : views === null ? '' : `${views.length} workspace(s)` }), flash !== null ? _jsx("span", { style: { color: 'gray' }, children: flash }) : null] }), error !== null
                ? _jsxs("p", { style: { color: 'red' }, children: ["failed to load workspaces: ", error] })
                : null, _jsxs("table", { style: { borderCollapse: 'collapse', width: '100%' }, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "workspace" }), _jsx("th", { children: "status" }), _jsx("th", { children: "port" }), _jsx("th", { children: "pid" }), _jsx("th", { children: "mode" }), _jsx("th", { children: "files" }), _jsx("th", { children: "chunks" }), _jsx("th", { children: "languages" }), _jsx("th", { children: "last indexed" }), _jsx("th", { children: "notes" }), _jsx("th", { children: "ready" }), _jsx("th", { children: "action" })] }) }), _jsx("tbody", { children: views?.map((view) => (_jsx(WorkspaceRow, { view: view, onReindex: reindex, busy: busyPort === view.port }, `${view.workspace}:${view.port}`))) })] })] }));
}
/** Services required by the client half (informational; host resolves them). */
export const inject = ['slots'];
/** Mount the workspace console into the Settings → Plugins tab. */
export function apply(ctx) {
    ctx.slots.inject('settings.plugins.tab', () => ({
        name: 'settings.plugins.tab',
        id: 'vectr-workspaces',
        order: 20,
        label: () => 'Vectr Workspaces',
        children: {},
    }), WorkspaceConsole);
}
//# sourceMappingURL=index.js.map