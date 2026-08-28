/**
 * Deployment regression test (问题1A) — the "src green / lib fake" guard.
 *
 * The original defect shipped a src fix for the slug 404 but the host kept
 * loading the OLD `lib/index.js` (built before the fix), so integration tests
 * against `src` stayed green while the live route returned 404. This spec pins
 * the BUILT ARTIFACT: it asserts `lib/index.js` exists and contains both fixes
 * (slug routing + tunnel self-heal) *and* that the artifact's code actually
 * behaves correctly when exercised. If a src change is committed without a
 * rebuild, this spec fails instead of going silently green.
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  ensureTunnelUp,
  probeTunnel,
  registerCodebaseRoutes,
  slugFromPathname,
} from '../lib/index.js'

const libIndexJs = join(__dirname, '..', 'lib', 'index.js')

/** Real listeners opened by fake reopens, closed in afterEach. */
const boundServers: Server[] = []

beforeEach(() => {})
afterEach(async () => {
  await Promise.all(boundServers.map((s) => new Promise<void>((r) => s.close(() => r()))))
  boundServers.length = 0
})

describe('built artifact contains both fixes (anti fake-green)', () => {
  it('lib/index.js exists', () => {
    expect(() => readFileSync(libIndexJs, 'utf8')).not.toThrow()
  })

  it('lib/index.js contains slugFromPathname (问题1A root-cause fix)', () => {
    const src = readFileSync(libIndexJs, 'utf8')
    expect(src).toContain('slugFromPathname')
  })

  it('lib/index.js contains ensureTunnelUp + the truthful "tunnel down" diagnostic (问题1B)', () => {
    const src = readFileSync(libIndexJs, 'utf8')
    expect(src).toContain('ensureTunnelUp')
    expect(src).toContain('tunnel down')
  })
})

describe('built slugFromPathname behaves correctly', () => {
  it('strips the /test action suffix from the built artifact', () => {
    expect(slugFromPathname('/api/vectr/codebases/demo/test')).toBe('demo')
  })
  it('keeps only the first segment for deeper paths', () => {
    expect(slugFromPathname('/api/vectr/codebases/demo/extra/deep')).toBe('demo')
  })
})

describe('built ensureTunnelUp self-heals (functional, fakes)', () => {
  function makeSsh(): { runner: import('../src/codebases.ts').SshRunner; opens: string[][] } {
    const opens: string[][] = []
    const runner = ((args: string[]): import('../src/codebases.ts').SpawnHandle => {
      if (args.includes('-f')) {
        opens.push(args)
        // Bind the forwarded local port so the post-reopen `isPortListening`
        // force-check (built artifact) reflects a real forward.
        const lIdx = args.indexOf('-L')
        const spec = lIdx >= 0 ? (args[lIdx + 1] ?? '') : ''
        const m = /127\.0\.0\.1:(\d+):/.exec(spec)
        const port = m !== null ? Number(m[1]) : undefined
        const p = new Promise<{ code: number; stdout: string; stderr: string }>((resolveOpen) => {
          if (port !== undefined) {
            const s = createServer((_q, res) => res.end())
            s.listen(port, '127.0.0.1', () => {
              boundServers.push(s)
              resolveOpen({ code: 0, stdout: '', stderr: '' })
            })
          } else {
            resolveOpen({ code: 0, stdout: '', stderr: '' })
          }
        })
        return { promise: p, kill() {} }
      }
      if (args.includes('-O') && args.includes('check')) {
        // first -O check = dead (probe), second = alive (confirm)
        const code = opens.length === 0 ? 1 : 0
        return { promise: Promise.resolve({ code, stdout: code === 0 ? 'Master running (pid=1)' : '', stderr: '' }), kill() {} }
      }
      return { promise: Promise.resolve({ code: 0, stdout: '', stderr: '' }), kill() {} }
    }) as import('../src/codebases.ts').SshRunner
    return { runner, opens }
  }

  it('reopens a dead tunnel using the built artifact', async () => {
    const { runner, opens } = makeSsh()
    const deps = {
      spawnRunner: () => ({ promise: Promise.resolve({ code: 0, stdout: '', stderr: '' }), kill() {} }),
      sshRunner: runner,
      credStore: { set() {}, get: () => undefined, unset() {} },
    }
    const entry = {
      id: 'vnm', slug: 'vnm', type: 'remote' as const, path: '/w', host: 'conan',
      serverName: 'vectr_vnm', localPort: 8760, remotePort: 8767,
      tunnelCtl: '/tmp/vectr-tunnel-vnm.sock', status: 'up' as const,
    }
    const tmp = await mkdtemp(join(tmpdir(), 'built-heal-'))
    const metaPath = join(tmp, 'cb.json')
    await writeFile(metaPath, JSON.stringify([entry]))
    try {
      const res = await ensureTunnelUp(deps as never, metaPath, entry)
      expect(res.healed).toBe(true)
      expect(opens.length).toBe(1)
      expect(opens[0]).toContain('-L')
      expect(probeTunnel).toBeTypeOf('function')
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('built route handler resolves the slug (no 404) on the artifact', () => {
  let tmp: string
  let codebasesPath: string
  let secretsPath: string
  let status: { port: number; close: () => Promise<void> }

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'built-route-'))
    codebasesPath = join(tmp, 'codebases.json')
    secretsPath = join(tmp, 'secrets.json')
    const server: Server = createServer((_req, res) => {
      res.statusCode = 200
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ready: true }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0
    status = { port, close: () => new Promise<void>((r) => server.close(() => r())) }
    // Seed a LOCAL codebase: the heal path is a no-op for local (no ssh), so the
    // built route exercises slug routing + fetch without any real network/ssh.
    await writeFile(codebasesPath, JSON.stringify([
      { id: 'demo', slug: 'demo', type: 'local', path: '/tmp/demo', serverName: 'vectr_demo', localPort: port, status: 'up' },
    ]))
  })

  afterEach(async () => {
    await status.close()
    await rm(tmp, { recursive: true, force: true })
  })

  it('POST /:slug/test on the built artifact returns 200 (was 404 before fix)', async () => {
    const registrations: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => Promise<void> }[] = []
    const fakeWebServer = {
      register: (r: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
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
    let code = -1
    let body = ''
    const res = { writeHead(c: number) { code = c }, end(p: string) { body = p } }
    await prefix.handler!({ method: 'POST', url: 'http://localhost/api/vectr/codebases/demo/test' }, res)
    expect(code).toBe(200)
    expect(JSON.parse(body)).toMatchObject({ ok: true })
  })
})
