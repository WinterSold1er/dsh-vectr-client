/**
 * One-click daemon launcher for the workspace console (改动: 一键拉起全部 daemon).
 *
 * `DaemonLauncher` owns the request/state; `DaemonLauncherView` is the hook-free
 * presentational half (same split as `WorkspaceConsole` / `WorkspaceConsoleView`)
 * so it can be rendered headlessly by the client specs — this repo has no jsdom,
 * and `react-dom/server` renders one pass without running effects.
 *
 * The summary line and the per-failure rows come from the REAL response body —
 * never from client-side guessing — and a transport/parse failure renders the
 * real error text.
 *
 * @module dsh-vectr-client/client/DaemonLauncher
 */
import { type ReactNode } from 'react';
/** One workspace's outcome, mirroring `StartAllEntryResult` in `src/index.ts`. */
export interface StartAllEntryResult {
    workspace: string;
    port: number | null;
    status: 'started' | 'already-running' | 'failed';
    error?: string;
}
/** Response body of `POST /api/vectr/daemons/start-all`. */
export interface StartAllResponse {
    ok: boolean;
    started: number;
    alreadyRunning: number;
    failed: number;
    results: StartAllEntryResult[];
}
/** Props of the hook-free launcher view. */
export interface DaemonLauncherViewProps {
    busy: boolean;
    /** Last response, or `null` before the first completed sweep. */
    data: StartAllResponse | null;
    /** Transport/HTTP failure text, or `null`. */
    error: string | null;
    onRun: () => void;
}
/**
 * Presentational half: the button, the summary line and the per-failure rows.
 *
 * @param props - see {@link DaemonLauncherViewProps}.
 * @returns the launcher markup for the given state.
 */
export declare function DaemonLauncherView(props: DaemonLauncherViewProps): ReactNode;
/**
 * Button + result panel for "start every registered workspace's daemon".
 *
 * @param props.onChanged - called after every completed sweep (HTTP 200) so the
 *   console can re-fetch its workspace table; the sweep may have started daemons.
 * @returns the launcher markup.
 */
export declare function DaemonLauncher(props: {
    onChanged?: (() => void) | undefined;
}): ReactNode;
//# sourceMappingURL=DaemonLauncher.d.ts.map