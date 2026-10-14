import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  normalizeWorkspacePath,
  parseRemotePort,
  resolveRemotePort,
  createCodebase,
  loadCodebases,
  type CodebaseDeps,
  type SpawnHandle,
  type SshRunner,
  type SpawnRunner,
  type CredentialStore,
  type SshAuthContext,
} from '../src/codebases.ts'

interface FakeProc {
  code: number
  stdout: string
  stderr: string
}

function makeSshRunner(
  scripts: Array<{ match: (args: string[]) => boolean; proc: FakeProc }>,
): SshRunner & { calls: string[][]; auths: Array<SshAuthContext | undefined> } {
  const calls: string[][] = []
  const auths: Array<SshAuthContext | undefined> = []
  const runner = ((args: string[], auth?: SshAuthContext): SpawnHandle => {
    calls.push(args)
    auths.push(auth)
    const hit = scripts.find((s) => s.match(args))
    if (hit === undefined) {
      throw new Error(`unexpected ssh: ${args.join(' ')}`)
    }
    const handle: SpawnHandle = {
      promise: Promise.resolve({
        code: hit.proc.code,
        stdout: hit.proc.stdout,
        stderr: hit.proc.stderr,
        signal: null,
      }),
      kill() {},
    }
    return handle
  }) as SshRunner & { calls: string[][]; auths: Array<SshAuthContext | undefined> }
  ;(runner as { calls: string[][] }).calls = calls
  ;(runner as { auths: Array<SshAuthContext | undefined> }).auths = auths
  return runner
}

function makeSpawnRunner(): SpawnRunner {
  return () => ({
    promise: Promise.resolve({ code: 0, stdout: '', stderr: '', signal: null }),
    kill() {},
  })
}

function makeCredStore(): CredentialStore {
  const map = new Map<string, string>()
  return {
    async set(ref, val) { map.set(ref, val) },
    async unset(ref) { map.delete(ref) },
    async resolve(ref) {
      const v = map.get(ref)
      return v !== undefined ? { value: v } : undefined
    },
  }
}

