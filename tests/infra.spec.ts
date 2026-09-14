/**
 * Unit tests for Layer 2: Infrastructure.
 *
 * Tests CLI runner (with path resolution & mock spawning) and API client (with mock HTTP).
 */

import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CLI_NAME,
  resolveCliExecutable,
  VectrApiClient,
  VectrCliRunner,
} from '../src/infra'

describe('Infrastructure Layer', () => {
  describe('VectrCliRunner', () => {
    it('resolves CLI executable via priority order', () => {
      // 1. Explicit config
      expect(resolveCliExecutable('/custom/bin/vectr')).toBe('/custom/bin/vectr')

      // 2. Env variable
      const origEnv = process.env.VECTR_CLI_PATH
      try {
        process.env.VECTR_CLI_PATH = '/env/bin/vectr'
        expect(resolveCliExecutable()).toBe('/env/bin/vectr')
      } finally {
        if (origEnv === undefined) delete process.env.VECTR_CLI_PATH
        else process.env.VECTR_CLI_PATH = origEnv
      }

      // 3. Fallback
      expect(resolveCliExecutable()).toBe(DEFAULT_CLI_NAME)
    })

    it('rejects invalid workspace without spawning', async () => {
      const runner = new VectrCliRunner()
      const res = await runner.init({ workspace: '' })
      expect(res.ok).toBe(false)
      expect(res.error).toBeDefined()
    })

    it('executes init with hooks and memory-only options', async () => {
      let capturedCmd = ''
      let capturedArgs: string[] = []

      const mockSpawn = (cmd: string, args: string[]) => {
        capturedCmd = cmd
        capturedArgs = args
        const child = new EventEmitter() as unknown as ChildProcess
        const stdout = new EventEmitter()
        const stderr = new EventEmitter()
        ;(child as any).stdout = stdout
        ;(child as any).stderr = stderr
        ;(child as any).kill = vi.fn()

        setTimeout(() => {
          stdout.emit('data', 'Workspace configured: /tmp/test-ws\n')
          child.emit('close', 0, null)
        }, 10)
        return child
      }

      const runner = new VectrCliRunner({
        cliPath: 'vectr',
        spawnFn: mockSpawn as any,
      })

      const res = await runner.init({
        workspace: '/tmp/test-ws',
        hooks: true,
        memoryOnly: true,
      })

      expect(res.ok).toBe(true)
      expect(res.stdout).toContain('Workspace configured')
      expect(capturedCmd).toBe('vectr')
      expect(capturedArgs).toEqual(['init', '--path', '/tmp/test-ws', '--hooks', '--style', 'memory-only'])
    })

    it('executes restart with --full option', async () => {
      let capturedCmd = ''
      let capturedArgs: string[] = []

      const mockSpawn = (cmd: string, args: string[]) => {
        capturedCmd = cmd
        capturedArgs = args
        const child = new EventEmitter() as unknown as ChildProcess
        const stdout = new EventEmitter()
        const stderr = new EventEmitter()
        ;(child as any).stdout = stdout
        ;(child as any).stderr = stderr
        ;(child as any).kill = vi.fn()

        setTimeout(() => {
          stdout.emit('data', 'Restarting daemon in full mode: /tmp/test-ws\n')
          child.emit('close', 0, null)
        }, 10)
        return child
      }

      const runner = new VectrCliRunner({ spawnFn: mockSpawn as any })
      const res = await runner.restart('/tmp/test-ws', { full: true })

      expect(res.ok).toBe(true)
      expect(res.stdout).toContain('Restarting daemon in full mode')
      expect(capturedCmd).toBe('vectr')
      expect(capturedArgs).toEqual(['restart', '/tmp/test-ws', '--full'])
    })

    it('handles CLI execution errors gracefully', async () => {
      const mockSpawn = () => {
        const child = new EventEmitter() as unknown as ChildProcess
        const stdout = new EventEmitter()
        const stderr = new EventEmitter()
        ;(child as any).stdout = stdout
        ;(child as any).stderr = stderr
        ;(child as any).kill = vi.fn()

        setTimeout(() => {
          stderr.emit('data', 'Error: invalid exclude pattern\n')
          child.emit('close', 1, null)
        }, 10)
        return child
      }

      const runner = new VectrCliRunner({ spawnFn: mockSpawn as any })
      const res = await runner.init({ workspace: '/tmp/ws' })

      expect(res.ok).toBe(false)
      expect(res.error).toContain('Error: invalid exclude pattern')
    })

    it('honors process.env.VECTR_CLI_TIMEOUT_MS fallback', () => {
      const orig = process.env.VECTR_CLI_TIMEOUT_MS
      try {
        process.env.VECTR_CLI_TIMEOUT_MS = '42000'
        const runner = new VectrCliRunner()
        expect((runner as any).defaultTimeoutMs).toBe(42_000)
      } finally {
        if (orig === undefined) delete process.env.VECTR_CLI_TIMEOUT_MS
        else process.env.VECTR_CLI_TIMEOUT_MS = orig
      }
    })

    it('kills process on timeout with SIGTERM and escalates to SIGKILL after delay', async () => {
      vi.useFakeTimers()
      const killCalls: string[] = []
      const child = new EventEmitter() as unknown as ChildProcess
      ;(child as any).stdout = new EventEmitter()
      ;(child as any).stderr = new EventEmitter()
      ;(child as any).exitCode = null
      ;(child as any).signalCode = null
      ;(child as any).kill = vi.fn((sig: string) => {
        killCalls.push(sig)
      })

      const mockSpawn = () => child
      const runner = new VectrCliRunner({
        spawnFn: mockSpawn as any,
        timeoutMs: 100,
      })

      const initPromise = runner.init({ workspace: '/tmp/timeout-ws' })

      // Advance past the 100ms command timeout
      await vi.advanceTimersByTimeAsync(100)
      expect(killCalls).toEqual(['SIGTERM'])

      // Advance past 1500ms escalation delay
      await vi.advanceTimersByTimeAsync(1500)
      expect(killCalls).toEqual(['SIGTERM', 'SIGKILL'])

      const res = await initPromise
      expect(res.ok).toBe(false)
      expect(res.error).toContain('timed out after 100ms')
      vi.useRealTimers()
    })
  })

  describe('VectrApiClient', () => {
    it('queries recall and parses response', async () => {
      const mockFetch: typeof fetch = vi.fn(async (url: any) => {
        if (String(url).endsWith('/v1/recall')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ notes: '# Note 1\nSome finding', processing_ms: 15 }),
          } as any
        }
        return { ok: false, status: 404 } as any
      })

      const client = new VectrApiClient({ fetchFn: mockFetch })
      const res = await client.recall('127.0.0.1', 8767, { query: 'test' }, 1000)

      expect(res.ok).toBe(true)
      expect(res.notes).toContain('# Note 1')
      expect(res.processing_ms).toBe(15)
    })

    it('queries resume and parses response', async () => {
      const mockFetch: typeof fetch = vi.fn(async (url: any) => {
        if (String(url).endsWith('/v1/resume')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              last_task: { title: 'Implement feature' },
              gotchas: [],
              formatted: 'Resume state ready',
              processing_ms: 10,
            }),
          } as any
        }
        return { ok: false, status: 404 } as any
      })

      const client = new VectrApiClient({ fetchFn: mockFetch })
      const res = await client.resume('127.0.0.1', 8767, 1000)

      expect(res.ok).toBe(true)
      expect(res.data?.last_task?.title).toBe('Implement feature')
      expect(res.data?.formatted).toBe('Resume state ready')
    })

    it('handles triggerIndex 503 as reindex in progress', async () => {
      const mockFetch: typeof fetch = vi.fn(async () => {
        return {
          ok: false,
          status: 503,
          text: async () => 'reindex already in progress',
        } as any
      })

      const client = new VectrApiClient({ fetchFn: mockFetch })
      const res = await client.triggerIndex('127.0.0.1', 8767, 1000)

      expect(res.ok).toBe(false)
      expect(res.status).toBe(503)
      expect(res.error).toContain('reindex already in progress')
    })
  })
})
