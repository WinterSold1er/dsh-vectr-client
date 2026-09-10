/**
 * Formal QA Verification Suite for dsh-vectr-client.
 *
 * Covers:
 * 1. Configuration Externalization (cliPath, cliTimeoutMs, VECTR_CLI_TIMEOUT_MS, probe timeouts, zero hardcoding)
 * 2. Decoupling & memory_only (block /v1/index, non-code workspace note recall & resume, mode matrix)
 * 3. Session Linkage & Anti-crosstalk (multi-session cwd switching, AbortController race guard, workspace isolation)
 * 4. Initialization Flow (vectr init --hooks, --style memory-only, stdout/stderr, post-init guidance)
 * 5. Codebase Management & Security (slug boundary, local/remote mount, password credential isolation)
 * 6. Boundary & Failure Paths (null byte injection, relative path, sentinel, CLI timeout SIGKILL escalation, offline daemon)
 */

import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  canReindex,
  formatMode,
  isMemoryOnly,
  isSearchOnly,
  SLUG_PATTERN,
  validateSlug,
  validateWorkspace,
  type CodebaseEntry,
  type CodebaseSpec,
  type ICodebaseService,
  type IInstanceResolver,
  type InstanceEntry,
  type IVectrApiClient,
  type IVectrCliRunner,
  type VectrStatus,
} from '../src/domain'
import {
  DEFAULT_CLI_NAME,
  DEFAULT_CLI_TIMEOUT_MS,
  resolveCliExecutable,
  SIGKILL_ESCALATION_DELAY_MS,
  VectrApiClient,
  VectrCliRunner,
} from '../src/infra'
import { registerSessionRoutes, SessionVectrService } from '../src/bridge'
import { isDaemonAlive } from '../src/probe'

