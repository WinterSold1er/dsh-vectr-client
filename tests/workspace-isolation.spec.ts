/**
 * 阶段1 workspace-isolation + migration + composite serverName tests.
 *
 * Covers (per the architect's acceptance list):
 *  - #2 workspace binding isolation (installCodebaseConnections only binds the
 *       agent's own workspace; mocked startConnection so no real MCP/HTTP).
 *  - #3 GET /api/vectr/codebases ?workspace= scoping.
 *  - #4 migrateCodebases backfill (inference + idempotency + composite name).
 *  - #5 composite serverName uniqueness across workspaces for the same slug.
 *
 * All side effects are injected/temp-file backed; no real ssh or vectr daemon.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { startConnection } from '@deepseek-ai/dsh-mcp-client/src/connection.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  installCodebaseConnections,
  registerCodebaseRoutes,
  type Config,
  type InstancesFile,
} from '../src/index.ts'
import {
  deriveServerName,
  loadCodebases,
  migrateCodebases,
  saveCodebases,
  UNASSIGNED_WORKSPACE,
  type CodebaseEntry,
} from '../src/codebases.ts'

// Mock startConnection so no real MCP/HTTP connection is ever attempted; the
// test asserts call/non-call + which serverName was requested.
vi.mock('@deepseek-ai/dsh-mcp-client/src/connection.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client/src/connection.ts')>()
  return {
    ...actual,
    startConnection: vi.fn(() => ({ ready: Promise.resolve({ error: undefined }), dispose: vi.fn() })),
  }
})
const startConnectionMock = startConnection as unknown as Mock

function keyOf(workspace: string): string {
  return createHash('sha256').update(workspace).digest('hex').slice(0, 12)
}

let dir: string
let metaPath: string
let codebasesPath: string
let secretsPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ws-iso-'))
  metaPath = join(dir, 'codebases.json')
  codebasesPath = join(dir, 'codebases.json')
  secretsPath = join(dir, 'secrets.json')
  await writeFile(codebasesPath, '[]')
  await writeFile(secretsPath, '{}')
  startConnectionMock.mockClear()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const instances: InstancesFile = {
  [keyOf('/wsA')]: { workspace: '/wsA', port: 8765, pid: 1, started_at: 0, mode: 'full', host: '127.0.0.1' },
  [keyOf('/wsB')]: { workspace: '/wsB', port: 8766, pid: 2, started_at: 0, mode: 'full', host: '127.0.0.1' },
  [keyOf('/wsRemote')]: { workspace: '/wsRemote', port: 8767, pid: 3, started_at: 0, mode: 'full', host: 'conan' },
}

const config = {
  instancesPath: '/tmp/x',
  serverName: 'vectr',
  toolCallTimeoutMs: 60000,
  reconnect: { enabled: false },
  codebasesPath: '/tmp/y',
  secretsPath: '/tmp/z',
  daemonHttpTimeoutMs: 5000,
  daemonTcpTimeoutMs: 300,
} as Required<Config>

const loggerCtx = { logger: { warn() {}, info() {}, error() {} } } as unknown as Context

function makeAgent(): Agent {
  return { id: 'agent1', ctx: new Context(), session: { header: { cwd: '/wsA' } } } as unknown as Agent
}

describe('installCodebaseConnections workspace isolation (改动3)', () => {
  it('binds ONLY the agent workspace; skips other workspaces', async () => {
    const entries: CodebaseEntry[] = [
      { id: 'a', slug: 'a', type: 'local', path: '/wsA', workspace: '/wsA', serverName: deriveServerName('/wsA', 'a'), localPort: 8700, status: 'up' },
      { id: 'b', slug: 'b', type: 'local', path: '/wsB', workspace: '/wsB', serverName: deriveServerName('/wsB', 'b'), localPort: 8701, status: 'up' },
    ]
    saveCodebases(metaPath, entries)

    // Agent in workspace B must bind only B.
    await installCodebaseConnections(loggerCtx, config, makeAgent(), codebasesPath, instances, '/wsB')
    expect(startConnectionMock).toHaveBeenCalledTimes(1)
    expect(startConnectionMock.mock.calls[0]![1].serverName).toBe(deriveServerName('/wsB', 'b'))

    // Agent in workspace A must bind only A.
    startConnectionMock.mockClear()
    await installCodebaseConnections(loggerCtx, config, makeAgent(), codebasesPath, instances, '/wsA')
    expect(startConnectionMock).toHaveBeenCalledTimes(1)
    expect(startConnectionMock.mock.calls[0]![1].serverName).toBe(deriveServerName('/wsA', 'a'))
  })

  it('down entries / missing localPort are never bound', async () => {
    const entries: CodebaseEntry[] = [
      { id: 'a', slug: 'a', type: 'local', path: '/wsA', workspace: '/wsA', serverName: deriveServerName('/wsA', 'a'), localPort: 8700, status: 'up' },
      { id: 'b', slug: 'b', type: 'local', path: '/wsA', workspace: '/wsA', serverName: deriveServerName('/wsA', 'b'), localPort: 8701, status: 'down' },
      { id: 'c', slug: 'c', type: 'local', path: '/wsA', workspace: '/wsA', serverName: deriveServerName('/wsA', 'c'), status: 'up' },
    ]
    saveCodebases(metaPath, entries)
    await installCodebaseConnections(loggerCtx, config, makeAgent(), codebasesPath, instances, '/wsA')
    expect(startConnectionMock).toHaveBeenCalledTimes(1)
    expect(startConnectionMock.mock.calls[0]![1].serverName).toBe(deriveServerName('/wsA', 'a'))
  })

  it('unresolved cwd (no registry match) falls back to binding all up entries (architect permissive default)', async () => {
    const entries: CodebaseEntry[] = [
      { id: 'a', slug: 'a', type: 'local', path: '/wsA', workspace: '/wsA', serverName: deriveServerName('/wsA', 'a'), localPort: 8700, status: 'up' },
      { id: 'b', slug: 'b', type: 'local', path: '/wsB', workspace: '/wsB', serverName: deriveServerName('/wsB', 'b'), localPort: 8701, status: 'up' },
    ]
    saveCodebases(metaPath, entries)
    await installCodebaseConnections(loggerCtx, config, makeAgent(), codebasesPath, instances, '/unknown')
    expect(startConnectionMock).toHaveBeenCalledTimes(2)
  })
})

describe('GET /api/vectr/codebases ?workspace= filter (改动3)', () => {
  function captureExactHandler() {
    const registrations: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }> = []
    const fakeWebServer = {
      register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
        registrations.push(r)
        return () => {}
      },
    }
    const ctx = {
      get: (s: string) => (s === 'webServer' ? fakeWebServer : undefined),
      effect: (fn: () => unknown) => fn(),
      logger: { warn() {}, info() {}, error() {} },
    } as unknown as Context
    registerCodebaseRoutes(ctx, codebasesPath, secretsPath)
    return registrations.find(r => r.kind === 'exact')!
  }

  async function getList(query: string): Promise<CodebaseEntry[]> {
    const handler = captureExactHandler()
    let code = -1
    let body = ''
    const res = { writeHead(c: number) { code = c }, end(payload: string) { body = payload } }
    await handler.handler!({ method: 'GET', url: `http://localhost/api/vectr/codebases${query}` }, res)
    expect(code).toBe(200)
    return JSON.parse(body) as CodebaseEntry[]
  }

  it('returns only the requested workspace', async () => {
    const entries: CodebaseEntry[] = [
      { id: 'a', slug: 'a', type: 'local', path: '/wsA', workspace: '/wsA', serverName: deriveServerName('/wsA', 'a'), localPort: 8700, status: 'up' },
      { id: 'b', slug: 'b', type: 'local', path: '/wsB', workspace: '/wsB', serverName: deriveServerName('/wsB', 'b'), localPort: 8701, status: 'up' },
    ]
    saveCodebases(metaPath, entries)
    const list = await getList('?workspace=/wsA')
    expect(list.every(e => e.workspace === '/wsA')).toBe(true)
    const nonPrimary = list.filter(e => !e.isPrimary)
    expect(nonPrimary).toHaveLength(1)
    expect(nonPrimary[0]!.workspace).toBe('/wsA')
    expect(nonPrimary[0]!.serverName).toBe(deriveServerName('/wsA', 'a'))
  })

  it('returns all when no workspace query', async () => {
    const entries: CodebaseEntry[] = [
      { id: 'a', slug: 'a', type: 'local', path: '/wsA', workspace: '/wsA', serverName: deriveServerName('/wsA', 'a'), localPort: 8700, status: 'up' },
      { id: 'b', slug: 'b', type: 'local', path: '/wsB', workspace: '/wsB', serverName: deriveServerName('/wsB', 'b'), localPort: 8701, status: 'up' },
    ]
    saveCodebases(metaPath, entries)
    const list = await getList('')
    const nonPrimary = list.filter(e => !e.isPrimary)
    expect(nonPrimary).toHaveLength(2)
  })
})

describe('migrateCodebases (改动2)', () => {
  it('infers workspace, recomputes composite serverName, and is idempotent', async () => {
    const inst: InstancesFile = {
      [keyOf('/wsA')]: { workspace: '/wsA', port: 8765, host: '127.0.0.1' },
      [keyOf('/wsRemote')]: { workspace: '/wsRemote', port: 8767, host: 'conan' },
    }
    const old: CodebaseEntry[] = [
      { id: 'a', slug: 'a', type: 'local', path: '/wsA', serverName: 'vectr_a', localPort: 8700, status: 'up' },
      { id: 'b', slug: 'b', type: 'remote', path: '/wsRemote', host: 'conan', serverName: 'vectr_b', localPort: 8701, remotePort: 9, status: 'up' },
    ]
    saveCodebases(metaPath, old)

    const r1 = migrateCodebases(metaPath, inst)
    expect(r1.changed).toBe(true)
    expect(r1.migrated).toBe(2)
    const after = loadCodebases(metaPath)
    expect(after[0]!.workspace).toBe('/wsA')
    expect(after[0]!.serverName).toBe(deriveServerName('/wsA', 'a'))
    // A1: remote migration can no longer infer workspace (entry.host is the SSH
    // target, never equal to InstanceEntry.host); it is forced UNASSIGNED and
    // must be rebuilt / re-assigned by the client — NOT silently matched to a
    // local workspace. The old test asserted /wsRemote via a contrived match.
    expect(after[1]!.workspace).toBe(UNASSIGNED_WORKSPACE)
    expect(after[1]!.serverName).toBe(deriveServerName(UNASSIGNED_WORKSPACE, 'b'))

    // Re-running is a no-op (idempotent).
    const r2 = migrateCodebases(metaPath, inst)
    expect(r2.changed).toBe(false)
    expect(r2.migrated).toBe(0)
  })

  it('falls back to UNASSIGNED_WORKSPACE when inference fails', async () => {
    const inst: InstancesFile = {
      [keyOf('/wsA')]: { workspace: '/wsA', port: 8765, host: '127.0.0.1' },
    }
    const orphan: CodebaseEntry[] = [
      { id: 'z', slug: 'z', type: 'local', path: '/nowhere', serverName: 'vectr_z', localPort: 1, status: 'up' },
    ]
    saveCodebases(metaPath, orphan)
    migrateCodebases(metaPath, inst)
    expect(loadCodebases(metaPath)[0]!.workspace).toBe(UNASSIGNED_WORKSPACE)
  })
})

describe('composite serverName uniqueness (改动2)', () => {
  it('same slug in two workspaces yields different server names', () => {
    const a = deriveServerName('/wsA', 'shared')
    const b = deriveServerName('/wsB', 'shared')
    expect(a).not.toBe(b)
    expect(a).toBe(`vectr_${keyOf('/wsA')}_shared`)
    expect(b).toBe(`vectr_${keyOf('/wsB')}_shared`)
  })
})

describe('migrateCodebases A2: empty registry skipped (no write)', () => {
  it('skips migration entirely when no instances registry is available', async () => {
    const old: CodebaseEntry[] = [
      { id: 'z', slug: 'z', type: 'local', path: '/nowhere', serverName: 'vectr_z', localPort: 1, status: 'up' },
    ]
    saveCodebases(metaPath, old)
    const before = readFileSync(metaPath, 'utf8')
    const r = migrateCodebases(metaPath, {})
    expect(r.changed).toBe(false)
    expect(r.migrated).toBe(0)
    // File must be byte-for-byte unchanged (the sticky UNASSIGNED field is NOT
    // poisoned, so a later run with a real registry still retries).
    expect(readFileSync(metaPath, 'utf8')).toBe(before)
  })
})

describe('POST /api/vectr/codebases B2: remote requires workspace', () => {
  it('rejects a remote codebase with no workspace field (400)', async () => {
    const registrations: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }> = []
    const fakeWebServer = {
      register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
        registrations.push(r)
        return () => {}
      },
    }
    const ctx = {
      get: (s: string) => (s === 'webServer' ? fakeWebServer : undefined),
      effect: (fn: () => unknown) => fn(),
      logger: { warn() {}, info() {}, error() {} },
    } as unknown as Context
    registerCodebaseRoutes(ctx, codebasesPath, secretsPath)
    const handler = registrations.find(r => r.kind === 'exact')!
    let code = -1
    let body = ''
    const res = { writeHead(c: number) { code = c }, end(p: string) { body = p } }
    const payload = JSON.stringify({ type: 'remote', path: '/remote/ws', host: 'conan', slug: 'x' })
    const req = {
      method: 'POST',
      url: 'http://localhost/api/vectr/codebases',
      async *[Symbol.asyncIterator]() { yield Buffer.from(payload) },
    }
    await handler.handler(req as unknown as never, res as unknown as never)
    expect(code).toBe(400)
    expect(JSON.parse(body).error).toMatch(/requires an explicit workspace/)
  })

  it('accepts a remote codebase that carries a workspace field', async () => {
    const registrations: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }> = []
    const fakeWebServer = {
      register: (r: { kind: string; path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
        registrations.push(r)
        return () => {}
      },
    }
    const ctx = {
      get: (s: string) => (s === 'webServer' ? fakeWebServer : undefined),
      effect: (fn: () => unknown) => fn(),
      logger: { warn() {}, info() {}, error() {} },
    } as unknown as Context
    registerCodebaseRoutes(ctx, codebasesPath, secretsPath)
    const handler = registrations.find(r => r.kind === 'exact')!
    let code = -1
    let body = ''
    const res = { writeHead(c: number) { code = c }, end(p: string) { body = p } }
    const payload = JSON.stringify({ type: 'remote', path: '/remote/ws', host: 'conan', slug: 'x', workspace: '/local/cwd' })
    const req = {
      method: 'POST',
      url: 'http://localhost/api/vectr/codebases',
      async *[Symbol.asyncIterator]() { yield Buffer.from(payload) },
    }
    await handler.handler(req as unknown as never, res as unknown as never)
    // The route builds REAL ssh deps, so a remote create cannot succeed in this
    // harness; but the workspace *validation* must pass (the failure is downstream
    // at the ssh probe, not the B2 guard). Assert the 400 is NOT the workspace
    // rejection.
    expect(code).toBe(400)
    expect(JSON.parse(body).error).not.toMatch(/requires an explicit workspace/)
  })
})

describe('migrateCodebases B3: serverName collision disambiguation', () => {
  it('two remote entries of the same slug get distinct serverNames + warn', async () => {
    const inst: InstancesFile = {
      [keyOf('/wsA')]: { workspace: '/wsA', port: 8765, host: '127.0.0.1' },
    }
    const old: CodebaseEntry[] = [
      { id: 'x', slug: 'x', type: 'remote', path: '/r1', host: 'conan1', serverName: 'vectr_x', localPort: 1, status: 'up' },
      { id: 'x', slug: 'x', type: 'remote', path: '/r2', host: 'conan2', serverName: 'vectr_x', localPort: 2, status: 'up' },
    ]
    saveCodebases(metaPath, old)
    const warns: string[] = []
    migrateCodebases(metaPath, inst, { warn: (m: string) => warns.push(m) })
    const after = loadCodebases(metaPath)
    expect(after[0]!.workspace).toBe(UNASSIGNED_WORKSPACE)
    expect(after[1]!.workspace).toBe(UNASSIGNED_WORKSPACE)
    expect(after[0]!.serverName).not.toBe(after[1]!.serverName)
    expect(warns.some(w => /collides/.test(w))).toBe(true)
  })
})
