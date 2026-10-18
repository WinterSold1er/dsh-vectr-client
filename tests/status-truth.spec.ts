/**
 * Canonical status truth (T1).
 *
 * Two boundary rules are asserted here:
 *
 * 1. `resolveUnifiedStatus` must report a daemon that is actually serving as
 *    ready, even while a background re-index runs. The pre-fix order tested
 *    `reindex_in_progress` before `fully_ready`, so the live /home/csy daemon
 *    (mode=full, fully_ready=true, reindex_in_progress=true) rendered
 *    "Indexing" forever and SessionHeaderAction showed a permanent idx badge.
 * 2. `mode` must cross the registry -> API boundary in its canonical spelling.
 *    `~/.vectr/instances.json` stores "memory-only" (hyphen) while every
 *    consumer compares `'memory_only'`, so the raw spread mis-classified a
 *    memory-only workspace as non-memory-only.
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeMode, resolveUnifiedStatus } from '../src/domain/rules.ts'
import { scanWorkspaces, type InstanceEntry, type InstancesFile, type VectrStatus } from '../src/workspaces.ts'

const ctx = { logger: { info() {}, warn() {}, error() {} } } as unknown as import('@deepseek-ai/cordis').Context

describe('normalizeMode', () => {
  it('canonicalizes both registry spellings and casing', () => {
    const table: Array<[string | undefined, string | undefined]> = [
      ['memory-only', 'memory_only'],
      ['MEMORY_ONLY', 'memory_only'],
      ['search-only', 'search_only'],
      ['full', 'full'],
      ['lite', 'lite'],
      ['memory_only', 'memory_only'],
      // Unknown modes are normalized, never silently dropped to undefined.
      ['weird-mode', 'weird_mode'],
      ['  Full  ', 'full'],
      ['', undefined],
      ['   ', undefined],
      [undefined, undefined],
    ]
    for (const [input, expected] of table) {
      expect(normalizeMode(input), `normalizeMode(${JSON.stringify(input)})`).toBe(expected)
    }
  })

  it('returns undefined for a non-string instead of throwing', () => {
    expect(normalizeMode(null as unknown as string)).toBeUndefined()
    expect(normalizeMode(42 as unknown as string)).toBeUndefined()
  })
})

describe('resolveUnifiedStatus evaluation order', () => {
  it('reports the live /home/csy payload (fully_ready + reindex_in_progress) as ready', () => {
    // Exact flags observed from http://127.0.0.1:8778/v1/status on 2026-10-18.
    const status = resolveUnifiedStatus({
      live: true,
      mode: 'full',
      status: {
        fully_ready: true,
        embedder_ready: true,
        reindex_in_progress: true,
        watcher_batch_running: true,
        watcher_pending_files: 1312,
      } as VectrStatus,
    })
    expect(status.kind).toBe('ready')
    expect(status.label).toBe('Ready')
    expect(status.isBusy).toBe(false)
    // The background work stays visible without hijacking `kind`.
    expect(status.background).toBe('Background re-index in progress')
  })

  it('does not set background when a ready daemon is idle', () => {
    const status = resolveUnifiedStatus({
      live: true,
      mode: 'full',
      status: { fully_ready: true, reindex_in_progress: false },
    })
    expect(status.kind).toBe('ready')
    expect(status.background).toBeUndefined()
  })

  it('lets memory-only mode beat both readiness flags', () => {
    const status = resolveUnifiedStatus({
      live: true,
      mode: 'memory-only',
      status: { fully_ready: false, reindex_in_progress: true },
    })
    expect(status.kind).toBe('memory_only')
    expect(status.label).toBe('Memory Only')
    expect(status.isBusy).toBe(false)
  })

  it('lets search-only mode beat a ready status', () => {
    const status = resolveUnifiedStatus({
      live: true,
      mode: 'search_only',
      status: { fully_ready: true },
    })
    expect(status.kind).toBe('search_only')
    expect(status.label).toBe('Search Only')
  })

  it('still reports indexing when the daemon is not fully ready', () => {
    const status = resolveUnifiedStatus({
      live: true,
      mode: 'full',
      status: { fully_ready: false, reindex_in_progress: true },
    })
    expect(status.kind).toBe('indexing')
    expect(status.label).toBe('Indexing')
    expect(status.isBusy).toBe(true)
    expect(status.background).toBeUndefined()
  })

  it('reports initializing when not ready and no re-index is running', () => {
    const status = resolveUnifiedStatus({
      live: true,
      mode: 'full',
      status: { fully_ready: false, reindex_in_progress: false },
    })
    expect(status.kind).toBe('initializing')
    expect(status.isBusy).toBe(true)
  })

  it('reports initializing while the daemon is live but has no status yet', () => {
    const status = resolveUnifiedStatus({ live: true, mode: 'full' })
    expect(status.kind).toBe('initializing')
    expect(status.isBusy).toBe(true)
  })

  it('reports offline for a dead daemon and Error for a thrown error', () => {
    const offline = resolveUnifiedStatus({ live: false, mode: 'full' })
    expect(offline.kind).toBe('offline')
    expect(offline.label).toBe('Offline')

    const failed = resolveUnifiedStatus({ error: 'boom' })
    expect(failed.kind).toBe('offline')
    expect(failed.label).toBe('Error')
    expect(failed.description).toBe('boom')
  })

  it('reports unknown for a live daemon whose mode is unrecognized', () => {
    const status = resolveUnifiedStatus({
      live: true,
      mode: 'weird-mode',
      status: { fully_ready: undefined },
    })
    expect(status.kind).toBe('unknown')
  })
})

describe('scanWorkspaces mode boundary', () => {
  let tmp: string
  let registryPath: string
  let server: Server | undefined

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'vectr-status-truth-'))
    registryPath = join(tmp, 'instances.json')
  })

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
    await rm(tmp, { recursive: true, force: true })
  })

  async function writeRegistry(entries: Record<string, InstanceEntry>): Promise<void> {
    await writeFile(registryPath, JSON.stringify(entries satisfies InstancesFile), 'utf8')
  }

  /** Minimal daemon: answers /v1/status so the row takes the live branch. */
  async function startDaemon(): Promise<number> {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ fully_ready: true, reindex_in_progress: false, notes_count: 1 }))
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    return (server.address() as AddressInfo).port
  }

  it('emits memory_only (never memory-only) for a live registry record', async () => {
    const port = await startDaemon()
    await writeRegistry({ aa: { workspace: '/ws/mem', port, mode: 'memory-only', host: '127.0.0.1' } })

    const views = await scanWorkspaces(ctx, registryPath)

    expect(views).toHaveLength(1)
    expect(views[0]!.live).toBe(true)
    expect(views[0]!.mode).toBe('memory_only')
    // The consumer contract this protects: a memory-only workspace must be
    // recognizable by the canonical spelling it is compared against in the UI.
    expect(views[0]!.mode).not.toBe('memory-only')
  })

  it('emits memory_only (never memory-only) for a dead registry record', async () => {
    // Port 1 is essentially never listening, so the row takes the not-alive branch.
    await writeRegistry({ bb: { workspace: '/ws/mem-dead', port: 1, mode: 'memory-only', host: '127.0.0.1' } })

    const views = await scanWorkspaces(ctx, registryPath)

    expect(views).toHaveLength(1)
    expect(views[0]!.live).toBe(false)
    expect(views[0]!.mode).toBe('memory_only')
  })
})
