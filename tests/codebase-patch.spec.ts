/**
 * PATCH /api/vectr/codebases/:slug — the `assign` action route (阶段2 UI).
 *
 * Drives the REAL `registerCodebaseRoutes` prefix handler (no stub) and the
 * REAL `patchCodebase` logic (no stub). Asserts:
 *  - success: workspace reassigned + serverName recomputed + meta persisted
 *  - 404: unknown slug
 *  - 400: missing / non-absolute workspace body
 *  - 409: target workspace not registered with a vectr daemon
 *  - 409: recomputed serverName collides with another entry (same workspace+slug)
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerCodebaseRoutes, slugFromPathname } from '../src/index.ts'
import { deriveServerName, type CodebaseEntry } from '../src/codebases.ts'

type Registration = { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => Promise<void> }

let tmp: string
let codebasesPath: string
let secretsPath: string
let instancesPath: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vectr-patch-'))
  codebasesPath = join(tmp, 'codebases.json')
  secretsPath = join(tmp, 'secrets.json')
  instancesPath = join(tmp, 'instances.json')
  await writeFile(codebasesPath, '[]')
  await writeFile(secretsPath, '{}')
  await writeFile(instancesPath, '{}')
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

/** Capture the real prefix handler, passing a temp instances file. */
function capturePrefix(): (method: string, path: string, body?: unknown) => Promise<{ code: number; body: string }> {
  const registrations: Registration[] = []
  const fakeWebServer = {
    register: (r: Registration) => { registrations.push(r); return () => {} },
  }
  const ctx = {
    get: (s: string) => (s === 'webServer' ? fakeWebServer : undefined),
    effect: (fn: () => unknown) => fn(),
    logger: { warn() {}, info() {}, error() {} },
  } as unknown as Context
  registerCodebaseRoutes(ctx, codebasesPath, secretsPath, instancesPath)
  const prefix = registrations.find(r => r.kind === 'prefix')!
  // `readJsonBody` drains the request via `for await (const chunk of req)`, so
  // the fake request must be an async iterable of Buffers (yielding nothing
  // when there is no body).
  function fakeReq(method: string, path: string, body?: unknown) {
    const url = `http://localhost${path}`
    if (body === undefined) {
      return { method, url, async *[Symbol.asyncIterator]() {} }
    }
    const data = Buffer.from(JSON.stringify(body))
    return { method, url, async *[Symbol.asyncIterator]() { yield data } }
  }
  return async (method: string, path: string, body?: unknown) => {
    let code = -1
    let out = ''
    const res = {
      writeHead(c: number) { code = c },
      end(payload: string) { out = payload },
    }
    await prefix.handler!(fakeReq(method, path, body), res)
    return { code, body: out }
  }
}

async function readMeta(): Promise<CodebaseEntry[]> {
  return JSON.parse(await (await import('node:fs/promises')).readFile(codebasesPath, 'utf8')) as CodebaseEntry[]
}

describe('slugFromPathname (assigned route)', () => {
  it('resolves PATCH slug like /test', () => {
    expect(slugFromPathname('/api/vectr/codebases/demo')).toBe('demo')
  })
})

