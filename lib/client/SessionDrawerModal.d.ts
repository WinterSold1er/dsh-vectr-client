/**
 * Session Drawer Modal for Vectr status, codebase management, init, and working memory.
 *
 * (Layer 4: Presentation)
 *
 * @module dsh-vectr-client/client/SessionDrawerModal
 */
import { type ReactNode } from 'react';
import { type SessionVectrState } from '../domain';
export interface SessionDrawerModalProps {
    workspace: string;
    state: SessionVectrState | null;
    loading: boolean;
    isOpen: boolean;
    onClose: () => void;
    onRefresh: () => void;
}
export declare function SessionDrawerModal({ workspace, state, loading, isOpen, onClose, onRefresh, }: SessionDrawerModalProps): ReactNode;
//# sourceMappingURL=SessionDrawerModal.d.ts.map