/**
 * Daemon-health and session-cwd unit tests (D-2, D-4, D-7, R3, R4) for the
 * vectr-client plugin's `install` path and the liveness gate.
 *
 * These run WITHOUT any real vectr daemon: `startConnection` is mocked so we
 * can assert whether a bind was attempted (connection requested) or skipped.
 * The `process.cwd()` fallback (removed by D-4), the registry re-read (D-7),
 * the pid/TCP/HTTP liveness gate (D-2 / R3) and the graceful skip (R4) are
 * exercised directly. A process-local HTTP server stands in for a live daemon's
 * `/v1/status` so the R3 HTTP layer is exercised end-to-end.
 */
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { startConnection } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  install,
  isDaemonAlive,
  isPortListening,
  readInstancesFile,
  type InstancesFile,
  type InstanceEntry,
} from '../src/index.ts'
import { diagnoseDaemon, fetchStatus, type HttpProbe } from '../src/probe.ts'

// Mock startConnection so no real MCP/HTTP connection is ever attempted; the
// test asserts call/non-call directly.
// The plugin sources `startConnection` (and `resolveReconnectPolicy`) from the
// `@deepseek-ai/dsh-mcp-client/src/connection.ts` subpath (the only export surface
// rc.2 exposes for these symbols — the package root only re-exports
// {Config, apply, inject, name}). The mock MUST therefore target that subpath,
// not the package root, or the real binding is called and the call count stays 0.
vi.mock('@deepseek-ai/dsh-mcp-client/src/connection.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client/src/connection.ts')>()
  return {
    ...actual,
    startConnection: vi.fn(() => ({ ready: Promise.resolve({}), dispose: vi.fn() })),
  }
})

const startConnectionMock = startConnection as unknown as Mock

/** sha256(abs path)[:12], the exact registry key vectr writes. */
function keyOf(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 12)
}

function makeAgent(id: string, cwd: string | undefined): Agent {
  const sessionCtx = new Context()
  const agent = {
    id,
    options: {},
    session: { header: { cwd } },
    status: 'idle' as const,
    acceptsNextStep: false,
    followup() {},
    steer() {},
    inject() {},
    send() {},
    updateInbox() { return 'not-found' as const },
    cancel() {},
    whenIdle: () => Promise.resolve(),
    ctx: sessionCtx,
  } as unknown as Agent
  return agent
}

function entryFor(cwd: string, port: number, pid?: number): InstanceEntry {
  return { workspace: cwd, port, pid, started_at: 0, mode: 'full', host: '127.0.0.1' }
}

/** A real, answering `/v1/status` daemon simulator (for the R3 HTTP layer). */
function startStatusServer(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ fully_ready: true }))
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/** A daemon that accepts TCP but never answers `/v1/status` (the R3 hang case). */
function startHangingServer(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((_req, _res) => {
      // Never respond: simulates a process that is up but HTTP-dead.
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port
}

const roots: string[] = []
const handles = new Map<Agent, unknown>()
const promptFibers = new Map<Agent, unknown>()
let statusServer: Server
let statusPort: number

beforeAll(async () => {
  statusServer = await startStatusServer()
  statusPort = portOf(statusServer)
})

afterAll(async () => {
  await new Promise<void>((r) => statusServer.close(() => r()))
})

afterEach(async () => {
  vi.restoreAllMocks()
  startConnectionMock.mockClear()
  handles.clear()
  promptFibers.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function aliveDeps(probe: HttpProbe = (e, ms) => fetchStatus(e, ms)) {
  return { httpProbe: probe, httpTimeoutMs: 10, tcpTimeoutMs: 300 }
}

describe('isDaemonAlive / isPortListening (D-2 primitives)', () => {
  it('reports a dead pid (ESRCH) as not alive', async () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException
      err.code = 'ESRCH'
      throw err
    })
    expect(await isDaemonAlive(entryFor('/w', 1234, 99_999), aliveDeps())).toBe(false)
    spy.mockRestore()
  })

  it('reports an alive pid (kill(0) success) as alive', async () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    // HTTP layer exercised via an injected probe (no real network).
    expect(await isDaemonAlive(entryFor('/w', statusPort, 4242), aliveDeps(async () => ({ fully_ready: true })))).toBe(true)
    spy.mockRestore()
  })

  it('reports a pid with EPERM (exists, no signal permission) as alive', async () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    })
    expect(await isDaemonAlive(entryFor('/w', statusPort, 1), aliveDeps(async () => ({ fully_ready: true })))).toBe(true)
    spy.mockRestore()
  })

  it('probes TCP when no pid is present; a closed port is not alive', async () => {
    const closedPort = 1 // privileged / nothing listening
    expect(await isDaemonAlive(entryFor('/w', closedPort), aliveDeps())).toBe(false)
  })

  it('treats a non-number pid ("abc") as process-layer absent, falling through to TCP/HTTP (F3)', async () => {
    // A non-number pid must NOT be run through process.kill (which would throw
    // TypeError) — it is treated as pid-less and judged by TCP/HTTP instead.
    const entry = entryFor('/w', 2, 'abc' as unknown as number) // closed port
    const diag = await diagnoseDaemon(entry, aliveDeps())
    expect(diag.alive).toBe(false)
    expect(diag.reason).toBe('PORT_CLOSED') // prove process-layer signal was skipped
  })
})

