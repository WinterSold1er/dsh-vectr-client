/**
 * Method / path-shape coverage for the real `/api/vectr/codebases` prefix
 * handler (改动3). `codebase-route.spec.ts` drives the success + 404 + 400
 * branches; this spec exercises the *remaining* branches of the real handler
 * that were previously unasserted:
 *
 * - `POST /api/vectr/codebases/:slug/foo` (a `/test`-less POST suffix) must NOT
 *   be treated as the test action and must return 405, not 200/404/500.
 * - Any non-DELETE/non-`/test`-POST method (GET/PUT/...) on the prefix route
 *   must return 405.
 *
 * The handler is the REAL one from `registerCodebaseRoutes` (no stub), captured
 * via a fake `webServer.register`. The 405 branch short-circuits before any
 * `find()`/`testCodebase`/spawn, so no status server or metadata is needed.
 */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { registerCodebaseRoutes } from '../src/index.ts'

type Registration = { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => Promise<void> }

function capturePrefixHandler(codebasesPath: string, secretsPath: string) {
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
  const prefix = registrations.find(r => r.kind === 'prefix')!
  return async (method: string, path: string): Promise<{ code: number; body: string }> => {
    let code = -1
    let body = ''
    const res = {
      writeHead(c: number) { code = c },
      end(payload: string) { body = payload },
    }
    await prefix.handler!({ method, url: `http://localhost${path}` }, res)
    return { code, body }
  }
}

describe('codebase prefix route method/path-shape branches (real handler)', () => {
  const call = capturePrefixHandler('/tmp/does-not-matter-codebases.json', '/tmp/does-not-matter-secrets.json')

  it('POST /:slug/foo (non-/test suffix) -> 405, not 200/404', async () => {
    const res = await call('POST', '/api/vectr/codebases/demo/foo')
    expect(res.code).toBe(405)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'method not allowed' })
  })

  it('GET /:slug on prefix route -> 405', async () => {
    const res = await call('GET', '/api/vectr/codebases/demo')
    expect(res.code).toBe(405)
  })

  it('PUT /:slug/test -> 405 (only POST is the test action)', async () => {
    const res = await call('PUT', '/api/vectr/codebases/demo/test')
    expect(res.code).toBe(405)
  })

  it('DELETE with empty slug (root prefix) -> 400, not 405', async () => {
    // `slug.length === 0` is checked BEFORE the method branch, so the bare
    // prefix with no slug yields 400 (missing slug), proving the guard wins.
    const res = await call('DELETE', '/api/vectr/codebases/')
    expect(res.code).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'missing codebase slug' })
  })
})
