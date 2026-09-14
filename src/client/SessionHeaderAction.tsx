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
import {
  resolveSessionSlotVisibility,
  resolveUnifiedStatus,
  type SessionVectrState,
} from '../domain'
import { VectrStyles } from './buttons'
import { dialogCoordinator } from './dialogCoordinator'

export interface SessionHeaderActionProps {
  sessionId?: string | undefined
  blank?: boolean | undefined
  workspace?: string | undefined
  useSession?: (<T>(selector: (state: any) => T) => T) | undefined
  useSessions?: (<T>(selector: (state: any) => T) => T) | undefined
  [key: string]: unknown
}

export interface ActiveSessionHeaderActionProps {
  sessionCwd?: string | undefined
  [key: string]: unknown
}

export function ActiveSessionHeaderAction(props: ActiveSessionHeaderActionProps): ReactNode {
  const { sessionCwd } = props
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

export interface SessionsBoundHeaderActionProps extends SessionHeaderActionProps {
  useSessions: <T>(selector: (state: any) => T) => T
}

export function SessionsBoundHeaderAction(props: SessionsBoundHeaderActionProps): ReactNode {
  const { useSessions, sessionId } = props

  // Unconditionally invoke useSessions at container top-level (strictly adheres to Rules of Hooks)
  const sessionInfo = useSessions((state: any) => {
    const id = sessionId ? String(sessionId) : ''
    return id ? state?.byId?.[id] : undefined
  })

  const isBlank = props.blank !== undefined ? props.blank : sessionInfo?.blank
  const sessionCwd = sessionInfo?.cwd ?? (typeof props.workspace === 'string' ? props.workspace : undefined)

  const visibility = resolveSessionSlotVisibility({ sessionId, blank: isBlank })
  if (!visibility.shouldRenderHeaderUtility) {
    return null
  }

  return <ActiveSessionHeaderAction sessionCwd={sessionCwd} />
}

export interface SessionBoundHeaderActionProps extends SessionHeaderActionProps {
  useSession: <T>(selector: (state: any) => T) => T
}

export function SessionBoundHeaderAction(props: SessionBoundHeaderActionProps): ReactNode {
  const { useSession, sessionId } = props
  // Unconditionally invoke useSession at container top-level
  const singleSession = useSession((s: any) => s)
  const isBlank = props.blank !== undefined ? props.blank : singleSession?.blank
  const sessionCwd = singleSession?.cwd ?? (typeof props.workspace === 'string' ? props.workspace : undefined)

  const visibility = resolveSessionSlotVisibility({ sessionId, blank: isBlank })
  if (!visibility.shouldRenderHeaderUtility) {
    return null
  }

  return <ActiveSessionHeaderAction sessionCwd={sessionCwd} />
}

export interface DualBoundHeaderActionProps extends SessionHeaderActionProps {
  useSession: <T>(selector: (state: any) => T) => T
  useSessions: <T>(selector: (state: any) => T) => T
}

export function DualBoundHeaderAction(props: DualBoundHeaderActionProps): ReactNode {
  const { useSession, useSessions, sessionId } = props
  // Unconditionally invoke hooks at container top-level
  const singleSession = useSession((s: any) => s)
  const sessionInfo = useSessions((state: any) => {
    const id = sessionId ? String(sessionId) : ''
    return id ? state?.byId?.[id] : undefined
  })

  const isBlank = props.blank !== undefined
    ? props.blank
    : (singleSession?.blank !== undefined ? singleSession.blank : sessionInfo?.blank)
  const sessionCwd = sessionInfo?.cwd ?? singleSession?.cwd ?? (typeof props.workspace === 'string' ? props.workspace : undefined)

  const visibility = resolveSessionSlotVisibility({ sessionId, blank: isBlank })
  if (!visibility.shouldRenderHeaderUtility) {
    return null
  }

  return <ActiveSessionHeaderAction sessionCwd={sessionCwd} />
}

export function SessionHeaderAction(props: SessionHeaderActionProps): ReactNode {
  // 无条件挂载 Hook-bound 容器，确保 Hooks 正常订阅状态变更；可见性判定由各容器内部动态执行
  if (typeof props.useSession === 'function' && typeof props.useSessions === 'function') {
    return <DualBoundHeaderAction {...props} useSession={props.useSession} useSessions={props.useSessions} />
  }

  if (typeof props.useSessions === 'function') {
    return <SessionsBoundHeaderAction {...props} useSessions={props.useSessions} />
  }

  if (typeof props.useSession === 'function') {
    return <SessionBoundHeaderAction {...props} useSession={props.useSession} />
  }

  // 无 Hooks 注入时的降级兜底路径
  const visibility = resolveSessionSlotVisibility({
    sessionId: props.sessionId,
    blank: props.blank,
  })

  if (!visibility.shouldRenderHeaderUtility) {
    return null
  }

  const sessionCwd = typeof props.workspace === 'string' ? props.workspace : undefined
  return <ActiveSessionHeaderAction sessionCwd={sessionCwd} />
}
