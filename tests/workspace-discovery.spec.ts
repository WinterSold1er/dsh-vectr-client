/**
 * Workspace discovery union (T1).
 *
 * `GET /api/vectr/workspaces` must list every workspace DSH knows about, not
 * only the ones a daemon wrote into `~/.vectr/instances.json`. These tests pin
 * the two halves of that union — {@link discoverWorkspaceRoots} reading DSH's
 * own registry, and {@link scanWorkspaces} merging it in — with a temp fixture
 * standing in for `$HOME` (never the real one).
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_DSH_WORKSPACE_FILE,
  discoverWorkspaceRoots,
  normalizeWorkspacePath,
  scanWorkspaces,
} from '../src/workspaces.ts'

const ctx = { logger: { info() {}, warn() {}, error() {} } } as unknown as Context

/** A daemon that answers `/v1/status` like a live vectr daemon. */
function startDaemon(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (new URL(req.url ?? '/', 'http://x').pathname === '/v1/status') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ fully_ready: true, mode: 'full' }))
        return
      }
      res.statusCode = 404
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port })
    })
  })
}

/** DSH unit store: `{ unit, global, tables: { workspaces: { [id]: { path, title } } } }`. */
function dshStore(workspaces: Record<string, { path?: unknown; title?: unknown }>): unknown {
  return { unit: { name: 'workspace', version: 2 }, global: {}, tables: { workspaces } }
}

let tmp: string
let registryPath: string
let dshPath: string
let daemon: Server | undefined

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vectr-discovery-'))
  registryPath = join(tmp, 'instances.json')
  dshPath = join(tmp, 'workspace.json')
})

afterEach(async () => {
  if (daemon !== undefined) {
    const closing = daemon
    daemon = undefined
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  }
  await rm(tmp, { recursive: true, force: true })
})

describe('discoverWorkspaceRoots', () => {
  it('degrades to an empty list (and reports once) when the DSH store is missing', () => {
    const errors: unknown[] = []
    const roots = discoverWorkspaceRoots(join(tmp, 'absent.json'), (error) => errors.push(error))
    expect(roots).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('degrades to an empty list (and reports once) when the DSH store is unparseable', async () => {
    await writeFile(dshPath, '{ this is not json')
    const errors: unknown[] = []
    const roots = discoverWorkspaceRoots(dshPath, (error) => errors.push(error))
    expect(roots).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it('reads path + title, skips unusable records, and dedupes by normalized path', async () => {
    await writeFile(dshPath, JSON.stringify(dshStore({
      a: { path: '/ws/alpha', title: '  Alpha  ' },
      b: { path: '/ws/beta' },
      c: { path: 'relative/nope', title: 'relative is not a workspace' },
      d: { title: 'no path at all' },
      e: { path: 42 },
      f: { path: '/ws/alpha/' },
    })))

    const roots = discoverWorkspaceRoots(dshPath)

    expect(roots).toEqual([
      { workspace: '/ws/alpha', title: 'Alpha' },
      { workspace: '/ws/beta' },
    ])
    // The title key is absent (not empty) when DSH has no title for a workspace.
    expect('title' in roots[1]!).toBe(false)
  })

  it('treats a store without tables.workspaces as empty, not as an error', async () => {
    await writeFile(dshPath, JSON.stringify({ unit: { name: 'workspace' }, global: {} }))
    expect(discoverWorkspaceRoots(dshPath)).toEqual([])
  })

  it('normalizes equivalent spellings to one dedupe key', () => {
    expect(normalizeWorkspacePath('/ws/a/')).toBe(normalizeWorkspacePath('/ws/a'))
    expect(normalizeWorkspacePath('/ws/./a')).toBe('/ws/a')
  })

  it('points at DSH\'s own storage file by default', () => {
    expect(DEFAULT_DSH_WORKSPACE_FILE.endsWith(join('storages', 'workspace.json'))).toBe(true)
  })
})

describe('scanWorkspaces union', () => {
  it('keeps the registry-only behaviour when no discovery source is injected', async () => {
    const views = await scanWorkspaces(ctx, join(tmp, 'absent-instances.json'))
    expect(views).toEqual([])
  })

  it('lists a discovered workspace that has no daemon as not started', async () => {
    const live = await startDaemon()
    daemon = live.server
    await writeFile(registryPath, JSON.stringify({
      aa: { workspace: '/ws/live', port: live.port, pid: process.pid, mode: 'full', host: '127.0.0.1' },
    }))
    await writeFile(dshPath, JSON.stringify(dshStore({
      a: { path: '/ws/live', title: 'live one' },
      b: { path: '/ws/never-started', title: 'never started' },
    })))

    const views = await scanWorkspaces(ctx, registryPath, {
      discover: () => discoverWorkspaceRoots(dshPath),
    })

    expect(views).toHaveLength(2)
    expect(views[0]).toMatchObject({ workspace: '/ws/live', live: true, title: 'live one' })
    expect(views[1]).toEqual({
      workspace: '/ws/never-started',
      title: 'never started',
      live: false,
      reason: 'not started',
      error: 'daemon not started',
    })
  })

  it('lets a dead instances.json record win over the discovered row for the same path', async () => {
    await writeFile(registryPath, JSON.stringify({
      dead: { workspace: '/ws/dead', port: 1, mode: 'full', host: '127.0.0.1' },
    }))
    await writeFile(dshPath, JSON.stringify(dshStore({
      d: { path: '/ws/dead', title: 'dead workspace' },
    })))

    const views = await scanWorkspaces(ctx, registryPath, {
      discover: () => discoverWorkspaceRoots(dshPath),
    })

    expect(views).toHaveLength(1)
    // The registry row survives with its failure reason and gains the title;
    // it is NOT replaced by a 'not started' row.
    expect(views[0]).toMatchObject({ workspace: '/ws/dead', live: false, title: 'dead workspace' })
    expect(views[0]!.reason).not.toBe('not started')
    expect(views[0]!.port).toBe(1)
  })

  it('dedupes a discovered path spelled with a trailing slash against the registry path', async () => {
    const live = await startDaemon()
    daemon = live.server
    await writeFile(registryPath, JSON.stringify({
      aa: { workspace: '/ws/live', port: live.port, pid: process.pid, mode: 'full', host: '127.0.0.1' },
    }))
    await writeFile(dshPath, JSON.stringify(dshStore({ a: { path: '/ws/live/' } })))

    const views = await scanWorkspaces(ctx, registryPath, {
      discover: () => discoverWorkspaceRoots(dshPath),
    })

    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ workspace: '/ws/live', live: true })
  })

  it('still lists discovered workspaces when no daemon registry exists at all', async () => {
    await writeFile(dshPath, JSON.stringify(dshStore({ b: { path: '/ws/never-started' } })))

    const views = await scanWorkspaces(ctx, join(tmp, 'absent-instances.json'), {
      discover: () => discoverWorkspaceRoots(dshPath),
    })

    expect(views).toEqual([
      { workspace: '/ws/never-started', live: false, reason: 'not started', error: 'daemon not started' },
    ])
  })
})