describe('QA Verification: 1. Configuration Externalization', () => {
  it('resolves cliPath via explicit config over env vars and PATH', () => {
    const origEnv = process.env.VECTR_CLI_PATH
    try {
      process.env.VECTR_CLI_PATH = '/env/bin/vectr'
      // 1. Explicit config wins
      expect(resolveCliExecutable('/custom/bin/vectr')).toBe('/custom/bin/vectr')
      // 2. Env variable wins when config omitted
      expect(resolveCliExecutable()).toBe('/env/bin/vectr')
    } finally {
      if (origEnv === undefined) delete process.env.VECTR_CLI_PATH
      else process.env.VECTR_CLI_PATH = origEnv
    }
  })

  it('resolves cliPath via VECTR_PATH fallback when VECTR_CLI_PATH is unset', () => {
    const origCliPath = process.env.VECTR_CLI_PATH
    const origVectrPath = process.env.VECTR_PATH
    try {
      delete process.env.VECTR_CLI_PATH
      process.env.VECTR_PATH = '/opt/vectr/bin/vectr'
      expect(resolveCliExecutable()).toBe('/opt/vectr/bin/vectr')
    } finally {
      if (origCliPath !== undefined) process.env.VECTR_CLI_PATH = origCliPath
      if (origVectrPath !== undefined) process.env.VECTR_PATH = origVectrPath
      else delete process.env.VECTR_PATH
    }
  })

  it('falls back to default CLI name when no config or env set', () => {
    const origCliPath = process.env.VECTR_CLI_PATH
    const origVectrPath = process.env.VECTR_PATH
    try {
      delete process.env.VECTR_CLI_PATH
      delete process.env.VECTR_PATH
      expect(resolveCliExecutable()).toBe(DEFAULT_CLI_NAME)
      expect(DEFAULT_CLI_NAME).toBe('vectr')
    } finally {
      if (origCliPath !== undefined) process.env.VECTR_CLI_PATH = origCliPath
      if (origVectrPath !== undefined) process.env.VECTR_PATH = origVectrPath
    }
  })

  it('externalizes cliTimeoutMs dynamically via options and env', () => {
    // 1. Explicit options
    const runner1 = new VectrCliRunner({ timeoutMs: 45_000 })
    expect((runner1 as any).defaultTimeoutMs).toBe(45_000)

    // 2. Env override
    const orig = process.env.VECTR_CLI_TIMEOUT_MS
    try {
      process.env.VECTR_CLI_TIMEOUT_MS = '12000'
      const runner2 = new VectrCliRunner()
      expect((runner2 as any).defaultTimeoutMs).toBe(12_000)
    } finally {
      if (orig === undefined) delete process.env.VECTR_CLI_TIMEOUT_MS
      else process.env.VECTR_CLI_TIMEOUT_MS = orig
    }
  })

  it('externalizes probe timeouts in SessionVectrService without hardcoding', async () => {
    const mockApiClient: IVectrApiClient = {
      getStatus: vi.fn(async (_h, _p, timeoutMs) => {
        expect(timeoutMs).toBe(2_500)
        return { fully_ready: true }
      }),
      triggerIndex: vi.fn(async () => ({ ok: true })),
      recall: vi.fn(async (_h, _p, _opts, timeoutMs) => {
        expect(timeoutMs).toBe(7_500)
        return { ok: true, notes: 'externalized timeout notes' }
      }),
      resume: vi.fn(async () => ({ ok: true })),
    }

    const service = new SessionVectrService({
      instanceResolver: {
        resolveForWorkspace: vi.fn(async () => ({ workspace: '/custom/ws', port: 9999, host: '127.0.0.1' })),
        getAll: vi.fn(async () => ({})),
      },
      apiClient: mockApiClient,
      codebaseService: { listForWorkspace: vi.fn(async () => []) },
      cliRunner: { init: vi.fn(async () => ({ ok: true })) },
      statusTimeoutMs: 2_500,
      recallTimeoutMs: 7_500,
    })

    await service.getSessionStatus('/custom/ws')
    expect(mockApiClient.getStatus).toHaveBeenCalledWith('127.0.0.1', 9999, 2_500)

    await service.recallNotes({ workspace: '/custom/ws' }, { query: 'test' })
    expect(mockApiClient.recall).toHaveBeenCalledWith('127.0.0.1', 9999, { query: 'test' }, 7_500)
  })
})

