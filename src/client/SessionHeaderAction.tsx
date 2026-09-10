/**
 * Session Header Utility Action for Vectr.
 *
 * Mounted into the host slot `conversation.session.header.utilities`.
 * Dynamically tracks the current active session's working directory (`session.cwd`)
 * and displays live status, mode, port, and quick metrics.
 *
 * (Layer 4: Presentation)
 *
 * @module dsh-vectr-client/client/SessionHeaderAction
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { SessionVectrState } from '../domain'
import { VectrStyles } from './buttons'
import { SessionDrawerModal } from './SessionDrawerModal'

export interface SessionHeaderActionProps {
  sessionId?: string | undefined
  useSessions?: (<T>(selector: (state: any) => T) => T) | undefined
  [key: string]: unknown
}

export function SessionHeaderAction(props: SessionHeaderActionProps): ReactNode {
  const { sessionId, useSessions } = props

  // Dynamically retrieve the current session's working directory
  const sessionCwd = useSessions
    ? useSessions((state: any) => (sessionId ? state?.byId?.[String(sessionId)]?.cwd : undefined))
    : undefined

  const [state, setState] = useState<SessionVectrState | null>(null)
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)

  const fetchStatus = async (cwd: string, signal?: AbortSignal): Promise<void> => {
    if (!cwd) return
    setLoading(true)
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
    } finally {
      if (!signal?.aborted) {
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    if (sessionCwd && typeof sessionCwd === 'string') {
      const controller = new AbortController()
      void fetchStatus(sessionCwd, controller.signal)
      return () => {
        controller.abort()
      }
    } else {
      setState(null)
    }
  }, [sessionCwd])

  if (!sessionCwd) {
    return null
  }

  const live = state?.live === true
  const mode = state?.mode ?? 'offline'
  const isMemoryOnly = mode === 'memory_only'

  let badgeText = 'Vectr'
  if (live) {
    badgeText = isMemoryOnly ? `Vectr [mem:${state?.port ?? ''}]` : `Vectr [${state?.port ?? ''}]`
  } else {
    badgeText = 'Vectr [off]'
  }

  return (
    <>
      <VectrStyles />
      <button
        type="button"
        className="vectr-header-capsule"
        onClick={() => setModalOpen(true)}
        title={`Vectr 状态: ${live ? `Live (${mode})` : 'Offline'}\n工作区: ${sessionCwd}`}
        aria-label="Vectr 状态与管理"
      >
        <span
          className={`vectr-indicator-dot ${live ? 'vectr-dot-live' : 'vectr-dot-offline'}`}
        />
        <span>{badgeText}</span>
      </button>

      <SessionDrawerModal
        workspace={sessionCwd}
        state={state}
        loading={loading}
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onRefresh={() => {
          if (sessionCwd) void fetchStatus(sessionCwd)
        }}
      />
    </>
  )
}
