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
import { type SessionVectrState, type UnifiedStatus } from '../domain';
export interface SessionHeaderActionProps {
    sessionId?: string | undefined;
    blank?: boolean | undefined;
    workspace?: string | undefined;
    useSession?: (<T>(selector: (state: any) => T) => T) | undefined;
    useSessions?: (<T>(selector: (state: any) => T) => T) | undefined;
    [key: string]: unknown;
}
export interface ActiveSessionHeaderActionProps {
    sessionCwd?: string | undefined;
    [key: string]: unknown;
}
/**
 * Fetch one workspace's status and report the outcome through `apply`.
 *
 * A failure must never collapse into a nameless offline state: both a non-ok
 * response and a transport/parse failure produce a state whose `error` carries
 * the real reason. `resolveUnifiedStatus` then yields label `'Error'` with that
 * text as its description, so the capsule renders `Vectr [err]` and the tooltip
 * carries the actual cause instead of hiding it.
 *
 * Exported and taking `apply` so this failure contract is testable without a
 * DOM: the repo has no jsdom, and `useEffect` never runs under static rendering.
 */
export declare function fetchSessionStatus(cwd: string, signal: AbortSignal | undefined, apply: (state: SessionVectrState) => void): Promise<void>;
export declare function ActiveSessionHeaderAction(props: ActiveSessionHeaderActionProps): ReactNode;
export interface HeaderCapsuleProps {
    unifiedStatus: UnifiedStatus;
    port?: number | undefined;
    sessionCwd?: string | undefined;
    onOpen: () => void;
}
/**
 * Hook-free capsule presentation. Everything the user sees in the header badge
 * (text, dot state, tooltip) is decided here from the resolved status alone, so
 * the status-surface specs can render it headlessly with a payload. The
 * hook-bound `ActiveSessionHeaderAction` keeps the fetch, the state and the
 * dialog-coordinator hand-off.
 */
export declare function HeaderCapsule({ unifiedStatus, port, sessionCwd, onOpen }: HeaderCapsuleProps): ReactNode;
export interface SessionsBoundHeaderActionProps extends SessionHeaderActionProps {
    useSessions: <T>(selector: (state: any) => T) => T;
}
export declare function SessionsBoundHeaderAction(props: SessionsBoundHeaderActionProps): ReactNode;
export interface SessionBoundHeaderActionProps extends SessionHeaderActionProps {
    useSession: <T>(selector: (state: any) => T) => T;
}
export declare function SessionBoundHeaderAction(props: SessionBoundHeaderActionProps): ReactNode;
export interface DualBoundHeaderActionProps extends SessionHeaderActionProps {
    useSession: <T>(selector: (state: any) => T) => T;
    useSessions: <T>(selector: (state: any) => T) => T;
}
export declare function DualBoundHeaderAction(props: DualBoundHeaderActionProps): ReactNode;
export declare function SessionHeaderAction(props: SessionHeaderActionProps): ReactNode;
//# sourceMappingURL=SessionHeaderAction.d.ts.map