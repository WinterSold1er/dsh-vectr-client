import { describe, expect, it, vi } from 'vitest'
import { VectrCliRunner } from '../src/infra/cli-runner.ts'
import { SessionVectrService } from '../src/bridge/session-service.ts'
import { registerSessionRoutes } from '../src/bridge/routes.ts'
import type {
  ICodebaseService,
  IInstanceResolver,
  IVectrApiClient,
  IVectrCliRunner,
  VectrStartOptions,
} from '../src/domain/index.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'

describe('VectrCliRunner.start', () => {
  it('spawns vectr start with --path and workspace', async () => {
    const spawnedArgs: string[][] = []
    const fakeChild = new EventEmitter() as any
    fakeChild.stdout = new EventEmitter()
    fakeChild.stderr = new EventEmitter()
    fakeChild.kill = vi.fn()

    const runner = new VectrCliRunner({
      spawnFn: (cmd, args) => {
        spawnedArgs.push([cmd, ...args])
        setTimeout(() => {
          fakeChild.stdout.emit('data', JSON.stringify({ status: 'ok', port: 8788 }))
          fakeChild.emit('close', 0, null)
        }, 10)
        return fakeChild
      },
    })

    const result = await runner.start({ workspace: '/home/csy/project' })
    expect(result.ok).toBe(true)
    expect(spawnedArgs[0]).toEqual(['vectr', 'start', '--path', '/home/csy/project'])
  })

  it('passes --memory-only when memoryOnly option is true', async () => {
    const spawnedArgs: string[][] = []
    const fakeChild = new EventEmitter() as any
    fakeChild.stdout = new EventEmitter()
    fakeChild.stderr = new EventEmitter()
    fakeChild.kill = vi.fn()

    const runner = new VectrCliRunner({
      spawnFn: (cmd, args) => {
        spawnedArgs.push([cmd, ...args])
        setTimeout(() => {
          fakeChild.emit('close', 0, null)
        }, 10)
        return fakeChild
      },
    })

    const result = await runner.start({ workspace: '/home/csy/project', memoryOnly: true })
    expect(result.ok).toBe(true)
    expect(spawnedArgs[0]).toContain('--memory-only')
  })
})

describe('SessionVectrService.startWorkspace', () => {
  it('validates workspace, invokes cliRunner.start, and probes until live', async () => {
    const mockCliRunner: IVectrCliRunner = {
      init: vi.fn(),
      restart: vi.fn(),
      start: vi.fn().mockResolvedValue({ ok: true, stdout: 'started' }),
    }
    const mockResolver: IInstanceResolver = {
      resolveForWorkspace: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({ workspace: '/home/csy/project', port: 8788, pid: 1234 }),
      getAll: vi.fn().mockResolvedValue({}),
    }
    const mockApiClient: IVectrApiClient = {
      getStatus: vi.fn().mockResolvedValue({ status: 'ok', fully_ready: true }),
      triggerIndex: vi.fn(),
      recall: vi.fn(),
      resume: vi.fn(),
    }
    const mockCodebases: ICodebaseService = {
      listForWorkspace: vi.fn().mockResolvedValue([]),
    }

    const service = new SessionVectrService({
      cliRunner: mockCliRunner,
      instanceResolver: mockResolver,
      apiClient: mockApiClient,
      codebaseService: mockCodebases,
    })

    const result = await service.startWorkspace({ workspace: '/home/csy/project' })
    expect(result.ok).toBe(true)
    expect(result.port).toBe(8788)
    expect(result.pid).toBe(1234)
    expect(mockCliRunner.start).toHaveBeenCalledWith({ workspace: '/home/csy/project' })
  })
})

describe('POST /api/vectr/session-start route', () => {
  it('registers endpoint on webServer and dispatches startWorkspace', async () => {
    type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
    const routes = new Map<string, Handler>()
    const fakeWebServer = {
      register: ({ path, handler }: { path: string; handler: Handler }) => {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    }
    const fakeCtx = {
      get: (name: string) => (name === 'webServer' ? fakeWebServer : undefined),
      effect: (fn: () => void) => fn(),
    } as any

    const mockService = {
      getSessionStatus: vi.fn(),
      triggerIndex: vi.fn(),
      initWorkspace: vi.fn(),
      upgradeWorkspace: vi.fn(),
      recallNotes: vi.fn(),
      getResume: vi.fn(),
      startWorkspace: vi.fn().mockResolvedValue({ ok: true, port: 8788, pid: 1234 }),
    }

    registerSessionRoutes(fakeCtx, mockService as any)

    const handler = routes.get('/api/vectr/session-start')
    expect(handler).toBeDefined()

    const reqStream: any = [Buffer.from(JSON.stringify({ workspace: '/home/csy/project' }))]
    reqStream.method = 'POST'
    reqStream.url = '/api/vectr/session-start'
    const res = {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as any

    await handler!(reqStream, res)

    expect(mockService.startWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: '/home/csy/project' })
    )
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
  })
})
