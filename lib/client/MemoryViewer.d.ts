/**
 * Working Memory Viewer (Recall & Resume) for Vectr.
 *
 * (Layer 4: Presentation)
 *
 * @module dsh-vectr-client/client/MemoryViewer
 */
import { type ReactNode } from 'react';
export interface MemoryViewerProps {
    workspace: string;
    port?: number | undefined;
    live: boolean;
}
export declare function MemoryViewer({ workspace, port, live }: MemoryViewerProps): ReactNode;
//# sourceMappingURL=MemoryViewer.d.ts.map