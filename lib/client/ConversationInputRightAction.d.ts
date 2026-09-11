/**
 * Conversation Input Right Action for Vectr.
 *
 * Mounted into the host slot `conversation.input.right`.
 * Provides a persistent Vectr trigger next to the prompt composer,
 * ensuring accessibility on both blank (new chat) and active sessions.
 * Acts as a pure trigger for `dialogCoordinator.open(workspace)`.
 *
 * (Layer 4: Presentation)
 *
 * @module dsh-vectr-client/client/ConversationInputRightAction
 */
import type { ReactNode } from 'react';
export interface ConversationInputRightActionProps {
    sessionId?: string | undefined;
    blank?: boolean | undefined;
    useSession?: (<T>(selector: (state: any) => T) => T) | undefined;
    useSessions?: (<T>(selector: (state: any) => T) => T) | undefined;
    workspace?: string | undefined;
    [key: string]: unknown;
}
export declare function StaticInputRightAction(props: ConversationInputRightActionProps): ReactNode;
export interface SessionBoundInputRightActionProps extends ConversationInputRightActionProps {
    useSession: <T>(selector: (state: any) => T) => T;
}
export declare function SessionBoundInputRightAction(props: SessionBoundInputRightActionProps): ReactNode;
export interface SessionsBoundInputRightActionProps extends ConversationInputRightActionProps {
    useSessions: <T>(selector: (state: any) => T) => T;
}
export declare function SessionsBoundInputRightAction(props: SessionsBoundInputRightActionProps): ReactNode;
export declare function ConversationInputRightAction(props: ConversationInputRightActionProps): ReactNode;
//# sourceMappingURL=ConversationInputRightAction.d.ts.map