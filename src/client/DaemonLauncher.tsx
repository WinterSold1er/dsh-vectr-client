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

import { useState, type ReactNode } from 'react'
import { BTN } from './buttons'

/** One workspace's outcome, mirroring `StartAllEntryResult` in `src/index.ts`. */
export interface StartAllEntryResult {
  workspace: string
  port: number | null
  status: 'started' | 'already-running' | 'failed'
  error?: string
}

/** Response body of `POST /api/vectr/daemons/start-all`. */
export interface StartAllResponse {
  ok: boolean
  started: number
  alreadyRunning: number
  failed: number
  results: StartAllEntryResult[]
}

/** Props of the hook-free launcher view. */
export interface DaemonLauncherViewProps {
  busy: boolean
  /** Last response, or `null` before the first completed sweep. */
  data: StartAllResponse | null
  /** Transport/HTTP failure text, or `null`. */
  error: string | null
  onRun: () => void
}

/**
 * Presentational half: the button, the summary line and the per-failure rows.
 *
 * @param props - see {@link DaemonLauncherViewProps}.
 * @returns the launcher markup for the given state.
 */
export function DaemonLauncherView(props: DaemonLauncherViewProps): ReactNode {
  const { busy, data, error, onRun } = props
  const failures = data === null ? [] : data.results.filter(r => r.status === 'failed')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className={BTN.primary} disabled={busy} onClick={onRun}>
          {busy ? '正在启动…' : '一键启动全部 Daemon'}
        </button>
        {data !== null && (
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }}>
            {`已启动 ${data.started} · 已在运行 ${data.alreadyRunning} · 失败 ${data.failed}`}
          </span>
        )}
      </div>
      {error !== null && (
        <div style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</div>
      )}
      {failures.map(result => (
        <div
          key={result.workspace}
          style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' }}
        >
          {`${result.workspace}: ${result.error ?? 'unknown error'}`}
        </div>
      ))}
    </div>
  )
}

/**
 * Button + result panel for "start every registered workspace's daemon".
 *
 * @param props.onChanged - called after every completed sweep (HTTP 200) so the
 *   console can re-fetch its workspace table; the sweep may have started daemons.
 * @returns the launcher markup.
 */
export function DaemonLauncher(props: { onChanged?: (() => void) | undefined }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [data, setData] = useState<StartAllResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = (): void => {
    setBusy(true)
    setError(null)
    fetch('/api/vectr/daemons/start-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(async res => ({ res, payload: (await res.json()) as StartAllResponse & { error?: string } }))
      .then(({ res, payload }) => {
        if (!res.ok) {
          setError(payload.error ?? `start-all endpoint returned ${res.status}`)
          return
        }
        setData(payload)
        props.onChanged?.()
      })
      .catch((err: unknown) => setError(`start-all request error: ${String(err)}`))
      .finally(() => setBusy(false))
  }

  return <DaemonLauncherView busy={busy} data={data} error={error} onRun={run} />
}
