/**
 * P2 / H3 — `sshpass -f` real-spawn coverage.
 *
 * `buildCodebaseDeps` (src/index.ts) wraps the real `node:child_process.spawn`.
 * Every prior test used an injected fake `sshRunner`, so the REAL spawn path that
 * builds the `sshpass` argv was at 0 coverage — exactly the surface that carried
 * the plaintext-password-in-argv bug (P2). Here we mock `node:child_process.spawn`
 * to capture the argv `buildCodebaseDeps` actually constructs, and assert:
 *
 *   - the password is passed via `-f <0600 temp file>` (never `-p <password>`),
 *   - the temp file holds the password with mode 0600,
 *   - `-o PreferredAuthentications=password` is still set,
 *   - a spawn `ENOENT` (sshpass missing) is turned into a code-1 failure.
 *
 * The password temp file is written by `buildCodebaseDeps` before spawn, so we
 * can read it from the captured `-f` path to verify its contents/permissions.
 * No real sshpass/ssh is executed.
 */
import { stat } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCodebaseDeps } from '../src/index.ts'

const hoist = vi.hoisted(() => ({
  captured: [] as Array<{ command: string; args: string[]; child: EventEmitter }>,
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter: EE } = await import('node:events')
  function makeSpawn(command: string, args: string[]): EventEmitter {
    const child = new EE() as unknown as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
    ;(child as unknown as { stdout: EventEmitter }).stdout = new EE()
    ;(child as unknown as { stderr: EventEmitter }).stderr = new EE()
    ;(child as unknown as { kill: () => void }).kill = () => {}
    hoist.captured.push({ command, args, child })
    return child
  }
  return { spawn: vi.fn((command: string, args: string[]) => makeSpawn(command, args)) }
})

const spawnMock = (await import('node:child_process')).spawn as unknown as ReturnType<typeof vi.fn>

function lastSpawn(): { command: string; args: string[]; child: EventEmitter } {
  const rec = hoist.captured.at(-1)
  if (rec === undefined) throw new Error('no spawn captured')
  return rec
}

beforeEach(() => {
  hoist.captured.length = 0
})

afterEach(() => {
  spawnMock.mockClear()
})

describe('sshpass -f construction (no plaintext argv)', () => {
  it('passes the password via -f <0600 temp file>, not -p', async () => {
    const deps = buildCodebaseDeps({ get: () => undefined } as never, '/tmp/vectr-secrets.json')
    const handle = deps.sshRunner(['-o', 'ConnectTimeout=5', 'h', 'true'], { password: 's3cret' })

    const { command, args } = lastSpawn()
    expect(command).toBe('sshpass')
    expect(args[0]).toBe('-f')
    const passFile = args[1]
    expect(passFile).toBeTypeOf('string')
    expect(passFile).not.toBe('s3cret')
    // plaintext password must never appear in argv
    expect(args).not.toContain('-p')
    expect(args.join(' ')).not.toContain('s3cret')
    // sshpass-only auth still forced
    expect(args).toContain('-o')
    expect(args).toContain('PreferredAuthentications=password')

    // temp file: mode 0600 and contents equal the password
    const info = await stat(passFile)
    expect(info.mode & 0o777).toBe(0o600)
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(passFile, 'utf8')).toBe('s3cret')

    // resolve the fake process so the cleanup `finally` runs
    lastSpawn().child.emit('close', 0)
    await handle.promise
  })

  it('key-auth hosts run plain ssh (no sshpass, no password file)', async () => {
    const deps = buildCodebaseDeps({ get: () => undefined } as never, '/tmp/vectr-secrets.json')
    const handle = deps.sshRunner(['-o', 'BatchMode=yes', 'h', 'true'])
    const { command, args } = lastSpawn()
    expect(command).toBe('ssh')
    expect(args[0]).toBe('-o')
    expect(args).not.toContain('-f')
    lastSpawn().child.emit('close', 0)
    await handle.promise
  })

  it('surfaces a spawn ENOENT as a code-1 failure and still cleans the temp file', async () => {
    const deps = buildCodebaseDeps({ get: () => undefined } as never, '/tmp/vectr-secrets.json')
    const handle = deps.sshRunner(['h', 'true'], { password: 's3cret' })
    const { args, child } = lastSpawn()
    const passFile = args[1]
    const info = await stat(passFile)
    expect(info.mode & 0o777).toBe(0o600)
    const err = new Error('spawn sshpass ENOENT') as NodeJS.ErrnoException
    err.code = 'ENOENT'
    child.emit('error', err)
    const result = await handle.promise
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ENOENT')
    // temp file removed on exit
    await expect(stat(passFile)).rejects.toThrow()
  })
})
