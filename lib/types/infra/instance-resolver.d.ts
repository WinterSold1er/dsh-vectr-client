/**
 * Infrastructure instance resolver for discovering running Vectr daemons.
 *
 * Implements {@link IInstanceResolver} (Layer 2: Infrastructure).
 * Reads `~/.vectr/instances.json` dynamically with no caching so external starts/restarts
 * are detected immediately.
 *
 * @module dsh-vectr-client/infra/instance-resolver
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IInstanceResolver } from '../domain';
import { type InstanceEntry } from '../registry';
export declare class InstanceResolver implements IInstanceResolver {
    private readonly ctx;
    private readonly instancesPath;
    constructor(instancesPath?: string, ctx?: Context);
    resolveForWorkspace(workspace: string): Promise<InstanceEntry | undefined>;
    getAll(): Promise<Record<string, InstanceEntry>>;
}
//# sourceMappingURL=instance-resolver.d.ts.map