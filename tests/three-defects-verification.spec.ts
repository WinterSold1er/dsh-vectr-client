/**
 * Comprehensive Verification Test Suite:
 * Verifying fixes for the 3 defects in an isolated test environment without affecting production services.
 *
 * Defect 1: Single mutex Vectr button (active session -> header; blank/new session -> input right).
 * Defect 2: Upgrade memory-only workspace to full mode (restart --full, probe ready, persist).
 * Defect 3: Non-memory only workspaces show primary codebase at index 0 when external codebases are mounted, with delete defense.
 */

import { describe, expect, it, vi } from 'vitest'
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
} from '../src/domain/rules'
import { SessionVectrService } from '../src/bridge/session-service'
import { registerSessionRoutes } from '../src/bridge/routes'
import { createCodebase, deleteCodebase, CodebaseError } from '../src/codebases'
import type {
  ICodebaseService,
  IInstanceResolver,
  IVectrApiClient,
  IVectrCliRunner,
} from '../src/domain'

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

describe('Defect 1: New Conversation Page Button & Strict Mutual Exclusion', () => {
  const sampleSessionId = 'session-test-001'

  it('renders input right button and hides header capsule when blank: true', () => {
    const inputElement = ConversationInputRightAction({
      sessionId: sampleSessionId,
      blank: true,
    })
    const headerElement = SessionHeaderAction({
      sessionId: sampleSessionId,
      blank: true,
    })

    const unpackedInput = unwrapElement(inputElement) as any
    const unpackedHeader = unwrapElement(headerElement)

    expect(unpackedInput).not.toBeNull()
    expect(unpackedHeader).toBeNull()

    const visibility = resolveSessionSlotVisibility({ sessionId: sampleSessionId, blank: true })
    expect(visibility.shouldRenderInputRight).toBe(true)
    expect(visibility.shouldRenderHeaderUtility).toBe(false)
  })

  it('renders input right button when useSession indicates blank: true even if useSessions byId is unready or empty', () => {
    const mockUseSession = vi.fn().mockImplementation((sel: any) =>
      sel({ sessionId: sampleSessionId, blank: true, cwd: '/workspace/alpha' }),
    )
    // useSessions has empty byId (e.g. in-flight session creation race)
    const mockUseSessions = vi.fn().mockImplementation((sel: any) =>
      sel({ byId: {}, current: sampleSessionId }),
    )

    const inputElement = ConversationInputRightAction({
      sessionId: sampleSessionId,
      useSession: mockUseSession,
      useSessions: mockUseSessions,
    })
    const headerElement = SessionHeaderAction({
      sessionId: sampleSessionId,
      useSession: mockUseSession,
      useSessions: mockUseSessions,
    })

    const unpackedInput = unwrapElement(inputElement) as any
    const unpackedHeader = unwrapElement(headerElement)

    expect(unpackedInput).not.toBeNull()
    expect(unpackedHeader).toBeNull()
  })

  it('renders header capsule and hides input right button in an active session (blank: false)', () => {
    const mockUseSession = vi.fn().mockImplementation((sel: any) =>
      sel({ sessionId: sampleSessionId, blank: false, cwd: '/workspace/alpha' }),
    )
    const mockUseSessions = vi.fn().mockImplementation((sel: any) =>
      sel({
        byId: { [sampleSessionId]: { blank: false, cwd: '/workspace/alpha' } },
        current: sampleSessionId,
      }),
    )

    const inputElement = ConversationInputRightAction({
      sessionId: sampleSessionId,
      useSession: mockUseSession,
      useSessions: mockUseSessions,
    })
    const headerElement = SessionHeaderAction({
      sessionId: sampleSessionId,
      useSession: mockUseSession,
      useSessions: mockUseSessions,
    })

    const unpackedInput = unwrapElement(inputElement)
    const unpackedHeader = unwrapElement(headerElement) as any

    expect(unpackedInput).toBeNull()
    expect(unpackedHeader).not.toBeNull()
    expect(unpackedHeader.type).toBe(ActiveSessionHeaderAction)
  })

  it('maintains strict mutual exclusion across all boundary scenarios', () => {
    const scenarios = [
      { sessionId: undefined, blank: undefined, expectedInput: true, expectedHeader: false },
      { sessionId: '', blank: undefined, expectedInput: true, expectedHeader: false },
      { sessionId: 'null', blank: undefined, expectedInput: true, expectedHeader: false },
      { sessionId: 'undefined', blank: undefined, expectedInput: true, expectedHeader: false },
      { sessionId: 'session-1', blank: true, expectedInput: true, expectedHeader: false },
      { sessionId: 'session-1', blank: false, expectedInput: false, expectedHeader: true },
      { sessionId: 'session-1', blank: undefined, expectedInput: false, expectedHeader: true },
    ]

    for (const scenario of scenarios) {
      const vis = resolveSessionSlotVisibility({
        sessionId: scenario.sessionId,
        blank: scenario.blank,
      })
      expect(vis.shouldRenderInputRight).toBe(scenario.expectedInput)
      expect(vis.shouldRenderHeaderUtility).toBe(scenario.expectedHeader)
      expect(vis.shouldRenderInputRight).toBe(!vis.shouldRenderHeaderUtility)
    }
  })
})

