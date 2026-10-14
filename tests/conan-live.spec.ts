import { describe, it, expect, afterAll } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { buildCodebaseDeps } from '../src/index.ts'
import { createCodebase, testCodebase, deleteCodebase } from '../src/codebases.ts'
import type { CodebaseEntry } from '../src/domain/index.ts'

async function isConanReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn('ssh', ['-o', 'ConnectTimeout=2', '-o', 'BatchMode=yes', 'conan', 'true'])
      p.on('close', (code) => resolve(code === 0))
      p.on('error', () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}

describe('Live Conan Integration Verification', () => {
  let tempDir: string | undefined
  let metaPath: string
  let createdEntry: CodebaseEntry | undefined
  let deps: ReturnType<typeof buildCodebaseDeps>

  afterAll(async () => {
    if (createdEntry && deps) {
      try {
        await deleteCodebase(deps, metaPath, createdEntry)
      } catch (e) {
        console.warn('Cleanup failed:', e)
      }
      // Ensure resident daemon on conan is kept alive for workspace two
      try {
        const restartProc = deps.sshRunner([
          'conan',
          'export',
          'PATH=$HOME/.local/bin:$PATH',
          '&&',
          'vectr',
          'start',
          '/home/edogawaconan/Code/Work/vnm_gui',
          '--host',
          '127.0.0.1',
        ])
        await restartProc.promise.catch(() => {})
      } catch {
        // best effort
      }
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('adds /home/edogawaconan/Code/Work/vnm_gui on conan to workspace /home/csy/Work/two, establishes tunnel, passes testCodebase, and responds on localPort', async () => {
    if (!(await isConanReachable())) {
      console.warn('Skipping conan live integration test: conan host unreachable')
      return
    }

    tempDir = await mkdtemp(join(tmpdir(), 'vectr-conan-live-'))
    metaPath = join(tempDir, 'codebases.json')
    const secretsPath = join(tempDir, 'secrets.json')

    deps = buildCodebaseDeps({ get: () => undefined } as never, secretsPath, {
      warn: (msg: string) => console.warn(msg),
    })

    const entry = await createCodebase(deps, metaPath, {
      slug: 'live-vnm-gui',
      type: 'remote',
      host: 'conan',
      path: '/home/edogawaconan/Code/Work/vnm_gui/',
      workspace: '/home/csy/Work/two/',
    })
    createdEntry = entry

    // 1. Verify path normalization
    expect(entry.path).toBe('/home/edogawaconan/Code/Work/vnm_gui')
    expect(entry.workspace).toBe('/home/csy/Work/two')
    expect(entry.host).toBe('conan')
    expect(entry.status).toBe('up')

    // 2. Verify remote port was resolved from remote instances.json
    expect(entry.remotePort).toBe(8767)

    // 3. Verify local port allocation
    expect(entry.localPort).toBeGreaterThanOrEqual(8900)
    expect(entry.localPort).toBeLessThanOrEqual(8999)

    // 4. Verify tunnel control socket and process PID
    expect(entry.tunnelCtl).toBeDefined()
    if (entry.tunnelPid !== undefined) {
      expect(entry.tunnelPid).toBeGreaterThan(0)
    }

    // 5. Verify testCodebase probe passes
    const testResult = await testCodebase(entry)
    expect(testResult.ok).toBe(true)

    // 6. Verify direct HTTP response on localPort
    const response = await fetch(`http://127.0.0.1:${entry.localPort}/v1/status`)
    expect(response.status).toBe(200)
    const statusData = (await response.json()) as { workspace_root?: string; fully_ready?: boolean }
    expect(statusData.workspace_root).toBe('/home/edogawaconan/Code/Work/vnm_gui')
    expect(statusData.fully_ready).toBe(true)
  }, 30000)
})
