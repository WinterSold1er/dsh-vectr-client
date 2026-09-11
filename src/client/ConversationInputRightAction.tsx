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
import { VectrStyles } from './buttons'
import { VectrNavIcon } from './VectrNavIcon'
import { dialogCoordinator } from './dialogCoordinator'

export interface ConversationInputRightActionProps {
  sessionId?: string | undefined
  useSessions?: (<T>(selector: (state: any) => T) => T) | undefined
  workspace?: string | undefined
  [key: string]: unknown
}

export function ConversationInputRightAction(props: ConversationInputRightActionProps): ReactNode {
  const { sessionId, useSessions } = props

  // Track active session cwd or fallback workspace
  const sessionCwd = useSessions
    ? useSessions((state: any) => (sessionId ? state?.byId?.[String(sessionId)]?.cwd : undefined))
    : props.workspace

  const effectiveWorkspace = (typeof sessionCwd === 'string' && sessionCwd)
    ? sessionCwd
    : '.'

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
        title="Vectr 语义检索与工作记忆控制台"
        aria-label="Vectr 状态与管理"
      >
        <VectrNavIcon size={14} />
        <span>Vectr</span>
      </button>
    </>
  )
}
