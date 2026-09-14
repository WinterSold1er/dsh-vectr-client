/**
 * Verification test suite for Adversarial Reviewer Round 3 Defect Fixes:
 *
 * 1. Issue 1 (Frontend-Backend integration): Frontend `test(slug, ws)` propagates
 *    `workspace` as query parameter (`?workspace=...`), avoiding 400 Ambiguous in multi-workspace environments.
 * 2. Issue 2 (Underlying defense penetration): `deleteCodebase` uses `isSystemPrimarySlug`
 *    to block deletion of 12-char hex system primary slugs (`primary-${wsKey}`).
 * 3. Issue 3 (Timeout hardcoding): Primary liveness probe uses configurable `daemonHttpTimeoutMs`
 *    or exported `DEFAULT_HTTP_TIMEOUT_MS` instead of raw 3000ms.
 * 4. Issue 4 (Single source of truth): Primary Slug and Reserved Prefix determinations unified in
 *    `src/domain/rules.ts`, eliminating divergent regexes across codebase layers.
 */

import { describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  isReservedPrimarySlug,
  isSystemPrimarySlug,
  PRIMARY_RESERVED_PREFIX_PATTERN,
  SYSTEM_PRIMARY_SLUG_PATTERN,
  type CodebaseEntry,
} from '../src/domain'
import { deleteCodebase, createCodebase, saveCodebases, CodebaseError } from '../src/codebases'
import { registerCodebaseRoutes, DEFAULT_HTTP_TIMEOUT_MS } from '../src/index'
import { WORKSPACE_KEY_LENGTH } from '../src/registry'

