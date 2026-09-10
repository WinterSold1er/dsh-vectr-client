/**
 * Session Header Utility Action for Vectr.
 *
 * Mounted into the host slot `conversation.session.header.utilities`.
 * Dynamically tracks the current active session's working directory (`session.cwd`)
 * and displays live status, mode, port, and quick metrics.
 *
 * (Layer 4: Presentation)
 *
 * @module dsh-vectr-client/client/SessionHeaderAction
 */
import { type ReactNode } from 'react';
export interface SessionHeaderActionProps {
    sessionId?: string | undefined;
    useSessions?: (<T>(selector: (state: any) => T) => T) | undefined;
    [key: string]: unknown;
}
export declare function SessionHeaderAction(props: SessionHeaderActionProps): ReactNode;
//# sourceMappingURL=SessionHeaderAction.d.ts.map