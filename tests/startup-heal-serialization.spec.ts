import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  healLocalCodebase,
  saveCodebases,
  startLocalDaemon,
  type CodebaseDeps,
  type CodebaseEntry,
  type DaemonAliveProbe,
  type SpawnHandle,
  type SpawnRunner,
} from '../src/codebases.ts'
import {
  daemonAliveProbe,
  startupHeal,
  _resetStartupHealCooldownForTests,
} from '../src/index.ts'
import * as probeModule from '../src/probe.ts'
import type { Context } from '@deepseek-ai/cordis'

interface ExecEvent {
  event: string
  slug: string
  time: number
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function makeDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('Local daemon startup serialization and concurrency lock', () => {
  let dir: string
  let metaPath: string

  beforeEach(() => {
    dir = join(tmpdir(), `vectr-startup-heal-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    metaPath = join(dir, 'codebases.json')
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  function makeLocalEntry(slug: string, overrides: Partial<CodebaseEntry> = {}): CodebaseEntry {
    return {
      id: slug,
      slug,
      type: 'local',
      path: `/home/csy/Work/${slug}`,
      workspace: `/home/csy/Work/${slug}`,
      serverName: `vectr_${slug}`,
      localPort: 8766,
      status: 'down',
      ...overrides,
    }
  }

  it('passes entry.workspace to DaemonAliveProbe when workspace is present', async () => {
    saveCodebases(metaPath, [makeLocalEntry('demo1', { workspace: '/home/csy/Workspace/custom' })])
    const probe = vi.fn<DaemonAliveProbe>(async () => true)
    const deps: CodebaseDeps = {
      spawnRunner: () => {
        throw new Error('should not start when probe is alive')
      },
      sshRunner: () => {
        throw new Error('ssh unused')
      },
      credStore: { set: () => {}, get: () => undefined, unset: () => {} },
    }

    const result = await healLocalCodebase(
      deps,
      metaPath,
      makeLocalEntry('demo1', { workspace: '/home/csy/Workspace/custom' }),
      probe,
    )

    expect(result).toBe('alive')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 8766,
      workspace: '/home/csy/Workspace/custom',
    })
  })

  it('falls back to entry.path for DaemonAliveProbe when workspace is omitted', async () => {
    const entryWithoutWorkspace = makeLocalEntry('demo2', { path: '/home/csy/Work/demo2' })
    delete entryWithoutWorkspace.workspace
    saveCodebases(metaPath, [entryWithoutWorkspace])

    const probe = vi.fn<DaemonAliveProbe>(async () => true)
    const deps: CodebaseDeps = {
      spawnRunner: () => {
        throw new Error('should not start')
      },
      sshRunner: () => {
        throw new Error('ssh unused')
      },
      credStore: { set: () => {}, get: () => undefined, unset: () => {} },
    }

    const result = await healLocalCodebase(deps, metaPath, entryWithoutWorkspace, probe)

    expect(result).toBe('alive')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: 8766,
      workspace: '/home/csy/Work/demo2',
    })
  })

  it('serializes concurrent healLocalCodebase calls: second probe starts strictly after first daemon startup finishes', async () => {
    const events: ExecEvent[] = []
    let activeHealCount = 0
    let maxConcurrentHealCount = 0

    const e1 = makeLocalEntry('codebase-a', { localPort: 8765 })
    const e2 = makeLocalEntry('codebase-b', { localPort: 8766 })
    saveCodebases(metaPath, [e1, e2])

    // Probe returns false (daemons dead, need start)
    const probe: DaemonAliveProbe = vi.fn(async (target) => {
      activeHealCount++
      if (activeHealCount > maxConcurrentHealCount) maxConcurrentHealCount = activeHealCount
      const slug = target.port === 8765 ? 'codebase-a' : 'codebase-b'
      events.push({ event: 'probe:start', slug, time: Date.now() })
      await delay(30)
      events.push({ event: 'probe:end', slug, time: Date.now() })
      return false
    })

    const spawnRunner: SpawnRunner = (_cmd, args) => {
      const isA = args.includes('/home/csy/Work/codebase-a')
      const slug = isA ? 'codebase-a' : 'codebase-b'
      const port = isA ? 8765 : 8766

      const promise = (async () => {
        events.push({ event: 'start:begin', slug, time: Date.now() })
        await delay(50)
        events.push({ event: 'start:end', slug, time: Date.now() })
        activeHealCount--
        return {
          code: 0,
          stdout: JSON.stringify({ status: 'ready', port }),
          stderr: '',
          signal: null,
        }
      })()

      return {
        promise,
        kill: () => {},
      }
    }

    const deps: CodebaseDeps = {
      spawnRunner,
      sshRunner: () => {
        throw new Error('ssh unused')
      },
      credStore: { set: () => {}, get: () => undefined, unset: () => {} },
    }

    // Launch both concurrently
    const [res1, res2] = await Promise.all([
      healLocalCodebase(deps, metaPath, e1, probe),
      healLocalCodebase(deps, metaPath, e2, probe),
    ])

    expect(res1).toBe('started')
    expect(res2).toBe('started')

    // Concurrency must never exceed 1
    expect(maxConcurrentHealCount).toBe(1)

    // Verify ordering: codebase-a must finish completely before codebase-b probe starts
    const aStartEnd = events.find((e) => e.slug === 'codebase-a' && e.event === 'start:end')!
    const bProbeStart = events.find((e) => e.slug === 'codebase-b' && e.event === 'probe:start')!

    expect(aStartEnd).toBeDefined()
    expect(bProbeStart).toBeDefined()
    expect(bProbeStart.time).toBeGreaterThanOrEqual(aStartEnd.time)

    // Complete timeline order
    const eventSequence = events.map((e) => `${e.slug}:${e.event}`)
    expect(eventSequence).toEqual([
      'codebase-a:probe:start',
      'codebase-a:probe:end',
      'codebase-a:start:begin',
      'codebase-a:start:end',
      'codebase-b:probe:start',
      'codebase-b:probe:end',
      'codebase-b:start:begin',
      'codebase-b:start:end',
    ])
  })

  it('serializes direct concurrent calls to startLocalDaemon', async () => {
    let activeStarts = 0
    let maxConcurrentStarts = 0

    const e1 = makeLocalEntry('start-1', { localPort: 8771 })
    const e2 = makeLocalEntry('start-2', { localPort: 8772 })
    saveCodebases(metaPath, [e1, e2])

    const spawnRunner: SpawnRunner = (_cmd, args) => {
      const is1 = args.includes('/home/csy/Work/start-1')
      const port = is1 ? 8771 : 8772

      const promise = (async () => {
        activeStarts++
        if (activeStarts > maxConcurrentStarts) maxConcurrentStarts = activeStarts
        await delay(40)
        activeStarts--
        return {
          code: 0,
          stdout: JSON.stringify({ status: 'ready', port }),
          stderr: '',
          signal: null,
        }
      })()

      return { promise, kill: () => {} }
    }

    const deps: CodebaseDeps = {
      spawnRunner,
      sshRunner: () => {
        throw new Error('ssh unused')
      },
      credStore: { set: () => {}, get: () => undefined, unset: () => {} },
    }

    const [out1, out2] = await Promise.all([
      startLocalDaemon(deps, metaPath, e1),
      startLocalDaemon(deps, metaPath, e2),
    ])

    expect(out1.port).toBe(8771)
    expect(out2.port).toBe(8772)
    expect(maxConcurrentStarts).toBe(1)
  })

  it('does not deadlock when healLocalCodebase calls startLocalDaemon internally (reentrant)', async () => {
    const e = makeLocalEntry('reentrant-test', { localPort: 8780 })
    saveCodebases(metaPath, [e])

    const deps: CodebaseDeps = {
      spawnRunner: () => ({
        promise: Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ status: 'ready', port: 8780 }),
          stderr: '',
          signal: null,
        }),
        kill: () => {},
      }),
      sshRunner: () => {
        throw new Error('ssh unused')
      },
      credStore: { set: () => {}, get: () => undefined, unset: () => {} },
    }

    // probe returns false, triggering internal call to startLocalDaemon
    const result = await healLocalCodebase(deps, metaPath, e, async () => false)
    expect(result).toBe('started')
  })

  it('continues queue processing even if an earlier start operation throws an error', async () => {
    const e1 = makeLocalEntry('fail-codebase', { localPort: 8785 })
    const e2 = makeLocalEntry('success-codebase', { localPort: 8786 })
    saveCodebases(metaPath, [e1, e2])

    const spawnRunner: SpawnRunner = (_cmd, args) => {
      const isFail = args.includes('/home/csy/Work/fail-codebase')
      if (isFail) {
        return {
          promise: Promise.resolve({
            code: 1,
            stdout: '',
            stderr: 'Failed to bind port',
            signal: null,
          }),
          kill: () => {},
        }
      }
      return {
        promise: Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ status: 'ready', port: 8786 }),
          stderr: '',
          signal: null,
        }),
        kill: () => {},
      }
    }

    const deps: CodebaseDeps = {
      spawnRunner,
      sshRunner: () => {
        throw new Error('ssh unused')
      },
      credStore: { set: () => {}, get: () => undefined, unset: () => {} },
    }

    const [r1, r2] = await Promise.allSettled([
      healLocalCodebase(deps, metaPath, e1, async () => false),
      healLocalCodebase(deps, metaPath, e2, async () => false),
    ])

    expect(r1.status).toBe('rejected')
    expect(r2.status).toBe('fulfilled')
    if (r2.status === 'fulfilled') {
      expect(r2.value).toBe('started')
    }
  })
})

describe('daemonAliveProbe in src/index.ts', () => {
  it('forwards target.workspace to diagnoseDaemon', async () => {
    const mockCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as Context
    const mockConfig = {
      instancesPath: '/tmp/instances.json',
      serverName: 'vectr',
      toolCallTimeoutMs: 10000,
      debounceMs: 50,
      codebasesPath: '/tmp/codebases.json',
      secretsPath: '/tmp/secrets.json',
      tunnelSshTimeoutMs: 5000,
      tunnelProbeTimeoutMs: 1000,
      daemonHttpTimeoutMs: 500,
      daemonTcpTimeoutMs: 500,
      tunnelPortMin: 8760,
      tunnelPortMax: 8799,
      reconnect: {
        enabled: true,
        initialDelayMs: 500,
        maxDelayMs: 30000,
        maxAttempts: 10,
      },
    }

    const spy = vi.spyOn(probeModule, 'diagnoseDaemon').mockResolvedValueOnce({ alive: true })

    const probe = daemonAliveProbe(mockCtx, mockConfig)
    const alive = await probe({
      host: '127.0.0.1',
      port: 8765,
      workspace: '/home/csy/Work/my-project',
    })

    expect(alive).toBe(true)
    expect(spy).toHaveBeenCalledWith(
      {
        workspace: '/home/csy/Work/my-project',
        port: 8765,
        host: '127.0.0.1',
      },
      expect.objectContaining({
        httpTimeoutMs: 500,
        tcpTimeoutMs: 500,
      }),
    )
    spy.mockRestore()
  })

  it('falls back to host when workspace is undefined in daemonAliveProbe', async () => {
    const mockCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as Context
    const mockConfig = {
      instancesPath: '/tmp/instances.json',
      serverName: 'vectr',
      toolCallTimeoutMs: 10000,
      debounceMs: 50,
      codebasesPath: '/tmp/codebases.json',
      secretsPath: '/tmp/secrets.json',
      tunnelSshTimeoutMs: 5000,
      tunnelProbeTimeoutMs: 1000,
      daemonHttpTimeoutMs: 500,
      daemonTcpTimeoutMs: 500,
      tunnelPortMin: 8760,
      tunnelPortMax: 8799,
      reconnect: {
        enabled: true,
        initialDelayMs: 500,
        maxDelayMs: 30000,
        maxAttempts: 10,
      },
    }

    const spy = vi.spyOn(probeModule, 'diagnoseDaemon').mockResolvedValueOnce({ alive: true })

    const probe = daemonAliveProbe(mockCtx, mockConfig)
    const alive = await probe({
      host: '127.0.0.1',
      port: 8765,
    })

    expect(alive).toBe(true)
    expect(spy).toHaveBeenCalledWith(
      {
        workspace: '127.0.0.1',
        port: 8765,
        host: '127.0.0.1',
      },
      expect.anything(),
    )
    spy.mockRestore()
  })
})

describe('startupHeal sequential execution in src/index.ts', () => {
  let dir: string
  let codebasesPath: string
  let instancesPath: string

  beforeEach(() => {
    _resetStartupHealCooldownForTests()
    dir = join(tmpdir(), `vectr-startup-loop-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    codebasesPath = join(dir, 'codebases.json')
    instancesPath = join(dir, 'instances.json')
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('processes multiple local codebases sequentially with await in startupHeal loop', async () => {
    const e1 = {
      id: 'proj-1',
      slug: 'proj-1',
      type: 'local' as const,
      path: '/home/csy/Work/proj-1',
      workspace: '/home/csy/Work/proj-1',
      serverName: 'vectr_proj-1',
      localPort: 8791,
      status: 'down' as const,
    }
    const e2 = {
      id: 'proj-2',
      slug: 'proj-2',
      type: 'local' as const,
      path: '/home/csy/Work/proj-2',
      workspace: '/home/csy/Work/proj-2',
      serverName: 'vectr_proj-2',
      localPort: 8792,
      status: 'down' as const,
    }
    const e3 = {
      id: 'proj-3',
      slug: 'proj-3',
      type: 'local' as const,
      path: '/home/csy/Work/proj-3',
      workspace: '/home/csy/Work/proj-3',
      serverName: 'vectr_proj-3',
      localPort: 8793,
      status: 'down' as const,
    }
    saveCodebases(codebasesPath, [e1, e2, e3])

    const executionLog: Array<{ slug: string; stage: 'start' | 'done'; time: number }> = []

    const spawnRunner: SpawnRunner = (_cmd, args) => {
      const match = args.find((a) => a.includes('proj-'))
      const slug = match ? match.split('/').pop()! : 'unknown'
      const port = slug === 'proj-1' ? 8791 : slug === 'proj-2' ? 8792 : 8793

      const promise = (async () => {
        executionLog.push({ slug, stage: 'start', time: Date.now() })
        await delay(30)
        executionLog.push({ slug, stage: 'done', time: Date.now() })
        return {
          code: 0,
          stdout: JSON.stringify({ status: 'ready', port }),
          stderr: '',
          signal: null,
        }
      })()

      return { promise, kill: () => {} }
    }

    const deps: CodebaseDeps = {
      spawnRunner,
      sshRunner: () => {
        throw new Error('ssh unused')
      },
      credStore: { set: () => {}, get: () => undefined, unset: () => {} },
    }

    const mockCtx = {
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as Context

    const mockConfig = {
      instancesPath,
      serverName: 'vectr',
      toolCallTimeoutMs: 10000,
      debounceMs: 50,
      codebasesPath,
      secretsPath: join(dir, 'secrets.json'),
      tunnelSshTimeoutMs: 5000,
      tunnelProbeTimeoutMs: 1000,
      daemonHttpTimeoutMs: 500,
      daemonTcpTimeoutMs: 500,
      tunnelPortMin: 8760,
      tunnelPortMax: 8799,
      reconnect: {
        enabled: true,
        initialDelayMs: 500,
        maxDelayMs: 30000,
        maxAttempts: 10,
      },
    }

    const probeSpy = vi.spyOn(probeModule, 'diagnoseDaemon').mockResolvedValue({ alive: false })

    await startupHeal(deps, codebasesPath, instancesPath, mockCtx, mockConfig)

    probeSpy.mockRestore()

    expect(executionLog).toHaveLength(6)
    const stages = executionLog.map((l) => `${l.slug}:${l.stage}`)
    expect(stages).toEqual([
      'proj-1:start',
      'proj-1:done',
      'proj-2:start',
      'proj-2:done',
      'proj-3:start',
      'proj-3:done',
    ])
  })
})
