/**
 * N2/N3 behavior tests for the `vectr-client.connections` teardown effect
 * registered by apply().
 *
 * The disposer tears down every persisted remote tunnel on host teardown:
 * first via the recorded control socket (`ssh -O exit -S <ctl> <host>`), then
 * a best-effort SIGTERM to the recorded PID, and — when the recorded teardown
 * could not prove the master is gone — the slug-prefix fallback sweep
 * (`cleanupOrphanedTunnelsForCodebases`).
 *
 * These tests pin:
 *
 *   N2 — the rm-named scenario: the `ssh` binary is MISSING, so the control-
 *        socket exit's child emits an async 'error' event. The awaited exit
 *        must resolve `{ code: 1, signal: null }` (never reject), the entry
 *        must be queued for the slug sweep, the disposer must not throw, and
 *        no unhandled rejection may escape the teardown.
 *
 *   N3 (index.ts point) — a SUCCESSFUL PID kill must NOT mark the teardown
 *        ok: after a failed ctl exit, the sweep still runs for the entry.
 *
 * `node:child_process.spawn` is mocked so no real ssh is ever spawned, and
 * `cleanupOrphanedTunnelsForCodebases` (imported by src/index.ts) is replaced
 * with a spy so "the sweep was called" is asserted directly. The startup
 * self-heal fired by apply() is a no-op in these fixtures: the mocked
 * `ssh -O check` reports the master alive AND the entry's localPort is bound
 * by a real listener, so `ensureTunnelUp` returns without rewriting the
 * metadata.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import {
  cleanupOrphanedTunnelsForCodebases,
  type CodebaseEntry,
} from '../src/codebases.ts'

// Mock the raw spawn used by the disposer (`spawn('ssh', ['-O','exit',...])`)
// and by buildCodebaseDeps' spawnRunner (startup heal probe).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
const spawnMock = spawn as unknown as Mock

// Replace ONLY the sweep so "the sweep was called" is asserted directly;
// everything else in codebases.ts (loadCodebases, ensureTunnelUp, ...) stays
// real.
vi.mock('../src/codebases.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/codebases.ts')>()
  return {
    ...actual,
    cleanupOrphanedTunnelsForCodebases: vi.fn(async (_deps: unknown, _entries: readonly CodebaseEntry[]) => {}),
  }
})
const sweepSpy = cleanupOrphanedTunnelsForCodebases as unknown as Mock

/** Options for the fake spawned child. */
interface FakeChildOpts {
  /** When set, the child emits 'error' (async) and never emits 'close'. */
  error?: Error
  /** Exit code emitted on 'close' (default 0). */
  code?: number
  /** Exit signal emitted on 'close' (default null). */
  signal?: NodeJS.Signals | null
  /** stdout data emitted before 'close'. */
  stdout?: string
}

/**
 * A stand-in for `child_process.spawn`'s ChildProcess. Emits its events
 * asynchronously (microtask), mirroring real spawn: listeners are registered
 * synchronously by the caller, then 'error'/'close' arrive.
 */
function fakeChild(opts: FakeChildOpts = {}): unknown {
  const errorCbs: Array<(err: Error) => void> = []
  const closeCbs: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const dataCbs: Array<(chunk: Buffer) => void> = []
  const child = {
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === 'error') errorCbs.push(cb as (err: Error) => void)
      else if (event === 'close') closeCbs.push(cb as (code: number | null, signal: NodeJS.Signals | null) => void)
      return child
    },
    stdout: {
      on(event: string, cb: (chunk: Buffer) => void) {
        if (event === 'data') dataCbs.push(cb)
        return this
      },
    },
    stderr: {
      on(event: string, cb: (chunk: Buffer) => void) {
        if (event === 'data') dataCbs.push(cb)
        return this
      },
    },
    kill(): boolean { return true },
  }
  queueMicrotask(() => {
    if (opts.error !== undefined) {
      for (const cb of errorCbs) cb(opts.error)
      return
    }
    if (opts.stdout !== undefined) for (const cb of dataCbs) cb(Buffer.from(opts.stdout))
    for (const cb of closeCbs) cb(opts.code ?? 0, opts.signal ?? null)
  })
  return child
}

/**
 * Script the mocked spawn: the recorded control-socket exit (`-O exit`) fails
 * with an async 'error' (the N2 "ssh binary missing" scenario); the startup
 * heal probe (`-O check`) reports the master alive so the heal is a no-op.
 */
function scriptSpawn(): void {
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    if (args.includes('-O') && args.includes('exit')) {
      const err = new Error('spawn ssh ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      return fakeChild({ error: err })
    }
    if (args.includes('-O') && args.includes('check')) {
      return fakeChild({ code: 0, stdout: 'Master running (pid=1)' })
    }
    return fakeChild({ code: 0 })
  })
}

