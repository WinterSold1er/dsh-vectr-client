/**
 * Global singleton modal root for Vectr.
 *
 * Subscribes to `dialogCoordinator` and renders a single instance of `SessionDrawerModal`.
 * Avoids duplicate modals and overlapping backdrops across trigger slots.
 *
 * @module dsh-vectr-client/client/VectrDialogRoot
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { SessionVectrState } from '../domain'
import { VectrStyles } from './buttons'
import { dialogCoordinator } from './dialogCoordinator'
import { SessionDrawerModal } from './SessionDrawerModal'

export function VectrDialogRoot(): ReactNode {
  const [isOpen, setIsOpen] = useState(false)
  const [workspace, setWorkspace] = useState<string | undefined>(undefined)
  const [state, setState] = useState<SessionVectrState | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    return dialogCoordinator.subscribe((coordState) => {
      setIsOpen(coordState.isOpen)
      setWorkspace(coordState.workspace)
    })
  }, [])

  const fetchStatus = async (ws: string, signal?: AbortSignal): Promise<void> => {
    if (!ws) return
    setLoading(true)
    try {
      const res = await fetch(
        `/api/vectr/session-status?workspace=${encodeURIComponent(ws)}`,
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
    if (isOpen && workspace) {
      const controller = new AbortController()
      void fetchStatus(workspace, controller.signal)
      return () => {
        controller.abort()
      }
    } else if (!isOpen) {
      setState(null)
    }
  }, [isOpen, workspace])

  if (!isOpen || !workspace) {
    return null
  }

  return (
    <>
      <VectrStyles />
      <SessionDrawerModal
        workspace={workspace}
        state={state}
        loading={loading}
        isOpen={isOpen}
        onClose={() => dialogCoordinator.close()}
        onRefresh={() => {
          if (workspace) void fetchStatus(workspace)
        }}
      />
    </>
  )
}
