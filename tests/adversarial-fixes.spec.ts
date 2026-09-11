/**
 * Tests verifying adversarial review findings fixes.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index'
import { dialogCoordinator } from '../src/client/dialogCoordinator'
import { resolveUnifiedStatus } from '../src/domain/rules'

describe('Adversarial Review Fixes', () => {
  describe('1. Theme & hardcoded values fixes (Component-wide styling)', () => {
    const componentFiles = [
      'SessionDrawerModal.tsx',
      'MemoryViewer.tsx',
      'CodebaseModal.tsx',
      'buttons.tsx',
      'ConversationInputRightAction.tsx',
      'SessionHeaderAction.tsx',
    ]

    for (const file of componentFiles) {
      it(`${file} must not contain hardcoded hex colors or invalid css tokens`, () => {
        const filePath = join(__dirname, '../src/client', file)
        const content = readFileSync(filePath, 'utf-8')

        // Hex colors check (no #xxx or #xxxxxx)
        expect(content).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
        // Invalid border tokens check
        expect(content).not.toContain('--dsw-alias-border-subtle')
        // Invalid warning tokens check
        expect(content).not.toContain('--dsw-alias-state-warning')
        // Invalid brand tokens check
        expect(content).not.toContain('--dsw-alias-brand-subtle')
        // Invalid success/error tokens check
        expect(content).not.toContain('--dsw-alias-state-success-subtle')
        expect(content).not.toContain('--dsw-alias-state-error-subtle')
      })
    }

    it('SessionDrawerModal.tsx must not contain confirm() or raw rgba()', () => {
      const filePath = join(__dirname, '../src/client/SessionDrawerModal.tsx')
      const content = readFileSync(filePath, 'utf-8')

      expect(content).not.toMatch(/rgba\(/i)
      expect(content).not.toMatch(/confirm\(/)
    })

    it('MemoryViewer.tsx line 268 must use official warn token instead of hardcoded hex', () => {
      const filePath = join(__dirname, '../src/client/MemoryViewer.tsx')
      const content = readFileSync(filePath, 'utf-8')

      expect(content).not.toContain('#f59e0b')
      expect(content).toContain('var(--dsw-alias-state-warn-primary)')
    })

    it('SessionDrawerModal and components align with DSH official CSS tokens', () => {
      const drawerContent = readFileSync(join(__dirname, '../src/client/SessionDrawerModal.tsx'), 'utf-8')

      expect(drawerContent).toContain('var(--dsw-alias-border-l2)')
      expect(drawerContent).toContain('var(--dsw-alias-state-warn-tertiary)')
      expect(drawerContent).toContain('var(--dsw-alias-state-warn-primary)')
      expect(drawerContent).toContain('var(--dsw-alias-state-success-tertiary)')
      expect(drawerContent).toContain('var(--dsw-alias-state-success-primary)')
      expect(drawerContent).toContain('var(--dsw-alias-brand-tertiary)')
      expect(drawerContent).toContain('var(--dsw-alias-brand-primary)')
    })
  })

  describe('2. Status mapping robustness (rules.ts)', () => {
    it('returns offline/Error when input.error exists', () => {
      const status = resolveUnifiedStatus({
        live: true,
        status: { fully_ready: true },
        error: 'Port conflict 8765',
      })
      expect(status.kind).toBe('offline')
      expect(status.label).toBe('Error')
      expect(status.description).toBe('Port conflict 8765')
    })

    it('returns offline/Unknown when input is undefined or live is undefined', () => {
      const s1 = resolveUnifiedStatus(undefined)
      expect(s1.kind).toBe('offline')
      expect(s1.label).toBe('Unknown')

      const s2 = resolveUnifiedStatus({
        status: { fully_ready: true },
      })
      expect(s2.kind).toBe('offline')
      expect(s2.label).toBe('Unknown')
    })

    it('returns offline/Offline when live === false', () => {
      const status = resolveUnifiedStatus({
        live: false,
        reason: 'Daemon not running',
      })
      expect(status.kind).toBe('offline')
      expect(status.label).toBe('Offline')
    })

    it('returns initializing when live === true but !input.status', () => {
      const status = resolveUnifiedStatus({
        live: true,
      })
      expect(status.kind).toBe('initializing')
      expect(status.label).toBe('Initializing')
      expect(status.isBusy).toBe(true)
    })
  })

  describe('3. Architecture, Dialog Singleton & Elimination of Duplicate Requests', () => {
    it('dialogCoordinator.close() clears workspace to undefined', () => {
      dialogCoordinator.open('/some/workspace')
      expect(dialogCoordinator.getState().isOpen).toBe(true)
      expect(dialogCoordinator.getState().workspace).toBe('/some/workspace')

      dialogCoordinator.close()
      expect(dialogCoordinator.getState().isOpen).toBe(false)
      expect(dialogCoordinator.getState().workspace).toBeUndefined()
    })

    it('SessionDrawerModal does not duplicate onRefresh or raw fetch on open', () => {
      const drawerContent = readFileSync(join(__dirname, '../src/client/SessionDrawerModal.tsx'), 'utf-8')

      // Must not call fetch('/api/vectr/session-status') directly inside SessionDrawerModal
      expect(drawerContent).not.toContain('/api/vectr/session-status')
      // Must not call onRefresh inside a useEffect
      expect(drawerContent).not.toMatch(/useEffect\([^)]*onRefresh/s)
    })

    it('all ctx.slots.inject in apply are wrapped in ctx.effect for HMR cleanup', () => {
      const injectedSlots: string[] = []
      const effectDisposers: Array<() => void> = []
      let effectCallCount = 0

      const mockCtx: any = {
        slots: {
          inject: (slotName: string, callback: () => any) => {
            injectedSlots.push(slotName)
            callback()
            return () => {
              const idx = injectedSlots.indexOf(slotName)
              if (idx !== -1) injectedSlots.splice(idx, 1)
            }
          },
          register: () => () => {},
        },
        effect: (fn: any) => {
          effectCallCount++
          if (typeof fn === 'function') {
            const disposer = fn()
            if (typeof disposer === 'function') {
              effectDisposers.push(disposer)
            }
          }
        },
      }

      apply(mockCtx)

      expect(effectCallCount).toBe(4)
      expect(injectedSlots).toEqual([
        'settings.section',
        'conversation.session.header.utilities',
        'conversation.input.right',
        'shell.overlay',
      ])

      // Simulate HMR reload cleanup: executing disposers cleans all slot injections
      for (const dispose of effectDisposers) {
        dispose()
      }
      expect(injectedSlots).toEqual([])
    })

    it('SessionHeaderAction falls back to "." when sessionCwd is empty or undefined', () => {
      const headerActionContent = readFileSync(
        join(__dirname, '../src/client/SessionHeaderAction.tsx'),
        'utf-8',
      )

      expect(headerActionContent).toContain('dialogCoordinator.open(sessionCwd || \'.\')')
      expect(headerActionContent).toContain('resolveUnifiedStatus')
    })
  })

  describe('4. DSH packaging & runtime build artifact execution', () => {
    it('package.json includes @deepseek-ai/dsh-client-ui-conversation in dsh.client.inject', () => {
      const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'))
      expect(pkg.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-conversation')
    })

    it('tsdown.config.ts has return exports in footer instead of module.exports', () => {
      const tsdownConfig = readFileSync(join(__dirname, '../tsdown.config.ts'), 'utf-8')
      expect(tsdownConfig).toContain("return exports; } });")
      expect(tsdownConfig).not.toContain("return module.exports; } });")
    })

    it('runtime build artifact lib/client.js executes correctly without ReferenceError: module is not defined', () => {
      const clientJsPath = join(__dirname, '../lib/client.js')
      const clientJs = readFileSync(clientJsPath, 'utf-8')

      let loadedPayload: { id: string; factory: (req: any) => any } | undefined
      const windowMock: any = {
        __ModuleLoader__: {
          load: (payload: any) => {
            loadedPayload = payload
          },
        },
      }

      // Execute client.js with windowMock in scope
      const fn = new Function('window', 'document', clientJs)
      expect(() => fn(windowMock, {})).not.toThrow()

      expect(loadedPayload).toBeDefined()
      expect(loadedPayload?.id).toBe('dsh-vectr-client')
      expect(typeof loadedPayload?.factory).toBe('function')

      // Execute factory with a dummy require that stubs external react/dsh modules
      const mockRequire = (id: string) => {
        if (id === 'react' || id === 'react/jsx-runtime') {
          return {
            createElement: () => null,
            useState: (initial: any) => [initial, () => {}],
            useEffect: () => {},
            useMemo: (cb: any) => cb(),
            useCallback: (cb: any) => cb,
            useRef: () => ({ current: null }),
            Fragment: 'Fragment',
            jsx: () => null,
            jsxs: () => null,
          }
        }
        return {}
      }

      let exportsResult: any
      expect(() => {
        exportsResult = loadedPayload?.factory(mockRequire)
      }).not.toThrow()

      expect(exportsResult).toBeDefined()
      expect(typeof exportsResult.apply).toBe('function')
      expect(exportsResult.VectrDialogRoot).toBeDefined()
      expect(exportsResult.SessionHeaderAction).toBeDefined()
      expect(exportsResult.SessionDrawerModal).toBeDefined()
      expect(exportsResult.MemoryViewer).toBeDefined()
      expect(exportsResult.CodebaseModal).toBeDefined()
    })
  })
})