describe('Defect 2: Upgrading Memory-Only Workspace to Full Mode', () => {
  it('executes full upgrade workflow: init configs, restart --full, probe ready, persist', async () => {
    let mode = 'memory_only'
    const mockResolver: IInstanceResolver = {
      resolveForWorkspace: vi.fn(async () => ({
        workspace: '/ws/upgrade-test',
        port: 8769,
        host: '127.0.0.1',
        mode,
      })),
      getAll: vi.fn(async () => ({})),
    }

    const mockApiClient: IVectrApiClient = {
      getStatus: vi.fn(async () => ({
        mode,
        fully_ready: true,
      })),
      triggerIndex: vi.fn(async () => ({ ok: true })),
      recall: vi.fn(async () => ({ ok: true })),
      resume: vi.fn(async () => ({ ok: true })),
    }

    const mockCodebaseService: ICodebaseService = {
      listForWorkspace: vi.fn(async () => []),
    }

    const mockCliRunner: IVectrCliRunner = {
      init: vi.fn(async () => ({ ok: true, stdout: 'init done' })),
      restart: vi.fn(async (_ws, opts) => {
        if (opts?.full) {
          mode = 'full'
        }
        return { ok: true, stdout: 'restart --full success' }
      }),
    }

    const service = new SessionVectrService({
      instanceResolver: mockResolver,
      apiClient: mockApiClient,
      codebaseService: mockCodebaseService,
      cliRunner: mockCliRunner,
    })

    const result = await service.upgradeWorkspace('/ws/upgrade-test')
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('full')
    expect(result.port).toBe(8769)
    expect(mockCliRunner.init).toHaveBeenCalledWith({
      workspace: '/ws/upgrade-test',
      hooks: true,
      memoryOnly: false,
    })
    expect(mockCliRunner.restart).toHaveBeenCalledWith('/ws/upgrade-test', { full: true })
  })

  it('exposes POST /api/vectr/upgrade and keeps POST /api/vectr/init isolated without semantic hijacking', async () => {
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
      upgradeWorkspace: vi.fn(async (ws: string) => ({ ok: true, mode: 'full', port: 8770 })),
      initWorkspace: vi.fn(async () => ({ ok: true, stdout: 'initialized' })),
    }

    registerSessionRoutes(mockCtx, mockSessionService)

    // 1. Direct /api/vectr/upgrade
    const upgradeRoute = routes.find((r) => r.path === '/api/vectr/upgrade')!
    expect(upgradeRoute).toBeDefined()

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

    const reqStream: any = [Buffer.from(JSON.stringify({ workspace: '/ws/test-upgrade' }))]
    reqStream.method = 'POST'
    await upgradeRoute.handler(reqStream, mockRes)

    expect(resStatus).toBe(200)
    expect(mockSessionService.upgradeWorkspace).toHaveBeenCalledWith('/ws/test-upgrade')
    expect(JSON.parse(resBody).ok).toBe(true)
    expect(JSON.parse(resBody).mode).toBe('full')

    // 2. /api/vectr/init with memoryOnly: false invokes initWorkspace directly without hijacking to upgrade
    const initRoute = routes.find((r) => r.path === '/api/vectr/init')!
    expect(initRoute).toBeDefined()

    let initResStatus = 0
    let initResBody = ''
    const mockInitRes: any = {
      writeHead: vi.fn((code: number) => {
        initResStatus = code
      }),
      end: vi.fn((body: string) => {
        initResBody = body
      }),
    }

    // 清理历史调用记录，准备测试 init 路由
    mockSessionService.initWorkspace.mockClear()
    mockSessionService.upgradeWorkspace.mockClear()

    const initReqStream: any = [Buffer.from(JSON.stringify({ workspace: '/ws/test-init', memoryOnly: false }))]
    initReqStream.method = 'POST'
    await initRoute.handler(initReqStream, mockInitRes)

    expect(initResStatus).toBe(200)
    expect(mockSessionService.initWorkspace).toHaveBeenCalledWith({
      workspace: '/ws/test-init',
      hooks: false,
      memoryOnly: false,
    })
    expect(mockSessionService.upgradeWorkspace).not.toHaveBeenCalled()
    expect(JSON.parse(initResBody).stdout).toBe('initialized')

    mockSessionService.initWorkspace.mockClear()
    mockSessionService.upgradeWorkspace.mockClear()
  })
})

