/**
 * Add Codebase dialog with regex validation, credential isolation, and workspace pre-binding.
 *
 * (Layer 4: Presentation)
 *
 * @module dsh-vectr-client/client/CodebaseModal
 */
import { type ReactNode } from 'react';
export interface CodebaseModalProps {
    workspace: string;
    isOpen: boolean;
    onClose: () => void;
    onSuccess: (slug: string) => void;
}
export declare function CodebaseModal({ workspace, isOpen, onClose, onSuccess, }: CodebaseModalProps): ReactNode;
//# sourceMappingURL=CodebaseModal.d.ts.map