describe('Adversarial Review Round 3 Fixes', () => {
  describe('Issue 1: 前后端脱节 - test 函数传递 workspace 消除 400 Ambiguous', () => {
    it('verifies src/client/index.tsx passes workspace to test and appends query parameter', () => {
      const clientSrc = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

      // 1. CodebaseSubRow calls onTest with view.slug and view.workspace
      expect(clientSrc).toMatch(/onTest\(\s*view\.slug\s*,\s*view\.workspace\s*\)/)

      // 2. CodebaseSubRow props accept workspace parameter
      expect(clientSrc).toMatch(/onTest:\s*\(slug:\s*string,\s*workspace\?:?\s*string\)\s*=>\s*void/)

      // 3. test function formats ?workspace query
      expect(clientSrc).toMatch(/const\s+wsParam\s*=\s*ws\s*\?\s*`\?workspace=\$\{encodeURIComponent\(ws\)\}`\s*:\s*''/)
      expect(clientSrc).toMatch(/run\(slug,\s*'POST',\s*`\/test\$\{wsParam\}`,\s*`tested\s+\$\{slug\}`\)/)
    })

    it('proves multi-workspace POST /test fails with 400 without ?workspace but succeeds with ?workspace', async () => {
      const metaPath = `/tmp/meta-r3-issue1-${Date.now()}.json`
      const instPath = `/tmp/inst-r3-issue1-${Date.now()}.json`

      const ws1 = '/workspace/project-alpha'
      const ws2 = '/workspace/project-beta'

      // Set up isolated mock daemon for ws1
      let ws1ProbeHits = 0
      const mockDaemonServer = createServer((req, res) => {
        if (req.url === '/v1/status') {
          ws1ProbeHits++
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, mode: 'full', indexed_files: 42 }))
          return
        }
        res.writeHead(404)
        res.end()
      })

      const port = await new Promise<number>((resolve) => {
        mockDaemonServer.listen(0, '127.0.0.1', () => {
          const addr = mockDaemonServer.address()
          resolve(typeof addr === 'object' && addr ? addr.port : 0)
        })
      })

      const instances = {
        [createHash('sha256').update(ws1).digest('hex')]: {
          workspace: ws1,
          port,
          host: '127.0.0.1',
          mode: 'full',
          live: true,
        },
        [createHash('sha256').update(ws2).digest('hex')]: {
          workspace: ws2,
          port: 9999,
          host: '127.0.0.1',
          mode: 'full',
          live: false,
        },
      }

      saveCodebases(metaPath, [
        {
          id: 'cb1',
          slug: 'cb1',
          type: 'local',
          path: '/path/cb1',
          workspace: ws1,
          serverName: 'cb1',
          status: 'up',
        },
        {
          id: 'cb2',
          slug: 'cb2',
          type: 'local',
          path: '/path/cb2',
          workspace: ws2,
          serverName: 'cb2',
          status: 'up',
        },
      ])
      writeFileSync(instPath, JSON.stringify(instances, null, 2))

      const registrations: Array<{ kind: string; path: string; handler: (req: any, res: any) => Promise<void> }> = []
      const mockWebServer = {
        register: (r: any) => {
          registrations.push(r)
          return () => {}
        },
      }
      const mockCtx = {
        get: (key: string) => (key === 'webServer' ? mockWebServer : undefined),
        effect: (fn: any) => fn(),
        logger: { warn() {}, info() {}, error() {} },
      } as unknown as Context

      registerCodebaseRoutes(mockCtx, metaPath, '/tmp/mock-secrets.json', instPath)
      const prefixHandler = registrations.find((r) => r.kind === 'prefix')!

      try {
        // Without ?workspace= in multi-workspace setting -> 400 Ambiguous
        let resCode1 = 0
        let resBody1 = ''
        await prefixHandler.handler(
          { method: 'POST', url: 'http://localhost/api/vectr/codebases/primary/test' },
          {
            writeHead: (c: number) => { resCode1 = c },
            end: (b: string) => { resBody1 = b },
          },
        )
        expect(resCode1).toBe(400)
        expect(JSON.parse(resBody1).error).toContain('Ambiguous primary codebase: please specify ?workspace=')

        // With ?workspace= parameter as provided by the frontend fix -> 200 OK
        let resCode2 = 0
        let resBody2 = ''
        await prefixHandler.handler(
          { method: 'POST', url: `http://localhost/api/vectr/codebases/primary/test?workspace=${encodeURIComponent(ws1)}` },
          {
            writeHead: (c: number) => { resCode2 = c },
            end: (b: string) => { resBody2 = b },
          },
        )
        expect(resCode2).toBe(200)
        expect(JSON.parse(resBody2).ok).toBe(true)
        expect(ws1ProbeHits).toBe(1)
      } finally {
        mockDaemonServer.close()
        try { unlinkSync(metaPath) } catch {}
        try { unlinkSync(instPath) } catch {}
      }
    })
  })

  describe('Issue 2: 底层防护击穿 - deleteCodebase 应用 isSystemPrimarySlug 防护 12 位 Primary slug', () => {
    it('blocks deletion of 12-char hex system primary slug in deleteCodebase', async () => {
      const testWs = '/data/test-workspace-r3'
      const wsKey = createHash('sha256').update(testWs).digest('hex').slice(0, WORKSPACE_KEY_LENGTH)
      expect(wsKey.length).toBe(12)

      const mockDeps: any = {
        spawnRunner: vi.fn(),
        sshRunner: vi.fn(),
        credentialStore: { get: vi.fn(), set: vi.fn(), unset: vi.fn() },
      }

      // 1. 12-char hex system primary slug: primary-xxxxxxxxxxxx
      const systemPrimaryEntry: CodebaseEntry = {
        id: `primary:${testWs}`,
        slug: `primary-${wsKey}`,
        type: 'local',
        path: '/some/unrelated/path', // path does not equal workspace
        workspace: '/another/ws',
        serverName: `primary_${wsKey}`,
        status: 'up',
        isPrimary: false, // even if flag is missing, slug protection must hold
      }

      await expect(
        deleteCodebase(mockDeps, '/tmp/meta-r3.json', systemPrimaryEntry),
      ).rejects.toThrow(CodebaseError)

      await expect(
        deleteCodebase(mockDeps, '/tmp/meta-r3.json', systemPrimaryEntry),
      ).rejects.toThrow(/Cannot delete primary codebase of the workspace/)

      // 2. Legacy 8-char hex system primary slug: primary-1234abcd
      const legacyPrimaryEntry: CodebaseEntry = {
        id: 'primary:legacy',
        slug: 'primary-1234abcd',
        type: 'local',
        path: '/some/path',
        workspace: '/some/ws',
        serverName: 'primary_legacy',
        status: 'up',
      }

      await expect(
        deleteCodebase(mockDeps, '/tmp/meta-r3.json', legacyPrimaryEntry),
      ).rejects.toThrow(/Cannot delete primary codebase of the workspace/)

      // 3. Exact 'primary' slug
      const exactPrimaryEntry: CodebaseEntry = {
        id: 'primary:exact',
        slug: 'primary',
        type: 'local',
        path: '/some/path',
        workspace: '/some/ws',
        serverName: 'primary_exact',
        status: 'up',
      }

      await expect(
        deleteCodebase(mockDeps, '/tmp/meta-r3.json', exactPrimaryEntry),
      ).rejects.toThrow(/Cannot delete primary codebase of the workspace/)

      // 4. Non-system custom slug is NOT blocked by primary defense
      const customEntry: CodebaseEntry = {
        id: 'custom:entry',
        slug: 'custom-entry',
        type: 'local',
        path: '/some/path',
        workspace: '/some/ws',
        serverName: 'custom_entry',
        status: 'up',
        localPort: 8888,
      }
      mockDeps.spawnRunner.mockReturnValue({
        promise: Promise.resolve({ code: 0 }),
      })
      const tmpMeta = `/tmp/meta-del-${Date.now()}.json`
      saveCodebases(tmpMeta, [customEntry])
      try {
        await expect(deleteCodebase(mockDeps, tmpMeta, customEntry)).resolves.toBeUndefined()
      } finally {
        try { unlinkSync(tmpMeta) } catch {}
      }
    })
  })

  describe('Issue 3: 超时硬编码 - Primary 探活超时使用配置值与系统常量', () => {
    it('exports DEFAULT_HTTP_TIMEOUT_MS matching DEFAULT_DAEMON_HTTP_TIMEOUT_MS (5000ms)', () => {
      expect(DEFAULT_HTTP_TIMEOUT_MS).toBe(5000)
    })

    it('respects config.daemonHttpTimeoutMs when probing Primary daemon and aborts on timeout', async () => {
      // Create a hung server that does not respond to /v1/status
      const hungServer = createServer((_req, _res) => {
        // intentionally hang
      })

      const hungPort = await new Promise<number>((resolve) => {
        hungServer.listen(0, '127.0.0.1', () => {
          const addr = hungServer.address()
          resolve(typeof addr === 'object' && addr ? addr.port : 0)
        })
      })

      const ws = '/workspace/hung-test'
      const instKey = createHash('sha256').update(ws).digest('hex')
      const metaPath = `/tmp/meta-r3-timeout-${Date.now()}.json`
      const instPath = `/tmp/inst-r3-timeout-${Date.now()}.json`

      saveCodebases(metaPath, [])
      writeFileSync(
        instPath,
        JSON.stringify({
          [instKey]: {
            workspace: ws,
            port: hungPort,
            host: '127.0.0.1',
            mode: 'full',
            live: true,
          },
        }),
      )

      const registrations: Array<{ kind: string; path: string; handler: (req: any, res: any) => Promise<void> }> = []
      const mockWebServer = {
        register: (r: any) => {
          registrations.push(r)
          return () => {}
        },
      }
      const mockCtx = {
        get: (key: string) => (key === 'webServer' ? mockWebServer : undefined),
        effect: (fn: any) => fn(),
        logger: { warn() {}, info() {}, error() {} },
      } as unknown as Context

      // Pass a custom short timeout: 80ms
      const customTimeoutMs = 80
      registerCodebaseRoutes(mockCtx, metaPath, '/tmp/mock-secrets.json', instPath, {
        daemonHttpTimeoutMs: customTimeoutMs,
      })
      const prefixHandler = registrations.find((r) => r.kind === 'prefix')!

      const startTime = Date.now()
      let resCode = 0
      let resBody = ''
      await prefixHandler.handler(
        { method: 'POST', url: `http://localhost/api/vectr/codebases/primary/test?workspace=${encodeURIComponent(ws)}` },
        {
          writeHead: (c: number) => { resCode = c },
          end: (b: string) => { resBody = b },
        },
      )
      const elapsed = Date.now() - startTime

      try {
        expect(resCode).toBe(503)
        expect(JSON.parse(resBody).error).toMatch(/Primary daemon probe failed/)
        // Proves it used the configured 80ms timeout and did NOT wait 3000ms or 5000ms
        expect(elapsed).toBeLessThan(1500)
      } finally {
        hungServer.close()
        try { unlinkSync(metaPath) } catch {}
        try { unlinkSync(instPath) } catch {}
      }
    })
  })

  describe('Issue 4: 单一真相源 - 统一 Primary Slug 判定与保留前缀判定', () => {
    it('exports single source of truth regex patterns and helper functions from domain', () => {
      expect(PRIMARY_RESERVED_PREFIX_PATTERN).toBeInstanceOf(RegExp)
      expect(SYSTEM_PRIMARY_SLUG_PATTERN).toBeInstanceOf(RegExp)
      expect(typeof isReservedPrimarySlug).toBe('function')
      expect(typeof isSystemPrimarySlug).toBe('function')
    })

    it('accurately distinguishes reserved primary prefixes from system primary slugs', () => {
      // Reserved primary slugs: users cannot create codebases with these slugs
      expect(isReservedPrimarySlug('primary')).toBe(true)
      expect(isReservedPrimarySlug('PRIMARY')).toBe(true)
      expect(isReservedPrimarySlug('  Primary  ')).toBe(true)
      expect(isReservedPrimarySlug('primary-')).toBe(true)
      expect(isReservedPrimarySlug('primary-subproject')).toBe(true)
      expect(isReservedPrimarySlug('PRIMARY-anything-at-all')).toBe(true)
      expect(isReservedPrimarySlug('not-primary')).toBe(false)
      expect(isReservedPrimarySlug('my-repo')).toBe(false)
      expect(isReservedPrimarySlug('')).toBe(false)
      expect(isReservedPrimarySlug(undefined)).toBe(false)
      expect(isReservedPrimarySlug(null)).toBe(false)

      // System primary slugs: generated by the system for workspace primary instances
      expect(isSystemPrimarySlug('primary')).toBe(true)
      expect(isSystemPrimarySlug('PRIMARY')).toBe(true)
      expect(isSystemPrimarySlug('primary-1234abcd')).toBe(true) // 8-char hex
      expect(isSystemPrimarySlug('primary-123456abcdef')).toBe(true) // 12-char hex (WORKSPACE_KEY_LENGTH)
      expect(isSystemPrimarySlug('primary-0123456789abcdef')).toBe(true) // 16-char hex
      expect(isSystemPrimarySlug('primary-subproject')).toBe(false) // arbitrary string is NOT system primary
      expect(isSystemPrimarySlug('primary-123')).toBe(false) // too short hex
      expect(isSystemPrimarySlug('not-primary')).toBe(false)
      expect(isSystemPrimarySlug('')).toBe(false)
      expect(isSystemPrimarySlug(undefined)).toBe(false)
      expect(isSystemPrimarySlug(null)).toBe(false)
    })

    it('verifies createCodebase rejects reserved slugs using isReservedPrimarySlug', async () => {
      const mockDeps: any = {
        spawnRunner: vi.fn(),
        sshRunner: vi.fn(),
        credentialStore: { get: vi.fn(), set: vi.fn(), unset: vi.fn() },
      }

      await expect(
        createCodebase(mockDeps, '/tmp/meta-r3.json', {
          type: 'local',
          slug: 'primary-subproject',
          path: '/tmp/repo',
          workspace: '/tmp/ws',
        }),
      ).rejects.toThrow(/Slug "primary" is reserved for the primary codebase/)
    })

    it('verifies CodebaseModal and client index use isReservedPrimarySlug instead of hardcoded inline regex', () => {
      const modalSrc = readFileSync(new URL('../src/client/CodebaseModal.tsx', import.meta.url), 'utf8')
      const clientSrc = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

      expect(modalSrc).toMatch(/import\s*\{[^}]*isReservedPrimarySlug[^}]*\}\s*from\s*'\.\.\/domain'/)
      expect(modalSrc).toMatch(/if\s*\(isReservedPrimarySlug\(slug\)\)/)
      expect(modalSrc).not.toMatch(/\/\^primary\(-.*\)?[^/]*\/i\.test/)

      expect(clientSrc).toMatch(/import\s*\{[^}]*isReservedPrimarySlug[^}]*\}\s*from\s*'\.\.\/domain'/)
      expect(clientSrc).toMatch(/if\s*\(isReservedPrimarySlug\(slug\)\)/)
      expect(clientSrc).not.toMatch(/\/\^primary\(-.*\)?[^/]*\/i\.test/)
    })
  })
})
