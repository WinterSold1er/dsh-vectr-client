/**
 * Unit tests for Layer 3: Host RPC Bridge.
 *
 * Tests SessionVectrService and session HTTP routes using mock domain abstractions.
 */

import { describe, expect, it, vi } from 'vitest'
import type {
  ICodebaseService,
  IInstanceResolver,
  IVectrApiClient,
  IVectrCliRunner,
} from '../src/domain'
import { SessionVectrService } from '../src/bridge/session-service'
import { registerSessionRoutes } from '../src/bridge/routes'

describe('Host RPC Bridge Layer', () => {
  describe('SessionVectrService', () => {
    it('returns offline state when no instance is registered', async () => {
      const mockResolver: IInstanceResolver = {
        resolveForWorkspace: vi.fn(async () => undefined),
        getAll: vi.fn(async () => ({})),
      }
      const mockApiClient: IVectrApiClient = {
        getStatus: vi.fn(async () => undefined),
        triggerIndex: vi.fn(async () => ({ ok: false })),
        recall: vi.fn(async () => ({ ok: false })),
        resume: vi.fn(async () => ({ ok: false })),
      }
      const mockCodebaseService: ICodebaseService = {
        listForWorkspace: vi.fn(async () => [
          {
            slug: 'cb-1',
            type: 'local',
            path: '/repo/cb-1',
            status: 'up',
            workspace: '/my/workspace',
            serverName: 'vectr_ws_cb-1',
          } as any,
        ]),
      }
      const mockCliRunner: IVectrCliRunner = {
        init: vi.fn(async () => ({ ok: true })),
      }

      const service = new SessionVectrService({
        instanceResolver: mockResolver,
        apiClient: mockApiClient,
        codebaseService: mockCodebaseService,
        cliRunner: mockCliRunner,
      })

      const status = await service.getSessionStatus('/my/workspace')
      expect(status.live).toBe(false)
      expect(status.mode).toBe('offline')
      expect(status.canReindex).toBe(false)
      expect(status.codebases).toHaveLength(1)
      expect(status.codebases[0]?.slug).toBe('cb-1')
    })

    it('returns memory_only state and enforces canReindex: false', async () => {
      const mockResolver: IInstanceResolver = {
        resolveForWorkspace: vi.fn(async () => ({
          workspace: '/memory/ws',
          port: 8765,
          mode: 'memory_only',
        })),
        getAll: vi.fn(async () => ({})),
      }
      const mockApiClient: IVectrApiClient = {
        getStatus: vi.fn(async () => ({
          mode: 'memory_only',
          notes_count: 5,
          fully_ready: true,
        })),
        triggerIndex: vi.fn(async () => ({ ok: false })),
        recall: vi.fn(async () => ({ ok: true, notes: 'note text' })),
        resume: vi.fn(async () => ({ ok: true, data: { formatted: 'ready', processing_ms: 10 } })),
      }
      const mockCodebaseService: ICodebaseService = {
        listForWorkspace: vi.fn(async () => []),
      }
      const mockCliRunner: IVectrCliRunner = {
        init: vi.fn(async () => ({ ok: true })),
      }

      const service = new SessionVectrService({
        instanceResolver: mockResolver,
        apiClient: mockApiClient,
        codebaseService: mockCodebaseService,
        cliRunner: mockCliRunner,
      })

      const status = await service.getSessionStatus('/memory/ws')
      expect(status.live).toBe(true)
      expect(status.mode).toBe('memory_only')
      expect(status.port).toBe(8765)
      expect(status.canReindex).toBe(false)
      expect(status.reindexDisabledReason).toContain('memory_only')
      expect(status.status?.notes_count).toBe(5)
    })

    it('executes triggerIndex via apiClient when conditions are met', async () => {
      const mockResolver: IInstanceResolver = {
        resolveForWorkspace: vi.fn(async () => ({
          workspace: '/app/ws',
          port: 8760,
          host: '127.0.0.1',
          mode: 'full',
        })),
        getAll: vi.fn(async () => ({})),
      }
      const mockApiClient: IVectrApiClient = {
        getStatus: vi.fn(async () => ({
          mode: 'full',
          fully_ready: true,
          reindex_in_progress: false,
        })),
        triggerIndex: vi.fn(async () => ({ ok: true, status: 200 })),
        recall: vi.fn(async () => ({ ok: false })),
        resume: vi.fn(async () => ({ ok: false })),
      }
      const mockCodebaseService: ICodebaseService = {
        listForWorkspace: vi.fn(async () => []),
      }
      const mockCliRunner: IVectrCliRunner = {
        init: vi.fn(async () => ({ ok: true })),
      }

      const service = new SessionVectrService({
        instanceResolver: mockResolver,
        apiClient: mockApiClient,
        codebaseService: mockCodebaseService,
        cliRunner: mockCliRunner,
        statusTimeoutMs: 3000,
      })

      const res = await service.triggerIndex('/app/ws')
      expect(res.ok).toBe(true)
      expect(mockApiClient.triggerIndex).toHaveBeenCalledWith('127.0.0.1', 8760, 3000)
    })

    it('rejects triggerIndex when daemon is in memory_only mode', async () => {
      const mockResolver: IInstanceResolver = {
        resolveForWorkspace: vi.fn(async () => ({
          workspace: '/app/mem',
          port: 8760,
          mode: 'memory_only',
        })),
        getAll: vi.fn(async () => ({})),
      }
      const mockApiClient: IVectrApiClient = {
        getStatus: vi.fn(async () => ({
          mode: 'memory_only',
          fully_ready: true,
        })),
        triggerIndex: vi.fn(async () => ({ ok: true })),
        recall: vi.fn(async () => ({ ok: false })),
        resume: vi.fn(async () => ({ ok: false })),
      }
      const mockCodebaseService: ICodebaseService = {
        listForWorkspace: vi.fn(async () => []),
      }
      const mockCliRunner: IVectrCliRunner = {
        init: vi.fn(async () => ({ ok: true })),
      }

      const service = new SessionVectrService({
        instanceResolver: mockResolver,
        apiClient: mockApiClient,
        codebaseService: mockCodebaseService,
        cliRunner: mockCliRunner,
      })

      const res = await service.triggerIndex('/app/mem')
      expect(res.ok).toBe(false)
      expect(res.error).toContain('memory_only')
      expect(mockApiClient.triggerIndex).not.toHaveBeenCalled()
    })
  })

  describe('Session HTTP Routes', () => {
    it('registers routes on webServer service', async () => {
      const routes: Array<{ path: string; handler: any }> = []
      const mockWebServer = {
        register: vi.fn((def) => {
          routes.push(def)
          return () => {}
        }),
      }

      const mockCtx: any = {
        get: vi.fn((key: string) => (key === 'webServer' ? mockWebServer : undefined)),
        effect: vi.fn((fn: () => any) => fn()),
      }

      const mockSessionService: any = {
        getSessionStatus: vi.fn(async (ws: string) => ({
          workspace: ws,
          live: true,
          mode: 'full',
          canReindex: true,
          codebases: [],
        })),
        initWorkspace: vi.fn(async () => ({ ok: true, stdout: 'configured' })),
        recallNotes: vi.fn(async () => ({ ok: true, notes: 'some notes' })),
        getResume: vi.fn(async () => ({ ok: true, data: { formatted: 'ok', processing_ms: 5 } })),
      }

      registerSessionRoutes(mockCtx, mockSessionService)

      expect(routes.some((r) => r.path === '/api/vectr/session-status')).toBe(true)
      expect(routes.some((r) => r.path === '/api/vectr/session-reindex')).toBe(true)
      expect(routes.some((r) => r.path === '/api/vectr/init')).toBe(true)
      expect(routes.some((r) => r.path === '/api/vectr/notes/recall')).toBe(true)
      expect(routes.some((r) => r.path === '/api/vectr/notes/resume')).toBe(true)

      // Test session-reindex route handler
      mockSessionService.triggerIndex = vi.fn(async () => ({ ok: true, status: 200 }))
      const reindexRoute = routes.find((r) => r.path === '/api/vectr/session-reindex')!
      let reindexStatus = 0
      let reindexBody = ''
      const mockReindexRes: any = {
        writeHead: vi.fn((code: number) => {
          reindexStatus = code
        }),
        end: vi.fn((body: string) => {
          reindexBody = body
        }),
      }

      // Mock request stream
      const reqStream: any = [Buffer.from(JSON.stringify({ workspace: '/my/code' }))]
      reqStream.method = 'POST'

      await reindexRoute.handler(reqStream, mockReindexRes)
      expect(reindexStatus).toBe(200)
      expect(mockSessionService.triggerIndex).toHaveBeenCalledWith('/my/code')
      expect(JSON.parse(reindexBody).ok).toBe(true)

      // Test session-status route handler
      const statusRoute = routes.find((r) => r.path === '/api/vectr/session-status')!
      let responseStatus = 0
      let responseBody = ''
      const mockRes: any = {
        writeHead: vi.fn((code: number) => {
          responseStatus = code
        }),
        end: vi.fn((body: string) => {
          responseBody = body
        }),
      }

      await statusRoute.handler(
        { method: 'GET', url: '/api/vectr/session-status?workspace=%2Fmy%2Fcode' },
        mockRes,
      )
      expect(responseStatus).toBe(200)
      expect(JSON.parse(responseBody).workspace).toBe('/my/code')
    })
  })
})