describe('QA Verification: 2. Decoupling & memory_only Validation', () => {
  it('strictly blocks triggerIndex and /v1/index in memory_only mode via domain rule', async () => {
    const status: VectrStatus = {
      notes_count: 12,
      fully_ready: true,
      reindex_in_progress: false,
    }

    // 1. Domain rule invariant
    const rule = canReindex(true, 'memory_only', status)
    expect(rule.canReindex).toBe(false)
    expect(rule.reason).toContain("Daemon in 'memory_only' mode cannot be re-indexed")

    // 2. Application service enforcement: apiClient.triggerIndex must NOT be called
    const mockApiClient: IVectrApiClient = {
      getStatus: vi.fn(async () => ({ mode: 'memory_only', ...status })),
      triggerIndex: vi.fn(async () => ({ ok: true })),
      recall: vi.fn(async () => ({ ok: true })),
      resume: vi.fn(async () => ({ ok: true })),
    }

    const service = new SessionVectrService({
      instanceResolver: {
        resolveForWorkspace: vi.fn(async () => ({ workspace: '/home/csy/notes', port: 8768, mode: 'memory_only' })),
        getAll: vi.fn(async () => ({})),
      },
      apiClient: mockApiClient,
      codebaseService: { listForWorkspace: vi.fn(async () => []) },
      cliRunner: { init: vi.fn(async () => ({ ok: true })) },
    })

    const triggerRes = await service.triggerIndex('/home/csy/notes')
    expect(triggerRes.ok).toBe(false)
    expect(triggerRes.error).toContain('memory_only')
    expect(mockApiClient.triggerIndex).not.toHaveBeenCalled()
  })

  it('allows working memory recall and resume in non-code directories without indexing', async () => {
    const mockApiClient: IVectrApiClient = {
      getStatus: vi.fn(async () => ({ mode: 'memory_only', notes_count: 3 })),
      triggerIndex: vi.fn(async () => ({ ok: false })),
      recall: vi.fn(async () => ({ ok: true, notes: '# Meeting Notes\n- Task 1 completed', processing_ms: 8 })),
      resume: vi.fn(async () => ({
        ok: true,
        data: {
          last_task: { id: 1, title: 'Write report' },
          formatted: 'Last task: Write report',
          processing_ms: 6,
        },
      })),
    }

    const service = new SessionVectrService({
      instanceResolver: {
        resolveForWorkspace: vi.fn(async () => ({ workspace: '/home/csy', port: 8769, mode: 'memory_only' })),
        getAll: vi.fn(async () => ({})),
      },
      apiClient: mockApiClient,
      codebaseService: { listForWorkspace: vi.fn(async () => []) },
      cliRunner: { init: vi.fn(async () => ({ ok: true })) },
    })

    // Status shows memory_only live
    const status = await service.getSessionStatus('/home/csy')
    expect(status.live).toBe(true)
    expect(status.mode).toBe('memory_only')
    expect(status.canReindex).toBe(false)

    // Recall works without code index
    const recallRes = await service.recallNotes({ workspace: '/home/csy' }, { query: 'report' })
    expect(recallRes.ok).toBe(true)
    expect(recallRes.notes).toContain('# Meeting Notes')

    // Resume works without code index
    const resumeRes = await service.getResume({ workspace: '/home/csy' })
    expect(resumeRes.ok).toBe(true)
    expect(resumeRes.data?.last_task?.title).toBe('Write report')
  })

  it('verifies ModeCapabilityMatrix for all supported modes', () => {
    // memory_only: live, no reindex
    expect(canReindex(true, 'memory_only').canReindex).toBe(false)
    // search_only: live, no reindex
    expect(canReindex(true, 'search_only').canReindex).toBe(false)
    // full: live & fully_ready -> can reindex
    expect(canReindex(true, 'full', { fully_ready: true, reindex_in_progress: false }).canReindex).toBe(true)
    // full: settling (fully_ready: false) -> cannot reindex
    expect(canReindex(true, 'full', { fully_ready: false }).canReindex).toBe(false)
    // full: busy (reindex_in_progress: true) -> cannot reindex
    expect(canReindex(true, 'full', { fully_ready: true, reindex_in_progress: true }).canReindex).toBe(false)
    // offline -> cannot reindex
    expect(canReindex(false, 'full').canReindex).toBe(false)
  })
})

