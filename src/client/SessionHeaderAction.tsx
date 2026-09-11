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

import { useEffect, useState, type ReactNode } from 'react'
import { hasActiveSession, resolveUnifiedStatus, type SessionVectrState } from '../domain'
import { VectrStyles } from './buttons'
import { dialogCoordinator } from './dialogCoordinator'

export interface SessionHeaderActionProps {
  sessionId?: string | undefined
  useSessions?: (<T>(selector: (state: any) => T) => T) | undefined
  [key: string]: unknown
}

function ActiveSessionHeaderAction(props: SessionHeaderActionProps): ReactNode {
  const { sessionId, useSessions } = props

  // Dynamically retrieve the current session's working directory
  const sessionCwd = useSessions
    ? useSessions((state: any) => (sessionId ? state?.byId?.[String(sessionId)]?.cwd : undefined))
    : undefined

  const [state, setState] = useState<SessionVectrState | null>(null)

  const fetchStatus = async (cwd: string, signal?: AbortSignal): Promise<void> => {
    if (!cwd) return
    try {
      const res = await fetch(
        `/api/vectr/session-status?workspace=${encodeURIComponent(cwd)}`,
        signal ? { signal } : undefined,
      )
      if (res.ok) {
        const data = (await res.json()) as SessionVectrState
        setState(data)
      } else {
        setState(null)
      }
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'AbortError' || signal?.aborted) {
        return
      }
      setState(null)
    }
  }

  useEffect(() => {
    if (!sessionCwd || typeof sessionCwd !== 'string' || sessionCwd.trim().length === 0) {
      setState(null)
      return
    }
    const controller = new AbortController()
    void fetchStatus(sessionCwd.trim(), controller.signal)
    return () => {
      controller.abort()
    }
  }, [sessionCwd])

  const unifiedStatus = resolveUnifiedStatus({
    live: state?.live,
    mode: state?.mode,
    status: state?.status,
    reason: state?.reason,
    error: state?.error,
  })

  let badgeText = 'Vectr'
  if (unifiedStatus.kind === 'ready') {
    badgeText = state?.port ? `Vectr [${state.port}]` : 'Vectr'
  } else if (unifiedStatus.kind === 'memory_only') {
    badgeText = state?.port ? `Vectr [mem:${state.port}]` : 'Vectr [mem]'
  } else if (unifiedStatus.kind === 'indexing') {
    badgeText = state?.port ? `Vectr [idx:${state.port}]` : 'Vectr [indexing]'
  } else if (unifiedStatus.kind === 'initializing') {
    badgeText = state?.port ? `Vectr [init:${state.port}]` : 'Vectr [init]'
  } else if (unifiedStatus.kind === 'search_only') {
    badgeText = state?.port ? `Vectr [search:${state.port}]` : 'Vectr [search]'
  } else if (unifiedStatus.label === 'Error') {
    badgeText = 'Vectr [err]'
  } else {
    badgeText = 'Vectr [off]'
  }

  const dotClass =
    unifiedStatus.kind === 'ready' || unifiedStatus.kind === 'memory_only' || unifiedStatus.kind === 'search_only'
      ? 'vectr-dot-live'
      : unifiedStatus.isBusy
        ? 'vectr-dot-live'
        : unifiedStatus.label === 'Error'
          ? 'vectr-dot-error'
          : 'vectr-dot-offline'

  const handleOpen = (): void => {
    if (typeof sessionCwd === 'string' && sessionCwd.trim().length > 0) {
      dialogCoordinator.open(sessionCwd.trim())
    }
  }

  return (
    <>
      <VectrStyles />
      <button
        type="button"
        className="vectr-header-capsule"
        onClick={handleOpen}
        title={`Vectr Status: ${unifiedStatus.label}${unifiedStatus.description ? ` (${unifiedStatus.description})` : ''}${sessionCwd ? `\nWorkspace: ${sessionCwd}` : ''}`}
        aria-label="Vectr status and management"
      >
        <span className={`vectr-indicator-dot ${dotClass}`} />
        <span>{badgeText}</span>
      </button>
    </>
  )
}

export function SessionHeaderAction(props: SessionHeaderActionProps): ReactNode {
  // In blank or new sessions, the top header capsule must not render or trigger requests
  if (!hasActiveSession(props.sessionId)) {
    return null
  }
  return <ActiveSessionHeaderAction {...props} />
}