/** A minimal Cordis Context that captures the effect factories. */
function makeCtx() {
  const effectFactories = new Map<string, unknown>()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: (_service: string) => undefined,
    on: (_event: string, _handler: (...args: unknown[]) => void) => {},
    agents: { list: () => [] },
    effect: (factory: () => unknown, name?: string) => {
      effectFactories.set(name ?? '', factory)
    },
  }
  return {
    ctx: ctx as unknown as Context,
    connectionsFactory: () => effectFactories.get('vectr-client.connections'),
  }
}

const roots: string[] = []

afterEach(async () => {
  sweepSpy.mockReset()
  spawnMock.mockReset()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/**
 * Boot apply() with one persisted remote entry and return its connections
 * disposer. The entry's localPort is bound by a real listener BEFORE the
 * metadata is written, so the startup self-heal (probe alive + port
 * listening) is a no-op and never rewrites the metadata under the disposer.
 */
async function bootDisposer(entry: Omit<CodebaseEntry, 'localPort'>): Promise<{
  disposer: () => Promise<void>
  close: () => Promise<void>
  localPort: number
}> {
  const dir = await mkdtemp(join(tmpdir(), 'teardown-disposer-'))
  roots.push(dir)
  const server: Server = createServer((_req, res) => res.end())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const localPort = (server.address() as AddressInfo).port
  await writeFile(join(dir, 'codebases.json'), JSON.stringify([{ ...entry, localPort }]))

  scriptSpawn()
  const { ctx, connectionsFactory } = makeCtx()
  apply(ctx, {
    // instancesPath points at a MISSING file: the registry is absent, so no
    // migration / seeding / bind runs and the test stays on the disposer.
    instancesPath: join(dir, 'instances.json'),
    codebasesPath: join(dir, 'codebases.json'),
    secretsPath: join(dir, 'secrets.json'),
  })
  const factory = connectionsFactory() as () => () => Promise<void>
  const disposer = factory()
  return {
    disposer: disposer as () => Promise<void>,
    close: () => new Promise<void>((r) => server.close(() => r())),
    localPort,
  }
}

describe('apply() connections disposer (N2/N3)', () => {
  /** Beyond pid_max on Linux, so a REAL SIGTERM is ESRCH (tunnel gone). */
  const base = {
    type: 'remote' as const,
    path: '/w',
    host: 'n2host',
    remotePort: 8767,
    tunnelPid: 999_999_999,
    status: 'up' as const,
  }

  it('N2: spawn "error" (missing ssh) -> exit resolves {code:1, signal:null} -> entry queued for the sweep; teardown does not throw; no unhandled rejection', async () => {
    const { disposer, close } = await bootDisposer({
      ...base,
      id: 'n2',
      slug: 'n2',
      serverName: 'vectr_n2',
      // Never touched on disk: spawn is mocked, so the path only scripts the
      // `-O exit` child (which fails with 'error').
      tunnelCtl: '/tmp/vectr-tunnel-n2-ctl.sock',
    })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    let threw = false
    try {
      await disposer()
    } catch {
      threw = true
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await close()
    }
    // The disposer must not throw out of the teardown...
    expect(threw).toBe(false)
    // ...the recorded ctl exit resolved {code:1, signal:null} (spawn error),
    // so the entry must be queued for the slug-prefix fallback sweep...
    expect(sweepSpy).toHaveBeenCalledTimes(1)
    const queued = sweepSpy.mock.calls[0]?.[1] as readonly CodebaseEntry[] | undefined
    expect(queued?.map((e) => e.slug)).toEqual(['n2'])
    // ...and no unhandled rejection escaped the teardown.
    expect(unhandled).toEqual([])
  })

  it('N3 (index.ts point): a successful PID kill does NOT suppress the sweep after a failed ctl exit', async () => {
    const { disposer, close } = await bootDisposer({
      ...base,
      id: 'n3',
      slug: 'n3',
      serverName: 'vectr_n3',
      tunnelCtl: '/tmp/vectr-tunnel-n3-ctl.sock',
    })
    // The recorded pid still points at a live process: the SIGTERM succeeds.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await disposer()
      // The kill was attempted (best-effort)...
      expect(killSpy).toHaveBeenCalledWith(999_999_999, 'SIGTERM')
      // ...but a successful kill must NOT mark the teardown ok: the ctl exit
      // failed (spawn error), so the sweep still ran for this entry.
      expect(sweepSpy).toHaveBeenCalledTimes(1)
      const queued = sweepSpy.mock.calls[0]?.[1] as readonly CodebaseEntry[] | undefined
      expect(queued?.map((e) => e.slug)).toEqual(['n3'])
    } finally {
      killSpy.mockRestore()
      await close()
    }
  })
})
