/**
 * Dialog Coordinator for cross-slot Vectr modal triggering.
 *
 * Coordinates dialog opening/closing across session header utilities,
 * conversation input bar actions, and blank session views.
 *
 * @module dsh-vectr-client/client/dialogCoordinator
 */
export interface DialogCoordinatorState {
    isOpen: boolean;
    workspace?: string | undefined;
}
export type DialogListener = (state: DialogCoordinatorState) => void;
export declare class DialogCoordinator {
    private listeners;
    private state;
    subscribe(listener: DialogListener): () => void;
    open(workspace?: string): void;
    close(): void;
    getState(): DialogCoordinatorState;
    private notify;
}
export declare const dialogCoordinator: DialogCoordinator;
//# sourceMappingURL=dialogCoordinator.d.ts.map