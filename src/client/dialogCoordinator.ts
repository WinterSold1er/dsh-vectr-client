/**
 * Dialog Coordinator for cross-slot Vectr modal triggering.
 *
 * Coordinates dialog opening/closing across session header utilities,
 * conversation input bar actions, and blank session views.
 *
 * @module dsh-vectr-client/client/dialogCoordinator
 */

export interface DialogCoordinatorState {
  isOpen: boolean
  workspace?: string | undefined
}

export type DialogListener = (state: DialogCoordinatorState) => void

export class DialogCoordinator {
  private listeners = new Set<DialogListener>()
  private state: DialogCoordinatorState = { isOpen: false }

  subscribe(listener: DialogListener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }

  open(workspace?: string): void {
    this.state = { isOpen: true, workspace }
    this.notify()
  }

  close(): void {
    this.state = { isOpen: false, workspace: undefined }
    this.notify()
  }

  getState(): DialogCoordinatorState {
    return this.state
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state)
      } catch {}
    }
  }
}

export const dialogCoordinator = new DialogCoordinator()