describe('install liveness gate (D-2 / R3)', () => {
  it('skips a dead pid entry: no connect, warn carries workspace/cwd/port/pid + reason', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-d2-deadpid-'))
    roots.push(dir)
    const cwd = join(dir, 'ws')
    const file = join(dir, 'instances.json')
    await writeFile(file, JSON.stringify({ [keyOf(cwd)]: entryFor(cwd, 1234, 99_999) }))

    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException
      err.code = 'ESRCH'
      throw err
    })

    const agent = makeAgent('dead-pid-agent', cwd)
    install(ctx, handles as Map<Agent, never>, promptFibers as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
      daemonHttpTimeoutMs: 5000,
      daemonTcpTimeoutMs: 300,
    }, agent)
    // N2/T5: wait for the liveness IIFE to settle on its REAL outcome (the
    // skip warn) instead of a fixed 20ms window that flakes under event-loop
    // load.
    await vi.waitFor(() => {
      expect(warn.mock.calls.some(
        c => String(c[0]).includes('not alive') && String(c[0]).includes('reason=PROCESS_DEAD_ESRCH'),
      )).toBe(true)
    }, { timeout: 5000, interval: 25 })

    expect(startConnectionMock).not.toHaveBeenCalled()
    expect(handles.has(agent)).toBe(false)
    const warned = warn.mock.calls.some(c => String(c[0]).includes('not alive') && String(c[0]).includes('pid=99999') && String(c[0]).includes('reason=PROCESS_DEAD_ESRCH'))
    expect(warned).toBe(true)
    spy.mockRestore()
  })

  it('skips an entry whose port is not listening (no pid): no connect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-d2-deadport-'))
    roots.push(dir)
    const cwd = join(dir, 'ws')
    const closedPort = 2 // nothing listening on a privileged port
    const file = join(dir, 'instances.json')
    await writeFile(file, JSON.stringify({ [keyOf(cwd)]: entryFor(cwd, closedPort) }))

    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const agent = makeAgent('dead-port-agent', cwd)
    install(ctx, handles as Map<Agent, never>, promptFibers as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
      daemonHttpTimeoutMs: 5000,
      daemonTcpTimeoutMs: 300,
    }, agent)
    // T5: wait for the real skip warn instead of a fixed 20ms window.
    await vi.waitFor(() => {
      expect(warn.mock.calls.some(
        c => String(c[0]).includes('not alive') && String(c[0]).includes('reason=PORT_CLOSED'),
      )).toBe(true)
    }, { timeout: 5000, interval: 25 })

    expect(startConnectionMock).not.toHaveBeenCalled()
    expect(handles.has(agent)).toBe(false)
    expect(warn.mock.calls.some(c => String(c[0]).includes('not alive') && String(c[0]).includes('reason=PORT_CLOSED'))).toBe(true)
  })

  it('binds a live pid + HTTP-reachable entry: connect is attempted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-d2-alivepid-'))
    roots.push(dir)
    const cwd = join(dir, 'ws')
    const file = join(dir, 'instances.json')
    await writeFile(file, JSON.stringify({ [keyOf(cwd)]: entryFor(cwd, statusPort, 4242) }))

    const ctx = new Context()
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const agent = makeAgent('alive-pid-agent', cwd)
    install(ctx, handles as Map<Agent, never>, promptFibers as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
      daemonHttpTimeoutMs: 5000,
      daemonTcpTimeoutMs: 300,
    }, agent)
    // T5: wait for the real bind outcome (handle registered) instead of a
    // fixed 20ms window; the HTTP probe to the status server is the slowest
    // step in the IIFE.
    await vi.waitFor(() => {
      expect(handles.has(agent)).toBe(true)
    }, { timeout: 5000, interval: 25 })

    expect(startConnectionMock).toHaveBeenCalledTimes(1)
    expect(handles.has(agent)).toBe(true)
    spy.mockRestore()
  })

  it('R3/R4: pid alive + port listening but HTTP hung → skip (graceful, no throw)', async () => {
    const hangServer = await startHangingServer()
    const hangPort = portOf(hangServer)
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-r3-hang-'))
    roots.push(dir)
    const cwd = join(dir, 'ws')
    const file = join(dir, 'instances.json')
    // twoplus 8765 analog: pid present, TCP up, HTTP /v1/status hung.
    await writeFile(file, JSON.stringify({ [keyOf(cwd)]: entryFor(cwd, hangPort, 2483691) }))

    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const agent = makeAgent('hang-daemon-agent', cwd)
    install(ctx, handles as Map<Agent, never>, promptFibers as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
      // Small budgets so the hang is judged dead quickly.
      daemonHttpTimeoutMs: 30,
      daemonTcpTimeoutMs: 30,
    }, agent)
    // The HTTP probe aborts after daemonHttpTimeoutMs (30ms) and install() then
    // emits the graceful-skip warn from its async liveness IIFE. A fixed
    // `setTimeout(100)` flaked under event-loop load — the fetch→abort→warn
    // chain can take longer than 100ms to settle, so the warn had not been
    // emitted yet when the assertions ran. Poll for the REAL warn to appear
    // (up to a generous 2s budget) instead of sleeping a fixed window.
    // Semantic unchanged: we still assert the daemon was judged not alive via
    // HTTP_PROBE_UNREACHABLE and that no connection was ever attempted.
    await vi.waitFor(() => {
      expect(warn.mock.calls.some(
        c => String(c[0]).includes('not alive') && String(c[0]).includes('reason=HTTP_PROBE_UNREACHABLE'),
      )).toBe(true)
    }, { timeout: 2000, interval: 25 })

    expect(startConnectionMock).not.toHaveBeenCalled()
    expect(handles.has(agent)).toBe(false)
    spy.mockRestore()
    await new Promise<void>((r) => hangServer.close(() => r()))
  })
})

