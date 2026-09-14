/**
 * HTTP route registration for session-scoped Vectr management and working memory.
 *
 * Implements Layer 3: Host RPC Bridge.
 * Exposes endpoints on the Cordis `webServer` service for session status, init,
 * note recall, and resume inspection.
 *
 * @module dsh-vectr-client/bridge/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { ISessionStatusService } from '../domain';
/**
 * Write a JSON HTTP response.
 */
export declare function sendJson(res: ServerResponse, statusCode: number, body: unknown): void;
/**
 * Read and parse JSON request body with size protection.
 */
export declare function readJsonBody(req: IncomingMessage, limitBytes?: number): Promise<unknown>;
/**
 * Register session-scoped management routes on the webServer service.
 *
 * - `GET  /api/vectr/session-status?workspace=<path>`
 * - `POST /api/vectr/session-reindex`
 * - `POST /api/vectr/init`
 * - `POST /api/vectr/upgrade`
 * - `POST /api/vectr/notes/recall`
 * - `GET  /api/vectr/notes/resume?workspace=<path>`
 *
 * @param ctx - plugin context carrying `webServer`.
 * @param sessionService - application service implementing {@link ISessionStatusService}.
 */
export declare function registerSessionRoutes(ctx: Context, sessionService: ISessionStatusService): void;
//# sourceMappingURL=routes.d.ts.map