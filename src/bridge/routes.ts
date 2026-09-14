/**
 * HTTP route registration for session-scoped Vectr management and working memory.
 *
 * Implements Layer 3: Host RPC Bridge.
 * Exposes endpoints on the Cordis `webServer` service for session status, init,
 * note recall, and resume inspection.
 *
 * @module dsh-vectr-client/bridge/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ISessionStatusService, RecallOptions, VectrInitOptions } from '../domain'

/**
 * Write a JSON HTTP response.
 */
export function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/**
 * Read and parse JSON request body with size protection.
 */
export async function readJsonBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('Request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text)
}

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
export function registerSessionRoutes(ctx: Context, sessionService: ISessionStatusService): void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) {
    ctx.logger?.warn?.(
      'vectr-client: webServer service unavailable; skipping /api/vectr/session-* routes',
    )
    return
  }

  // 1. Session status endpoint
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: '/api/vectr/session-status',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'Method not allowed' })
            return
          }
          try {
            const url = new URL(req.url ?? '', 'http://localhost')
            const workspace = url.searchParams.get('workspace')
            if (!workspace || workspace.trim().length === 0) {
              sendJson(res, 400, { error: 'Missing required query parameter "workspace"' })
              return
            }
            const state = await sessionService.getSessionStatus(workspace.trim())
            sendJson(res, 200, state)
          } catch (error) {
            sendJson(res, 500, { error: String(error) })
          }
        },
      }),
    'vectr-client: GET /api/vectr/session-status',
  )

  // 2. Vectr init endpoint
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: '/api/vectr/init',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Method not allowed' })
            return
          }
          let body: unknown
          try {
            body = await readJsonBody(req)
          } catch (error) {
            sendJson(res, 400, { error: `Invalid JSON body: ${String(error)}` })
            return
          }

          const opts = body as VectrInitOptions
          if (!opts || typeof opts.workspace !== 'string' || opts.workspace.trim().length === 0) {
            sendJson(res, 400, { error: 'Missing required field "workspace" in request body' })
            return
          }

          try {
            const initOpts: VectrInitOptions = {
              workspace: opts.workspace.trim(),
              hooks: opts.hooks === true,
              memoryOnly: opts.memoryOnly === true,
              ...(opts.style && typeof opts.style === 'string' ? { style: opts.style.trim() } : {}),
            }
            const result = await sessionService.initWorkspace(initOpts)
            sendJson(res, result.ok ? 200 : 400, result)
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) })
          }
        },
      }),
    'vectr-client: POST /api/vectr/init',
  )

  // 2b. Vectr upgrade endpoint (memory-only -> full mode)
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: '/api/vectr/upgrade',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Method not allowed' })
            return
          }
          let body: unknown
          try {
            body = await readJsonBody(req)
          } catch (error) {
            sendJson(res, 400, { error: `Invalid JSON body: ${String(error)}` })
            return
          }

          const opts = body as { workspace?: string }
          if (!opts || typeof opts.workspace !== 'string' || opts.workspace.trim().length === 0) {
            sendJson(res, 400, { error: 'Missing required field "workspace" in request body' })
            return
          }

          try {
            const result = await sessionService.upgradeWorkspace(opts.workspace.trim())
            sendJson(res, result.ok ? 200 : 400, result)
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) })
          }
        },
      }),
    'vectr-client: POST /api/vectr/upgrade',
  )

  // 3. Working memory recall endpoint
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: '/api/vectr/notes/recall',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Method not allowed' })
            return
          }
          let body: unknown
          try {
            body = await readJsonBody(req)
          } catch (error) {
            sendJson(res, 400, { error: `Invalid JSON body: ${String(error)}` })
            return
          }

          const params = body as {
            workspace?: string
            port?: number
            query?: string
            limit?: number
            detail?: 'index' | 'full'
            kind?: string
            priority?: string
            sort_by?: 'relevance' | 'recency' | 'priority' | 'chronological'
            tags?: string[]
          }

          const target = {
            ...(params.workspace ? { workspace: params.workspace.trim() } : {}),
            ...(typeof params.port === 'number' ? { port: params.port } : {}),
          }

          const recallOpts: RecallOptions = {
            ...(params.query ? { query: params.query } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
            ...(params.detail ? { detail: params.detail } : {}),
            ...(params.kind ? { kind: params.kind } : {}),
            ...(params.priority ? { priority: params.priority } : {}),
            ...(params.sort_by ? { sort_by: params.sort_by } : {}),
            ...(params.tags ? { tags: params.tags } : {}),
          }

          try {
            const result = await sessionService.recallNotes(target, recallOpts)
            sendJson(res, result.ok ? 200 : 400, result)
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) })
          }
        },
      }),
    'vectr-client: POST /api/vectr/notes/recall',
  )

  // 4. Working memory resume endpoint
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: '/api/vectr/notes/resume',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'Method not allowed' })
            return
          }
          try {
            const url = new URL(req.url ?? '', 'http://localhost')
            const workspace = url.searchParams.get('workspace') ?? undefined
            const portRaw = url.searchParams.get('port')
            const port = portRaw ? parseInt(portRaw, 10) : undefined

            const target = {
              ...(workspace ? { workspace: workspace.trim() } : {}),
              ...(typeof port === 'number' && !isNaN(port) ? { port } : {}),
            }

            const result = await sessionService.getResume(target)
            sendJson(res, result.ok ? 200 : 400, result)
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) })
          }
        },
      }),
    'vectr-client: GET /api/vectr/notes/resume',
  )

  // 5. Session re-index endpoint
  ctx.effect(
    () =>
      webServer.register({
        kind: 'exact',
        path: '/api/vectr/session-reindex',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Method not allowed' })
            return
          }
          let body: unknown
          try {
            body = await readJsonBody(req)
          } catch (error) {
            sendJson(res, 400, { error: `Invalid JSON body: ${String(error)}` })
            return
          }
          const params = body as { workspace?: string }
          if (!params || typeof params.workspace !== 'string' || params.workspace.trim().length === 0) {
            sendJson(res, 400, { error: 'Missing required field "workspace" in request body' })
            return
          }
          try {
            const result = await sessionService.triggerIndex(params.workspace.trim())
            sendJson(res, result.ok ? 200 : 400, result)
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error) })
          }
        },
      }),
    'vectr-client: POST /api/vectr/session-reindex',
  )
}
