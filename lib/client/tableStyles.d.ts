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
import type { CSSProperties } from 'react';
/** Outer wrapper that enables horizontal scrolling when the table overflows. */
export declare const scrollWrap: CSSProperties;
/** Same as {@link scrollWrap} but bounded to ~8 rows, which makes the wrapper its
 * own scrollport so `.vectr-table thead th { position: sticky }` does real work
 * (verifier D2: an unbounded wrapper never scrolls, so the header just rides the
 * page). The cap stays below the table height, so the bound actually binds. */
export declare const scrollWrapSticky: CSSProperties;
/** Collapsed-border + full-width base shared by every vectr table. */
export declare const tableBase: CSSProperties;
/** Workspaces table: 11 columns. The minWidth sits under the settings modal's
 * content box (~705px inside the ~800px modal), so the whole row — including the
 * canonical `mode` value — is on screen without scrolling; narrower viewports
 * still get {@link scrollWrap}, and `mode` is the 4th column either way. */
export declare const tableStyleWorkspaces: CSSProperties;
/** Codebases table: 8 columns, narrower minWidth so it does not scroll needlessly. */
export declare const tableStyleCodebases: CSSProperties;
/** @deprecated use {@link tableStyleWorkspaces} / {@link tableStyleCodebases}. */
export declare const tableStyle: CSSProperties;
/** Header cell style: padding, bottom border, nowrap so headers stay readable. */
export declare const thStyle: CSSProperties;
/** Body cell style: padding + bottom border, top-aligned for multi-line cells. */
export declare const tdStyle: CSSProperties;
/** Ellipsis wrapper style for long text cells: shows a tooltip (title) on hover
 * while truncating the visible text so the column stays narrow. */
export declare const ellipsisStyle: CSSProperties;
//# sourceMappingURL=tableStyles.d.ts.map