/**
 * 改动3 route tests.
 *
 * - Unit: `slugFromPathname` strips the `/test` (and any deeper) action suffix
 *   so `POST /api/vectr/codebases/:slug/test` resolves the same slug as the bare
 *   `DELETE /api/vectr/codebases/:slug` path. This was the root-cause of the
 *   404: the slug was derived as `demo/test` and never matched a persisted entry.
 * - Integration: drives the REAL `registerCodebaseRoutes` handler (no stub) with
 *   a seeded meta entry and a fake `/v1/status` server, asserting
 *   `POST /:slug/test` → 200 (was 404), `DELETE /:slug` → 200, and a slug-less
 *   request → 400.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerCodebaseRoutes, slugFromPathname } from '../src/index.ts'

type Registration = { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => Promise<void> }

let tmp: string
let codebasesPath: string
let secretsPath: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vectr-route-'))
  codebasesPath = join(tmp, 'codebases.json')
  secretsPath = join(tmp, 'secrets.json')
  await writeFile(codebasesPath, '[]')
  await writeFile(secretsPath, '{}')
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('slugFromPathname', () => {
  it('strips a /test action suffix', () => {
    expect(slugFromPathname('/api/vectr/codebases/demo/test')).toBe('demo')
  })
  it('returns the slug for a bare path', () => {
    expect(slugFromPathname('/api/vectr/codebases/demo')).toBe('demo')
  })
  it('takes only the first segment for deeper paths', () => {
    expect(slugFromPathname('/api/vectr/codebases/demo/extra/deep')).toBe('demo')
  })
  it('returns empty when no slug segment', () => {
    expect(slugFromPathname('/api/vectr/codebases/')).toBe('')
  })
})

function captureRegistrations(): Registration[] {
  const registrations: Registration[] = []
  const fakeWebServer = {
    register: (r: Registration) => {
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
  return registrations
}

async function startStatusServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.statusCode = 200
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ready: true }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? (addr as { port: number }).port : 0
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

describe('codebases /test route (root-cause slug fix)', () => {
  it('POST /:slug/test returns 200, DELETE /:slug returns 200, missing slug 400', async () => {
    const status = await startStatusServer()
    // Seed a local codebase whose localPort is the fake /v1/status server.
    await writeFile(codebasesPath, JSON.stringify([
      { id: 'demo', slug: 'demo', type: 'local', path: '/tmp/demo', serverName: 'vectr_demo', localPort: status.port, status: 'up' },
    ]))
    const registrations = captureRegistrations()
    const prefix = registrations.find(r => r.kind === 'prefix')!
    const call = async (method: string, path: string): Promise<{ code: number; body: string }> => {
      let code = -1
      let body = ''
      const res = {
        writeHead(c: number) { code = c },
        end(payload: string) { body = payload },
      }
      await prefix.handler!({ method, url: `http://localhost${path}` }, res)
      return { code, body }
    }

    const testRes = await call('POST', '/api/vectr/codebases/demo/test')
    expect(testRes.code).toBe(200)
    expect(JSON.parse(testRes.body)).toMatchObject({ ok: true })

    const delRes = await call('DELETE', '/api/vectr/codebases/demo')
    expect(delRes.code).toBe(200)
    expect(JSON.parse(delRes.body)).toMatchObject({ ok: true })

    const missingRes = await call('POST', '/api/vectr/codebases/')
    expect(missingRes.code).toBe(400)
    expect(JSON.parse(missingRes.body)).toMatchObject({ error: 'missing codebase slug' })

    await status.close()
  })
})

describe('codebases routes with empty meta (404 branch)', () => {
  /** Drive the real prefix handler with the (empty) seeded meta. */
  async function call(method: string, path: string): Promise<{ code: number; body: string }> {
    const registrations = captureRegistrations()
    const prefix = registrations.find(r => r.kind === 'prefix')!
    let code = -1
    let body = ''
    const res = {
      writeHead(c: number) { code = c },
      end(payload: string) { body = payload },
    }
    await prefix.handler!({ method, url: `http://localhost${path}` }, res)
    return { code, body }
  }

  it('POST /:slug/test returns 404 (find()===undefined branch)', async () => {
    const res = await call('POST', '/api/vectr/codebases/ghost/test')
    expect(res.code).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: 'no such codebase' })
  })

  it('DELETE /:slug returns 404 (find()===undefined branch)', async () => {
    const res = await call('DELETE', '/api/vectr/codebases/ghost')
    expect(res.code).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ ok: false, error: 'no such codebase' })
  })
})
