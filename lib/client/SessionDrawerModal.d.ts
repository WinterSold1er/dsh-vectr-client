/**
 * Session Drawer Modal for Vectr status, codebase management, init, and working memory.
 *
 * (Layer 4: Presentation)
 *
 * @module dsh-vectr-client/client/SessionDrawerModal
 */
import { type ReactNode } from 'react';
import { type SessionVectrState } from '../domain';
/** The drawer's three panels. Named type so a caller can ask for one without re-spelling
 *  the union. */
export type SessionDrawerTab = 'codebases' | 'memory' | 'ops';
export interface SessionDrawerModalProps {
    workspace: string;
    state: SessionVectrState | null;
    loading: boolean;
    isOpen: boolean;
    onClose: () => void;
    onRefresh: () => void;
    /**
     * Panel to open on. Defaults to 'codebases' (the production behaviour, unchanged).
     * The visual gate renders the shipped component through react-dom/server — no hydration,
     * so a click cannot switch tabs there — and the Init panel is exactly the one whose
     * height has to be measured on a 390x844 viewport. This prop is how the gate gets there
     * without faking the markup.
     */
    initialTab?: SessionDrawerTab;
}
export declare function SessionDrawerModal({ workspace, state, loading, isOpen, onClose, onRefresh, initialTab, }: SessionDrawerModalProps): ReactNode;
//# sourceMappingURL=SessionDrawerModal.d.ts.map