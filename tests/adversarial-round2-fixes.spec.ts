/**
 * Verification test suite for Adversarial Reviewer Round 2 Defect & Vulnerability Fixes.
 *
 * 1. fail-fast on !initRes.ok in doUpgradeWorkspace (no restart, no 15s wait)
 * 2. VECTR_UPGRADE_TIMEOUT_MS env var priority over default upgradeTimeoutMs
 * 3. GET /api/vectr/codebases injects status: 'down' Primary codebase when daemon offline / unlisted
 * 4. Slug reservation /^primary(-.*)?$/i in createCodebase & exact matching in route layer
 * 5. Route tests execute mockClear() and assert initWorkspace called, upgradeWorkspace never called
 */

import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { writeFileSync, unlinkSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import {
  type CodebaseEntry,
  type ICodebaseService,
  type IInstanceResolver,
  type IVectrApiClient,
  type IVectrCliRunner,
} from '../src/domain'
import { SessionVectrService } from '../src/bridge/session-service'
import { registerSessionRoutes } from '../src/bridge/routes'
import { createCodebase, saveCodebases } from '../src/codebases'
import { registerCodebaseRoutes, isSystemPrimarySlug } from '../src/index'
import { WORKSPACE_KEY_LENGTH } from '../src/registry'

describe('Adversarial Review Round 2 Fixes', () => {
  describe('Fix 1: doUpgradeWorkspace fail-fast on !initRes.ok', () => {
    it('immediately aborts and returns error when cliRunner.init fails without executing restart', async () => {
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
        listForWorkspace: vi.fn(async () => []),
      }
      const restartSpy = vi.fn(async () => ({ ok: true }))
      const mockCliRunner: IVectrCliRunner = {
        init: vi.fn(async () => ({
          ok: false,
          error: 'Vectr CLI init failed: disk full',
          stdout: '',
          stderr: 'error: no space left on device',
        })),
        restart: restartSpy,
      }

      const service = new SessionVectrService({
        instanceResolver: mockResolver,
        apiClient: mockApiClient,
        codebaseService: mockCodebaseService,
        cliRunner: mockCliRunner,
        upgradeTimeoutMs: 15_000,
      })

      const startTime = Date.now()
      const result = await service.upgradeWorkspace('/workspace/fail-init')
      const elapsed = Date.now() - startTime

      // 1. Fail-fast: Must return ok: false immediately (far less than 15s)
      expect(result.ok).toBe(false)
      expect(result.error).toContain('Vectr CLI init failed: disk full')
      expect(result.stderr).toContain('no space left on device')
      expect(elapsed).toBeLessThan(1000)

      // 2. Restart MUST NOT be called
      expect(mockCliRunner.init).toHaveBeenCalledTimes(1)
      expect(restartSpy).not.toHaveBeenCalled()
    })
  })

  describe('Fix 2: VECTR_UPGRADE_TIMEOUT_MS env var priority', () => {
    it('prioritizes environment variable over options.upgradeTimeoutMs even when default is passed', () => {
      const prevEnv = process.env.VECTR_UPGRADE_TIMEOUT_MS
      try {
        process.env.VECTR_UPGRADE_TIMEOUT_MS = '42000'

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
          listForWorkspace: vi.fn(async () => []),
        }
        const mockCliRunner: IVectrCliRunner = {
          init: vi.fn(async () => ({ ok: true })),
        }

        // Even though options.upgradeTimeoutMs is explicitly passed as 15000 (standard default)
        const service = new SessionVectrService({
          instanceResolver: mockResolver,
          apiClient: mockApiClient,
          codebaseService: mockCodebaseService,
          cliRunner: mockCliRunner,
          upgradeTimeoutMs: 15_000,
        })

        expect((service as any).upgradeTimeoutMs).toBe(42_000)
      } finally {
        if (prevEnv !== undefined) {
          process.env.VECTR_UPGRADE_TIMEOUT_MS = prevEnv
        } else {
          delete process.env.VECTR_UPGRADE_TIMEOUT_MS
        }
      }
    })
  })

  describe('Fix 3: GET /api/vectr/codebases injects status: down Primary when daemon offline', () => {
    function setupRouteHandler(metaFile: string, instFile: string) {
      const registrations: Array<{ kind: string; path: string; handler: (req: any, res: any) => Promise<void> }> = []
      const mockWebServer = {
        register: (r: any) => {
          registrations.push(r)
          return () => {}
        },
      }
      const mockCtx = {
        get: (key: string) => (key === 'webServer' ? mockWebServer : undefined),
        effect: (fn: any) => fn(),
        logger: { warn() {}, info() {}, error() {} },
      } as unknown as Context

      registerCodebaseRoutes(mockCtx, metaFile, '/tmp/mock-secrets.json', instFile)
      const exactHandler = registrations.find((r) => r.kind === 'exact')!
      const prefixHandler = registrations.find((r) => r.kind === 'prefix')!
      return { exactHandler, prefixHandler }
    }

    it('injects status: down Primary codebase for non-memory_only workspace when daemon is offline', async () => {
      const metaPath = `/tmp/meta-f3-${Date.now()}.json`
      const instPath = `/tmp/inst-f3-${Date.now()}.json`

      const entries: CodebaseEntry[] = [
        { id: '1', slug: 'mounted-lib', type: 'local', path: '/app/lib', workspace: '/app', serverName: 's1', status: 'up' },
      ]
      saveCodebases(metaPath, entries)

      // Empty instances.json: daemon not running / no entry
      const { writeFileSync } = await import('node:fs')
      writeFileSync(instPath, JSON.stringify({}))

      const { exactHandler } = setupRouteHandler(metaPath, instPath)

      // A: Scoped query ?workspace=/app
      let resCode = 0
      let resBody = ''
      const mockRes = {
        writeHead: (c: number) => {
          resCode = c
        },
        end: (b: string) => {
          resBody = b
        },
      }

      await exactHandler.handler({ method: 'GET', url: 'http://localhost/api/vectr/codebases?workspace=/app' }, mockRes)
      expect(resCode).toBe(200)
      const scopedList = JSON.parse(resBody) as CodebaseEntry[]
      expect(scopedList).toHaveLength(2)
      expect(scopedList[0]!.slug).toBe('primary')
      expect(scopedList[0]!.isPrimary).toBe(true)
      expect(scopedList[0]!.status).toBe('down')
      expect(scopedList[0]!.workspace).toBe('/app')
      expect(scopedList[1]!.slug).toBe('mounted-lib')

      // B: Global listing without workspace query
      resCode = 0
      resBody = ''
      await exactHandler.handler({ method: 'GET', url: 'http://localhost/api/vectr/codebases' }, mockRes)
      expect(resCode).toBe(200)
      const globalList = JSON.parse(resBody) as CodebaseEntry[]
      expect(globalList).toHaveLength(2)
      expect(globalList[0]!.isPrimary).toBe(true)
      expect(globalList[0]!.status).toBe('down')
      expect(globalList[0]!.workspace).toBe('/app')
      expect(globalList[1]!.slug).toBe('mounted-lib')
    })
  })

  describe('Fix 4: Slug reservation /^primary(-.*)?$/i and exact route matching', () => {
    it('createCodebase rejects all variations of primary prefix', async () => {
      const mockDeps: any = {
        spawnRunner: vi.fn(),
        sshRunner: vi.fn(),
        credentialStore: { get: vi.fn(), set: vi.fn(), unset: vi.fn() },
      }

      const rejectedSlugs = [
        'primary',
        'Primary',
        'PRIMARY',
        'primary-',
        'primary-abc',
        'Primary-Secret',
        'PRIMARY-12345678',
        '  primary-test  ',
      ]

      for (const slug of rejectedSlugs) {
        await expect(
          createCodebase(mockDeps, '/tmp/meta.json', {
            type: 'local',
            slug,
            path: '/tmp/repo',
            workspace: '/tmp/ws',
          }),
        ).rejects.toThrow(/Slug "primary" is reserved/)
      }
    })

    it('route layer exact matching blocks system primary while allowing non-system slug to pass to normal handler', async () => {
      const metaPath = `/tmp/meta-f4-${Date.now()}.json`
      const instPath = `/tmp/inst-f4-${Date.now()}.json`
      saveCodebases(metaPath, [])

      const registrations: Array<{ kind: string; path: string; handler: (req: any, res: any) => Promise<void> }> = []
      const mockWebServer = {
        register: (r: any) => {
          registrations.push(r)
          return () => {}
        },
      }
      const mockCtx = {
        get: (key: string) => (key === 'webServer' ? mockWebServer : undefined),
        effect: (fn: any) => fn(),
        logger: { warn() {}, info() {}, error() {} },
      } as unknown as Context

      registerCodebaseRoutes(mockCtx, metaPath, '/tmp/mock-secrets.json', instPath)
      const prefixHandler = registrations.find((r) => r.kind === 'prefix')!

      let resCode = 0
      let resBody = ''
      const mockRes = {
        writeHead: (c: number) => {
          resCode = c
        },
        end: (b: string) => {
          resBody = b
        },
      }

      // 1. Exact 'primary': blocked with 403
      await prefixHandler.handler({ method: 'DELETE', url: 'http://localhost/api/vectr/codebases/primary' }, mockRes)
      expect(resCode).toBe(403)
      expect(JSON.parse(resBody).error).toContain('Cannot delete primary codebase')

      // 2. Exact 8-char hex primary-xxxxxxxx: blocked with 403
      await prefixHandler.handler({ method: 'DELETE', url: 'http://localhost/api/vectr/codebases/primary-abcdef12' }, mockRes)
      expect(resCode).toBe(403)
      expect(JSON.parse(resBody).error).toContain('Cannot delete primary codebase')

      // 3. Real 12-char hex primary-${wsKey} (WORKSPACE_KEY_LENGTH = 12): blocked with 403
      const sampleWs = '/home/user/project'
      const wsKey12 = createHash('sha256').update(sampleWs).digest('hex').slice(0, WORKSPACE_KEY_LENGTH)
      expect(wsKey12.length).toBe(12)
      await prefixHandler.handler({ method: 'DELETE', url: `http://localhost/api/vectr/codebases/primary-${wsKey12}` }, mockRes)
      expect(resCode).toBe(403)
      expect(JSON.parse(resBody).error).toContain('Cannot delete primary codebase')

      // 4. Arbitrary primary-xxx that is NOT 8-16 hex: NOT intercepted as system primary (returns 404 since no such codebase)
      await prefixHandler.handler({ method: 'DELETE', url: 'http://localhost/api/vectr/codebases/primary-arbitrary-name' }, mockRes)
      expect(resCode).toBe(404)
      expect(JSON.parse(resBody).error).toBe('no such codebase')

      // 5. Same for PATCH
      await prefixHandler.handler({ method: 'PATCH', url: 'http://localhost/api/vectr/codebases/primary' }, mockRes)
      expect(resCode).toBe(403)
      expect(JSON.parse(resBody).error).toContain('Cannot reassign primary codebase')

      await prefixHandler.handler({ method: 'PATCH', url: 'http://localhost/api/vectr/codebases/primary-abcdef12' }, mockRes)
      expect(resCode).toBe(403)
      expect(JSON.parse(resBody).error).toContain('Cannot reassign primary codebase')

      await prefixHandler.handler({ method: 'PATCH', url: `http://localhost/api/vectr/codebases/primary-${wsKey12}` }, mockRes)
      expect(resCode).toBe(403)
      expect(JSON.parse(resBody).error).toContain('Cannot reassign primary codebase')

      await prefixHandler.handler({ method: 'PATCH', url: 'http://localhost/api/vectr/codebases/primary-arbitrary-name' }, mockRes)
      expect(resCode).toBe(404)
    })

    it('verifies isSystemPrimarySlug helper and primary connectivity test with real 12-char WORKSPACE_KEY_LENGTH', async () => {
      // 1. Validate isSystemPrimarySlug helper directly
      const testWs = '/data/test-workspace'
      const wsKey = createHash('sha256').update(testWs).digest('hex').slice(0, WORKSPACE_KEY_LENGTH)
      expect(wsKey.length).toBe(12)

      expect(isSystemPrimarySlug('primary')).toBe(true)
      expect(isSystemPrimarySlug('PRIMARY')).toBe(true)
      expect(isSystemPrimarySlug('primary-abcdef12')).toBe(true) // 8-char hex
      expect(isSystemPrimarySlug(`primary-${wsKey}`)).toBe(true) // 12-char hex (system primary)
      expect(isSystemPrimarySlug('primary-0123456789abcdef')).toBe(true) // 16-char hex
      expect(isSystemPrimarySlug('primary-arbitrary-name')).toBe(false)
      expect(isSystemPrimarySlug('primary-abc')).toBe(false)
      expect(isSystemPrimarySlug('not-primary')).toBe(false)
      expect(isSystemPrimarySlug('')).toBe(false)
      expect(isSystemPrimarySlug(undefined)).toBe(false)

      // 2. Start a mock isolated daemon server on ephemeral port
      let daemonHits = 0
      const mockDaemonServer = createServer((req, res) => {
        if (req.url === '/v1/status') {
          daemonHits++
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, mode: 'full', indexed_files: 99, notes_count: 10 }))
          return
        }
        res.writeHead(404)
        res.end()
      })

      const mockDaemonPort = await new Promise<number>((resolve) => {
        mockDaemonServer.listen(0, '127.0.0.1', () => {
          const addr = mockDaemonServer.address() as { port: number }
          resolve(addr.port)
        })
      })

      const metaPath = `/tmp/meta-conn-${Date.now()}.json`
      const instPath = `/tmp/inst-conn-${Date.now()}.json`
      saveCodebases(metaPath, [])

      // Write instance file with the 12-char key
      writeFileSync(
        instPath,
        JSON.stringify({
          [wsKey]: { workspace: testWs, port: mockDaemonPort, mode: 'full' },
        }),
      )

      const registrations: Array<{ kind: string; path: string; handler: (req: any, res: any) => Promise<void> }> = []
      const mockWebServer = {
        register: (r: any) => {
          registrations.push(r)
          return () => {}
        },
      }
      const mockCtx = {
        get: (key: string) => (key === 'webServer' ? mockWebServer : undefined),
        effect: (fn: any) => fn(),
        logger: { warn() {}, info() {}, error() {} },
      } as unknown as Context

      registerCodebaseRoutes(mockCtx, metaPath, '/tmp/mock-secrets.json', instPath)
      const prefixHandler = registrations.find((r) => r.kind === 'prefix')!

      try {
        // Test primary connectivity via 12-char slug WITHOUT ?workspace= query param
        let resCode = 0
        let resBody = ''
        const mockRes = {
          writeHead: (c: number) => {
            resCode = c
          },
          end: (b: string) => {
            resBody = b
          },
        }

        await prefixHandler.handler(
          { method: 'POST', url: `http://localhost/api/vectr/codebases/primary-${wsKey}/test` },
          mockRes,
        )

        // Must succeed with 200 and probe data, NOT 404
        expect(resCode).toBe(200)
        const parsed = JSON.parse(resBody)
        expect(parsed.ok).toBe(true)
        expect(parsed.status).toBeDefined()
        expect(parsed.status.indexed_files).toBe(99)
        expect(daemonHits).toBe(1)

        // When non-system slug is tested, falls through to 404
        await prefixHandler.handler(
          { method: 'POST', url: `http://localhost/api/vectr/codebases/primary-non-system/test` },
          mockRes,
        )
        expect(resCode).toBe(404)
        expect(JSON.parse(resBody).error).toBe('no such codebase')
      } finally {
        await new Promise<void>((resolve) => mockDaemonServer.close(() => resolve()))
        try { unlinkSync(metaPath) } catch {}
        try { unlinkSync(instPath) } catch {}
      }
    })
  })

  describe('Fix 5: tests/bridge.spec.ts mockClear and strict call assertion', () => {
    it('executes mockClear before and after invoking /api/vectr/init and verifies upgradeWorkspace is never called', async () => {
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
        initWorkspace: vi.fn(async () => ({ ok: true, stdout: 'success' })),
        upgradeWorkspace: vi.fn(async () => ({ ok: true, mode: 'full' })),
      }

      registerSessionRoutes(mockCtx, mockSessionService)

      const initRoute = routes.find((r) => r.path === '/api/vectr/init')!
      expect(initRoute).toBeDefined()

      // 1. 调用前 mockClear()
      mockSessionService.initWorkspace.mockClear()
      mockSessionService.upgradeWorkspace.mockClear()

      let resStatus = 0
      let resBody = ''
      const mockRes: any = {
        writeHead: vi.fn((code: number) => {
          resStatus = code
        }),
        end: vi.fn((body: string) => {
          resBody = body
        }),
      }

      const reqStream: any = [Buffer.from(JSON.stringify({ workspace: '/test/workspace', memoryOnly: false }))]
      reqStream.method = 'POST'

      await initRoute.handler(reqStream, mockRes)

      // 2. 断言
      expect(resStatus).toBe(200)
      expect(mockSessionService.initWorkspace).toHaveBeenCalledWith({
        workspace: '/test/workspace',
        hooks: false,
        memoryOnly: false,
      })
      // 绝不被调用
      expect(mockSessionService.upgradeWorkspace).not.toHaveBeenCalled()
      expect(mockSessionService.upgradeWorkspace).toHaveBeenCalledTimes(0)

      // 3. 调用后 mockClear()
      mockSessionService.initWorkspace.mockClear()
      mockSessionService.upgradeWorkspace.mockClear()
      expect(mockSessionService.initWorkspace).toHaveBeenCalledTimes(0)
    })
  })
})