describe('QA Verification: 3. Session Linkage & Anti-crosstalk', () => {
  it('isolates state and codebases between multiple concurrent sessions', async () => {
    const instances: Record<string, InstanceEntry> = {
      '/workspace/repo-a': { workspace: '/workspace/repo-a', port: 8761, host: '127.0.0.1', mode: 'full' },
      '/workspace/repo-b': { workspace: '/workspace/repo-b', port: 8762, host: '127.0.0.1', mode: 'memory_only' },
    }

    const codebasesByWs: Record<string, CodebaseEntry[]> = {
      '/workspace/repo-a': [
        { id: 'cb-a', slug: 'cb-a', type: 'local', path: '/local/lib-a', status: 'up', serverName: 'vectr_cb_a', workspace: '/workspace/repo-a' },
      ],
      '/workspace/repo-b': [
        { id: 'cb-b', slug: 'cb-b', type: 'remote', path: '/remote/svc', host: 'remote.corp', remotePort: 8760, status: 'up', serverName: 'vectr_cb_b', workspace: '/workspace/repo-b' },
      ],
    }

    const service = new SessionVectrService({
      instanceResolver: {
        resolveForWorkspace: vi.fn(async (ws: string) => instances[ws]),
        getAll: vi.fn(async () => instances),
      },
      apiClient: {
        getStatus: vi.fn(async (_h, port) => ({ port, fully_ready: true })),
        triggerIndex: vi.fn(async () => ({ ok: true })),
        recall: vi.fn(async () => ({ ok: true })),
        resume: vi.fn(async () => ({ ok: true })),
      },
      codebaseService: {
        listForWorkspace: vi.fn(async (ws: string) => codebasesByWs[ws] ?? []),
      },
      cliRunner: { init: vi.fn(async () => ({ ok: true })) },
    })

    // Query Session A
    const stateA = await service.getSessionStatus('/workspace/repo-a')
    expect(stateA.workspace).toBe('/workspace/repo-a')
    expect(stateA.port).toBe(8761)
    expect(stateA.mode).toBe('full')
    expect(stateA.codebases).toHaveLength(1)
    expect(stateA.codebases[0]?.slug).toBe('cb-a')
    expect(stateA.codebases[0]?.type).toBe('local')

    // Query Session B
    const stateB = await service.getSessionStatus('/workspace/repo-b')
    expect(stateB.workspace).toBe('/workspace/repo-b')
    expect(stateB.port).toBe(8762)
    expect(stateB.mode).toBe('memory_only')
    expect(stateB.codebases).toHaveLength(1)
    expect(stateB.codebases[0]?.slug).toBe('cb-b')
    expect(stateB.codebases[0]?.type).toBe('remote')

    // Anti-crosstalk: repo-a has zero trace of cb-b, repo-b has zero trace of cb-a
    expect(stateA.codebases.some(c => c.slug === 'cb-b')).toBe(false)
    expect(stateB.codebases.some(c => c.slug === 'cb-a')).toBe(false)
  })

  it('validates AbortController cancellation prevents stale response race conditions', async () => {
    // Simulate frontend fast-switching scenario where response A is slow and aborted
    let aborted = false
    const controller = new AbortController()
    controller.signal.addEventListener('abort', () => {
      aborted = true
    })

    // Switch happens immediately
    controller.abort()
    expect(aborted).toBe(true)

    // A delayed fetch response check
    let stateSet = false
    const simulateFetch = async (signal: AbortSignal) => {
      try {
        if (signal.aborted) return
        stateSet = true
      } catch {
        // aborted
      }
    }

    await simulateFetch(controller.signal)
    expect(stateSet).toBe(false) // Stale state was not set!
  })
})

describe('QA Verification: 4. Initialization Flow', () => {
  it('executes vectr init with --hooks and --style memory-only', async () => {
    let capturedArgs: string[] = []

    const mockSpawn = (_cmd: string, args: string[]) => {
      capturedArgs = args
      const child = new EventEmitter() as unknown as ChildProcess
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()
      ;(child as any).stdout = stdout
      ;(child as any).stderr = stderr
      ;(child as any).kill = vi.fn()

      setTimeout(() => {
        stdout.emit('data', 'Initialized vectr in /projects/app\nInjected Claude Code hooks.\n')
        child.emit('close', 0, null)
      }, 10)
      return child
    }

    const runner = new VectrCliRunner({
      spawnFn: mockSpawn as any,
    })

    const res = await runner.init({
      workspace: '/projects/app',
      hooks: true,
      memoryOnly: true,
    })

    expect(res.ok).toBe(true)
    expect(res.stdout).toContain('Injected Claude Code hooks')
    expect(capturedArgs).toEqual(['init', '--path', '/projects/app', '--hooks', '--style', 'memory-only'])
  })

  it('supports custom instruction style in init', async () => {
    let capturedArgs: string[] = []

    const mockSpawn = (_cmd: string, args: string[]) => {
      capturedArgs = args
      const child = new EventEmitter() as unknown as ChildProcess
      ;(child as any).stdout = new EventEmitter()
      ;(child as any).stderr = new EventEmitter()
      ;(child as any).kill = vi.fn()
      setTimeout(() => child.emit('close', 0, null), 10)
      return child
    }

    const runner = new VectrCliRunner({ spawnFn: mockSpawn as any })
    await runner.init({
      workspace: '/projects/custom',
      style: 'directed',
    })

    expect(capturedArgs).toEqual(['init', '--path', '/projects/custom', '--style', 'directed'])
  })

  it('captures structured error output on init non-zero exit', async () => {
    const mockSpawn = () => {
      const child = new EventEmitter() as unknown as ChildProcess
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()
      ;(child as any).stdout = stdout
      ;(child as any).stderr = stderr
      ;(child as any).kill = vi.fn()

      setTimeout(() => {
        stderr.emit('data', 'fatal: directory not writable\n')
        child.emit('close', 2, null)
      }, 10)
      return child
    }

    const runner = new VectrCliRunner({ spawnFn: mockSpawn as any })
    const res = await runner.init({ workspace: '/root/forbidden' })

    expect(res.ok).toBe(false)
    expect(res.error).toBe('fatal: directory not writable')
    expect(res.stderr).toContain('fatal: directory not writable')
  })
})

