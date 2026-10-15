import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  diagnoseDaemon,
  isDaemonAlive,
  type HttpProbe,
  type InstanceEntry,
  type VectrStatus,
  DEFAULT_TCP_TIMEOUT_MS,
} from '../src/probe.ts'
import { SessionVectrService } from '../src/bridge/session-service.ts'
import type {
  ICodebaseService,
  IInstanceResolver,
  IVectrApiClient,
  IVectrCliRunner,
  CodebaseEntry,
} from '../src/domain/index.ts'

function createEntry(over: Partial<InstanceEntry> = {}): InstanceEntry {
  return {
    workspace: '/home/user/project-a',
    port: 8765,
    pid: 12345,
    mode: 'full',
    host: '127.0.0.1',
    ...over,
  }
}

function fakeProbe(result: VectrStatus | undefined, throws = false): HttpProbe {
  return async () => {
    if (throws) throw new Error('probe hung')
    return result
  }
}

const deps = (probe: HttpProbe) => ({
  httpProbe: probe,
  httpTimeoutMs: 100,
  tcpTimeoutMs: DEFAULT_TCP_TIMEOUT_MS,
})

describe('Workspace Identity Probe (src/probe.ts diagnoseDaemon)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('marks alive: true when entry.workspace matches status.workspace_root exactly', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const status: VectrStatus = {
      fully_ready: true,
      workspace_root: '/home/user/project-a',
    }
    const result = await diagnoseDaemon(createEntry(), deps(fakeProbe(status)))
    expect(result.alive).toBe(true)
    expect(result.reason).toBeUndefined()
    expect(await isDaemonAlive(createEntry(), deps(fakeProbe(status)))).toBe(true)
  })

  it('normalizes trailing slashes and whitespace when matching workspace paths', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const status: VectrStatus = {
      fully_ready: true,
      workspace_root: '/home/user/project-a/  ',
    }
    const entry = createEntry({ workspace: '  /home/user/project-a/// ' })
    const result = await diagnoseDaemon(entry, deps(fakeProbe(status)))
    expect(result.alive).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('marks alive: false and reason: WORKSPACE_MISMATCH when workspace_root does not match', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const status: VectrStatus = {
      fully_ready: true,
      workspace_root: '/home/user/project-b',
    }
    const entry = createEntry({ workspace: '/home/user/project-a' })
    const result = await diagnoseDaemon(entry, deps(fakeProbe(status)))
    expect(result.alive).toBe(false)
    expect(result.reason).toBe('WORKSPACE_MISMATCH')
    expect(await isDaemonAlive(entry, deps(fakeProbe(status)))).toBe(false)
  })

  it('tolerates status without workspace_root (legacy or partial daemons)', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const status: VectrStatus = {
      fully_ready: true,
    }
    const result = await diagnoseDaemon(createEntry(), deps(fakeProbe(status)))
    expect(result.alive).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('skips validation when entry.workspace is the __unassigned__ placeholder', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const status: VectrStatus = {
      fully_ready: true,
      workspace_root: '/home/user/any-root',
    }
    const entry = createEntry({ workspace: '__unassigned__' })
    const result = await diagnoseDaemon(entry, deps(fakeProbe(status)))
    expect(result.alive).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('skips validation when entry.workspace is equal to host (placeholder / remote)', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    const status: VectrStatus = {
      fully_ready: true,
      workspace_root: '/home/user/any-root',
    }
    const entryHost = createEntry({ workspace: '10.0.0.5', host: '10.0.0.5' })
    const resultHost = await diagnoseDaemon(entryHost, deps(fakeProbe(status)))
    expect(resultHost.alive).toBe(true)
    expect(resultHost.reason).toBeUndefined()

    const entryLocalhost = createEntry({ workspace: 'localhost' })
    const resultLocalhost = await diagnoseDaemon(entryLocalhost, deps(fakeProbe(status)))
    expect(resultLocalhost.alive).toBe(true)
    expect(resultLocalhost.reason).toBeUndefined()
  })
})

describe('Workspace Identity in Session Service (src/bridge/session-service.ts)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function createMockServices(statusPayload?: VectrStatus | undefined) {
    const mockResolver: IInstanceResolver = {
      resolveForWorkspace: vi.fn(async (ws: string) => ({
        workspace: ws,
        port: 8765,
        pid: 9999,
        mode: 'full',
        host: '127.0.0.1',
      })),
      getAll: vi.fn(async () => ({})),
    }

    const mockApiClient: IVectrApiClient = {
      getStatus: vi.fn(async () => statusPayload),
      triggerIndex: vi.fn(async () => ({ ok: true })),
      recall: vi.fn(async () => ({ ok: true, notes: 'test notes' })),
      resume: vi.fn(async () => ({ ok: true, data: { formatted: 'ready', processing_ms: 5 } })),
    }

    const codebasesList: CodebaseEntry[] = [
      {
        slug: 'dep-a',
        type: 'local',
        path: '/home/user/dep-a',
        workspace: '/home/user/project-a',
        status: 'up',
      },
    ]

    const mockCodebaseService: ICodebaseService = {
      listForWorkspace: vi.fn(async () => codebasesList),
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

    return { service, mockApiClient, mockResolver }
  }

  it('returns live: true and reason: undefined when status.workspace_root matches requested workspace', async () => {
    const { service } = createMockServices({
      fully_ready: true,
      workspace_root: '/home/user/project-a',
      mode: 'full',
    })

    const state = await service.getSessionStatus('/home/user/project-a')
    expect(state.live).toBe(true)
    expect(state.reason).toBeUndefined()
    expect(state.mode).toBe('full')
    expect(state.canReindex).toBe(true)
    expect(state.workspace).toBe('/home/user/project-a')
    expect(state.status?.workspace_root).toBe('/home/user/project-a')
  })

  it('matches workspace path with trailing slashes in session service', async () => {
    const { service } = createMockServices({
      fully_ready: true,
      workspace_root: '/home/user/project-a/',
      mode: 'full',
    })

    const state = await service.getSessionStatus('/home/user/project-a')
    expect(state.live).toBe(true)
    expect(state.reason).toBeUndefined()
  })

  it('detects workspace mismatch in getSessionStatus: live is false and reason is workspace_mismatch', async () => {
    const { service } = createMockServices({
      fully_ready: true,
      workspace_root: '/home/user/project-hijacker',
      mode: 'full',
    })

    const state = await service.getSessionStatus('/home/user/project-a')
    expect(state.live).toBe(false)
    expect(state.reason).toBe('workspace_mismatch')
    expect(state.mode).toBe('offline')
    expect(state.canReindex).toBe(false)
    expect(state.reindexDisabledReason).toBeDefined()
    // Verify codebase reflects down/offline
    expect(state.codebases[0]?.status).toBe('down')
  })

  it('keeps live: true if status response does not include workspace_root', async () => {
    const { service } = createMockServices({
      fully_ready: true,
      mode: 'full',
    })

    const state = await service.getSessionStatus('/home/user/project-a')
    expect(state.live).toBe(true)
    expect(state.reason).toBeUndefined()
  })

  it('sets reason to daemon_unresponsive_or_offline when status is undefined', async () => {
    const { service } = createMockServices(undefined)

    const state = await service.getSessionStatus('/home/user/project-a')
    expect(state.live).toBe(false)
    expect(state.reason).toBe('daemon_unresponsive_or_offline')
    expect(state.mode).toBe('offline')
  })
})
