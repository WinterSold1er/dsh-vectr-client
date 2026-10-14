import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { deriveSlugFromPath } from '../src/client/CodebaseModal'
import { normalizePath, SLUG_PATTERN, isReservedPrimarySlug } from '../src/domain'

describe('remote-codebase-ui-fixes (task-2)', () => {
  describe('deriveSlugFromPath', () => {
    it('extracts basename from a local path', () => {
      expect(deriveSlugFromPath('/home/edogawaconan/Code/Work/vnm_gui')).toBe('vnm_gui')
    })

    it('handles trailing slashes properly', () => {
      expect(deriveSlugFromPath('/home/edogawaconan/Code/Work/vnm_gui/')).toBe('vnm_gui')
      expect(deriveSlugFromPath('/home/edogawaconan/Code/Work/vnm_gui///')).toBe('vnm_gui')
    })

    it('extracts basename from a remote path', () => {
      expect(deriveSlugFromPath('/opt/services/auth-api')).toBe('auth-api')
      expect(deriveSlugFromPath('/var/www/my_backend_v2/')).toBe('my_backend_v2')
    })

    it('sanitizes spaces, dots, and disallowed characters to hyphens', () => {
      expect(deriveSlugFromPath('/home/user/my project')).toBe('my-project')
      expect(deriveSlugFromPath('/home/user/my.project.app')).toBe('my-project-app')
      expect(deriveSlugFromPath('/home/user/special@#$chars')).toBe('special-chars')
    })

    it('strips leading and trailing hyphens from basename', () => {
      expect(deriveSlugFromPath('/home/user/---project---')).toBe('project')
      expect(deriveSlugFromPath('/home/user/.git')).toBe('git')
    })

    it('avoids reserved primary slug collision', () => {
      const derivedPrimary = deriveSlugFromPath('/home/user/primary')
      expect(isReservedPrimarySlug(derivedPrimary)).toBe(false)
      expect(derivedPrimary).toBe('cb-primary')

      const derivedPrimaryApp = deriveSlugFromPath('/home/user/primary-app')
      expect(isReservedPrimarySlug(derivedPrimaryApp)).toBe(false)
      expect(derivedPrimaryApp).toBe('cb-primary-app')
    })

    it('truncates slugs exceeding 32 characters to fit SLUG_PATTERN', () => {
      const longPath = '/home/user/a-very-long-project-name-that-is-way-more-than-thirty-two-chars'
      const slug = deriveSlugFromPath(longPath)
      expect(slug.length).toBeLessThanOrEqual(32)
      expect(SLUG_PATTERN.test(slug)).toBe(true)
    })

    it('returns empty string for empty, root, or whitespace paths', () => {
      expect(deriveSlugFromPath('')).toBe('')
      expect(deriveSlugFromPath('/')).toBe('')
      expect(deriveSlugFromPath('   ')).toBe('')
    })

    it('all non-empty derived slugs match SLUG_PATTERN', () => {
      const samplePaths = [
        '/home/user/project',
        '/a/b/c/d/my-service_1',
        '/var/data/foo.bar',
        'relative/path/to/repo/',
        'C:\\Users\\admin\\repo',
      ]
      for (const p of samplePaths) {
        const slug = deriveSlugFromPath(p)
        expect(slug.length).toBeGreaterThan(0)
        expect(SLUG_PATTERN.test(slug)).toBe(true)
      }
    })
  })

  describe('src/client/CodebaseModal.tsx source checks', () => {
    const modalSrc = readFileSync(new URL('../src/client/CodebaseModal.tsx', import.meta.url), 'utf8')

    it('normalizes path and remotePath using normalizePath on submission', () => {
      expect(modalSrc).toMatch(/const\s+normalizedPath\s*=\s*normalizePath\(path\)/)
      expect(modalSrc).toMatch(/payload\.path\s*=\s*normalizedPath/)
      expect(modalSrc).toMatch(/const\s+normalizedRemotePath\s*=\s*normalizePath\(remotePath\)/)
      expect(modalSrc).toMatch(/payload\.remotePath\s*=\s*normalizedRemotePath/)
      expect(modalSrc).toMatch(/payload\.path\s*=\s*normalizedRemotePath/)
    })

    it('uses "自动检测 (留空即可)" as placeholder for remotePort', () => {
      expect(modalSrc).toContain('placeholder="自动检测 (留空即可)"')
      expect(modalSrc).not.toContain('placeholder="8765"')
    })

    it('auto-derives slug when path or remotePath changes', () => {
      expect(modalSrc).toContain('deriveSlugFromPath(val)')
      expect(modalSrc).toContain('handlePathChange')
      expect(modalSrc).toContain('handleRemotePathChange')
    })
  })

  describe('src/client/index.tsx CodebaseCreateForm source checks', () => {
    const clientSrc = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')

    it('resets path to empty string when switching type to remote', () => {
      expect(clientSrc).toMatch(/nextType\s*===\s*'remote'[\s\S]*?setPath\(''\)/)
    })

    it('normalizes path (trimming whitespace and trailing slashes) on submit', () => {
      expect(clientSrc).toMatch(/const\s+normalizedPath\s*=\s*normalizePath\(path\)/)
      expect(clientSrc).toMatch(/path:\s*normalizedPath/)
    })

    it('displays remote placeholder when type is remote', () => {
      expect(clientSrc).toContain("placeholder={type === 'remote' ? '/remote/path/to/codebase' : '/abs/path'}")
    })
  })
})
