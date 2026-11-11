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
export interface MemoryNoteListProps {
    /** Note text exactly as the daemon returned it (recall output or `resume.formatted`). */
    text: string;
    /** 'resume' is the denser variant the Resume panel uses. */
    variant?: 'recall' | 'resume';
}
/**
 * One box of note text: the presentational half of {@link MemoryViewer}, same container/view
 * split as `WorkspaceConsole` / `WorkspaceConsoleView`. Hook-free and props-driven, so the
 * shipped markup renders headlessly (see tests/react-render.ts: effects never run there, so a
 * component that fetches its own list can only ever be asserted in its empty state).
 *
 * The height cap is a CLASS (`.vectr-list-cap` / `.vectr-list-cap--sm`, buttons.tsx) and not an
 * inline `maxHeight`. An inline cap is untouchable from a stylesheet, and that is exactly how
 * this box became a wheel sink inside a phone sheet: with the pointer over it the list scrolled
 * 0->862 while `.vectr-sheet-body` behind it stayed at 0. Declared in CSS, the `max-width:640px`
 * block can lift it and leave the sheet body as the sheet's only scroll layer.
 */
export declare function MemoryNoteListView({ text, variant }: MemoryNoteListProps): ReactNode;
export declare function MemoryViewer({ workspace, port, live }: MemoryViewerProps): ReactNode;
//# sourceMappingURL=MemoryViewer.d.ts.map