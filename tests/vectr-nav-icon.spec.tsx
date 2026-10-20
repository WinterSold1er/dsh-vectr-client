/**
 * T28 — the Vectr mark is standalone: our own lightning polygon, never the host
 * settings gear.
 *
 * Why this spec exists: the settings RAIL glyph a user sees is chosen by the host
 * (`ui-settings-general/src/client/SettingsRoot.tsx:32-40`, id→icon map with an
 * `IconSettingsOutlineMedium` gear fallback at :39), and the host's
 * `SettingsSectionRow` contract has no `icon` field, so our registration's
 * `icon:` is dropped. That host fallback cannot be fixed from this repo; what CAN
 * be pinned here is that every surface WE render uses our polygon and that the
 * gear's path data never appears in our output.
 *
 * The gear path data below is copied verbatim from the host artwork
 * (`packages/client/ui-primitives/src/icons/index.tsx:66-67`) on purpose: if our
 * mark ever regresses to a cog, these exact strings reappear and the spec fails.
 *
 * @module tests/vectr-nav-icon
 */

import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { renderToHtml } from './react-render'
import { VectrNavIcon } from '../src/client/VectrNavIcon'
import { WorkspaceConsoleView, apply } from '../src/client/index'

/** The polygon that IS the Vectr mark. */
const VECTR_POLYGON = '13 2 3 14 12 14 11 22 21 10 12 10 13 2'

/** Host gear: hollow hub circle. */
const GEAR_HUB = 'M8 9.75012C8.9665 9.75012'
/** Host gear: toothed silhouette. */
const GEAR_SILHOUETTE = 'M13.0107 7.79377'

/** Minimal view-props so the panel header renders without fetching anything. */
function viewProps(): Record<string, unknown> {
  const noop = (): void => {}
  return {
    wsViews: [],
    cbViews: [],
    wsError: null,
    cbError: null,
    loading: false,
    flash: null,
    busyPort: null,
    busySlug: null,
    expanded: new Set<string>(),
    onRefresh: noop,
    onToggle: noop,
    onReindex: noop,
    onTest: noop,
    onStart: noop,
    onDelete: noop,
  }
}

describe('VectrNavIcon renders the standalone Vectr mark, not a gear', () => {
  it('renders our own lightning polygon', () => {
    const html = renderToHtml(<VectrNavIcon />)

    expect(html).toContain(`points="${VECTR_POLYGON}"`)
  })

  it('contains none of the host gear path data and no cog hub', () => {
    const html = renderToHtml(<VectrNavIcon />)

    expect(html).not.toContain(GEAR_HUB)
    expect(html).not.toContain(GEAR_SILHOUETTE)
    // A toothed wheel always needs a hub (circle or a closed hub path); the
    // lightning polygon has neither.
    expect(html).not.toContain('<circle')
    expect(html).not.toContain('<path')
  })

  it('is theme-safe: currentColor only, no hardcoded colour', () => {
    const html = renderToHtml(<VectrNavIcon />)

    expect(html).toContain('stroke="currentColor"')
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/i)
    expect(html).not.toMatch(/rgba?\(/i)
  })

  it('uses the host section-icon size (16) by default and honours a smaller one', () => {
    const standard = renderToHtml(<VectrNavIcon />)
    expect(standard).toContain('width="16"')
    expect(standard).toContain('height="16"')

    const capsule = renderToHtml(<VectrNavIcon size={14} />)
    expect(capsule).toContain('width="14"')
    expect(capsule).toContain('height="14"')
    expect(capsule).toContain(`points="${VECTR_POLYGON}"`)
  })

  it('is decorative by default and becomes a named image when a title is given', () => {
    const decorative = renderToHtml(<VectrNavIcon />)
    expect(decorative).toContain('aria-hidden="true"')
    expect(decorative).not.toContain('role="img"')
    expect(decorative).not.toContain('<title>')

    const named = renderToHtml(<VectrNavIcon title="Vectr" />)
    expect(named).toContain('role="img"')
    expect(named).toContain('<title>Vectr</title>')
    expect(named).not.toContain('aria-hidden')
    // Still the same mark, still no gear.
    expect(named).toContain(`points="${VECTR_POLYGON}"`)
    expect(named).not.toContain(GEAR_HUB)
    expect(named).not.toContain(GEAR_SILHOUETTE)
  })
})

describe('the Vectr settings page shows the mark in its header', () => {
  it('mounts the standalone mark next to the page title', () => {
    const html = renderToHtml(<WorkspaceConsoleView {...viewProps()} />)
    const head = html.slice(html.indexOf('class="vectr-page-head"'))

    expect(head).toContain(`points="${VECTR_POLYGON}"`)
    expect(head).toContain('<title>Vectr</title>')
    expect(head).toContain('role="img"')
    expect(head).not.toContain(GEAR_HUB)
    expect(head).not.toContain(GEAR_SILHOUETTE)
  })
})

describe('the settings-section registration wires our mark', () => {
  it('registers VectrNavIcon as the icon of the vectr section', () => {
    const registrations: Array<Record<string, unknown>> = []
    const ctx = {
      slots: {
        inject: (_key: string, callback: () => void) => {
          callback()
          return (): void => {}
        },
        register: (options: Record<string, unknown>) => {
          registrations.push(options)
          return (): void => {}
        },
      },
      effect: (): void => {},
    }

    apply(ctx as never)

    const section = registrations.find((row) => row.name === 'settings.section' && row.id === 'vectr')
    expect(section).toBeDefined()
    // Identity, not just "something truthy": the rail must get THIS component.
    expect(section?.icon).toBe(VectrNavIcon)
    expect(section?.icon).not.toBe(undefined)
  })
})
