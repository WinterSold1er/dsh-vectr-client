/**
 * TDD Specification & Regression Test Suite:
 * Session Button Deduplication & Mutual Exclusion (Issue 1 & Review Hardening).
 *
 * Requirements & Invariants:
 * 1. Active session (valid, non-empty, finite sessionId):
 *    - conversation.session.header.utilities (SessionHeaderAction) renders header capsule.
 *    - conversation.input.right (ConversationInputRightAction) returns null (yields to top capsule).
 * 2. Inactive / Blank / New session (sessionId missing, undefined, empty, whitespace, 'null', 'undefined', NaN, Infinity):
 *    - conversation.input.right (ConversationInputRightAction) renders input action button.
 *    - conversation.session.header.utilities (SessionHeaderAction) returns null and makes ZERO network calls.
 * 3. React Hook Safety (Anti-Breakage Invariant):
 *    - ConversationInputRightAction must be a pure, hook-free component.
 *    - It must never call useSessions or any React hooks (conditional or unconditional).
 * 4. Workspace Isolation (CWD Fallback Elimination):
 *    - SessionHeaderAction must never fall back to '.' when sessionCwd is missing or unready.
 *    - Unready sessionCwd must immediately reset state to null and make zero network requests.
 * 5. Domain layer:
 *    - src/domain/rules.ts exports hasActiveSession(sessionId?: unknown): boolean as the single source of truth.
 *    - Rigorous boundary defense against sentinel strings and non-finite numbers.
 * 6. Internationalization & Accessibility:
 *    - English titles and aria-labels across both components.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as domainRules from '../src/domain/rules'
import * as domainIndex from '../src/domain/index'
import { SessionHeaderAction } from '../src/client/SessionHeaderAction'
import { ConversationInputRightAction } from '../src/client/ConversationInputRightAction'
import { dialogCoordinator } from '../src/client/dialogCoordinator'

const inputActionSrc = readFileSync(
  new URL('../src/client/ConversationInputRightAction.tsx', import.meta.url),
  'utf8',
)
const headerActionSrc = readFileSync(
  new URL('../src/client/SessionHeaderAction.tsx', import.meta.url),
  'utf8',
)

describe('Domain: hasActiveSession truth source & boundary defense', () => {
  it('exports hasActiveSession from src/domain/rules and src/domain/index', () => {
    const rules = domainRules as Record<string, unknown>
    const index = domainIndex as Record<string, unknown>

    expect(typeof rules.hasActiveSession).toBe('function')
    expect(typeof index.hasActiveSession).toBe('function')
    expect(rules.hasActiveSession).toBe(index.hasActiveSession)
  })

  it('returns true for valid, non-empty session IDs', () => {
    const { hasActiveSession } = domainRules

    expect(hasActiveSession('session-123')).toBe(true)
    expect(hasActiveSession('s_abc_xyz')).toBe(true)
    expect(hasActiveSession('1')).toBe(true)
    expect(hasActiveSession('0')).toBe(true)
    expect(hasActiveSession(42)).toBe(true)
    expect(hasActiveSession(0)).toBe(true)
    expect(hasActiveSession(-1)).toBe(true)
  })

  it('returns false for absent, undefined, null, empty or whitespace-only session IDs', () => {
    const { hasActiveSession } = domainRules

    expect(hasActiveSession(undefined)).toBe(false)
    expect(hasActiveSession(null)).toBe(false)
    expect(hasActiveSession('')).toBe(false)
    expect(hasActiveSession('   ')).toBe(false)
    expect(hasActiveSession('\t\n')).toBe(false)
    expect(hasActiveSession('\r\n  ')).toBe(false)
    expect(hasActiveSession({})).toBe(false)
    expect(hasActiveSession([])).toBe(false)
    expect(hasActiveSession(false)).toBe(false)
    expect(hasActiveSession(true)).toBe(false)
    expect(hasActiveSession(() => {})).toBe(false)
    expect(hasActiveSession(Symbol('test'))).toBe(false)
  })

  it('defensively filters string literals "null" and "undefined" (case-insensitive)', () => {
    const { hasActiveSession } = domainRules

    expect(hasActiveSession('null')).toBe(false)
    expect(hasActiveSession('NULL')).toBe(false)
    expect(hasActiveSession('Null')).toBe(false)
    expect(hasActiveSession('  null  ')).toBe(false)
    expect(hasActiveSession('undefined')).toBe(false)
    expect(hasActiveSession('UNDEFINED')).toBe(false)
    expect(hasActiveSession('Undefined')).toBe(false)
    expect(hasActiveSession('  undefined  ')).toBe(false)
  })

  it('defensively filters non-finite numbers (NaN, Infinity, -Infinity)', () => {
    const { hasActiveSession } = domainRules

    expect(hasActiveSession(NaN)).toBe(false)
    expect(hasActiveSession(Infinity)).toBe(false)
    expect(hasActiveSession(-Infinity)).toBe(false)
  })
})

describe('React Hook Rule Safety in ConversationInputRightAction', () => {
  it('does not invoke useSessions even if provided via props', () => {
    const throwingUseSessions = vi.fn().mockImplementation(() => {
      throw new Error('Rules of Hooks violated: useSessions should never be called in ConversationInputRightAction')
    })

    // Must not throw when rendered for blank session
    const element = ConversationInputRightAction({
      sessionId: undefined,
      useSessions: throwingUseSessions,
    })

    expect(element).not.toBeNull()
    expect(throwingUseSessions).not.toHaveBeenCalled()
  })

  it('source code contains zero React Hook invocations', () => {
    // Assert no React hooks (useState, useEffect, useMemo, useCallback, useContext, useRef, useSessions)
    expect(inputActionSrc).not.toMatch(/\buseState\b/)
    expect(inputActionSrc).not.toMatch(/\buseEffect\b/)
    expect(inputActionSrc).not.toMatch(/\buseMemo\b/)
    expect(inputActionSrc).not.toMatch(/\buseCallback\b/)
    expect(inputActionSrc).not.toMatch(/\buseContext\b/)
    expect(inputActionSrc).not.toMatch(/\buseRef\b/)
    expect(inputActionSrc).not.toMatch(/\buseSessions\s*\(/)
  })

  it('uses static props.workspace with fallback "." for dialog trigger', () => {
    dialogCoordinator.close()

    // 1. With custom workspace prop
    const elemWithWs = ConversationInputRightAction({
      sessionId: undefined,
      workspace: '/custom/workspace/alpha',
    }) as any

    const buttonWithWs = Array.isArray(elemWithWs?.props?.children)
      ? elemWithWs.props.children.find((c: any) => c?.type === 'button')
      : elemWithWs
    expect(buttonWithWs).toBeDefined()
    buttonWithWs.props.onClick()
    expect(dialogCoordinator.getState().workspace).toBe('/custom/workspace/alpha')
    expect(dialogCoordinator.getState().isOpen).toBe(true)

    dialogCoordinator.close()

    // 2. Without workspace prop (defaults to '.')
    const elemWithoutWs = ConversationInputRightAction({
      sessionId: undefined,
    }) as any

    const buttonWithoutWs = Array.isArray(elemWithoutWs?.props?.children)
      ? elemWithoutWs.props.children.find((c: any) => c?.type === 'button')
      : elemWithoutWs
    expect(buttonWithoutWs).toBeDefined()
    buttonWithoutWs.props.onClick()
    expect(dialogCoordinator.getState().workspace).toBe('.')
    expect(dialogCoordinator.getState().isOpen).toBe(true)
  })

  it('uses standardized English title and aria-label', () => {
    const elem = ConversationInputRightAction({
      sessionId: undefined,
    }) as any

    const button = Array.isArray(elem?.props?.children)
      ? elem.props.children.find((c: any) => c?.type === 'button')
      : elem
    expect(button.props.title).toBe('Vectr Search & Memory Console')
    expect(button.props['aria-label']).toBe('Vectr status and management')
  })
})

describe('Workspace Isolation & CWD Fallback Elimination in SessionHeaderAction', () => {
  it('source code contains no fallback to "." (sessionCwd || ".") and eliminates silent default', () => {
    // Both fetch and dialogCoordinator must never fall back to '.' in session header
    expect(headerActionSrc).not.toMatch(/sessionCwd\s*\|\|\s*'\.'/)
    expect(headerActionSrc).not.toMatch(/cwdToFetch\s*=\s*sessionCwd\s*\|\|\s*'\.'/)
    expect(headerActionSrc).not.toMatch(/dialogCoordinator\.open\(sessionCwd\s*\|\|\s*'\.'\)/)
  })

  it('source code guards empty sessionCwd and resets state to null without fetching', () => {
    expect(headerActionSrc).toMatch(/if\s*\(!sessionCwd[\s\S]*?setState\(null\)[\s\S]*?return/)
  })

  it('source code guards dialog opening to only valid sessionCwd', () => {
    expect(headerActionSrc).toMatch(/if\s*\(typeof sessionCwd === 'string' && sessionCwd\.trim\(\)\.length > 0\)\s*\{\s*dialogCoordinator\.open\(sessionCwd\.trim\(\)\)/)
  })

  it('uses standardized English title and aria-label', () => {
    expect(headerActionSrc).toMatch(/Vectr Status:/)
    expect(headerActionSrc).toMatch(/aria-label="Vectr status and management"/)
  })
})

describe('Component Mutual Exclusion & Lifecycle Transitions', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ live: true, mode: 'full' }),
    } as unknown as Response)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  describe('Active Session (sessionId exists and is valid)', () => {
    const activeSessionId = 'session-active-001'

    it('ConversationInputRightAction returns null in an active session', () => {
      const element = ConversationInputRightAction({
        sessionId: activeSessionId,
      })
      expect(element).toBeNull()
    })

    it('SessionHeaderAction returns non-null element in an active session', () => {
      const element = SessionHeaderAction({
        sessionId: activeSessionId,
      })
      expect(element).not.toBeNull()
    })
  })

  describe('Blank / New / Inactive Session Boundary Scenarios', () => {
    const inactiveCases = [
      { name: 'undefined', value: undefined },
      { name: 'null', value: null },
      { name: 'empty string', value: '' },
      { name: 'whitespace', value: '   ' },
      { name: 'newline/tab', value: '\t\n' },
      { name: 'string literal "null"', value: 'null' },
      { name: 'string literal "undefined"', value: 'undefined' },
      { name: 'Infinity', value: Infinity as unknown as string },
      { name: 'NaN', value: NaN as unknown as string },
    ]

    for (const { name, value } of inactiveCases) {
      it(`mutual exclusion holds for ${name}: input action renders, header action is null with zero fetch calls`, () => {
        const inputElem = ConversationInputRightAction({ sessionId: value })
        expect(inputElem).not.toBeNull()

        const headerElem = SessionHeaderAction({ sessionId: value })
        expect(headerElem).toBeNull()
        expect(globalThis.fetch).not.toHaveBeenCalled()
      })
    }
  })

  describe('Full Session Lifecycle Transitions', () => {
    it('seamlessly transitions across blank -> active -> blank -> active states', () => {
      // Step 1: Blank new chat
      let currentSessionId: string | undefined = undefined
      expect(ConversationInputRightAction({ sessionId: currentSessionId })).not.toBeNull()
      expect(SessionHeaderAction({ sessionId: currentSessionId })).toBeNull()

      // Step 2: Session created / activated
      currentSessionId = 'session-first-msg'
      expect(ConversationInputRightAction({ sessionId: currentSessionId })).toBeNull()
      expect(SessionHeaderAction({ sessionId: currentSessionId })).not.toBeNull()

      // Step 3: User resets / starts a new chat
      currentSessionId = ''
      expect(ConversationInputRightAction({ sessionId: currentSessionId })).not.toBeNull()
      expect(SessionHeaderAction({ sessionId: currentSessionId })).toBeNull()

      // Step 4: User selects a historic session
      currentSessionId = 'session-historic-42'
      expect(ConversationInputRightAction({ sessionId: currentSessionId })).toBeNull()
      expect(SessionHeaderAction({ sessionId: currentSessionId })).not.toBeNull()

      // Step 5: Teardown / sentinel value
      currentSessionId = 'null'
      expect(ConversationInputRightAction({ sessionId: currentSessionId })).not.toBeNull()
      expect(SessionHeaderAction({ sessionId: currentSessionId })).toBeNull()
    })
  })
})

describe('QA Quality Detector: Tricky Boundaries, Failure Paths & Configuration Externalization', () => {
  const rootReadmePath = new URL('../README.md', import.meta.url)
  const zhReadmePath = new URL('../README.zh-CN.md', import.meta.url)

  describe('Documentation & Bilingual Link Invariants', () => {
    it('README.md has [简体中文](README.zh-CN.md) on the very first line', () => {
      const content = readFileSync(rootReadmePath, 'utf8')
      const lines = content.split(/\r?\n/)
      expect(lines[0].trim()).toBe('[简体中文](README.zh-CN.md)')
    })

    it('README.zh-CN.md has [English](README.md) on the very first line', () => {
      const content = readFileSync(zhReadmePath, 'utf8')
      const lines = content.split(/\r?\n/)
      expect(lines[0].trim()).toBe('[English](README.md)')
    })

    it('both READMEs explicitly cite Based on Vectr with repository and documentation links', () => {
      const en = readFileSync(rootReadmePath, 'utf8')
      const zh = readFileSync(zhReadmePath, 'utf8')

      // Vectr attribution
      expect(en).toContain('Based on Vectr')
      expect(en).toContain('https://github.com/swapnanil/vectr')
      expect(en).toContain('https://swapnanilsaha.com/tools/vectr')

      expect(zh).toContain('基于 Vectr 开发 (Based on Vectr)')
      expect(zh).toContain('https://github.com/swapnanil/vectr')
      expect(zh).toContain('https://swapnanilsaha.com/tools/vectr')
    })

    it('both READMEs highlight Vectr core capabilities: Semantic Search & Reliable Working Memory', () => {
      const en = readFileSync(rootReadmePath, 'utf8')
      const zh = readFileSync(zhReadmePath, 'utf8')

      expect(en).toContain('Semantic Search')
      expect(en).toContain('Reliable Working Memory')
      expect(en).toContain('<50ms')

      expect(zh).toContain('语义检索 (Semantic Search)')
      expect(zh).toContain('可靠工作记忆 (Reliable Working Memory)')
      expect(zh).toContain('<50ms')
    })
  })

  describe('Configuration Externalization & Anti-Fake-Implementation Invariants', () => {
    it('SessionHeaderAction does not contain hardcoded localhost ports or mock status strings', () => {
      // Must not hardcode fake ports or fake status states
      expect(headerActionSrc).not.toMatch(/http:\/\/localhost:\d+/)
      expect(headerActionSrc).not.toMatch(/8765|8766|9223/)
      // Must dynamically build query string from encoded cwd
      expect(headerActionSrc).toContain('encodeURIComponent(cwd)')
      // Dynamic badge construction based on state.port and unifiedStatus
      expect(headerActionSrc).toContain('state?.port')
    })

    it('ConversationInputRightAction does not hardcode absolute paths or mock sessions', () => {
      expect(inputActionSrc).not.toMatch(/\/home\/[a-zA-Z0-9_-]+/)
      expect(inputActionSrc).not.toMatch(/session-[0-9a-f]{8}/)
    })
  })

  describe('Failure Paths & AbortController Defensive Architecture', () => {
    it('SessionHeaderAction source explicitly traps AbortError and ignores it', () => {
      expect(headerActionSrc).toMatch(/err.*name\s*===\s*'AbortError'\s*\|\|\s*signal\?\.aborted/)
    })

    it('SessionHeaderAction source explicitly cleans up via controller.abort() on unmount or cwd change', () => {
      expect(headerActionSrc).toMatch(/controller\s*=\s*new AbortController\(\)/)
      expect(headerActionSrc).toMatch(/controller\.abort\(\)/)
    })

    it('SessionHeaderAction source resets state to null on non-200 HTTP responses', () => {
      expect(headerActionSrc).toMatch(/if\s*\(res\.ok\)[\s\S]*?else\s*\{\s*setState\(null\)\s*\}/)
    })
  })
})