describe('missing session cwd (D-4)', () => {
  it('skips with a warn and never starts a connection when header.cwd is undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-d4-'))
    roots.push(dir)
    const file = join(dir, 'instances.json')
    await writeFile(file, JSON.stringify({ x: entryFor('/somewhere', statusPort, 1) }))

    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const agent = makeAgent('no-cwd-agent', undefined)
    install(ctx, handles as Map<Agent, never>, promptFibers as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
      daemonHttpTimeoutMs: 5000,
      daemonTcpTimeoutMs: 300,
    }, agent)
    // T5: the no-cwd skip warn is synchronous, but poll the real outcome for
    // uniformity with the other liveness-gate cases.
    await vi.waitFor(() => {
      expect(warn.mock.calls.some(
        c => String(c[0]).includes('no cwd on session') && String(c[0]).includes('no-cwd-agent'),
      )).toBe(true)
    }, { timeout: 5000, interval: 25 })

    expect(startConnectionMock).not.toHaveBeenCalled()
    expect(handles.has(agent)).toBe(false)
    expect(warn.mock.calls.some(c => String(c[0]).includes('no cwd on session') && String(c[0]).includes('no-cwd-agent'))).toBe(true)
    // process.cwd() must never be consulted as a fallback.
    expect(warn.mock.calls.some(c => String(c[0]).includes('process.cwd'))).toBe(false)
  })
})

