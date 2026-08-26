/**
 * Daemon-health and session-cwd unit tests (D-2, D-4, D-7) for the vectr-client
 * plugin's `install` path.
 *
 * These run WITHOUT any real vectr daemon: `startConnection` is mocked so we can
 * assert whether a bind was attempted (connection requested) or skipped. The
 * `process.cwd()` fallback (removed by D-4) and the registry re-read (D-7) and
 * the pid/TCP liveness gate (D-2) are exercised directly.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { startConnection } from '@deepseek-ai/dsh-mcp-client'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  install,
  isDaemonAlive,
  isPortListening,
  readInstancesFile,
  type InstancesFile,
  type InstanceEntry,
} from '../src/index.ts'

// Mock startConnection so no real MCP/HTTP connection is ever attempted; the
// test asserts call/non-call directly.
vi.mock('@deepseek-ai/dsh-mcp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client')>()
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

const roots: string[] = []
const handles = new Map<Agent, unknown>()

afterEach(async () => {
  vi.restoreAllMocks()
  startConnectionMock.mockClear()
  handles.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Let the non-blocking liveness IIFE inside install() settle. */
async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10))
}

describe('isDaemonAlive / isPortListening (D-2 primitives)', () => {
  it('reports a dead pid (ESRCH) as not alive', async () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException
      err.code = 'ESRCH'
      throw err
    })
    expect(await isDaemonAlive(entryFor('/w', 1234, 99_999))).toBe(false)
    spy.mockRestore()
  })

  it('reports an alive pid (kill(0) success) as alive', async () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(await isDaemonAlive(entryFor('/w', 1234, 4242))).toBe(true)
    spy.mockRestore()
  })

  it('reports a pid with EPERM (exists, no signal permission) as alive', async () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    })
    expect(await isDaemonAlive(entryFor('/w', 1234, 1))).toBe(true)
    spy.mockRestore()
  })

  it('probes TCP when no pid is present; a closed port is not alive', async () => {
    const closedPort = 1 // privileged / nothing listening
    expect(await isDaemonAlive(entryFor('/w', closedPort))).toBe(false)
  })
})

describe('install liveness gate (D-2)', () => {
  it('skips a dead pid entry: no connect, warn carries workspace/cwd/port/pid', async () => {
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
    install(ctx, handles as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
    }, agent)
    await tick()

    expect(startConnectionMock).not.toHaveBeenCalled()
    expect(handles.has(agent)).toBe(false)
    const warned = warn.mock.calls.some(c => String(c[0]).includes('is not alive') && String(c[0]).includes('pid=99999'))
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
    install(ctx, handles as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
    }, agent)
    await tick()

    expect(startConnectionMock).not.toHaveBeenCalled()
    expect(handles.has(agent)).toBe(false)
    expect(warn.mock.calls.some(c => String(c[0]).includes('is not alive'))).toBe(true)
  })

  it('binds a live pid entry (mocked alive): connect is attempted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-d2-alivepid-'))
    roots.push(dir)
    const cwd = join(dir, 'ws')
    const file = join(dir, 'instances.json')
    await writeFile(file, JSON.stringify({ [keyOf(cwd)]: entryFor(cwd, 1234, 4242) }))

    const ctx = new Context()
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const agent = makeAgent('alive-pid-agent', cwd)
    install(ctx, handles as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
    }, agent)
    await tick()

    expect(startConnectionMock).toHaveBeenCalledTimes(1)
    expect(handles.has(agent)).toBe(true)
    spy.mockRestore()
  })
})

describe('missing session cwd (D-4)', () => {
  it('skips with a warn and never starts a connection when header.cwd is undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-d4-'))
    roots.push(dir)
    const file = join(dir, 'instances.json')
    await writeFile(file, JSON.stringify({ x: entryFor('/somewhere', 1234, 1) }))

    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const agent = makeAgent('no-cwd-agent', undefined)
    install(ctx, handles as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
    }, agent)
    await tick()

    expect(startConnectionMock).not.toHaveBeenCalled()
    expect(handles.has(agent)).toBe(false)
    expect(warn.mock.calls.some(c => String(c[0]).includes('no cwd on session') && String(c[0]).includes('no-cwd-agent'))).toBe(true)
    // process.cwd() must never be consulted as a fallback.
    expect(warn.mock.calls.some(c => String(c[0]).includes('process.cwd'))).toBe(false)
  })
})

describe('registry re-read on every call (D-7)', () => {
  it('resolves a freshly rewritten registry entry for a later agent (new port)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-d7-'))
    roots.push(dir)
    const cwd = join(dir, 'ws')
    const file = join(dir, 'instances.json')

    // First generation: port 7001.
    await writeFile(file, JSON.stringify({ [keyOf(cwd)]: entryFor(cwd, 7001, 1) }))
    const ctx = new Context()
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true) // treat pid as alive

    const agent1 = makeAgent('reread-agent-1', cwd)
    install(ctx, handles as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
    }, agent1)
    await tick()
    const firstUrl = startConnectionMock.mock.calls[0]?.[1]?.url as string | undefined
    expect(firstUrl).toContain(':7001')

    // Rewrite the registry with a NEW port (simulating a daemon restart).
    await writeFile(file, JSON.stringify({ [keyOf(cwd)]: entryFor(cwd, 7002, 1) }))
    const agent2 = makeAgent('reread-agent-2', cwd)
    install(ctx, handles as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
    }, agent2)
    await tick()
    const secondUrl = startConnectionMock.mock.calls[1]?.[1]?.url as string | undefined
    expect(secondUrl).toContain(':7002')

    spy.mockRestore()
  })
})

describe('subagent / multi-agent scenario (D-2)', () => {
  it('binds the live parent daemon but skips a child whose daemon is dead', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-vectr-subagent-'))
    roots.push(dir)
    const parentCwd = join(dir, 'parent')
    const childCwd = join(dir, 'child')
    const file = join(dir, 'instances.json')
    await writeFile(file, JSON.stringify({
      [keyOf(parentCwd)]: entryFor(parentCwd, 8001, 1),
      [keyOf(childCwd)]: entryFor(childCwd, 8002, 99_999), // dead pid
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
    install(ctx, handles as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
    }, parent)
    install(ctx, handles as Map<Agent, never>, file, {
      instancesPath: file,
      serverName: 'vectr',
      toolCallTimeoutMs: 60_000,
      reconnect: { enabled: false },
    }, child)
    await tick()

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
    const inst: InstancesFile = { [keyOf('/w')]: entryFor('/w', 9001, 1) }
    await writeFile(file, JSON.stringify(inst))
    const ctx = new Context()
    const parsed = readInstancesFile(ctx, file)
    expect(parsed?.[keyOf('/w')]?.port).toBe(9001)
  })
})
