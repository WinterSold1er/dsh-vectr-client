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
  type UnifiedStatus,
} from '../domain'
import { VectrStyles } from './buttons'
import { dialogCoordinator } from './dialogCoordinator'

/**
 * Busy indicator for a *ready* daemon that still has background work running.
 * `VectrStyles` (buttons.tsx) is owned by another task, so this single class
 * lives here until it can be folded into that shared stylesheet. Host tokens
 * only — no hardcoded colour.
 */
const BUSY_DOT_CSS = `
.vectr-dot-busy {
  background: var(--dsw-alias-state-warn-primary);
  animation: vectr-dot-pulse 1.4s ease-in-out infinite;
}
@keyframes vectr-dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
`

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

/**
 * Fetch one workspace's status and report the outcome through `apply`.
 *
 * A failure must never collapse into a nameless offline state: both a non-ok
 * response and a transport/parse failure produce a state whose `error` carries
 * the real reason. `resolveUnifiedStatus` then yields label `'Error'` with that
 * text as its description, so the capsule renders `Vectr [err]` and the tooltip
 * carries the actual cause instead of hiding it.
 *
 * Exported and taking `apply` so this failure contract is testable without a
 * DOM: the repo has no jsdom, and `useEffect` never runs under static rendering.
 */
export async function fetchSessionStatus(
  cwd: string,
  signal: AbortSignal | undefined,
  apply: (state: SessionVectrState) => void,
): Promise<void> {
  if (!cwd) return

  const failed = (error: string): SessionVectrState => ({
    workspace: cwd,
    live: false,
    mode: 'offline',
    codebases: [],
    canReindex: false,
    error,
  })

  try {
    const res = await fetch(
      `/api/vectr/session-status?workspace=${encodeURIComponent(cwd)}`,
      signal ? { signal } : undefined,
    )
    if (res.ok) {
      const data = (await res.json()) as SessionVectrState
      apply(data)
      return
    }
    // Keep the status code AND whatever the endpoint said about the failure.
    let detail = ''
    try {
      const body = (await res.text()).trim()
      if (body) detail = ` ${body.slice(0, 200)}`
    } catch (bodyErr: unknown) {
      detail = ` (响应体读取失败: ${String(bodyErr)})`
    }
    apply(failed(`状态查询失败: HTTP ${res.status}${detail}`))
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'AbortError' || signal?.aborted) {
      return
    }
    apply(failed(`状态查询失败: ${String(err)}`))
  }
}

export function ActiveSessionHeaderAction(props: ActiveSessionHeaderActionProps): ReactNode {
  const { sessionCwd } = props
  const [state, setState] = useState<SessionVectrState | null>(null)

  useEffect(() => {
    if (!sessionCwd || typeof sessionCwd !== 'string' || sessionCwd.trim().length === 0) {
      setState(null)
      return
    }
    const controller = new AbortController()
    void fetchSessionStatus(sessionCwd.trim(), controller.signal, setState)
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

  const handleOpen = (): void => {
    if (typeof sessionCwd === 'string' && sessionCwd.trim().length > 0) {
      dialogCoordinator.open(sessionCwd.trim())
    }
  }

  return (
    <HeaderCapsule
      unifiedStatus={unifiedStatus}
      port={state?.port}
      sessionCwd={sessionCwd}
      onOpen={handleOpen}
    />
  )
}

export interface HeaderCapsuleProps {
  unifiedStatus: UnifiedStatus
  port?: number | undefined
  sessionCwd?: string | undefined
  onOpen: () => void
}

/**
 * Hook-free capsule presentation. Everything the user sees in the header badge
 * (text, dot state, tooltip) is decided here from the resolved status alone, so
 * the status-surface specs can render it headlessly with a payload. The
 * hook-bound `ActiveSessionHeaderAction` keeps the fetch, the state and the
 * dialog-coordinator hand-off.
 */
export function HeaderCapsule({ unifiedStatus, port, sessionCwd, onOpen }: HeaderCapsuleProps): ReactNode {
  let badgeText = 'Vectr'
  if (unifiedStatus.kind === 'ready') {
    badgeText = port ? `Vectr [${port}]` : 'Vectr'
  } else if (unifiedStatus.kind === 'memory_only') {
    badgeText = port ? `Vectr [mem:${port}]` : 'Vectr [mem]'
  } else if (unifiedStatus.kind === 'indexing') {
    badgeText = port ? `Vectr [idx:${port}]` : 'Vectr [indexing]'
  } else if (unifiedStatus.kind === 'initializing') {
    badgeText = port ? `Vectr [init:${port}]` : 'Vectr [init]'
  } else if (unifiedStatus.kind === 'search_only') {
    badgeText = port ? `Vectr [search:${port}]` : 'Vectr [search]'
  } else if (unifiedStatus.label === 'Error') {
    badgeText = 'Vectr [err]'
  } else {
    badgeText = 'Vectr [off]'
  }

  // A ready daemon with background work keeps the ready badge, but its dot
  // pulses: the capsule must not read as idle while a re-index is running.
  const hasBackgroundWork = unifiedStatus.kind === 'ready' && Boolean(unifiedStatus.background)

  const dotClass =
    unifiedStatus.kind === 'ready'
      ? hasBackgroundWork
        ? 'vectr-dot-busy'
        : 'vectr-dot-live'
      : unifiedStatus.kind === 'memory_only' || unifiedStatus.kind === 'search_only'
        ? 'vectr-dot-live'
        : unifiedStatus.isBusy
          ? 'vectr-dot-live'
          : unifiedStatus.label === 'Error'
            ? 'vectr-dot-error'
            : 'vectr-dot-offline'

  return (
    <>
      <VectrStyles />
      <style>{BUSY_DOT_CSS}</style>
      <button
        type="button"
        className="vectr-header-capsule"
        onClick={onOpen}
        title={`Vectr Status: ${unifiedStatus.label}${unifiedStatus.background ? ` — ${unifiedStatus.background}` : ''}${unifiedStatus.description ? ` (${unifiedStatus.description})` : ''}${sessionCwd ? `\nWorkspace: ${sessionCwd}` : ''}`}
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
