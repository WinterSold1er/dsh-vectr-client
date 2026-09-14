/**
 * Infrastructure CLI runner for Vectr commands.
 *
 * Implements {@link IVectrCliRunner} (Layer 2: Infrastructure).
 * Resolves CLI executable dynamically from Config -> Environment variables -> PATH.
 * Absolute paths are strictly injected, never hardcoded.
 *
 * @module dsh-vectr-client/infra/cli-runner
 */
import { type ChildProcess } from 'node:child_process';
import type { InitResult, IVectrCliRunner, VectrInitOptions } from '../domain';
export type SpawnFunction = (command: string, args: string[], options?: {
    timeout?: number;
}) => ChildProcess;
export interface CliRunnerOptions {
    /** Explicit CLI path from plugin configuration. */
    cliPath?: string | undefined;
    /** Injected spawn function for testing. */
    spawnFn?: SpawnFunction | undefined;
    /** Execution timeout in ms (default 30,000ms). */
    timeoutMs?: number | undefined;
}
/**
 * Default fallback CLI executable name (resolved via system PATH).
 */
export declare const DEFAULT_CLI_NAME = "vectr";
/** Default timeout for CLI commands in milliseconds. */
export declare const DEFAULT_CLI_TIMEOUT_MS = 30000;
/** Delay before escalating from SIGTERM to SIGKILL on process kill (ms). */
export declare const SIGKILL_ESCALATION_DELAY_MS = 1500;
/**
 * Resolve the CLI binary path in priority order:
 * 1. Explicit configuration (`opts.cliPath`)
 * 2. Environment variable `VECTR_CLI_PATH`
 * 3. Environment variable `VECTR_PATH`
 * 4. System PATH executable `vectr`
 */
export declare function resolveCliExecutable(cliPath?: string): string;
export declare class VectrCliRunner implements IVectrCliRunner {
    private readonly cliExecutable;
    private readonly spawnFn;
    private readonly defaultTimeoutMs;
    constructor(options?: CliRunnerOptions);
    init(options: VectrInitOptions): Promise<InitResult>;
    restart(workspace: string, options?: {
        full?: boolean;
    }): Promise<InitResult>;
    private executeCommand;
}
//# sourceMappingURL=cli-runner.d.ts.map