describe('PATCH /:slug assign', () => {
  it('reassigns workspace + recomputes serverName + persists', async () => {
    // Target workspace must be a known daemon workspace in the registry.
    await writeFile(instancesPath, JSON.stringify({ wnew: { workspace: '/w_new', port: 9999 } }))
    const seeded: CodebaseEntry = {
      id: 'demo', slug: 'demo', type: 'local', path: '/w_old',
      workspace: '/w_old', serverName: deriveServerName('/w_old', 'demo'), status: 'up',
    }
    await writeFile(codebasesPath, JSON.stringify([seeded]))

    const call = capturePrefix()
    const res = await call('PATCH', '/api/vectr/codebases/demo', { workspace: '/w_new' })
    expect(res.code).toBe(200)
    const updated = JSON.parse(res.body) as CodebaseEntry
    expect(updated.workspace).toBe('/w_new')
    expect(updated.serverName).toBe(deriveServerName('/w_new', 'demo'))
    // Old fields preserved.
    expect(updated.slug).toBe('demo')
    expect(updated.path).toBe('/w_old')
    // Meta on disk reflects the reassignment.
    const meta = await readMeta()
    expect(meta).toHaveLength(1)
    expect(meta[0]!.workspace).toBe('/w_new')
    expect(meta[0]!.serverName).toBe(deriveServerName('/w_new', 'demo'))
  })

  it('returns 404 for an unknown slug', async () => {
    const call = capturePrefix()
    const res = await call('PATCH', '/api/vectr/codebases/ghost', { workspace: '/w_new' })
    expect(res.code).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: 'no such codebase' })
  })

  it('returns 400 when the body omits an absolute workspace', async () => {
    const seeded: CodebaseEntry = {
      id: 'demo', slug: 'demo', type: 'local', path: '/w_old',
      workspace: '/w_old', serverName: deriveServerName('/w_old', 'demo'), status: 'up',
    }
    await writeFile(codebasesPath, JSON.stringify([seeded]))
    const call = capturePrefix()
    // missing workspace
    expect((await call('PATCH', '/api/vectr/codebases/demo', {})).code).toBe(400)
    // relative path
    expect((await call('PATCH', '/api/vectr/codebases/demo', { workspace: 'rel' })).code).toBe(400)
    // wrong type
    expect((await call('PATCH', '/api/vectr/codebases/demo', { workspace: 123 })).code).toBe(400)
  })

  it('returns 409 when the target workspace is not a registered daemon', async () => {
    // Registry exists but has no /w_new entry.
    await writeFile(instancesPath, JSON.stringify({ wother: { workspace: '/w_other', port: 1 } }))
    const seeded: CodebaseEntry = {
      id: 'demo', slug: 'demo', type: 'local', path: '/w_old',
      workspace: '/w_old', serverName: deriveServerName('/w_old', 'demo'), status: 'up',
    }
    await writeFile(codebasesPath, JSON.stringify([seeded]))
    const call = capturePrefix()
    const res = await call('PATCH', '/api/vectr/codebases/demo', { workspace: '/w_new' })
    expect(res.code).toBe(409)
    expect(JSON.parse(res.body).error).toMatch(/not registered with a vectr daemon/)
  })

  it('returns 409 on a serverName collision (same workspace+slug already exists)', async () => {
    // Both target workspaces are registered so the collision branch (not the
    // "unregistered" branch) is exercised.
    await writeFile(instancesPath, JSON.stringify({
      wa: { workspace: '/w1', port: 1 },
      wb: { workspace: '/w2', port: 2 },
    }))
    // Two entries that share a slug but live in different workspaces produce
    // distinct serverNames; reassigning the first to the second's workspace
    // collides with the second's composite serverName.
    const a: CodebaseEntry = {
      id: 'demo', slug: 'demo', type: 'local', path: '/w1',
      workspace: '/w1', serverName: deriveServerName('/w1', 'demo'), status: 'up',
    }
    const b: CodebaseEntry = {
      id: 'demo', slug: 'demo', type: 'local', path: '/w2',
      workspace: '/w2', serverName: deriveServerName('/w2', 'demo'), status: 'up',
    }
    await writeFile(codebasesPath, JSON.stringify([a, b]))
    const call = capturePrefix()
    const res = await call('PATCH', '/api/vectr/codebases/demo', { workspace: '/w2' })
    expect(res.code).toBe(409)
    expect(JSON.parse(res.body).error).toMatch(/already in use/)
    // Meta unchanged (no partial write).
    const meta = await readMeta()
    expect(meta[0]!.workspace).toBe('/w1')
  })

  it('accepts the "__unassigned__" sentinel (moves entry back to unassigned, no daemon)', async () => {
    // Registry has no entry that would validate '__unassigned__' as a real
    // workspace; the sentinel must bypass the daemon-registry check.
    await writeFile(instancesPath, JSON.stringify({ wother: { workspace: '/w_other', port: 1 } }))
    const seeded: CodebaseEntry = {
      id: 'demo', slug: 'demo', type: 'local', path: '/w_old',
      workspace: '/w_old', serverName: deriveServerName('/w_old', 'demo'), status: 'up',
    }
    await writeFile(codebasesPath, JSON.stringify([seeded]))
    const call = capturePrefix()
    const res = await call('PATCH', '/api/vectr/codebases/demo', { workspace: '__unassigned__' })
    expect(res.code).toBe(200)
    const body = JSON.parse(res.body) as { ok?: boolean; workspace?: string }
    // C2: success envelope carries ok:true.
    expect(body.ok).toBe(true)
    expect(body.workspace).toBe('__unassigned__')
    const meta = await readMeta()
    expect(meta[0]!.workspace).toBe('__unassigned__')
  })
})