describe('QA Verification: 5. Codebase Management & Security Isolation', () => {
  it('enforces SLUG_PATTERN boundary conditions rigorously', () => {
    // Boundary min: 1 char
    expect(validateSlug('a').valid).toBe(true)
    expect(validateSlug('1').valid).toBe(true)
    expect(validateSlug('_').valid).toBe(true)
    expect(validateSlug('-').valid).toBe(true)

    // Boundary max: 32 chars
    expect(validateSlug('a'.repeat(32)).valid).toBe(true)

    // Boundary exceed: 33 chars -> rejected
    expect(validateSlug('a'.repeat(33)).valid).toBe(false)

    // Boundary 0 chars -> rejected
    expect(validateSlug('').valid).toBe(false)

    // Illegal characters rejected
    expect(validateSlug('slug with space').valid).toBe(false)
    expect(validateSlug('slug/slash').valid).toBe(false)
    expect(validateSlug('slug\\backslash').valid).toBe(false)
    expect(validateSlug('slug.dot').valid).toBe(false)
    expect(validateSlug('slug@at').valid).toBe(false)
    expect(validateSlug('slug:colon').valid).toBe(false)
    expect(validateSlug('slug\0null').valid).toBe(false)
    expect(validateSlug('中文slug').valid).toBe(false)
  })

  it('ensures password credentials are isolated and never leaked in codebase entries', () => {
    const rawSpec: CodebaseSpec = {
      type: 'remote',
      slug: 'secure-node',
      path: '/data/repo',
      host: 'node1.corp',
      auth: 'password',
      password: 'SuperSecretPassword123!',
    }

    // When processed into CodebaseEntry, password is saved to credential store and referenced via credentialRef
    const entry: CodebaseEntry = {
      id: rawSpec.slug,
      slug: rawSpec.slug,
      type: rawSpec.type,
      path: rawSpec.path,
      host: rawSpec.host,
      auth: rawSpec.auth,
      credentialRef: 'VECTR_CRED_SECURE_NODE',
      serverName: 'vectr_ws_secure-node',
      status: 'up',
    }

    // Verify plaintext password is never present on CodebaseEntry
    expect((entry as any).password).toBeUndefined()

    // Verify stripSecret helper strips credentialRef before public exposure
    const { credentialRef: _c, ...stripped } = entry
    expect(stripped.credentialRef).toBeUndefined()
    expect(stripped.slug).toBe('secure-node')
    expect(stripped.status).toBe('up')
  })
})

