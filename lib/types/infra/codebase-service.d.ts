/**
 * Infrastructure codebase service for querying codebase metadata.
 *
 * Implements {@link ICodebaseService} (Layer 2: Infrastructure).
 * Reads codebase definitions from the configured metadata file.
 *
 * @module dsh-vectr-client/infra/codebase-service
 */
import type { ICodebaseService } from '../domain';
import { type CodebaseEntry } from '../codebases';
export declare class CodebaseService implements ICodebaseService {
    private readonly metaPath;
    constructor(metaPath?: string);
    listForWorkspace(workspace: string): Promise<CodebaseEntry[]>;
}
//# sourceMappingURL=codebase-service.d.ts.map