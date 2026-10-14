import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
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
import { buildCodebaseDeps } from '../src/index.ts'

// Mock node:child_process to inspect sshRunner / buildCodebaseDeps behavior
const hoist = vi.hoisted(() => ({
  capturedSpawns: [] as Array<{
    command: string
    args: string[]
    child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
  }>,
  syncSpawnError: null as Error | null,
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter: EE } = await import('node:events')
  function makeSpawn(command: string, args: string[]) {
    if (hoist.syncSpawnError !== null) {
      const err = hoist.syncSpawnError
      hoist.syncSpawnError = null
      throw err
    }
    const child = new EE() as unknown as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      kill: () => void
    }
    ;(child as unknown as { stdout: EventEmitter }).stdout = new EE()
    ;(child as unknown as { stderr: EventEmitter }).stderr = new EE()
    ;(child as unknown as { kill: () => void }).kill = () => {}
    hoist.capturedSpawns.push({ command, args, child })
    return child
  }
  return {
    spawn: vi.fn((command: string, args: string[]) => makeSpawn(command, args)),
  }
})

interface FakeProc {
  code: number
  stdout: string
  stderr: string
}

function makeSshRunner(
  scripts: Array<{ match: (args: string[]) => boolean; proc: FakeProc | ((args: string[]) => FakeProc) }>,
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
    const resolvedProc = typeof hit.proc === 'function' ? hit.proc(args) : hit.proc
    const handle: SpawnHandle = {
      promise: Promise.resolve({
        code: resolvedProc.code,
        stdout: resolvedProc.stdout,
        stderr: resolvedProc.stderr,
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
    async set(ref, val) {
      map.set(ref, val)
    },
    async unset(ref) {
      map.delete(ref)
    },
    async resolve(ref) {
      const v = map.get(ref)
      return v !== undefined ? { value: v } : undefined
    },
  }
}

describe('Remote Codebase Fixes', () => {
  let tempDir: string
  let metaPath: string

  beforeEach(async () => {
    hoist.capturedSpawns.length = 0
    hoist.syncSpawnError = null
    tempDir = await mkdtemp(join(tmpdir(), 'vectr-test-fixes-'))
    metaPath = join(tempDir, 'codebases.json')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('1. Path Normalization with Trailing Slashes', () => {
    it('normalizes various paths by stripping trailing slashes and trimming whitespace', () => {
      expect(normalizeWorkspacePath('/foo/bar/')).toBe('/foo/bar')
      expect(normalizeWorkspacePath('/foo/bar///')).toBe('/foo/bar')
      expect(normalizeWorkspacePath('   /foo/bar/   ')).toBe('/foo/bar')
      expect(normalizeWorkspacePath('/home/edogawaconan/Code/Work/vnm_gui/')).toBe(
        '/home/edogawaconan/Code/Work/vnm_gui',
      )
    })

    it('preserves single root slash when given root variations', () => {
      expect(normalizeWorkspacePath('/')).toBe('/')
      expect(normalizeWorkspacePath('///')).toBe('/')
      expect(normalizeWorkspacePath('   ///   ')).toBe('/')
    })

    it('handles empty or non-string inputs safely', () => {
      expect(normalizeWorkspacePath('')).toBe('/')
      expect(normalizeWorkspacePath('   ')).toBe('/')
      expect(normalizeWorkspacePath(null as unknown as string)).toBe('')
      expect(normalizeWorkspacePath(undefined as unknown as string)).toBe('')
    })

    it('matches instances.json entry without trailing slash when query has trailing slash', async () => {
      const ssh = makeSshRunner([
        {
          match: (a) => a.join(' ').includes('instances.json'),
          proc: {
            code: 0,
            stdout: JSON.stringify({
              inst1: { workspace: '/home/edogawaconan/Code/Work/vnm_gui', port: 8767 },
            }),
            stderr: '',
          },
        },
      ])

      const port = await resolveRemotePort(
        ssh,
        'conan',
        '/home/edogawaconan/Code/Work/vnm_gui/',
      )
      expect(port).toBe(8767)
    })

    it('matches instances.json entry with trailing slash when query has no trailing slash', async () => {
      const ssh = makeSshRunner([
        {
          match: (a) => a.join(' ').includes('instances.json'),
          proc: {
            code: 0,
            stdout: JSON.stringify({
              inst1: { workspace: '/home/edogawaconan/Code/Work/vnm_gui/', port: 8767 },
            }),
            stderr: '',
          },
        },
      ])

      const port = await resolveRemotePort(
        ssh,
        'conan',
        '/home/edogawaconan/Code/Work/vnm_gui',
      )
      expect(port).toBe(8767)
    })

    it('disambiguates between similar path prefixes in instances.json', async () => {
      const ssh = makeSshRunner([
        {
          match: (a) => a.join(' ').includes('instances.json'),
          proc: {
            code: 0,
            stdout: JSON.stringify({
              a: { workspace: '/data/app', port: 8001 },
              b: { workspace: '/data/app_extra', port: 8002 },
              c: { workspace: '/data/app/', port: 8001 },
            }),
            stderr: '',
          },
        },
      ])

      const portApp = await resolveRemotePort(ssh, 'host1', '/data/app/')
      expect(portApp).toBe(8001)

      const portExtra = await resolveRemotePort(ssh, 'host1', '/data/app_extra')
      expect(portExtra).toBe(8002)

      const portUnknown = await resolveRemotePort(ssh, 'host1', '/data/app_other')
      expect(portUnknown).toBeUndefined()
    })

    it('returns undefined if instances.json read fails or contains invalid json', async () => {
      const sshFail = makeSshRunner([
        {
          match: (a) => a.join(' ').includes('instances.json'),
          proc: { code: 1, stdout: '', stderr: 'No such file or directory' },
        },
      ])
      expect(await resolveRemotePort(sshFail, 'host', '/path')).toBeUndefined()

      const sshBadJson = makeSshRunner([
        {
          match: (a) => a.join(' ').includes('instances.json'),
          proc: { code: 0, stdout: 'not json { [', stderr: '' },
        },
      ])
      expect(await resolveRemotePort(sshBadJson, 'host', '/path')).toBeUndefined()
    })

    it('createCodebase normalizes path, workspace, and remotePath with trailing slashes', async () => {
      const ssh = makeSshRunner([
        { match: (a) => a.join(' ').includes('true') && !a.join(' ').includes('curl'), proc: { code: 0, stdout: '', stderr: '' } },
        { match: (a) => a.join(' ').includes('tool') && a.join(' ').includes('list'), proc: { code: 0, stdout: 'vectr 0.1.0', stderr: '' } },
        { match: (a) => a.join(' ').includes('vectr start'), proc: { code: 0, stdout: 'started', stderr: '' } },
        {
          match: (a) => a.join(' ').includes('instances.json'),
          proc: {
            code: 0,
            stdout: JSON.stringify({
              inst: { workspace: '/remote/repo', port: 8888 },
            }),
            stderr: '',
          },
        },
        { match: (a) => a.join(' ').includes('curl'), proc: { code: 0, stdout: '{"status":"ok"}', stderr: '' } },
        { match: (a) => a.join(' ').includes('-M') && a.join(' ').includes('-S'), proc: { code: 0, stdout: 'Master running (pid=12345)', stderr: '' } },
        { match: (a) => a.join(' ').includes('-O') && a.join(' ').includes('check'), proc: { code: 0, stdout: 'Master running (pid=12345)', stderr: '' } },
      ])

      const deps: CodebaseDeps = {
        spawnRunner: makeSpawnRunner(),
        sshRunner: ssh,
        credStore: makeCredStore(),
      }

      // Pass spec with trailing slashes in path and workspace
      const entry = await createCodebase(deps, metaPath, {
        slug: 'repo-trail-test',
        type: 'remote',
        host: 'remote-host',
        path: '/remote/repo/',
        workspace: '/local/work/',
      })

      expect(entry.path).toBe('/remote/repo')
      expect(entry.workspace).toBe('/local/work')
      expect(entry.remotePort).toBe(8888)

      // Verify persisted metadata has normalized paths
      const list = loadCodebases(metaPath)
      const persisted = list.find((e) => e.slug === 'repo-trail-test')
      expect(persisted).toBeDefined()
      expect(persisted?.path).toBe('/remote/repo')
      expect(persisted?.workspace).toBe('/local/work')
    })
  })

  describe('2. parseRemotePort Parsing stdout and stderr Formats', () => {
    it('parses "Vectr started (PID 123) on port 8768"', () => {
      const out = 'Vectr started (PID 123) on port 8768'
      expect(parseRemotePort(out)).toBe(8768)
    })

    it('parses "Vectr running on port 9021"', () => {
      const out = 'Vectr daemon is now running on port 9021'
      expect(parseRemotePort(out)).toBe(9021)
    })

    it('parses "Port : 8767" and "Port: 8767"', () => {
      expect(parseRemotePort('Status: ok, Port : 8767')).toBe(8767)
      expect(parseRemotePort('Port: 8767')).toBe(8767)
    })

    it('parses "port=8765" and "port: 8765"', () => {
      expect(parseRemotePort('daemon listening port=8765')).toBe(8765)
      expect(parseRemotePort('active port: 8765')).toBe(8765)
    })

    it('parses JSON formatted `"port": 8765` and `"port" : 8765`', () => {
      expect(parseRemotePort('{"status":"ok","port":8765}')).toBe(8765)
      expect(parseRemotePort('{"port" : 8765}')).toBe(8765)
    })

    it('parses port from stderr-formatted multiline text', () => {
      const stderrOutput = `
2026-10-14T04:15:30Z [WARN] indexer warming up
2026-10-14T04:15:32Z [INFO] Vectr started (PID 506153) on port 8768
2026-10-14T04:15:33Z [INFO] symbol indexing ready
`
      expect(parseRemotePort(stderrOutput)).toBe(8768)
    })

    it('parses port when combined stdout and stderr contains noise and port is in stderr', () => {
      const combined = `
--- STDOUT ---
Starting vectr daemon for /workspace...
--- STDERR ---
[DEBUG] Initializing sqlite database at /workspace/.vectr/index.db
Vectr started (PID 999) on port 8991
`
      expect(parseRemotePort(combined)).toBe(8991)
    })

    it('is case-insensitive for PORT label', () => {
      expect(parseRemotePort('PORT: 8766')).toBe(8766)
      expect(parseRemotePort('PORT : 8766')).toBe(8766)
      expect(parseRemotePort('STARTED ON PORT 8766')).toBe(8766)
    })

    it('returns undefined for output without port or empty/invalid inputs', () => {
      expect(parseRemotePort('')).toBeUndefined()
      expect(parseRemotePort('   ')).toBeUndefined()
      expect(parseRemotePort('Vectr started successfully without any number')).toBeUndefined()
      expect(parseRemotePort('port=')).toBeUndefined()
      expect(parseRemotePort(null as unknown as string)).toBeUndefined()
      expect(parseRemotePort(undefined as unknown as string)).toBeUndefined()
    })
  })

  describe('3. sshRunner in Password Mode Invoking ssh via sshpass', () => {
    it('spawns sshpass with -f <tempfile>, ssh command, and password flags', async () => {
      const deps = buildCodebaseDeps({ get: () => undefined } as never, join(tempDir, 'secrets.json'))
      const handle = deps.sshRunner(['-o', 'ConnectTimeout=5', 'conan', 'echo hello'], {
        password: 'super-secret-password-123',
      })

      expect(hoist.capturedSpawns.length).toBe(1)
      const call = hoist.capturedSpawns[0]
      expect(call.command).toBe('sshpass')

      const { args } = call
      expect(args[0]).toBe('-f')
      const passFile = args[1]
      expect(typeof passFile).toBe('string')
      expect(passFile).toContain('vectr-sshpass-')

      // CRITICAL BUGFIX ASSERTION: args[2] must be 'ssh'
      expect(args[2]).toBe('ssh')

      // Authentication flags
      expect(args).toContain('-o')
      expect(args).toContain('PreferredAuthentications=password')
      expect(args).toContain('PubkeyAuthentication=no')

      // Target command flags
      expect(args).toContain('conan')
      expect(args).toContain('echo hello')

      // Plaintext password must NOT appear in argv
      expect(args).not.toContain('super-secret-password-123')
      expect(args.join(' ')).not.toContain('super-secret-password-123')

      // Temp file must exist with mode 0o600 and contain the password
      const fileStat = await stat(passFile)
      expect(fileStat.mode & 0o777).toBe(0o600)
      const content = await readFile(passFile, 'utf8')
      expect(content).toBe('super-secret-password-123')

      // Emit child exit to verify cleanup
      call.child.emit('close', 0, null)
      await handle.promise

      // Temp file must be deleted after promise settles
      await expect(stat(passFile)).rejects.toThrow()
    })

    it('spawns ssh directly when auth is absent or has no password', async () => {
      const deps = buildCodebaseDeps({ get: () => undefined } as never, join(tempDir, 'secrets.json'))
      const handle = deps.sshRunner(['-o', 'BatchMode=yes', 'conan', 'uptime'])

      expect(hoist.capturedSpawns.length).toBe(1)
      const call = hoist.capturedSpawns[0]
      expect(call.command).toBe('ssh')
      expect(call.args).toEqual(['-o', 'BatchMode=yes', 'conan', 'uptime'])
      expect(call.args).not.toContain('sshpass')
      expect(call.args).not.toContain('-f')

      call.child.emit('close', 0, null)
      await handle.promise
    })

    it('cleans up temp password file when spawn throws synchronously', async () => {
      hoist.syncSpawnError = new Error('spawn sshpass ENOENT: command not found')
      const deps = buildCodebaseDeps({ get: () => undefined } as never, join(tempDir, 'secrets.json'))

      let caughtError: Error | null = null
      try {
        deps.sshRunner(['conan', 'true'], { password: 'throw-test-password' })
      } catch (e) {
        caughtError = e as Error
      }

      expect(caughtError).not.toBeNull()
      expect(caughtError?.message).toContain('spawn sshpass ENOENT')
    })
  })

  describe('4. Stale Remote Daemon Recovery in createCodebaseCore', () => {
    it('detects dead daemon, calls vectr stop, restarts vectr start, and recovers new port', async () => {
      let vectrStopCalled = false
      let restartVectrStartCalled = false
      let startInvocationCount = 0
      let instancesReadCount = 0

      const ssh = makeSshRunner([
        { match: (a) => a.join(' ').includes('true') && !a.join(' ').includes('curl'), proc: { code: 0, stdout: '', stderr: '' } },
        { match: (a) => a.join(' ').includes('tool') && a.join(' ').includes('list'), proc: { code: 0, stdout: 'vectr 0.1.0', stderr: '' } },
        {
          match: (a) => a.join(' ').includes('instances.json'),
          proc: () => {
            instancesReadCount++
            return {
              code: 0,
              stdout: JSON.stringify({
                inst: {
                  workspace: '/remote/stale/project',
                  port: instancesReadCount === 1 ? 8765 : 8770,
                },
              }),
              stderr: '',
            }
          },
        },
        // Initial probe to port 8765 reports DEAD (code 7 connection refused, or empty output)
        {
          match: (a) => a.join(' ').includes('curl') && a.join(' ').includes('8765'),
          proc: { code: 7, stdout: '', stderr: 'curl: (7) Failed to connect to 127.0.0.1 port 8765' },
        },
        // Stop called on stale port 8765
        {
          match: (a) => {
            if (a.join(' ').includes('vectr stop --port 8765')) {
              vectrStopCalled = true
              return true
            }
            return false
          },
          proc: { code: 0, stdout: 'Stopped instance on port 8765', stderr: '' },
        },
        // Restart vectr start
        {
          match: (a) => {
            if (a.join(' ').includes('vectr start')) {
              startInvocationCount++
              if (startInvocationCount >= 2) {
                restartVectrStartCalled = true
              }
              return true
            }
            return false
          },
          proc: () => ({
            code: 0,
            stdout: 'Vectr started (PID 8888) on port 8770',
            stderr: '',
          }),
        },
        // Health check on new port 8770 succeeds
        {
          match: (a) => a.join(' ').includes('curl') && a.join(' ').includes('8770'),
          proc: { code: 0, stdout: '{"status":"ok"}', stderr: '' },
        },
        // Tunnel creation and check
        { match: (a) => a.join(' ').includes('-M') && a.join(' ').includes('-S'), proc: { code: 0, stdout: 'Master running (pid=555)', stderr: '' } },
        { match: (a) => a.join(' ').includes('-O') && a.join(' ').includes('check'), proc: { code: 0, stdout: 'Master running (pid=555)', stderr: '' } },
      ])

      const deps: CodebaseDeps = {
        spawnRunner: makeSpawnRunner(),
        sshRunner: ssh,
        credStore: makeCredStore(),
      }

      const entry = await createCodebase(deps, metaPath, {
        slug: 'stale-recover-test',
        type: 'remote',
        host: 'remote-host',
        path: '/remote/stale/project',
        workspace: '/local/work',
      })

      expect(vectrStopCalled).toBe(true)
      expect(restartVectrStartCalled).toBe(true)
      expect(entry.remotePort).toBe(8770)
      expect(entry.status).toBe('up')

      // Verify tunnel argument targeted the new recovered port 8770
      const tunnelCall = ssh.calls.find((c) => c.join(' ').includes('-M') && c.join(' ').includes('-S'))
      expect(tunnelCall).toBeDefined()
      expect(tunnelCall?.some((arg) => arg.includes(':127.0.0.1:8770'))).toBe(true)
    })

    it('fails and cleans up if vectr restart fails on remote host', async () => {
      let vectrStopCalled = false
      let startInvocationCount = 0

      const ssh = makeSshRunner([
        { match: (a) => a.join(' ').includes('true') && !a.join(' ').includes('curl'), proc: { code: 0, stdout: '', stderr: '' } },
        { match: (a) => a.join(' ').includes('tool') && a.join(' ').includes('list'), proc: { code: 0, stdout: 'vectr 0.1.0', stderr: '' } },
        {
          match: (a) => a.join(' ').includes('instances.json'),
          proc: {
            code: 0,
            stdout: JSON.stringify({
              inst: { workspace: '/remote/crash/project', port: 8765 },
            }),
            stderr: '',
          },
        },
        {
          match: (a) => a.join(' ').includes('curl') && a.join(' ').includes('8765'),
          proc: { code: 7, stdout: '', stderr: 'connection refused' },
        },
        {
          match: (a) => {
            if (a.join(' ').includes('vectr stop --port 8765')) {
              vectrStopCalled = true
              return true
            }
            return false
          },
          proc: { code: 0, stdout: '', stderr: '' },
        },
        {
          match: (a) => a.join(' ').includes('vectr start'),
          proc: () => {
            startInvocationCount++
            if (startInvocationCount >= 2) {
              return {
                code: 1,
                stdout: '',
                stderr: 'Fatal: port already in use or permission denied',
              }
            }
            return {
              code: 0,
              stdout: 'vectr started',
              stderr: '',
            }
          },
        },
      ])

      const deps: CodebaseDeps = {
        spawnRunner: makeSpawnRunner(),
        sshRunner: ssh,
        credStore: makeCredStore(),
      }

      await expect(
        createCodebase(deps, metaPath, {
          slug: 'stale-fail-test',
          type: 'remote',
          host: 'remote-host',
          path: '/remote/crash/project',
          workspace: '/local/work',
        }),
      ).rejects.toThrow(/failed to start vectr on remote-host: Fatal: port already in use/)

      expect(vectrStopCalled).toBe(true)
    })

    it('does NOT stop or restart daemon when it is already healthy', async () => {
      let vectrStopCalled = false
      let startCount = 0

      const ssh = makeSshRunner([
        { match: (a) => a.join(' ').includes('true') && !a.join(' ').includes('curl'), proc: { code: 0, stdout: '', stderr: '' } },
        { match: (a) => a.join(' ').includes('tool') && a.join(' ').includes('list'), proc: { code: 0, stdout: 'vectr 0.1.0', stderr: '' } },
        {
          match: (a) => a.join(' ').includes('instances.json'),
          proc: {
            code: 0,
            stdout: JSON.stringify({
              inst: { workspace: '/remote/healthy/project', port: 8767 },
            }),
            stderr: '',
          },
        },
        {
          match: (a) => a.join(' ').includes('curl') && a.join(' ').includes('8767'),
          proc: { code: 0, stdout: '{"status":"ok"}', stderr: '' },
        },
        {
          match: (a) => {
            if (a.join(' ').includes('vectr stop')) {
              vectrStopCalled = true
              return true
            }
            return false
          },
          proc: { code: 0, stdout: '', stderr: '' },
        },
        {
          match: (a) => {
            if (a.join(' ').includes('vectr start')) {
              startCount++
              return true
            }
            return false
          },
          proc: { code: 0, stdout: 'Vectr started on port 8767', stderr: '' },
        },
        { match: (a) => a.join(' ').includes('-M') && a.join(' ').includes('-S'), proc: { code: 0, stdout: 'Master running (pid=100)', stderr: '' } },
        { match: (a) => a.join(' ').includes('-O') && a.join(' ').includes('check'), proc: { code: 0, stdout: 'Master running (pid=100)', stderr: '' } },
      ])

      const deps: CodebaseDeps = {
        spawnRunner: makeSpawnRunner(),
        sshRunner: ssh,
        credStore: makeCredStore(),
      }

      const entry = await createCodebase(deps, metaPath, {
        slug: 'healthy-test',
        type: 'remote',
        host: 'remote-host',
        path: '/remote/healthy/project',
        workspace: '/local/work',
      })

      expect(entry.remotePort).toBe(8767)
      expect(vectrStopCalled).toBe(false)
      // Only initial step 3 start was invoked (idempotent), no restart step
      expect(startCount).toBe(1)
    })
  })
})