describe('remote backend fixes', () => {
  let dir: string
  let metaPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vectr-remote-fixes-'))
    metaPath = join(dir, 'codebases.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('normalizeWorkspacePath', () => {
    it('trims trailing slashes from single and multi-level paths', () => {
      expect(normalizeWorkspacePath('/home/user/project/')).toBe('/home/user/project')
      expect(normalizeWorkspacePath('/home/user/project///')).toBe('/home/user/project')
      expect(normalizeWorkspacePath('/home/user/project')).toBe('/home/user/project')
      expect(normalizeWorkspacePath('  /home/user/project/  ')).toBe('/home/user/project')
    })

    it('preserves root path /', () => {
      expect(normalizeWorkspacePath('/')).toBe('/')
      expect(normalizeWorkspacePath('///')).toBe('/')
    })

    it('handles empty or non-string inputs gracefully', () => {
      expect(normalizeWorkspacePath('')).toBe('/')
      expect(normalizeWorkspacePath('   ')).toBe('/')
      expect(normalizeWorkspacePath(null as unknown as string)).toBe('')
    })
  })

  describe('parseRemotePort', () => {
    it('parses pattern a: "port" : (\\d+)', () => {
      expect(parseRemotePort('{"port": 8765}')).toBe(8765)
      expect(parseRemotePort('{\n  "port"  :  8765\n}')).toBe(8765)
      expect(parseRemotePort('"port":9001')).toBe(9001)
    })

    it('parses pattern b: port[=:]\\s*(\\d+) and allows whitespace before = or :', () => {
      expect(parseRemotePort('port=8765')).toBe(8765)
      expect(parseRemotePort('port = 8765')).toBe(8765)
      expect(parseRemotePort('port : 8765')).toBe(8765)
      expect(parseRemotePort('port: 8765')).toBe(8765)
      expect(parseRemotePort('port:8765')).toBe(8765)
      expect(parseRemotePort('info: port = 9123 ok')).toBe(9123)
    })

    it('parses pattern c: (?:started|running).*?on port\\s+(\\d+)', () => {
      expect(parseRemotePort('vectr daemon started on port 8765')).toBe(8765)
      expect(parseRemotePort('Vectr daemon is already running on port 8765')).toBe(8765)
      expect(parseRemotePort('service running on port 9200')).toBe(9200)
    })

    it('parses pattern d: Port\\s*:\\s*(\\d+)', () => {
      expect(parseRemotePort('Port: 8765')).toBe(8765)
      expect(parseRemotePort('Port : 8765')).toBe(8765)
      expect(parseRemotePort('Daemon Port: 9300')).toBe(9300)
    })

    it('parses port from combined stdout and stderr when port is on stderr', () => {
      const stdout = 'Vectr server initializing...\nLoading models...'
      const stderr = 'daemon started on port 8765\n'
      const combined = `${stdout}\n${stderr}`
      expect(parseRemotePort(combined)).toBe(8765)
    })

    it('returns undefined for non-port outputs', () => {
      expect(parseRemotePort('')).toBeUndefined()
      expect(parseRemotePort('random output without port')).toBeUndefined()
      expect(parseRemotePort('error: connection failed')).toBeUndefined()
    })
  })

  describe('resolveRemotePort trailing slash tolerance', () => {
    it('matches workspace path regardless of trailing slash differences', async () => {
      const instances = {
        inst1: { workspace: '/home/user/project/', port: 8765 },
      }
      const ssh = makeSshRunner([
        {
          match: (a) => a.includes('cat'),
          proc: { code: 0, stdout: JSON.stringify(instances), stderr: '' },
        },
      ])

      // Query without trailing slash against instances.json entry with trailing slash
      const port1 = await resolveRemotePort(ssh, 'user@host', '/home/user/project')
      expect(port1).toBe(8765)

      // Query with trailing slash against instances.json entry with trailing slash
      const port2 = await resolveRemotePort(ssh, 'user@host', '/home/user/project/')
      expect(port2).toBe(8765)
    })

    it('matches when instances.json entry has no trailing slash and query has trailing slash', async () => {
      const instances = {
        inst1: { workspace: '/home/user/project', port: 8765 },
      }
      const ssh = makeSshRunner([
        {
          match: (a) => a.includes('cat'),
          proc: { code: 0, stdout: JSON.stringify(instances), stderr: '' },
        },
      ])

      const port = await resolveRemotePort(ssh, 'user@host', '/home/user/project///')
      expect(port).toBe(8765)
    })
  })

  describe('createCodebaseCore liveness check and stale cleanup', () => {
    it('detects dead remote daemon, calls vectr stop --port, restarts daemon, and resolves new port', async () => {
      const staleInstances = {
        inst1: { workspace: '/remote/workspace', port: 8762 },
      }
      const freshInstances = {
        inst1: { workspace: '/remote/workspace', port: 8763 },
      }

      let catCount = 0
      let stopCalledWithPort: number | undefined
      let startCalls = 0

      const ssh = makeSshRunner([
        { match: (a) => a.includes('true') && !a.includes('curl'), proc: { code: 0, stdout: '', stderr: '' } },
        { match: (a) => a.includes('tool') && a.includes('list'), proc: { code: 0, stdout: 'vectr 0.1.0', stderr: '' } },
        {
          match: (a) => a.includes('start'),
          proc: {
            code: 0,
            stdout: '',
            stderr: '',
          },
        },
        {
          match: (a) => a.includes('cat'),
          proc: {
            code: 0,
            stdout: JSON.stringify(staleInstances),
            stderr: '',
          },
        },
        {
          match: (a) => a.includes('curl') && a.some((x) => x.includes('8762')),
          // Dead port 8762: curl fails, stdout empty
          proc: { code: 7, stdout: '', stderr: 'Failed to connect' },
        },
        {
          match: (a) => a.includes('stop'),
          proc: { code: 0, stdout: 'stopped', stderr: '' },
        },
        {
          match: (a) => a.includes('curl') && a.some((x) => x.includes('8763')),
          proc: { code: 0, stdout: '{"status":"ok"}', stderr: '' },
        },
        { match: (a) => a.includes('-L') || a.includes('-M'), proc: { code: 0, stdout: '', stderr: '' } },
        { match: (a) => a.includes('-O'), proc: { code: 0, stdout: 'Master running (pid=99)', stderr: '' } },
      ])

      // Custom wrap to track dynamic cat results
      const originalRunner = ssh
      const dynamicSsh: SshRunner = (args, auth) => {
        if (args.includes('cat')) {
          catCount++
          const json = catCount === 1 ? staleInstances : freshInstances
          return {
            promise: Promise.resolve({ code: 0, stdout: JSON.stringify(json), stderr: '', signal: null }),
            kill() {},
          }
        }
        if (args.includes('start')) {
          startCalls++
        }
        if (args.includes('stop')) {
          const portArg = args[args.indexOf('--port') + 1]
          stopCalledWithPort = Number(portArg)
        }
        return originalRunner(args, auth)
      }

      const deps: CodebaseDeps = {
        spawnRunner: makeSpawnRunner(),
        sshRunner: dynamicSsh,
        credStore: makeCredStore(),
      }

      const entry = await createCodebase(deps, metaPath, {
        type: 'remote',
        path: '/remote/workspace/',
        host: 'remote-user@remote-host',
        workspace: '/local/workspace/',
        slug: 'stale-recover',
      })

      expect(entry.status).toBe('up')
      expect(entry.remotePort).toBe(8763)
      expect(stopCalledWithPort).toBe(8762)
      // vectr start was called initially and once more after stop
      expect(startCalls).toBe(2)
    })

    it('reuses alive remote daemon without calling vectr stop', async () => {
      const instances = {
        inst1: { workspace: '/remote/workspace', port: 8762 },
      }
      let stopCalled = false

      const ssh = makeSshRunner([
        { match: (a) => a.includes('true') && !a.includes('curl'), proc: { code: 0, stdout: '', stderr: '' } },
        { match: (a) => a.includes('tool') && a.includes('list'), proc: { code: 0, stdout: 'vectr 0.1.0', stderr: '' } },
        { match: (a) => a.includes('start'), proc: { code: 0, stdout: '', stderr: '' } },
        { match: (a) => a.includes('cat'), proc: { code: 0, stdout: JSON.stringify(instances), stderr: '' } },
        { match: (a) => a.includes('curl'), proc: { code: 0, stdout: '{"status":"ok"}', stderr: '' } },
        {
          match: (a) => a.includes('stop'),
          proc: { code: 0, stdout: '', stderr: '' },
        },
        { match: (a) => a.includes('-L') || a.includes('-M'), proc: { code: 0, stdout: '', stderr: '' } },
        { match: (a) => a.includes('-O'), proc: { code: 0, stdout: 'Master running (pid=99)', stderr: '' } },
      ])

      const dynamicSsh: SshRunner = (args, auth) => {
        if (args.includes('stop')) stopCalled = true
        return ssh(args, auth)
      }

      const deps: CodebaseDeps = {
        spawnRunner: makeSpawnRunner(),
        sshRunner: dynamicSsh,
        credStore: makeCredStore(),
      }

      const entry = await createCodebase(deps, metaPath, {
        type: 'remote',
        path: '/remote/workspace',
        host: 'remote-user@remote-host',
        workspace: '/local/workspace',
        slug: 'alive-reuse',
      })

      expect(entry.status).toBe('up')
      expect(entry.remotePort).toBe(8762)
      expect(stopCalled).toBe(false)
    })

    it('falls back to parseRemotePort with combined stderr when instances.json is absent', async () => {
      const ssh = makeSshRunner([
        { match: (a) => a.includes('true'), proc: { code: 0, stdout: '', stderr: '' } },
        { match: (a) => a.includes('tool') && a.includes('list'), proc: { code: 0, stdout: 'vectr 0.1.0', stderr: '' } },
        {
          match: (a) => a.includes('start'),
          proc: { code: 0, stdout: '', stderr: 'Vectr server running on port 8999' },
        },
        { match: (a) => a.includes('cat'), proc: { code: 1, stdout: '', stderr: 'No such file' } },
        { match: (a) => a.includes('-L') || a.includes('-M'), proc: { code: 0, stdout: '', stderr: '' } },
        { match: (a) => a.includes('-O'), proc: { code: 0, stdout: 'Master running (pid=99)', stderr: '' } },
      ])

      const deps: CodebaseDeps = {
        spawnRunner: makeSpawnRunner(),
        sshRunner: ssh,
        credStore: makeCredStore(),
      }

      const entry = await createCodebase(deps, metaPath, {
        type: 'remote',
        path: '/remote/workspace',
        host: 'remote-user@remote-host',
        workspace: '/local/workspace',
        slug: 'stderr-fallback',
      })

      expect(entry.status).toBe('up')
      expect(entry.remotePort).toBe(8999)
    })
  })
})