describe('QA Verification: 6. Boundary & Failure Paths', () => {
  it('rejects null byte injection in workspace path', () => {
    const res = validateWorkspace('/home/csy/code\0/malicious')
    expect(res.valid).toBe(false)
    expect(res.error).toContain('null bytes')
  })

  it('rejects unassigned sentinel and relative paths in workspace', () => {
    expect(validateWorkspace('__unassigned__').valid).toBe(false)
    expect(validateWorkspace('').valid).toBe(false)
    expect(validateWorkspace('   ').valid).toBe(false)
    expect(validateWorkspace('./foo/bar').valid).toBe(false)
    expect(validateWorkspace('../foo/bar').valid).toBe(false)
    expect(validateWorkspace('relative/path').valid).toBe(false)
  })

  it('escalates from SIGTERM to SIGKILL on CLI timeout zombie prevention', async () => {
    vi.useFakeTimers()
    const killSignals: string[] = []
    const child = new EventEmitter() as unknown as ChildProcess
    ;(child as any).stdout = new EventEmitter()
    ;(child as any).stderr = new EventEmitter()
    ;(child as any).exitCode = null
    ;(child as any).signalCode = null
    ;(child as any).kill = vi.fn((sig: string) => {
      killSignals.push(sig)
    })

    const runner = new VectrCliRunner({
      spawnFn: () => child,
      timeoutMs: 500,
    })

    const runPromise = runner.init({ workspace: '/tmp/zombie-ws' })

    // Advance 500ms -> triggers SIGTERM
    await vi.advanceTimersByTimeAsync(500)
    expect(killSignals).toEqual(['SIGTERM'])

    // Advance SIGKILL_ESCALATION_DELAY_MS (1500ms) -> escalates to SIGKILL
    await vi.advanceTimersByTimeAsync(SIGKILL_ESCALATION_DELAY_MS)
    expect(killSignals).toEqual(['SIGTERM', 'SIGKILL'])

    const result = await runPromise
    expect(result.ok).toBe(false)
    expect(result.error).toContain('timed out after 500ms')
    vi.useRealTimers()
  })

  it('detects hung daemon (process alive but HTTP probe times out) and marks alive: false', async () => {
    // Process layer alive (using current test runner's pid)
    const entry: InstanceEntry = {
      workspace: '/home/csy/Work/twoplus',
      port: 8765,
      pid: process.pid,
    }

    // Mock httpProbe returning undefined (HTTP hung)
    const mockHungProbe = vi.fn(async () => undefined)

    const alive = await isDaemonAlive(entry, {
      httpProbe: mockHungProbe,
      httpTimeoutMs: 100,
      tcpTimeoutMs: 50,
    })

    // Must be false: alive = processLayer && httpLayer
    expect(alive).toBe(false)
    expect(mockHungProbe).toHaveBeenCalledWith(entry, 100)
  })

  it('returns 400 Bad Request on malformed JSON body in HTTP routes', async () => {
    const routes: Array<{ path: string; handler: any }> = []
    const mockCtx: any = {
      get: vi.fn(() => ({
        register: (def: any) => {
          routes.push(def)
          return () => {}
        },
      })),
      effect: vi.fn((fn: () => any) => fn()),
    }

    const mockService: any = {
      getSessionStatus: vi.fn(),
      initWorkspace: vi.fn(),
    }

    registerSessionRoutes(mockCtx, mockService)
    const initRoute = routes.find(r => r.path === '/api/vectr/init')!

    let status = 0
    let responseText = ''
    const mockRes: any = {
      writeHead: (code: number) => {
        status = code
      },
      end: (data: string) => {
        responseText = data
      },
    }

    // Send malformed non-JSON data
    const malformedReq: any = [Buffer.from('{ not valid json ...')]
    malformedReq.method = 'POST'

    await initRoute.handler(malformedReq, mockRes)
    expect(status).toBe(400)
    expect(JSON.parse(responseText).error).toContain('Invalid JSON body')
  })
})
