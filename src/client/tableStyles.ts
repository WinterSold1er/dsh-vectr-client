/**
 * Shared table styling for the vectr console panels (改动2).
 *
 * Both the workspace console and the codebase manager render wide tables that
 * were being clipped/crammed in the narrow Settings panel. These constants
 * give every table a horizontal scroll wrapper, a consistent collapsed border
 * with padding, and an ellipsis helper for long text cells (workspace paths,
 * remote addresses, …) so columns no longer overlap or get cut off.
 *
 * @module dsh-vectr-client/client/tableStyles
 */

import type { CSSProperties } from 'react'

/** Outer wrapper that enables horizontal scrolling when the table overflows. */
export const scrollWrap: CSSProperties = { overflowX: 'auto' }

/** Collapsed-border + full-width base shared by every vectr table. */
export const tableBase: CSSProperties = {
  borderCollapse: 'collapse',
  width: '100%',
}

/** Workspaces table: 13 columns, needs a wide minWidth or columns cram (<53px). */
export const tableStyleWorkspaces: CSSProperties = {
  ...tableBase,
  minWidth: 1080,
}

/** Codebases table: 8 columns, narrower minWidth so it does not scroll needlessly. */
export const tableStyleCodebases: CSSProperties = {
  ...tableBase,
  minWidth: 620,
}

/** @deprecated use {@link tableStyleWorkspaces} / {@link tableStyleCodebases}. */
export const tableStyle: CSSProperties = tableStyleWorkspaces

/** Header cell style: padding, bottom border, nowrap so headers stay readable. */
export const thStyle: CSSProperties = {
  padding: '6px 8px',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  whiteSpace: 'nowrap',
  textAlign: 'left',
}

/** Body cell style: padding + bottom border, top-aligned for multi-line cells. */
export const tdStyle: CSSProperties = {
  padding: '6px 8px',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  verticalAlign: 'top',
}

/** Ellipsis wrapper style for long text cells: shows a tooltip (title) on hover
 * while truncating the visible text so the column stays narrow. */
export const ellipsisStyle: CSSProperties = {
  display: 'block',
  maxWidth: 220,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
