/**
 * Session Header Utility Action for Vectr.
 *
 * Mounted into the host slot `conversation.session.header.utilities`.
 * Dynamically tracks the current active session's working directory (`session.cwd`)
 * and displays live status, mode, port, and quick metrics.
 * Acts as a pure trigger for `dialogCoordinator.open(workspace)`.
 *
 * (Layer 4: Presentation)
 *
 * @module dsh-vectr-client/client/SessionHeaderAction
 */
import { type ReactNode } from 'react';
export interface SessionHeaderActionProps {
    sessionId?: string | undefined;
    blank?: boolean | undefined;
    workspace?: string | undefined;
    useSessions?: (<T>(selector: (state: any) => T) => T) | undefined;
    [key: string]: unknown;
}
export interface ActiveSessionHeaderActionProps {
    sessionCwd?: string | undefined;
    [key: string]: unknown;
}
export declare function ActiveSessionHeaderAction(props: ActiveSessionHeaderActionProps): ReactNode;
export interface SessionsBoundHeaderActionProps extends SessionHeaderActionProps {
    useSessions: <T>(selector: (state: any) => T) => T;
}
export declare function SessionsBoundHeaderAction(props: SessionsBoundHeaderActionProps): ReactNode;
export declare function SessionHeaderAction(props: SessionHeaderActionProps): ReactNode;
//# sourceMappingURL=SessionHeaderAction.d.ts.map