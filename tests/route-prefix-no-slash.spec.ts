/**
 * Prefix-route trailing-slash regression test (root-cause fix for
 * DELETE /api/vectr/codebases/:slug → host 404).
 *
 * The host's `match()` only routes a subpath to a `prefix` registration when
 * `pathname === p || pathname.startsWith(p + '/')`. If the registered prefix
 * `p` itself ends with `/`, `p + '/'` becomes a double slash (e.g.
 * `/api/vectr/codebases//`), which never matches a real subpath like
 * `/api/vectr/codebases/vnm_gui` — so the request falls through to the longer
 * `/api` RPC-bridge prefix and the host answers plain-text `not found`.
 *
 * This test captures the *real* registration produced by
 * `registerCodebaseRoutes` (no stub of the handler) and asserts:
 *   1. the registered prefix path has no trailing slash;
 *   2. a real subpath matches per host `match()` semantics
 *      (`pathname.startsWith(path + '/')`);
 *   3. invoking the captured handler for a subpath returns plugin JSON
 *      (proving the route is actually reachable, not swallowed by the host).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerCodebaseRoutes } from '../src/index.ts'

type Registration = { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => Promise<void> }

let tmp: string
let codebasesPath: string
let secretsPath: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vectr-prefix-slash-'))
  codebasesPath = join(tmp, 'codebases.json')
  secretsPath = join(tmp, 'secrets.json')
  await writeFile(codebasesPath, '[]') // empty list: DELETE of any slug → 404 plugin JSON
  await writeFile(secretsPath, '{}')
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
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

describe('codebases prefix route has no trailing slash (host match fix)', () => {
  it('registers the :slug prefix without a trailing slash', () => {
    const registrations = captureRegistrations()
    const prefix = registrations.find(r => r.kind === 'prefix')
    expect(prefix).toBeDefined()
    expect(prefix!.path).toBe('/api/vectr/codebases')
    expect(prefix!.path.endsWith('/')).toBe(false)
  })

  it('a real :slug subpath matches the prefix per host match() semantics', () => {
    const registrations = captureRegistrations()
    const prefix = registrations.find(r => r.kind === 'prefix')!
    const subpath = '/api/vectr/codebases/vnm_gui'
    // Replicates packages/host/webserver/src/index.ts match():
    //   pathname === p || pathname.startsWith(p + '/')
    const matches = subpath === prefix.path || subpath.startsWith(prefix.path + '/')
    expect(matches).toBe(true)
  })

  it('the captured handler answers plugin JSON for a subpath DELETE (not host 404)', async () => {
    const registrations = captureRegistrations()
    const prefix = registrations.find(r => r.kind === 'prefix')!
    let code = -1
    let body = ''
    const res = {
      writeHead(c: number) { code = c },
      end(payload: string) { body = payload },
    }
    await prefix.handler!(
      { method: 'DELETE', url: 'http://localhost/api/vectr/codebases/vnm_gui' },
      res,
    )
    expect(code).toBe(404)
    const parsed = JSON.parse(body)
    expect(parsed).toMatchObject({ ok: false, error: 'no such codebase' })
    // Must be plugin JSON, never the host's plain-text "not found".
    expect(typeof parsed).toBe('object')
  })
})
