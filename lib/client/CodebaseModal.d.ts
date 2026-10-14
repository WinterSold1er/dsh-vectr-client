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
/**
 * Auto-derive a valid slug from a local or remote directory path.
 * Extracts the basename (last path segment), sanitizes it to match SLUG_PATTERN
 * (1-32 chars of [A-Za-z0-9_-]), and avoids reserved primary slug collisions.
 */
export declare function deriveSlugFromPath(inputPath: string): string;
export declare function CodebaseModal({ workspace, isOpen, onClose, onSuccess, }: CodebaseModalProps): ReactNode;
//# sourceMappingURL=CodebaseModal.d.ts.map