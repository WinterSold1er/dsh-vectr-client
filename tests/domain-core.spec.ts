/**
 * Unit tests for Layer 1: Domain Core.
 *
 * Tests pure business rules, validation logic, and mode policies without external dependencies.
 */

import { describe, expect, it } from 'vitest'
import {
  canReindex,
  formatMode,
  isMemoryOnly,
  isSearchOnly,
  SLUG_PATTERN,
  validateSlug,
  validateWorkspace,
  resolveUnifiedStatus,
} from '../src/domain'

describe('Domain Core: rules & validation', () => {
  describe('SLUG_PATTERN & validateSlug', () => {
    it('accepts valid slugs', () => {
      expect(SLUG_PATTERN.test('my-codebase')).toBe(true)
      expect(SLUG_PATTERN.test('codebase_123')).toBe(true)
      expect(SLUG_PATTERN.test('A')).toBe(true)
      expect(validateSlug('api-v2').valid).toBe(true)
      expect(validateSlug('backend_service').valid).toBe(true)
    })

    it('rejects invalid slugs', () => {
      expect(validateSlug('').valid).toBe(false)
      expect(validateSlug('my codebase').valid).toBe(false)
      expect(validateSlug('codebase/sub').valid).toBe(false)
      expect(validateSlug('my@project').valid).toBe(false)
      expect(validateSlug('a'.repeat(33)).valid).toBe(false)
    })
  })

  describe('validateWorkspace', () => {
    it('accepts valid workspace directories', () => {
      expect(validateWorkspace('/projects/my-app').valid).toBe(true)
      expect(validateWorkspace('/home/user/code').valid).toBe(true)
      expect(validateWorkspace('C:\\Users\\dev\\project').valid).toBe(true)
      expect(validateWorkspace('D:/code/my-app').valid).toBe(true)
    })

    it('rejects empty or unassigned sentinel workspaces', () => {
      expect(validateWorkspace('').valid).toBe(false)
      expect(validateWorkspace('   ').valid).toBe(false)
      expect(validateWorkspace('__unassigned__').valid).toBe(false)
    })

    it('rejects relative paths', () => {
      const res = validateWorkspace('relative/path')
      expect(res.valid).toBe(false)
      expect(res.error).toContain('absolute')

      const dotRes = validateWorkspace('./local/dir')
      expect(dotRes.valid).toBe(false)
      expect(dotRes.error).toContain('absolute')
    })

    it('rejects paths containing null bytes', () => {
      const res = validateWorkspace('/home/user\0/hack')
      expect(res.valid).toBe(false)
      expect(res.error).toContain('null')
    })
  })

  describe('mode helpers', () => {
    it('identifies memory_only mode', () => {
      expect(isMemoryOnly('memory_only')).toBe(true)
      expect(isMemoryOnly('full')).toBe(false)
      expect(isMemoryOnly(undefined)).toBe(false)
    })

    it('identifies search_only mode', () => {
      expect(isSearchOnly('search_only')).toBe(true)
      expect(isSearchOnly('memory_only')).toBe(false)
    })

    it('formats mode correctly', () => {
      expect(formatMode('full', true)).toBe('full')
      expect(formatMode('memory_only', true)).toBe('memory_only')
      expect(formatMode('search_only', true)).toBe('search_only')
      expect(formatMode('full', false)).toBe('offline')
      expect(formatMode(undefined, true)).toBe('unknown')
    })
  })

  describe('canReindex invariants', () => {
    it('prohibits re-indexing in memory_only mode', () => {
      const res = canReindex(true, 'memory_only', { fully_ready: true })
      expect(res.canReindex).toBe(false)
      expect(res.reason).toContain('memory_only')
    })

    it('prohibits re-indexing in search_only mode', () => {
      const res = canReindex(true, 'search_only', { fully_ready: true })
      expect(res.canReindex).toBe(false)
      expect(res.reason).toContain('search_only')
    })

    it('prohibits re-indexing when daemon is offline', () => {
      const res = canReindex(false, 'full')
      expect(res.canReindex).toBe(false)
      expect(res.reason).toBe('Daemon offline')
    })

    it('prohibits re-indexing when reindex is already in progress', () => {
      const res = canReindex(true, 'full', { reindex_in_progress: true })
      expect(res.canReindex).toBe(false)
      expect(res.reason).toContain('already in progress')
    })

    it('prohibits re-indexing when daemon is not fully ready', () => {
      const res = canReindex(true, 'full', { fully_ready: false })
      expect(res.canReindex).toBe(false)
      expect(res.reason).toContain('not fully_ready')
    })

    it('allows re-indexing when live, full mode, and ready', () => {
      const res = canReindex(true, 'full', { fully_ready: true })
      expect(res.canReindex).toBe(true)
      expect(res.reason).toBeUndefined()
    })
  })

  describe('resolveUnifiedStatus robustness', () => {
    it('returns offline/Error when input.error exists', () => {
      const res = resolveUnifiedStatus({
        live: true,
        status: { fully_ready: true },
        error: 'connection refused',
      })
      expect(res.kind).toBe('offline')
      expect(res.label).toBe('Error')
      expect(res.description).toBe('connection refused')
    })

    it('returns offline/Unknown when !input or input.live is undefined', () => {
      const resNull = resolveUnifiedStatus(undefined)
      expect(resNull.kind).toBe('offline')
      expect(resNull.label).toBe('Unknown')

      const resUndefLive = resolveUnifiedStatus({
        status: { fully_ready: true },
      })
      expect(resUndefLive.kind).toBe('offline')
      expect(resUndefLive.label).toBe('Unknown')
    })

    it('returns offline/Offline when input.live is false', () => {
      const resFalse = resolveUnifiedStatus({
        live: false,
        reason: 'daemon hung',
      })
      expect(resFalse.kind).toBe('offline')
      expect(resFalse.label).toBe('Offline')
      expect(resFalse.description).toBe('daemon hung')
    })

    it('returns initializing when live === true but !input.status', () => {
      const res = resolveUnifiedStatus({
        live: true,
        mode: 'full',
      })
      expect(res.kind).toBe('initializing')
      expect(res.label).toBe('Initializing')
      expect(res.isBusy).toBe(true)
    })
  })
})
