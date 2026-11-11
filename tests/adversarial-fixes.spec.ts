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

      // Positional, not "the name appears somewhere in the file". On this platform each
      // state ships a FILL layer and a deep layer, and putting them in the wrong job is
      // the defect this guard exists to catch: --dsw-alias-state-warn-tertiary is
      // amber-100 rgb(254,245,231) in light and amber-900 rgb(39,36,31) in dark
      // (design-platform.css:276 / :400), --dsw-alias-state-success-tertiary is green-100
      // rgb(230,250,237) / green-900 rgb(35,60,44) (:272 / :396). As *text* those measure
      // 1.08:1 on a white panel and 1.18:1 on this panel's dark surface — unreadable, and
      // even the deepest warn text alias the host publishes (warn-label, amber-600
      // rgb(221,134,41), :273) only reaches 2.79:1 — while the -primary layer (amber-500
      // rgb(245,158,11) / green-500 rgb(34,197,94), :274 / :270) is deep enough to read as
      // a ring or a glyph. The old assertions were satisfied by either reading, including
      // the one that made the chip illegible, so they asserted nothing about the job the
      // token was doing.
      //
      // The fill is declared once, in the shared sheet the drawer renders with, so the
      // assertion spans both halves: the chip the drawer mounts, and what the sheet paints
      // on it. Neither half alone is enough — a class the drawer never applies proves
      // nothing, and a sheet that fills the wrong alias is the defect itself.
      const sheet = readFileSync(join(__dirname, '../src/client/buttons.tsx'), 'utf-8')
      expect(drawerContent).toMatch(/vectr-pill-live vectr-pill-live-filled/)
      expect(drawerContent).toMatch(/vectr-pill-pending vectr-pill-pending-filled/)
      for (const cls of ['vectr-pill-live-filled', 'vectr-pill-pending-filled']) {
        expect(sheet, `${cls} must paint its state as a FILL`).toMatch(
          new RegExp(`\\.${cls}\\s*\\{[^}]*background:\\s*var\\(--dsw-alias-state-\\w+-tertiary\\)`),
        )
        expect(sheet, `${cls} must ring with the deep state alias`).toMatch(
          new RegExp(`\\.${cls}\\s*\\{[^}]*border-color:\\s*var\\(--dsw-alias-state-\\w+-primary\\)`),
        )
        expect(sheet, `${cls} must keep its word on a label alias`).toMatch(
          new RegExp(`\\.${cls}\\s*\\{[^}]*color:\\s*var\\(--dsw-alias-label-primary\\)`),
        )
      }
      // The warn fill specifically: the sheet may not quietly swap it for success.
      expect(sheet).toMatch(/\.vectr-pill-pending-filled\s*\{[^}]*background:\s*var\(--dsw-alias-state-warn-tertiary\)/)
      expect(sheet).toMatch(/\.vectr-pill-live-filled\s*\{[^}]*background:\s*var\(--dsw-alias-state-success-tertiary\)/)
      // …and no state fill/ring alias is ever painted as a *word* in the drawer.
      expect(drawerContent).not.toMatch(/color:\s*'var\(--dsw-alias-state-(warn|success)-(tertiary|secondary)\)'/)

      // Two assertions this revision inverts, each because the original demanded a defect
      // rather than forbidding one:
      //
      // 1. `toContain('var(--dsw-alias-brand-tertiary)')` demanded a token no host
      //    stylesheet defines. `grep -rn -- "--dsw-alias-brand-tertiary"` over the whole
      //    deepseek-harness-0.2.2-rc.1 checkout, packages/client/ui-theme/src/styles
      //    included, returns 0 hits, while brand-primary / brand-primary-invert /
      //    brand-primary-new-colorprimary-new-color are declared at design-platform.css
      //    :200-202 (light) and :324-326 (dark). A declaration that paints an undefined
      //    alias paints nothing at all: the "Primary" badge built on this token had no fill
      //    — which is exactly what tests/e2e/visual-settings.spec.tsx recorded in
      //    KNOWN_DEFECTS as `deadNoFallback`. Requiring the token therefore required the
      //    hole, so it becomes a prohibition.
      expect(drawerContent).not.toContain('var(--dsw-alias-brand-tertiary)')
      //
      // 2. `toContain('var(--dsw-alias-brand-primary)')` demanded the drawer paint an ink
      //    alias as chrome: design-platform.css:202 binds brand-primary to
      //    neutral-bluish-1000 = rgb(15,17,21) in light and :326 to neutral-bluish-50 =
      //    rgb(249,250,251) in dark, so honouring it means a near-black ring on a light
      //    card or a near-white ring on a dark card. buttons.tsx:138 and :178 already record
      //    avoiding brand-primary for borders and interactive states for this reason; the
      //    accent the panel really uses is --vx-accent, which resolves through
      //    --dsw-alias-state-done-primary (violet-600 / violet-400, :266 / :390) with
      //    brand-primary-new-… as the fallback. The drawer's brand mark is asserted through
      //    that route instead — the mark class the visual gate reads.
      expect(drawerContent).not.toContain('var(--dsw-alias-brand-primary)')
      expect(drawerContent).toContain('vectr-mark')
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

    it('SessionHeaderAction strictly enforces workspace isolation and does not fall back to "."', () => {
      const headerActionContent = readFileSync(
        join(__dirname, '../src/client/SessionHeaderAction.tsx'),
        'utf-8',
      )

      expect(headerActionContent).not.toContain("dialogCoordinator.open(sessionCwd || '.')")
      expect(headerActionContent).not.toContain("sessionCwd || '.'")
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
