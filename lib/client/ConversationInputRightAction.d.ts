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
    useSessions?: (<T>(selector: (state: any) => T) => T) | undefined;
    workspace?: string | undefined;
    [key: string]: unknown;
}
export declare function ConversationInputRightAction(props: ConversationInputRightActionProps): ReactNode;
//# sourceMappingURL=ConversationInputRightAction.d.ts.map