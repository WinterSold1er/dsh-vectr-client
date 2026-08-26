import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
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
import { useEffect, useState } from 'react';
/** One table row with test / delete actions. */
function CodebaseRow(props) {
    const { view, onTest, onDelete, busy } = props;
    const address = view.type === 'remote'
        ? `${view.host ?? '?'} → 127.0.0.1:${view.localPort ?? '?'}`
        : `127.0.0.1:${view.localPort ?? '?'}`;
    return (_jsxs("tr", { children: [_jsx("td", { children: view.slug }), _jsx("td", { children: view.type }), _jsx("td", { title: view.path, children: view.path }), _jsx("td", { children: address }), _jsx("td", { children: view.localPort ?? '—' }), _jsx("td", { children: view.status === 'up'
                    ? _jsx("span", { style: { color: 'green' }, children: "up" })
                    : _jsxs("span", { style: { color: 'red' }, children: [view.status, view.error ? ` (${view.error})` : ''] }) }), _jsx("td", { children: view.tunnelPid !== undefined ? String(view.tunnelPid) : '—' }), _jsxs("td", { children: [_jsx("button", { type: "button", disabled: busy, onClick: () => onTest(view.slug), children: "test" }), _jsx("button", { type: "button", disabled: busy, onClick: () => onDelete(view.slug), style: { marginLeft: 4 }, children: "delete" })] })] }));
}
/** The full codebase manager panel. */
function CodebaseManager() {
    const [views, setViews] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [busySlug, setBusySlug] = useState(null);
    const [flash, setFlash] = useState(null);
    // Form state
    const [type, setType] = useState('local');
    const [slug, setSlug] = useState('');
    const [path, setPath] = useState('');
    const [host, setHost] = useState('');
    const [auth, setAuth] = useState('key');
    const [password, setPassword] = useState('');
    const [formError, setFormError] = useState(null);
    const [creating, setCreating] = useState(false);
    const refresh = () => {
        setLoading(true);
        setError(null);
        fetch('/api/vectr/codebases')
            .then((res) => {
            if (!res.ok)
                throw new Error(`codebases endpoint returned ${res.status}`);
            return res.json();
        })
            .then((data) => setViews(data))
            .catch((err) => setError(String(err)))
            .finally(() => setLoading(false));
    };
    useEffect(() => { refresh(); }, []);
    const submit = (e) => {
        e.preventDefault();
        setFormError(null);
        setCreating(true);
        const body = { type, slug, path };
        if (type === 'remote') {
            body.host = host;
            body.auth = auth;
            if (auth === 'password')
                body.password = password;
        }
        fetch('/api/vectr/codebases', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })
            .then((res) => res.json())
            .then((result) => {
            if (result.error !== undefined) {
                setFormError(result.error ?? 'create failed');
            }
            else {
                setFlash(`codebase "${slug}" created`);
                setSlug('');
                setPath('');
                setHost('');
                setPassword('');
                refresh();
            }
        })
            .catch((err) => setFormError(`create request error: ${String(err)}`))
            .finally(() => setCreating(false));
    };
    const run = (slug, method, suffix, okFlash) => {
        setBusySlug(slug);
        setFlash(null);
        fetch(`/api/vectr/codebases/${encodeURIComponent(slug)}${suffix}`, { method })
            .then((res) => res.json())
            .then((result) => {
            if (result.ok === false) {
                setFlash(`failed: ${result.error ?? 'unknown error'}`);
            }
            else {
                setFlash(okFlash);
                refresh();
            }
        })
            .catch((err) => setFlash(`request error: ${String(err)}`))
            .finally(() => setBusySlug(null));
    };
    const test = (slug) => run(slug, 'POST', '/test', `tested ${slug}`);
    const del = (slug) => run(slug, 'DELETE', '', `deleted ${slug}`);
    return (_jsxs("div", { children: [_jsx("h4", { style: { margin: '12px 0 6px' }, children: "Codebases" }), _jsxs("form", { onSubmit: submit, style: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: 6, marginBottom: 10, maxWidth: 520 }, children: [_jsx("label", { children: "type" }), _jsxs("select", { value: type, onChange: (e) => setType(e.target.value), children: [_jsx("option", { value: "local", children: "local" }), _jsx("option", { value: "remote", children: "remote" })] }), _jsx("label", { children: "slug" }), _jsx("input", { value: slug, onChange: (e) => setSlug(e.target.value), placeholder: "my-codebase", required: true }), _jsx("label", { children: "path" }), _jsx("input", { value: path, onChange: (e) => setPath(e.target.value), placeholder: "/abs/path", required: true }), type === 'remote'
                        ? (_jsxs(_Fragment, { children: [_jsx("label", { children: "host" }), _jsx("input", { value: host, onChange: (e) => setHost(e.target.value), placeholder: "user@host", required: true }), _jsx("label", { children: "auth" }), _jsxs("select", { value: auth, onChange: (e) => setAuth(e.target.value), children: [_jsx("option", { value: "key", children: "key" }), _jsx("option", { value: "password", children: "password" })] }), auth === 'password'
                                    ? (_jsxs(_Fragment, { children: [_jsx("label", { children: "password" }), _jsx("input", { type: "password", value: password, onChange: (e) => setPassword(e.target.value), placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022" })] }))
                                    : null] }))
                        : null, _jsx("span", {}), _jsx("button", { type: "submit", disabled: creating || slug.length === 0 || path.length === 0, children: creating ? '…' : 'create' }), formError !== null
                        ? _jsx("span", { style: { color: 'red', gridColumn: '1 / span 2' }, children: formError })
                        : null] }), _jsxs("div", { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }, children: [_jsx("button", { type: "button", disabled: loading, onClick: refresh, children: "refresh" }), _jsx("span", { children: loading ? 'loading…' : views === null ? '' : `${views.length} codebase(s)` }), flash !== null ? _jsx("span", { style: { color: 'gray' }, children: flash }) : null] }), error !== null
                ? _jsxs("p", { style: { color: 'red' }, children: ["failed to load codebases: ", error] })
                : null, _jsxs("table", { style: { borderCollapse: 'collapse', width: '100%' }, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "slug" }), _jsx("th", { children: "type" }), _jsx("th", { children: "path" }), _jsx("th", { children: "address" }), _jsx("th", { children: "local port" }), _jsx("th", { children: "status" }), _jsx("th", { children: "tunnel" }), _jsx("th", { children: "actions" })] }) }), _jsx("tbody", { children: views?.map((view) => (_jsx(CodebaseRow, { view: view, onTest: test, onDelete: del, busy: busySlug === view.slug }, view.slug))) })] })] }));
}
/** Services required by the client half (informational; host resolves them). */
export const inject = ['slots'];
/** Mount the codebase manager into the Settings → Plugins tab (alongside the workspace console). */
export function apply(ctx) {
    ctx.slots.inject('settings.plugins.tab', () => ({
        name: 'settings.plugins.tab',
        id: 'vectr-codebases',
        order: 21,
        label: () => 'Vectr Codebases',
        children: {},
    }), CodebaseManager);
}
//# sourceMappingURL=codebases.js.map