describe('Defect 3: Primary Codebase Listing at Index 0 & Deletion Defense', () => {
  it('prepends primary codebase at index 0 for non-memory_only workspace with external codebases', async () => {
    const mockResolver: IInstanceResolver = {
      resolveForWorkspace: vi.fn(async () => ({
        workspace: '/ws/main-project',
        port: 8760,
        host: '127.0.0.1',
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
      listForWorkspace: vi.fn(async () => [
        {
          id: 'ext-dep',
          slug: 'ext-dep',
          type: 'remote',
          path: '/remote/dep',
          host: 'server.corp',
          status: 'up',
          serverName: 'vectr_ws_ext',
          workspace: '/ws/main-project',
        } as any,
      ]),
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

    const status = await service.getSessionStatus('/ws/main-project')
    expect(status.codebases).toHaveLength(2)
    // Index 0: Primary codebase
    expect(status.codebases[0]?.slug).toBe('primary')
    expect(status.codebases[0]?.isPrimary).toBe(true)
    expect(status.codebases[0]?.deletable).toBe(false)
    expect(status.codebases[0]?.target).toBe('/ws/main-project')
    expect(status.codebases[0]?.status).toBe('up')

    // Index 1: External codebase
    expect(status.codebases[1]?.slug).toBe('ext-dep')
    expect(status.codebases[1]?.isPrimary).toBe(false)
    expect(status.codebases[1]?.deletable).toBe(true)
  })

  it('does NOT add primary codebase if workspace is memory_only', async () => {
    const mockResolver: IInstanceResolver = {
      resolveForWorkspace: vi.fn(async () => ({
        workspace: '/ws/memory-project',
        port: 8760,
        host: '127.0.0.1',
        mode: 'memory_only',
      })),
      getAll: vi.fn(async () => ({})),
    }

    const mockApiClient: IVectrApiClient = {
      getStatus: vi.fn(async () => ({ mode: 'memory_only', fully_ready: true })),
      triggerIndex: vi.fn(async () => ({ ok: false })),
      recall: vi.fn(async () => ({ ok: true })),
      resume: vi.fn(async () => ({ ok: true })),
    }

    const mockCodebaseService: ICodebaseService = {
      listForWorkspace: vi.fn(async () => [
        {
          id: 'ext-dep',
          slug: 'ext-dep',
          type: 'remote',
          path: '/remote/dep',
          host: 'server.corp',
          status: 'up',
          serverName: 'vectr_ws_ext',
          workspace: '/ws/memory-project',
        } as any,
      ]),
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

    const status = await service.getSessionStatus('/ws/memory-project')
    expect(status.codebases).toHaveLength(1)
    expect(status.codebases[0]?.slug).toBe('ext-dep')
    expect(status.codebases[0]?.isPrimary).toBe(false)
  })

  it('rejects deletion of primary codebase with error', async () => {
    const mockDeps: any = {
      spawnRunner: vi.fn(),
      sshRunner: vi.fn(),
      credentialStore: { get: vi.fn(), set: vi.fn(), unset: vi.fn() },
    }

    const primaryEntry: any = {
      id: 'primary',
      slug: 'primary',
      type: 'local',
      path: '/ws/my-code',
      workspace: '/ws/my-code',
      serverName: 'primary_my_code',
      status: 'up',
      isPrimary: true,
    }

    await expect(deleteCodebase(mockDeps, '/tmp/mock-meta.json', primaryEntry)).rejects.toThrow(
      /Cannot delete primary codebase of the workspace/,
    )
  })

  it('rejects creation of codebase with slug "primary"', async () => {
    const mockDeps: any = {
      spawnRunner: vi.fn(),
      sshRunner: vi.fn(),
      credentialStore: { get: vi.fn(), set: vi.fn(), unset: vi.fn() },
    }

    await expect(
      createCodebase(mockDeps, '/tmp/mock-meta.json', {
        type: 'local',
        slug: 'primary',
        path: '/tmp/other-path',
        workspace: '/tmp/ws',
      }),
    ).rejects.toThrow(/Slug "primary" is reserved for the primary codebase/)
  })
})