describe('registry re-read on every call (D-7)', () => {
  it('resolves a freshly rewritten registry entry for a later agent (new port)', async () => {
    const server1 = await startStatusServer()
    const server2 = await startStatusServer()
    const p1 = portOf(server1)
    const p2 = portOf(server2)
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-d7-'))
    roots.push(dir)
    const cwd = join(dir, 'ws')
    const file = join(dir, 'instances.json')

    // First generation: port p1.
    await writeFile(file, JSON.stringify({ [keyOf(cwd)]: entryFor(cwd, p1, 1) }))
    const ctx = new Context()
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true) // treat pid as alive

    const agent1 = makeAgent('reread-agent-1', cwd)
    install(ctx, handles as Map<Agent, never>, promptFibers as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
      daemonHttpTimeoutMs: 5000,
      daemonTcpTimeoutMs: 300,
    }, agent1)
    // T5: wait for the first bind to settle (url carrying p1) instead of a
    // fixed 20ms window.
    await vi.waitFor(() => {
      expect(startConnectionMock.mock.calls.some(c => String(c[1]?.url ?? '').includes(`:${p1}`))).toBe(true)
    }, { timeout: 5000, interval: 25 })
    const firstUrl = startConnectionMock.mock.calls[0]?.[1]?.url as string | undefined
    expect(firstUrl).toContain(`:${p1}`)

    // Rewrite the registry with a NEW port (simulating a daemon restart).
    await writeFile(file, JSON.stringify({ [keyOf(cwd)]: entryFor(cwd, p2, 1) }))
    const agent2 = makeAgent('reread-agent-2', cwd)
    install(ctx, handles as Map<Agent, never>, promptFibers as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
      daemonHttpTimeoutMs: 5000,
      daemonTcpTimeoutMs: 300,
    }, agent2)
    // T5: wait for the second bind (url carrying p2) the same way.
    await vi.waitFor(() => {
      expect(startConnectionMock.mock.calls.some(c => String(c[1]?.url ?? '').includes(`:${p2}`))).toBe(true)
    }, { timeout: 5000, interval: 25 })
    const secondUrl = startConnectionMock.mock.calls[1]?.[1]?.url as string | undefined
    expect(secondUrl).toContain(`:${p2}`)

    spy.mockRestore()
    await new Promise<void>((r) => server1.close(() => r()))
    await new Promise<void>((r) => server2.close(() => r()))
  })
})

describe('subagent / multi-agent scenario (D-2 / R4)', () => {
  it('binds the live parent daemon but skips a child whose daemon is dead', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-subagent-'))
    roots.push(dir)
    const parentCwd = join(dir, 'parent')
    const childCwd = join(dir, 'child')
    const file = join(dir, 'instances.json')
    await writeFile(file, JSON.stringify({
      [keyOf(parentCwd)]: entryFor(parentCwd, statusPort, 1),
      [keyOf(childCwd)]: entryFor(childCwd, statusPort, 99_999), // dead pid
    }))

    const ctx = new Context()
    // parent pid alive, child pid dead (ESRCH).
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
      if (pid === 99_999) {
        const err = new Error('no such process') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      }
      return true
    })

    const parent = makeAgent('parent-agent', parentCwd)
    const child = makeAgent('child-agent', childCwd)
    install(ctx, handles as Map<Agent, never>, promptFibers as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
      daemonHttpTimeoutMs: 5000,
      daemonTcpTimeoutMs: 300,
    }, parent)
    install(ctx, handles as Map<Agent, never>, promptFibers as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
      daemonHttpTimeoutMs: 5000,
      daemonTcpTimeoutMs: 300,
    }, child)
    // T5: wait until the parent bind has settled, then assert the child was
    // skipped.
    await vi.waitFor(() => {
      expect(handles.has(parent)).toBe(true)
    }, { timeout: 5000, interval: 25 })

    expect(handles.has(parent)).toBe(true) // live daemon → registered
    expect(handles.has(child)).toBe(false) // dead daemon → skipped
    killSpy.mockRestore()
  })
})

describe('readInstancesFile still used by install (D-7 integration)', () => {
  it('parses the registry through readInstancesFile and returns records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-read-'))
    roots.push(dir)
    const file = join(dir, 'instances.json')
    const inst: InstancesFile = { [keyOf('/w')]: entryFor('/w', statusPort, 1) }
    await writeFile(file, JSON.stringify(inst))
    const ctx = new Context()
    const parsed = readInstancesFile(ctx, file)
    expect(parsed?.[keyOf('/w')]?.port).toBe(statusPort)
  })
})
