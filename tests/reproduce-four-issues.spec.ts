/**
 * TDD RED Specification: Reproduction tests for the 4 identified issues.
 *
 * Issue 1: vectr status mismatch dialog vs settings (unified status, formatMode, path normalization)
 * Issue 2: dialog theme not following DSH theme (illegal --dsw-alias-bg-layer-0, hardcoded #fff whiteout)
 * Issue 3: new chat page missing dialog trigger button (conversation.input.right registration & dialog root)
 * Issue 4: settings panel vectr item icon needs replacement (icon property on settings.section)
 */

import { describe, expect, it } from 'vitest'
import * as domain from '../src/domain'
import { resolveInstance } from '../src/registry'
import { VECTR_CSS } from '../src/client/buttons'
import { apply } from '../src/client/index'

describe('Issue 1: Vectr Status Mismatch Dialog vs Settings', () => {
  it('formatMode should normalize hyphenated "memory-only" to "memory_only"', () => {
    // Vectr CLI writes "memory-only" in instances.json
    // In a4efca6, formatMode('memory-only', true) returns 'unknown'
    const mode = domain.formatMode('memory-only', true)
    expect(mode).toBe('memory_only')
  })

  it('resolveUnifiedStatus must exist and resolve status correctly for initializing / indexing / memory-only / offline', () => {
    // In a4efca6, resolveUnifiedStatus does NOT exist
    const anyDomain = domain as Record<string, any>
    expect(typeof anyDomain.resolveUnifiedStatus).toBe('function')

    // 1. Initializing (fully_ready is false)
    const initStatus = anyDomain.resolveUnifiedStatus({
      live: true,
      mode: 'full',
      status: { fully_ready: false, reindex_in_progress: false },
    })
    expect(initStatus.kind).toBe('initializing')
    expect(initStatus.label).toBe('Initializing')
    expect(initStatus.isBusy).toBe(true)

    // 2. Indexing (reindex_in_progress is true)
    const indexingStatus = anyDomain.resolveUnifiedStatus({
      live: true,
      mode: 'full',
      status: { fully_ready: true, reindex_in_progress: true },
    })
    expect(indexingStatus.kind).toBe('indexing')
    expect(indexingStatus.label).toBe('Indexing')
    expect(indexingStatus.isBusy).toBe(true)

    // 3. Memory Only
    const memStatus = anyDomain.resolveUnifiedStatus({
      live: true,
      mode: 'memory-only',
      status: { fully_ready: true, reindex_in_progress: false },
    })
    expect(memStatus.kind).toBe('memory_only')
    expect(memStatus.label).toBe('Memory Only')

    // 4. Offline
    const offStatus = anyDomain.resolveUnifiedStatus({
      live: false,
      reason: 'daemon_unresponsive',
    })
    expect(offStatus.kind).toBe('offline')
    expect(offStatus.label).toBe('Offline')
  })

  it('resolveInstance must resolve workspace paths with trailing slash and subdirectories', () => {
    const instances: domain.InstancesFile = {
      b5b2266ddc64: {
        workspace: '/home/csy/Work/two',
        port: 8767,
        pid: 12345,
      },
    }

    // Trailing slash
    const withSlash = resolveInstance(instances, '/home/csy/Work/two/')
    expect(withSlash).toBeDefined()
    expect(withSlash?.port).toBe(8767)

    // Subdirectory inside workspace
    const subDir = resolveInstance(instances, '/home/csy/Work/two/src/components')
    expect(subDir).toBeDefined()
    expect(subDir?.port).toBe(8767)

    // Redundant consecutive slashes and dot segments
    const redundant = resolveInstance(instances, '/home/csy/Work/two/./src')
    expect(redundant).toBeDefined()
    expect(redundant?.port).toBe(8767)
  })
})

describe('Issue 2: Dialog Theme Not Following DSH Theme', () => {
  it('VECTR_CSS must NOT contain illegal token --dsw-alias-bg-layer-0', () => {
    // In a4efca6, buttons.tsx writes var(--dsw-alias-bg-layer-0, #fff)
    expect(VECTR_CSS).not.toContain('--dsw-alias-bg-layer-0')
  })

  it('VECTR_CSS modal card background must use --dsw-alias-bg-base and have NO hardcoded #fff fallback', () => {
    // In a4efca6, buttons.tsx writes:
    // .vectr-modal-card { background: var(--dsw-alias-bg-layer-0, #fff);
    // This causes complete whiteout in dark mode!
    const cardMatch = VECTR_CSS.match(/\.vectr-modal-card\s*\{([^}]+)\}/)
    expect(cardMatch).toBeTruthy()
    const cardBody = cardMatch![1]!

    expect(cardBody).toContain('var(--dsw-alias-bg-base)')
    expect(cardBody).not.toContain('#fff')
  })

  it('VECTR_CSS modal card border must NOT have hardcoded #e5e7eb fallback', () => {
    const cardMatch = VECTR_CSS.match(/\.vectr-modal-card\s*\{([^}]+)\}/)
    expect(cardMatch).toBeTruthy()
    const cardBody = cardMatch![1]!

    expect(cardBody).not.toContain('#e5e7eb')
  })
})

describe('Issue 3: New Chat Page Missing Dialog Trigger Button', () => {
  it('client plugin must register into slot conversation.input.right for new chat page', () => {
    const registrations: Array<{ name: string; id?: string; options?: any }> = []
    const mockCtx: any = {
      slots: {
        inject: (slotName: string, callback: () => void) => {
          callback()
          return () => {}
        },
        register: (options: any) => {
          registrations.push(options)
          return () => {}
        },
      },
      effect: () => {},
    }

    apply(mockCtx)

    const inputRight = registrations.find(r => r.name === 'conversation.input.right')
    // In a4efca6, apply only registers 'settings.section' and 'conversation.session.header.utilities'
    expect(inputRight).toBeDefined()
    expect(inputRight?.id).toBe('vectr-conversation-input-right')
  })

  it('client module must export ConversationInputRightAction and DialogRoot or coordinator', async () => {
    const clientModule = await import('../src/client/index') as Record<string, any>
    expect(clientModule.ConversationInputRightAction).toBeDefined()
    expect(clientModule.dialogCoordinator).toBeDefined()
  })
})

describe('Issue 4: Settings Panel Vectr Item Icon Needs Replacement', () => {
  it('settings.section registration options MUST specify a dedicated icon property', () => {
    const registrations: Array<{ name: string; id?: string; icon?: any }> = []
    const mockCtx: any = {
      slots: {
        inject: (slotName: string, callback: () => void) => {
          callback()
          return () => {}
        },
        register: (options: any) => {
          registrations.push(options)
          return () => {}
        },
      },
      effect: () => {},
    }

    apply(mockCtx)

    const settingsSection = registrations.find(r => r.name === 'settings.section' && r.id === 'vectr')
    expect(settingsSection).toBeDefined()
    // In a4efca6, settingsSection.icon is undefined!
    expect(settingsSection?.icon).toBeDefined()
    expect(typeof settingsSection?.icon).not.toBe('undefined')
  })

  it('client module must export VectrNavIcon component', async () => {
    const clientModule = await import('../src/client/index') as Record<string, any>
    expect(clientModule.VectrNavIcon).toBeDefined()
  })
})
