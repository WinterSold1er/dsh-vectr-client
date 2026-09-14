/**
 * Comprehensive verification for the 8 issues identified by the Adversarial Reviewer:
 *
 * 1. 探活超时假阳性: Returns ok: false with clear error on timeout or persistent memory_only.
 * 2. SessionHeaderAction: Unconditional hook-bound mounting to maintain subscription.
 * 3. Primary codebase offline defense: Prepends primary codebase with status 'down', isPrimary true, deletable false even if !instance.
 * 4. Slug collision & real connectivity test: No duplicate global 'primary' slugs; real probe on test endpoint.
 * 5. Path normalization: path.resolve prevents trailing slash bypass in delete defense.
 * 6. Slug case-normalization: Rejects 'Primary' / 'PRIMARY' as reserved.
 * 7. /api/vectr/init semantic isolation: No hijacking of init to upgrade.
 * 8. Concurrency lock & configurable timeout: Mutex on upgradeWorkspace and VECTR_UPGRADE_TIMEOUT_MS support.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { resolve } from 'node:path'
import {
  SessionVectrService,
  registerSessionRoutes,
} from '../src/bridge'
import {
  SessionHeaderAction,
  DualBoundHeaderAction,
  SessionBoundHeaderAction,
  SessionsBoundHeaderAction,
  ActiveSessionHeaderAction,
} from '../src/client/SessionHeaderAction'
import {
  createCodebase,
  deleteCodebase,
  CodebaseError,
  saveCodebases,
} from '../src/codebases'
import { registerCodebaseRoutes } from '../src/index'
import type {
  ICodebaseService,
  IInstanceResolver,
  IVectrApiClient,
  IVectrCliRunner,
  CodebaseEntry,
} from '../src/domain'
import type { Context } from '@deepseek-ai/cordis'

describe('Adversarial 8 Issues Verification Suite', () => {
  describe('Issue 1: 探活超时假阳性防线', () => {
    it('returns ok: false and clear error message when probe loop times out', async () => {
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
        restart: vi.fn(async () => ({ ok: true, stdout: 'restarting...' })),
      }

      const service = new SessionVectrService({
        instanceResolver: mockResolver,
        apiClient: mockApiClient,
        codebaseService: mockCodebaseService,
        cliRunner: mockCliRunner,
        upgradeTimeoutMs: 300, // Short timeout for test
      })

      const res = await service.upgradeWorkspace('/ws/timeout-test')
      expect(res.ok).toBe(false)
      expect(res.error).toContain('Timed out waiting for Vectr instance to become ready in full mode')
      expect(res.error).toContain('300ms')
    })

    it('returns ok: false when daemon restarts but remains in memory_only mode', async () => {
      const mockResolver: IInstanceResolver = {
        resolveForWorkspace: vi.fn(async () => ({
          workspace: '/ws/stuck-mem',
          port: 8765,
          mode: 'memory_only',
        })),
        getAll: vi.fn(async () => ({})),
      }
      const mockApiClient: IVectrApiClient = {
        getStatus: vi.fn(async () => ({
          mode: 'memory_only',
          fully_ready: true,
        })),
        triggerIndex: vi.fn(async () => ({ ok: false })),
        recall: vi.fn(async () => ({ ok: false })),
        resume: vi.fn(async () => ({ ok: false })),
      }
      const mockCodebaseService: ICodebaseService = {
        listForWorkspace: vi.fn(async () => []),
      }
      const mockCliRunner: IVectrCliRunner = {
        init: vi.fn(async () => ({ ok: true })),
        restart: vi.fn(async () => ({ ok: true })),
      }

      const service = new SessionVectrService({
        instanceResolver: mockResolver,
        apiClient: mockApiClient,
        codebaseService: mockCodebaseService,
        cliRunner: mockCliRunner,
        upgradeTimeoutMs: 300,
      })

      const res = await service.upgradeWorkspace('/ws/stuck-mem')
      expect(res.ok).toBe(false)
      expect(res.error).toContain('still in memory_only mode')
      expect(res.mode).toBe('memory_only')
    })
  })

  describe('Issue 2: SessionHeaderAction Hook 订阅防破坏', () => {
    it('unconditionally mounts DualBoundHeaderAction when both hooks are passed', () => {
      const mockUseSession = vi.fn().mockImplementation((sel: any) => sel({ cwd: '/ws/active', blank: false }))
      const mockUseSessions = vi.fn().mockImplementation((sel: any) => sel({ byId: {} }))

      // Even with blank: true or missing sessionId, it must NOT return null at outer level
      const node = SessionHeaderAction({
        sessionId: undefined,
        blank: true,
        useSession: mockUseSession,
        useSessions: mockUseSessions,
      }) as any

      expect(node).not.toBeNull()
      expect(node.type).toBe(DualBoundHeaderAction)
      expect(node.props.useSession).toBe(mockUseSession)
      expect(node.props.useSessions).toBe(mockUseSessions)
    })

    it('unconditionally mounts SessionBoundHeaderAction when useSession is passed', () => {
      const mockUseSession = vi.fn().mockImplementation((sel: any) => sel({ cwd: '/ws/active', blank: false }))

      const node = SessionHeaderAction({
        sessionId: 'test-session',
        blank: true,
        useSession: mockUseSession,
      }) as any

      expect(node).not.toBeNull()
      expect(node.type).toBe(SessionBoundHeaderAction)
    })

    it('unconditionally mounts SessionsBoundHeaderAction when useSessions is passed', () => {
      const mockUseSessions = vi.fn().mockImplementation((sel: any) => sel({ byId: {} }))

      const node = SessionHeaderAction({
        sessionId: 'test-session',
        blank: true,
        useSessions: mockUseSessions,
      }) as any

      expect(node).not.toBeNull()
      expect(node.type).toBe(SessionsBoundHeaderAction)
    })
  })

  describe('Issue 3: 守护进程离线时 Primary 代码库不消失且防御不降级', () => {
    it('injects primary codebase at index 0 with status down and deletable false when !instance', async () => {
      const mockResolver: IInstanceResolver = {
        resolveForWorkspace: vi.fn(async () => undefined), // Daemon not registered / offline
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
            slug: 'external-repo',
            type: 'local',
            path: '/repo/ext',
            status: 'up',
            workspace: '/my/workspace',
            serverName: 'vectr_ws_ext',
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

      const state = await service.getSessionStatus('/my/workspace')
      expect(state.live).toBe(false)
      expect(state.mode).toBe('offline')
      expect(state.codebases).toHaveLength(2)

      // Index 0 must be Primary codebase
      const primary = state.codebases[0]!
      expect(primary.slug).toBe('primary')
      expect(primary.isPrimary).toBe(true)
      expect(primary.status).toBe('down')
      expect(primary.deletable).toBe(false)
      expect(primary.target).toBe('/my/workspace')

      // Index 1 is external
      const ext = state.codebases[1]!
      expect(ext.slug).toBe('external-repo')
      expect(ext.isPrimary).toBe(false)
      expect(ext.deletable).toBe(true)
    })
  })

  describe('Issue 4: 全局代码库路由 Slug 冲突与连通性真实探活', () => {
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

    it('distinguishes primary slugs across multiple workspaces in GET /api/vectr/codebases', async () => {
      const metaPath = `/tmp/meta-slug-${Date.now()}.json`
      const instPath = `/tmp/inst-slug-${Date.now()}.json`

      const entries: CodebaseEntry[] = [
        { id: '1', slug: 'sub-1', type: 'local', path: '/ws1/sub', workspace: '/ws1', serverName: 's1', status: 'up' },
        { id: '2', slug: 'sub-2', type: 'local', path: '/ws2/sub', workspace: '/ws2', serverName: 's2', status: 'up' },
      ]
      saveCodebases(metaPath, entries)

      const instances = {
        'inst1': { workspace: '/ws1', port: 8761, mode: 'full' },
        'inst2': { workspace: '/ws2', port: 8762, mode: 'full' },
      }
      const { writeFileSync } = await import('node:fs')
      writeFileSync(instPath, JSON.stringify(instances))

      const { exactHandler } = setupRouteHandler(metaPath, instPath)

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

      await exactHandler.handler({ method: 'GET', url: 'http://localhost/api/vectr/codebases' }, mockRes)
      expect(resCode).toBe(200)
      const list = JSON.parse(resBody) as CodebaseEntry[]

      const primaryEntries = list.filter((e) => e.isPrimary)
      expect(primaryEntries).toHaveLength(2)
      // Slugs must be distinct to prevent routing collision
      expect(primaryEntries[0]!.slug).not.toBe(primaryEntries[1]!.slug)
      expect(primaryEntries[0]!.slug).toMatch(/^primary-/)
      expect(primaryEntries[1]!.slug).toMatch(/^primary-/)
    })

    it('injects status: down primary codebase in GET /api/vectr/codebases when instances file is missing or has no entry', async () => {
      const metaPath = `/tmp/meta-offline-${Date.now()}.json`
      const instPath = `/tmp/inst-offline-${Date.now()}.json`

      const entries: CodebaseEntry[] = [
        { id: '1', slug: 'sub-1', type: 'local', path: '/ws1/sub', workspace: '/ws1', serverName: 's1', status: 'up' },
      ]
      saveCodebases(metaPath, entries)

      // instances 文件为空，模拟守护进程离线 / 无条目
      const { writeFileSync } = await import('node:fs')
      writeFileSync(instPath, JSON.stringify({}))

      const { exactHandler } = setupRouteHandler(metaPath, instPath)

      // 1. Scoped ?workspace=/ws1: Primary injected with status: 'down'
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

      await exactHandler.handler({ method: 'GET', url: 'http://localhost/api/vectr/codebases?workspace=/ws1' }, mockRes)
      expect(resCode).toBe(200)
      const listScoped = JSON.parse(resBody) as CodebaseEntry[]
      expect(listScoped).toHaveLength(2)
      expect(listScoped[0]!.slug).toBe('primary')
      expect(listScoped[0]!.status).toBe('down')
      expect(listScoped[0]!.isPrimary).toBe(true)
      expect(listScoped[1]!.slug).toBe('sub-1')

      // 2. Global listing: Primary injected with status: 'down'
      resCode = 0
      resBody = ''
      await exactHandler.handler({ method: 'GET', url: 'http://localhost/api/vectr/codebases' }, mockRes)
      expect(resCode).toBe(200)
      const listGlobal = JSON.parse(resBody) as CodebaseEntry[]
      expect(listGlobal).toHaveLength(2)
      expect(listGlobal[0]!.isPrimary).toBe(true)
      expect(listGlobal[0]!.status).toBe('down')
      expect(listGlobal[1]!.slug).toBe('sub-1')
    })

    it('performs real probe in POST /api/vectr/codebases/primary/test and fails with 503 when daemon is down', async () => {
      const metaPath = `/tmp/meta-probe-${Date.now()}.json`
      const instPath = `/tmp/inst-probe-${Date.now()}.json`

      saveCodebases(metaPath, [
        { id: '1', slug: 'sub', type: 'local', path: '/ws/sub', workspace: '/ws', serverName: 's', status: 'up' },
      ])

      const { writeFileSync } = await import('node:fs')
      // Point to a non-existent port (e.g. 59999) to verify real network failure
      writeFileSync(instPath, JSON.stringify({
        'inst': { workspace: '/ws', port: 59999, mode: 'full' },
      }))

      const { prefixHandler } = setupRouteHandler(metaPath, instPath)

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
        { method: 'POST', url: 'http://localhost/api/vectr/codebases/primary/test?workspace=/ws' },
        mockRes,
      )

      // Must NOT return fake 200 up; must report 503 probe failure
      expect(resCode).toBe(503)
      const data = JSON.parse(resBody)
      expect(data.ok).toBe(false)
      expect(data.error).toBeDefined()
    })
  })

  describe('Issue 5: 路径比对规范化防尾随斜杠绕过', () => {
    it('prevents delete of primary codebase when entry.path has trailing slash', async () => {
      const mockDeps: any = {
        spawnRunner: vi.fn(),
        sshRunner: vi.fn(),
        credentialStore: { get: vi.fn(), set: vi.fn(), unset: vi.fn() },
      }

      const entry: CodebaseEntry = {
        id: 'cb-slash',
        slug: 'my-repo',
        type: 'local',
        path: '/workspace/project/', // Trailing slash
        workspace: '/workspace/project', // No trailing slash
        serverName: 'vectr_ws_repo',
        status: 'up',
      }

      await expect(deleteCodebase(mockDeps, '/tmp/meta.json', entry)).rejects.toThrow(
        /Cannot delete primary codebase of the workspace/,
      )
    })
  })

  describe('Issue 6: Slug 保留字大小写归一化与前缀劫持防范', () => {
    it('rejects codebase creation with case-varied "Primary" or "PRIMARY" and any primary-* prefix', async () => {
      const mockDeps: any = {
        spawnRunner: vi.fn(),
        sshRunner: vi.fn(),
        credentialStore: { get: vi.fn(), set: vi.fn(), unset: vi.fn() },
      }

      await expect(
        createCodebase(mockDeps, '/tmp/meta.json', {
          type: 'local',
          slug: 'Primary',
          path: '/tmp/repo1',
          workspace: '/tmp/ws',
        }),
      ).rejects.toThrow(/Slug "primary" is reserved/)

      await expect(
        createCodebase(mockDeps, '/tmp/meta.json', {
          type: 'local',
          slug: '  PRIMARY  ',
          path: '/tmp/repo2',
          workspace: '/tmp/ws',
        }),
      ).rejects.toThrow(/Slug "primary" is reserved/)

      await expect(
        createCodebase(mockDeps, '/tmp/meta.json', {
          type: 'local',
          slug: 'primary-subproject',
          path: '/tmp/repo3',
          workspace: '/tmp/ws',
        }),
      ).rejects.toThrow(/Slug "primary" is reserved/)

      await expect(
        createCodebase(mockDeps, '/tmp/meta.json', {
          type: 'local',
          slug: 'PRIMARY-12345678',
          path: '/tmp/repo4',
          workspace: '/tmp/ws',
        }),
      ).rejects.toThrow(/Slug "primary" is reserved/)
    })

    it('distinguishes system primary from arbitrary primary- prefix in route layer', async () => {
      const metaPath = `/tmp/meta-prefix-${Date.now()}.json`
      const instPath = `/tmp/inst-prefix-${Date.now()}.json`
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

      // 1. Exact 'primary' is blocked as system primary
      await prefixHandler.handler({ method: 'DELETE', url: 'http://localhost/api/vectr/codebases/primary' }, mockRes)
      expect(resCode).toBe(403)
      expect(JSON.parse(resBody).error).toContain('Cannot delete primary codebase')

      // 2. Exact 8-char hex primary-xxxxxxxx is blocked as system primary
      await prefixHandler.handler({ method: 'DELETE', url: 'http://localhost/api/vectr/codebases/primary-1234abcd' }, mockRes)
      expect(resCode).toBe(403)
      expect(JSON.parse(resBody).error).toContain('Cannot delete primary codebase')

      // 2b. Exact 12-char hex primary-xxxxxxxxxxxx (WORKSPACE_KEY_LENGTH = 12) is blocked as system primary
      await prefixHandler.handler({ method: 'DELETE', url: 'http://localhost/api/vectr/codebases/primary-123456abcdef' }, mockRes)
      expect(resCode).toBe(403)
      expect(JSON.parse(resBody).error).toContain('Cannot delete primary codebase')

      // 3. Non-system slug like primary-custom-name is NOT blocked by primary defense (falls through to 404)
      await prefixHandler.handler({ method: 'DELETE', url: 'http://localhost/api/vectr/codebases/primary-custom-name' }, mockRes)
      expect(resCode).toBe(404)
      expect(JSON.parse(resBody).error).toBe('no such codebase')
    })
  })

  describe('Issue 7: POST /api/vectr/init 语义隔离', () => {
    it('keeps POST /api/vectr/init calling initWorkspace and does NOT hijack to upgrade', async () => {
      const routes: Array<{ path: string; handler: any }> = []
      const mockWebServer = {
        register: (def: any) => {
          routes.push(def)
          return () => {}
        },
      }
      const mockCtx: any = {
        get: vi.fn((key: string) => (key === 'webServer' ? mockWebServer : undefined)),
        effect: vi.fn((fn: () => any) => fn()),
      }

      const mockSessionService: any = {
        initWorkspace: vi.fn(async () => ({ ok: true, stdout: 'init success' })),
        upgradeWorkspace: vi.fn(async () => ({ ok: true, mode: 'full' })),
      }

      registerSessionRoutes(mockCtx, mockSessionService)

      const initRoute = routes.find((r) => r.path === '/api/vectr/init')!
      let resStatus = 0
      let resBody = ''
      const mockRes: any = {
        writeHead: (code: number) => {
          resStatus = code
        },
        end: (body: string) => {
          resBody = body
        },
      }

      const reqStream: any = [Buffer.from(JSON.stringify({ workspace: '/ws/new-repo', memoryOnly: false }))]
      reqStream.method = 'POST'
      await initRoute.handler(reqStream, mockRes)

      expect(resStatus).toBe(200)
      expect(mockSessionService.initWorkspace).toHaveBeenCalledWith({
        workspace: '/ws/new-repo',
        hooks: false,
        memoryOnly: false,
      })
      // Crucial: upgradeWorkspace MUST NOT be called!
      expect(mockSessionService.upgradeWorkspace).not.toHaveBeenCalled()
    })
  })

  describe('Issue 8: 并发锁与超时参数读取', () => {
    it('shares in-flight promise when multiple upgrade requests target the same workspace concurrently', async () => {
      let restartCount = 0
      const mockResolver: IInstanceResolver = {
        resolveForWorkspace: vi.fn(async () => ({
          workspace: '/ws/concurrent',
          port: 8760,
          mode: 'full',
        })),
        getAll: vi.fn(async () => ({})),
      }
      const mockApiClient: IVectrApiClient = {
        getStatus: vi.fn(async () => ({ mode: 'full', fully_ready: true })),
        triggerIndex: vi.fn(async () => ({ ok: true })),
        recall: vi.fn(async () => ({ ok: true })),
        resume: vi.fn(async () => ({ ok: true })),
      }
      const mockCodebaseService: ICodebaseService = {
        listForWorkspace: vi.fn(async () => []),
      }
      const mockCliRunner: IVectrCliRunner = {
        init: vi.fn(async () => ({ ok: true })),
        restart: vi.fn(async () => {
          restartCount++
          await new Promise((r) => setTimeout(r, 50))
          return { ok: true, stdout: 'restarted' }
        }),
      }

      const service = new SessionVectrService({
        instanceResolver: mockResolver,
        apiClient: mockApiClient,
        codebaseService: mockCodebaseService,
        cliRunner: mockCliRunner,
      })

      // Launch two concurrent calls with slash variance
      const [res1, res2] = await Promise.all([
        service.upgradeWorkspace('/ws/concurrent'),
        service.upgradeWorkspace('/ws/concurrent/'),
      ])

      expect(res1.ok).toBe(true)
      expect(res2.ok).toBe(true)
      // Concurrency lock must ensure restart is executed exactly once
      expect(restartCount).toBe(1)
    })

    it('reads upgrade timeout from VECTR_UPGRADE_TIMEOUT_MS environment variable', async () => {
      process.env.VECTR_UPGRADE_TIMEOUT_MS = '750'
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
        restart: vi.fn(async () => ({ ok: true })),
      }

      const service = new SessionVectrService({
        instanceResolver: mockResolver,
        apiClient: mockApiClient,
        codebaseService: mockCodebaseService,
        cliRunner: mockCliRunner,
      })

      const res = await service.upgradeWorkspace('/ws/env-timeout')
      delete process.env.VECTR_UPGRADE_TIMEOUT_MS

      expect(res.ok).toBe(false)
      expect(res.error).toContain('750ms')
    })
  })
})
