/**
 * Conversation Input Right Action for Vectr.
 *
 * Mounted into the host slot `conversation.input.right`.
 * Provides a persistent Vectr trigger next to the prompt composer,
 * ensuring accessibility on both blank (new chat) and active sessions.
 * Acts as a pure trigger for `dialogCoordinator.open(workspace)`.
 *
 * (Layer 4: Presentation)
 *
 * @module dsh-vectr-client/client/ConversationInputRightAction
 */

import type { ReactNode } from 'react'
import { resolveSessionSlotVisibility } from '../domain'
import { VectrStyles } from './buttons'
import { VectrNavIcon } from './VectrNavIcon'
import { dialogCoordinator } from './dialogCoordinator'

export interface ConversationInputRightActionProps {
  sessionId?: string | undefined
  blank?: boolean | undefined
  useSession?: (<T>(selector: (state: any) => T) => T) | undefined
  useSessions?: (<T>(selector: (state: any) => T) => T) | undefined
  workspace?: string | undefined
  [key: string]: unknown
}

export function StaticInputRightAction(props: ConversationInputRightActionProps): ReactNode {
  const effectiveWorkspace =
    typeof props.workspace === 'string' && props.workspace ? props.workspace : '.'

  const handleOpen = (): void => {
    dialogCoordinator.open(effectiveWorkspace)
  }

  return (
    <>
      <VectrStyles />
      <button
        type="button"
        className="vectr-btn vectr-btn-dense"
        style={{
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          height: 28,
          padding: '0 8px',
          borderRadius: 6,
          fontSize: 12,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
        }}
        onClick={handleOpen}
        title="Vectr Search & Memory Console"
        aria-label="Vectr status and management"
      >
        <VectrNavIcon size={14} />
        <span>Vectr</span>
      </button>
    </>
  )
}

export interface SessionBoundInputRightActionProps extends ConversationInputRightActionProps {
  useSession: <T>(selector: (state: any) => T) => T
}

export function SessionBoundInputRightAction(props: SessionBoundInputRightActionProps): ReactNode {
  const { useSession, sessionId } = props
  // Unconditionally call hook without optional chaining
  const singleSession = useSession((s: any) => s)
  const isBlank = props.blank !== undefined ? props.blank : singleSession?.blank
  const sessionCwd = singleSession?.cwd

  const visibility = resolveSessionSlotVisibility({ sessionId, blank: isBlank })
  if (!visibility.shouldRenderInputRight) {
    return null
  }

  const effectiveWorkspace = sessionCwd || (typeof props.workspace === 'string' ? props.workspace : undefined)
  return <StaticInputRightAction {...props} workspace={effectiveWorkspace} />
}

export interface SessionsBoundInputRightActionProps extends ConversationInputRightActionProps {
  useSessions: <T>(selector: (state: any) => T) => T
}

export function SessionsBoundInputRightAction(props: SessionsBoundInputRightActionProps): ReactNode {
  const { useSessions, sessionId } = props
  // Unconditionally call hook without optional chaining
  const sessionInfo = useSessions((state: any) => {
    const id = sessionId ? String(sessionId) : ''
    return id ? state?.byId?.[id] : undefined
  })
  const sessionCwd = sessionInfo?.cwd
  const isBlank = props.blank !== undefined ? props.blank : sessionInfo?.blank

  const visibility = resolveSessionSlotVisibility({ sessionId, blank: isBlank })
  if (!visibility.shouldRenderInputRight) {
    return null
  }

  const effectiveWorkspace = sessionCwd || (typeof props.workspace === 'string' ? props.workspace : undefined)
  return <StaticInputRightAction {...props} workspace={effectiveWorkspace} />
}

export interface DualBoundInputRightActionProps extends ConversationInputRightActionProps {
  useSession: <T>(selector: (state: any) => T) => T
  useSessions: <T>(selector: (state: any) => T) => T
}

export function DualBoundInputRightAction(props: DualBoundInputRightActionProps): ReactNode {
  const { useSession, useSessions, sessionId } = props
  // Unconditionally call hooks at top level
  const singleSession = useSession((s: any) => s)
  const sessionInfo = useSessions((state: any) => {
    const id = sessionId ? String(sessionId) : ''
    return id ? state?.byId?.[id] : undefined
  })
  const sessionCwd = sessionInfo?.cwd ?? singleSession?.cwd
  const isBlank = props.blank !== undefined
    ? props.blank
    : (singleSession?.blank !== undefined ? singleSession.blank : sessionInfo?.blank)

  const visibility = resolveSessionSlotVisibility({ sessionId, blank: isBlank })
  if (!visibility.shouldRenderInputRight) {
    return null
  }

  const effectiveWorkspace = sessionCwd || (typeof props.workspace === 'string' ? props.workspace : undefined)
  return <StaticInputRightAction {...props} workspace={effectiveWorkspace} />
}

export function ConversationInputRightAction(props: ConversationInputRightActionProps): ReactNode {
  // Use dual-bound container when both hooks are available
  if (typeof props.useSession === 'function' && typeof props.useSessions === 'function') {
    return (
      <DualBoundInputRightAction
        {...props}
        useSession={props.useSession}
        useSessions={props.useSessions}
      />
    )
  }

  // Fallback to single hook containers
  if (typeof props.useSessions === 'function') {
    return <SessionsBoundInputRightAction {...props} useSessions={props.useSessions} />
  }

  if (typeof props.useSession === 'function') {
    return <SessionBoundInputRightAction {...props} useSession={props.useSession} />
  }

  const visibility = resolveSessionSlotVisibility({
    sessionId: props.sessionId,
    blank: props.blank,
  })

  if (!visibility.shouldRenderInputRight) {
    return null
  }

  return <StaticInputRightAction {...props} />
}
