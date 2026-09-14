/**
 * QA Deep Defect Verification Test Suite
 *
 * Designed by QA Quality Probe:
 * - Isolated test environment (Vitest, ephemeral mock servers, ephemeral ports, temp files).
 * - Zero interference with active DSH instance (3081) or live Vectr daemons.
 * - Rigorous verification of externalized configurations, boundaries, failure paths, and anti-hardcoding.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  ConversationInputRightAction,
  DualBoundInputRightAction,
  SessionsBoundInputRightAction,
  SessionBoundInputRightAction,
  StaticInputRightAction,
} from '../src/client/ConversationInputRightAction'
import {
  SessionHeaderAction,
  DualBoundHeaderAction,
  SessionsBoundHeaderAction,
  SessionBoundHeaderAction,
  ActiveSessionHeaderAction,
} from '../src/client/SessionHeaderAction'
import {
  hasActiveSession,
  isSessionActivated,
  resolveSessionSlotVisibility,
  isReservedPrimarySlug,
  isSystemPrimarySlug,
  SLUG_PATTERN,
  PRIMARY_RESERVED_PREFIX_PATTERN,
  SYSTEM_PRIMARY_SLUG_PATTERN,
} from '../src/domain/rules'
import { SessionVectrService } from '../src/bridge/session-service'
import { registerSessionRoutes } from '../src/bridge/routes'
import { registerCodebaseRoutes, DEFAULT_HTTP_TIMEOUT_MS, DEFAULT_UPGRADE_TIMEOUT_MS } from '../src/index'
import { createCodebase, deleteCodebase, saveCodebases, CodebaseError } from '../src/codebases'
import type {
  ICodebaseService,
  IInstanceResolver,
  IVectrApiClient,
  IVectrCliRunner,
  CodebaseEntry,
} from '../src/domain'
import { WORKSPACE_KEY_LENGTH } from '../src/registry'

function unwrapElement(node: unknown): unknown {
  let current: any = node
  while (
    current &&
    typeof current === 'object' &&
    typeof current.type === 'function' &&
    current.type !== ActiveSessionHeaderAction &&
    current.type !== StaticInputRightAction
  ) {
    current = current.type(current.props)
  }
  return current
}

describe('QA Deep Verification: Defect 1 - Button Mutual Exclusion & Dual Hook Resilience', () => {
  const testSessionId = 'qa-sess-404'

  it('TC-1.1: blank session with valid sessionId ONLY renders InputRight, NEVER Header', () => {
    const inputEl = ConversationInputRightAction({ sessionId: testSessionId, blank: true })
    const headerEl = SessionHeaderAction({ sessionId: testSessionId, blank: true })

    const unwrappedInput = unwrapElement(inputEl)
    const unwrappedHeader = unwrapElement(headerEl)

    expect(unwrappedInput).not.toBeNull()
    expect(unwrappedHeader).toBeNull()

    const vis = resolveSessionSlotVisibility({ sessionId: testSessionId, blank: true })
    expect(vis.shouldRenderInputRight).toBe(true)
    expect(vis.shouldRenderHeaderUtility).toBe(false)
  })

  it('TC-1.2: active session with blank: false ONLY renders Header, NEVER InputRight', () => {
    const inputEl = ConversationInputRightAction({ sessionId: testSessionId, blank: false })
    const headerEl = SessionHeaderAction({ sessionId: testSessionId, blank: false })

    const unwrappedInput = unwrapElement(inputEl)
    const unwrappedHeader = unwrapElement(headerEl) as any

    expect(unwrappedInput).toBeNull()
    expect(unwrappedHeader).not.toBeNull()
    expect(unwrappedHeader.type).toBe(ActiveSessionHeaderAction)

    const vis = resolveSessionSlotVisibility({ sessionId: testSessionId, blank: false })
    expect(vis.shouldRenderInputRight).toBe(false)
    expect(vis.shouldRenderHeaderUtility).toBe(true)
  })

  it('TC-1.3: boundary strings ("null", "undefined", "", spaces) strictly resolve to non-active', () => {
    const testCases = ['', '   ', 'null', 'undefined', null, undefined]
    for (const badId of testCases) {
      const vis = resolveSessionSlotVisibility({ sessionId: badId as any, blank: false })
      expect(vis.shouldRenderInputRight).toBe(true)
      expect(vis.shouldRenderHeaderUtility).toBe(false)
    }
  })

  it('TC-1.4: DualBound containers handle state transition without hook order violation or dual render', () => {
    let state = {
      single: { sessionId: testSessionId, blank: true, cwd: '/ws/qa' },
      sessions: { byId: { [testSessionId]: { blank: true, cwd: '/ws/qa' } } },
    }

    const mockUseSession = (selector: any) => selector(state.single)
    const mockUseSessions = (selector: any) => selector(state.sessions)

    // Initial: blank state
    let inputEl = DualBoundInputRightAction({
      sessionId: testSessionId,
      useSession: mockUseSession,
      useSessions: mockUseSessions,
    })
    let headerEl = DualBoundHeaderAction({
      sessionId: testSessionId,
      useSession: mockUseSession,
      useSessions: mockUseSessions,
    })

    expect(unwrapElement(inputEl)).not.toBeNull()
    expect(unwrapElement(headerEl)).toBeNull()

    // Transition: first prompt submitted, blank becomes false
    state = {
      single: { sessionId: testSessionId, blank: false, cwd: '/ws/qa' },
      sessions: { byId: { [testSessionId]: { blank: false, cwd: '/ws/qa' } } },
    }

    inputEl = DualBoundInputRightAction({
      sessionId: testSessionId,
      useSession: mockUseSession,
      useSessions: mockUseSessions,
    })
    headerEl = DualBoundHeaderAction({
      sessionId: testSessionId,
      useSession: mockUseSession,
      useSessions: mockUseSessions,
    })

    expect(unwrapElement(inputEl)).toBeNull()
    expect(unwrapElement(headerEl)).not.toBeNull()
  })
})

describe('QA Deep Verification: Defect 2 - Memory-Only Upgrade (Config Externalization & Failure Paths)', () => {
  const originalEnv = process.env.VECTR_UPGRADE_TIMEOUT_MS

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.VECTR_UPGRADE_TIMEOUT_MS = originalEnv
    } else {
      delete process.env.VECTR_UPGRADE_TIMEOUT_MS
    }
  })

  it('TC-2.1: Externalized Config - VECTR_UPGRADE_TIMEOUT_MS overrides default and is enforced', async () => {
    // Inject 250ms timeout via env
    process.env.VECTR_UPGRADE_TIMEOUT_MS = '250'

    const mockResolver: IInstanceResolver = {
      resolveForWorkspace: vi.fn(async () => ({
        workspace: '/ws/qa-timeout',
        port: 9876,
        host: '127.0.0.1',
        mode: 'memory_only', // never turns full
      })),
      getAll: vi.fn(async () => ({})),
    }

    const mockApiClient: IVectrApiClient = {
      getStatus: vi.fn(async () => ({ mode: 'memory_only', fully_ready: true })),
      triggerIndex: vi.fn(),
      recall: vi.fn(),
      resume: vi.fn(),
    }

    const mockCliRunner: IVectrCliRunner = {
      init: vi.fn(async () => ({ ok: true })),
      restart: vi.fn(async () => ({ ok: true })),
    }

    const service = new SessionVectrService({
      instanceResolver: mockResolver,
      apiClient: mockApiClient,
      codebaseService: { listForWorkspace: vi.fn(async () => []) },
      cliRunner: mockCliRunner,
    })

    const startTime = Date.now()
    const result = await service.upgradeWorkspace('/ws/qa-timeout')
    const elapsed = Date.now() - startTime

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/timeout: 250ms/i)
    // Proves timeout was strictly bounded by 250ms, not default 15000ms
    expect(elapsed).toBeLessThan(1500)
  })

  it('TC-2.2: Illegal Env Config fallback - NaN/negative values fallback gracefully to option or default', async () => {
    process.env.VECTR_UPGRADE_TIMEOUT_MS = 'invalid_number'

    const service = new SessionVectrService({
      instanceResolver: { resolveForWorkspace: vi.fn(), getAll: vi.fn() },
      apiClient: { getStatus: vi.fn(), triggerIndex: vi.fn(), recall: vi.fn(), resume: vi.fn() },
      codebaseService: { listForWorkspace: vi.fn() },
      cliRunner: { init: vi.fn(), restart: vi.fn() },
      upgradeTimeoutMs: 350,
    })

    expect((service as any).upgradeTimeoutMs).toBe(350)
  })

  it('TC-2.3: Failure Path - CLI init fails blocks restart and aborts with error', async () => {
    const mockCliRunner: IVectrCliRunner = {
      init: vi.fn(async () => ({ ok: false, error: 'EACCES: permission denied' })),
      restart: vi.fn(),
    }

    const service = new SessionVectrService({
      instanceResolver: { resolveForWorkspace: vi.fn(), getAll: vi.fn() },
      apiClient: { getStatus: vi.fn(), triggerIndex: vi.fn(), recall: vi.fn(), resume: vi.fn() },
      codebaseService: { listForWorkspace: vi.fn() },
      cliRunner: mockCliRunner,
    })

    const res = await service.upgradeWorkspace('/ws/perm-denied')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('EACCES: permission denied')
    expect(mockCliRunner.restart).not.toHaveBeenCalled()
  })

  it('TC-2.4: Failure Path - CLI restart fails aborts immediately with command output', async () => {
    const mockCliRunner: IVectrCliRunner = {
      init: vi.fn(async () => ({ ok: true })),
      restart: vi.fn(async () => ({
        ok: false,
        error: 'Port 8765 in use by unknown process',
        stderr: 'fatal: bind failed',
      })),
    }

    const service = new SessionVectrService({
      instanceResolver: { resolveForWorkspace: vi.fn(), getAll: vi.fn() },
      apiClient: { getStatus: vi.fn(), triggerIndex: vi.fn(), recall: vi.fn(), resume: vi.fn() },
      codebaseService: { listForWorkspace: vi.fn() },
      cliRunner: mockCliRunner,
    })

    const res = await service.upgradeWorkspace('/ws/bind-failed')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('Port 8765 in use by unknown process')
    expect(res.stderr).toBe('fatal: bind failed')
  })

  it('TC-2.5: Anti-Stuck defense - daemon restarts but remains memory_only fails with explicit message', async () => {
    process.env.VECTR_UPGRADE_TIMEOUT_MS = '200'

    const mockResolver: IInstanceResolver = {
      resolveForWorkspace: vi.fn(async () => ({
        workspace: '/ws/stuck-mem',
        port: 8888,
        host: '127.0.0.1',
        mode: 'memory_only',
      })),
      getAll: vi.fn(),
    }

    const mockApiClient: IVectrApiClient = {
      getStatus: vi.fn(async () => ({ mode: 'memory_only', fully_ready: true })),
      triggerIndex: vi.fn(),
      recall: vi.fn(),
      resume: vi.fn(),
    }

    const mockCliRunner: IVectrCliRunner = {
      init: vi.fn(async () => ({ ok: true })),
      restart: vi.fn(async () => ({ ok: true })),
    }

    const service = new SessionVectrService({
      instanceResolver: mockResolver,
      apiClient: mockApiClient,
      codebaseService: { listForWorkspace: vi.fn(async () => []) },
      cliRunner: mockCliRunner,
    })

    const res = await service.upgradeWorkspace('/ws/stuck-mem')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/still in memory_only mode/i)
  })

  it('TC-2.6: Concurrency debounce - multiple simultaneous upgrade calls deduplicate to 1 execution', async () => {
    let mode = 'memory_only'
    let restartCallCount = 0

    const mockResolver: IInstanceResolver = {
      resolveForWorkspace: vi.fn(async () => ({
        workspace: '/ws/concurrent',
        port: 8899,
        host: '127.0.0.1',
        mode,
      })),
      getAll: vi.fn(),
    }

    const mockApiClient: IVectrApiClient = {
      getStatus: vi.fn(async () => ({ mode, fully_ready: true })),
      triggerIndex: vi.fn(),
      recall: vi.fn(),
      resume: vi.fn(),
    }

    const mockCliRunner: IVectrCliRunner = {
      init: vi.fn(async () => ({ ok: true })),
      restart: vi.fn(async () => {
        restartCallCount++
        await new Promise((r) => setTimeout(r, 50))
        mode = 'full'
        return { ok: true }
      }),
    }

    const service = new SessionVectrService({
      instanceResolver: mockResolver,
      apiClient: mockApiClient,
      codebaseService: { listForWorkspace: vi.fn(async () => []) },
      cliRunner: mockCliRunner,
      upgradeTimeoutMs: 2000,
    })

    const [res1, res2, res3] = await Promise.all([
      service.upgradeWorkspace('/ws/concurrent'),
      service.upgradeWorkspace('/ws/concurrent'),
      service.upgradeWorkspace('/ws/concurrent'),
    ])

    expect(res1.ok).toBe(true)
    expect(res2.ok).toBe(true)
    expect(res3.ok).toBe(true)
    expect(restartCallCount).toBe(1)
  })
})

describe('QA Deep Verification: Defect 3 - Primary Codebase Index 0, Delete Defense & Multi-WS Probe', () => {
  const metaPath = `/tmp/qa-meta-${Date.now()}.json`
  const instPath = `/tmp/qa-inst-${Date.now()}.json`

  afterEach(() => {
    if (existsSync(metaPath)) unlinkSync(metaPath)
    if (existsSync(instPath)) unlinkSync(instPath)
  })

  it('TC-3.1: Non-memory_only workspace prepends Primary codebase at index 0 when external codebases exist', async () => {
    const mockResolver: IInstanceResolver = {
      resolveForWorkspace: vi.fn(async () => ({
        workspace: '/ws/alpha-project',
        port: 8761,
        host: '127.0.0.1',
        mode: 'full',
      })),
      getAll: vi.fn(),
    }

    const mockApiClient: IVectrApiClient = {
      getStatus: vi.fn(async () => ({ mode: 'full', fully_ready: true })),
      triggerIndex: vi.fn(),
      recall: vi.fn(),
      resume: vi.fn(),
    }

    const mockCodebaseService: ICodebaseService = {
      listForWorkspace: vi.fn(async () => [
        {
          id: 'ext-lib',
          slug: 'ext-lib',
          type: 'remote',
          workspace: '/ws/alpha-project',
          status: 'up',
        } as any,
      ]),
    }

    const service = new SessionVectrService({
      instanceResolver: mockResolver,
      apiClient: mockApiClient,
      codebaseService: mockCodebaseService,
      cliRunner: { init: vi.fn(), restart: vi.fn() },
    })

    const status = await service.getSessionStatus('/ws/alpha-project')
    expect(status.codebases.length).toBe(2)
    expect(status.codebases[0]?.slug).toBe('primary')
    expect(status.codebases[0]?.isPrimary).toBe(true)
    expect(status.codebases[0]?.deletable).toBe(false)
    expect(status.codebases[0]?.target).toBe('/ws/alpha-project')
  })

  it('TC-3.2: Memory_only workspace NEVER displays Primary codebase even with external codebases mounted', async () => {
    const mockResolver: IInstanceResolver = {
      resolveForWorkspace: vi.fn(async () => ({
        workspace: '/ws/mem-only-project',
        port: 8762,
        host: '127.0.0.1',
        mode: 'memory_only',
      })),
      getAll: vi.fn(),
    }

    const mockApiClient: IVectrApiClient = {
      getStatus: vi.fn(async () => ({ mode: 'memory_only', fully_ready: true })),
      triggerIndex: vi.fn(),
      recall: vi.fn(),
      resume: vi.fn(),
    }

    const mockCodebaseService: ICodebaseService = {
      listForWorkspace: vi.fn(async () => [
        {
          id: 'ext-lib',
          slug: 'ext-lib',
          type: 'local',
          path: '/ext/lib',
          workspace: '/ws/mem-only-project',
          status: 'up',
        } as any,
      ]),
    }

    const service = new SessionVectrService({
      instanceResolver: mockResolver,
      apiClient: mockApiClient,
      codebaseService: mockCodebaseService,
      cliRunner: { init: vi.fn(), restart: vi.fn() },
    })

    const status = await service.getSessionStatus('/ws/mem-only-project')
    expect(status.codebases.length).toBe(1)
    expect(status.codebases[0]?.slug).toBe('ext-lib')
    expect(status.codebases[0]?.isPrimary).toBe(false)
  })

  it('TC-3.3: Delete Defense - rejects DELETE on primary, system hex primary, and same-path codebase', async () => {
    const deps: any = {
      spawnRunner: vi.fn(),
      sshRunner: vi.fn(),
      credentialStore: { get: vi.fn(), set: vi.fn(), unset: vi.fn() },
    }

    // 1. Explicit isPrimary flag
    await expect(
      deleteCodebase(deps, metaPath, {
        id: 'cb1',
        slug: 'custom-name',
        type: 'local',
        path: '/ws/alpha',
        workspace: '/ws/alpha',
        serverName: 'sn1',
        status: 'up',
        isPrimary: true,
      }),
    ).rejects.toThrow(/Cannot delete primary codebase/)

    // 2. System hex primary slug (12 hex chars)
    await expect(
      deleteCodebase(deps, metaPath, {
        id: 'cb2',
        slug: 'primary-abcdef012345',
        type: 'local',
        path: '/some/path',
        workspace: '/ws/beta',
        serverName: 'sn2',
        status: 'up',
      }),
    ).rejects.toThrow(/Cannot delete primary codebase/)

    // 3. Same path as workspace
    await expect(
      deleteCodebase(deps, metaPath, {
        id: 'cb3',
        slug: 'my-root',
        type: 'local',
        path: '/ws/gamma',
        workspace: '/ws/gamma',
        serverName: 'sn3',
        status: 'up',
      }),
    ).rejects.toThrow(/Cannot delete primary codebase/)
  })

  it('TC-3.4: Creation Defense - rejects user codebase creation with "primary" or reserved prefix', async () => {
    const deps: any = {
      spawnRunner: vi.fn(),
      sshRunner: vi.fn(),
      credentialStore: { get: vi.fn(), set: vi.fn(), unset: vi.fn() },
    }

    await expect(
      createCodebase(deps, metaPath, {
        type: 'local',
        slug: 'primary',
        path: '/tmp/dir',
        workspace: '/tmp/ws',
      }),
    ).rejects.toThrow(/reserved for the primary codebase/)

    await expect(
      createCodebase(deps, metaPath, {
        type: 'local',
        slug: 'primary-test',
        path: '/tmp/dir',
        workspace: '/tmp/ws',
      }),
    ).rejects.toThrow(/reserved for the primary codebase/)
  })

  it('TC-3.5: Multi-workspace Primary Probe - 400 when ambiguous, 200 when disambiguated via ?workspace=', async () => {
    // Spin up an isolated mock HTTP server on an ephemeral port
    let probeReceived = false
    const mockDaemon = createServer((req, res) => {
      if (req.url === '/v1/status') {
        probeReceived = true
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, mode: 'full', indexed_files: 99 }))
        return
      }
      res.writeHead(404).end()
    })

    const daemonPort = await new Promise<number>((res) => {
      mockDaemon.listen(0, '127.0.0.1', () => {
        const addr = mockDaemon.address()
        res(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

    const wsAlpha = '/workspace/alpha'
    const wsBeta = '/workspace/beta'
    const wsAlphaHash = createHash('sha256').update(wsAlpha).digest('hex')
    const wsBetaHash = createHash('sha256').update(wsBeta).digest('hex')

    writeFileSync(
      instPath,
      JSON.stringify({
        [wsAlphaHash]: { workspace: wsAlpha, port: daemonPort, host: '127.0.0.1', mode: 'full' },
        [wsBetaHash]: { workspace: wsBeta, port: 9991, host: '127.0.0.1', mode: 'full' },
      }),
    )

    saveCodebases(metaPath, [
      { id: '1', slug: 'ext-a', type: 'local', path: '/ext/a', workspace: wsAlpha, serverName: 'a', status: 'up' },
      { id: '2', slug: 'ext-b', type: 'local', path: '/ext/b', workspace: wsBeta, serverName: 'b', status: 'up' },
    ])

    const routes: Array<{ path: string; handler: any }> = []
    const mockWebServer = { register: vi.fn((def) => routes.push(def)) }
    const mockCtx: any = {
      get: vi.fn((k: string) => (k === 'webServer' ? mockWebServer : undefined)),
      effect: vi.fn((fn: () => any) => fn()),
      logger: { warn: vi.fn() },
    }

    registerCodebaseRoutes(mockCtx, metaPath, '/tmp/sec.json', instPath)

    const testRoute = routes.find((r) => r.kind === 'prefix' && r.path === '/api/vectr/codebases')!
    expect(testRoute).toBeDefined()

    // 1. Without ?workspace= in multi-workspace -> 400 Ambiguous
    let resStatus = 0
    let resData = ''
    let mockRes: any = {
      writeHead: vi.fn((code) => { resStatus = code }),
      end: vi.fn((body) => { resData = body }),
    }
    let mockReq: any = { method: 'POST', url: '/api/vectr/codebases/primary/test' }
    await testRoute.handler(mockReq, mockRes)

    expect(resStatus).toBe(400)
    expect(JSON.parse(resData).error).toMatch(/Ambiguous primary codebase/i)
    expect(probeReceived).toBe(false)

    // 2. With ?workspace=/workspace/alpha -> 200 and probes daemonPort
    mockRes = {
      writeHead: vi.fn((code) => { resStatus = code }),
      end: vi.fn((body) => { resData = body }),
    }
    mockReq = {
      method: 'POST',
      url: `/api/vectr/codebases/primary/test?workspace=${encodeURIComponent(wsAlpha)}`,
    }
    await testRoute.handler(mockReq, mockRes)

    expect(resStatus).toBe(200)
    expect(probeReceived).toBe(true)
    expect(JSON.parse(resData).status.indexed_files).toBe(99)

    // Close mock daemon
    await new Promise<void>((resolve) => mockDaemon.close(() => resolve()))
  })

  it('TC-3.6: Probe Timeout configuration - respects daemonHttpTimeoutMs and aborts hanging daemon', async () => {
    // Create hanging mock daemon that never replies
    const hangingDaemon = createServer((_req, _res) => {
      // Intentionally never respond
    })

    const daemonPort = await new Promise<number>((res) => {
      hangingDaemon.listen(0, '127.0.0.1', () => {
        const addr = hangingDaemon.address()
        res(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

    const wsTest = '/workspace/hang-test'
    const wsHash = createHash('sha256').update(wsTest).digest('hex')

    writeFileSync(
      instPath,
      JSON.stringify({
        [wsHash]: { workspace: wsTest, port: daemonPort, host: '127.0.0.1', mode: 'full' },
      }),
    )

    saveCodebases(metaPath, [
      { id: '1', slug: 'ext', type: 'local', path: '/ext', workspace: wsTest, serverName: 'e', status: 'up' },
    ])

    const routes: Array<{ path: string; handler: any }> = []
    const mockWebServer = { register: vi.fn((def) => routes.push(def)) }
    const mockCtx: any = {
      get: vi.fn((k: string) => (k === 'webServer' ? mockWebServer : undefined)),
      effect: vi.fn((fn: () => any) => fn()),
      logger: { warn: vi.fn() },
    }

    // Configure aggressive timeout 150ms
    registerCodebaseRoutes(mockCtx, metaPath, '/tmp/sec.json', instPath, { daemonHttpTimeoutMs: 150 })

    const testRoute = routes.find((r) => r.kind === 'prefix' && r.path === '/api/vectr/codebases')!
    expect(testRoute).toBeDefined()

    let resStatus = 0
    let resData = ''
    const mockRes: any = {
      writeHead: vi.fn((code) => { resStatus = code }),
      end: vi.fn((body) => { resData = body }),
    }
    const mockReq: any = {
      method: 'POST',
      url: `/api/vectr/codebases/primary/test?workspace=${encodeURIComponent(wsTest)}`,
    }

    const t0 = Date.now()
    await testRoute.handler(mockReq, mockRes)
    const elapsed = Date.now() - t0

    expect(resStatus).toBe(503)
    expect(JSON.parse(resData).error).toMatch(/Primary daemon probe failed/i)
    // Proves timeout aborted quickly near 150ms rather than hanging
    expect(elapsed).toBeLessThan(1000)

    await new Promise<void>((resolve) => hangingDaemon.close(() => resolve()))
  })
})
