/**
 * Top-level **Settings → Vectr** section shell + the glyph shown for it in the
 * settings rail.
 *
 * 阶段2: the codebase manager is merged INTO the workspace console, so there is
 * no longer a separate Codebases tab. This shell is now a thin single-panel host
 * that injects the shared stylesheet and renders {@link WorkspaceConsole} (which
 * owns both the workspace cards and the per-workspace codebase sub-tables).
 *
 * {@link VectrSettingsRailIcon} is the other half: the host picks the rail glyph
 * from a separate `settings.section.icon` slot that it filters by the section id,
 * so the plugin only gets its own mark by registering into that slot with the same
 * id — the `icon` field of the section registration is dropped by the host.
 *
 * @module dsh-vectr-client/client/vectr-settings
 */
import type { ReactNode } from 'react';
/** Panel host for the Vectr settings section. */
export declare function VectrSettings(): import("react").JSX.Element;
/** Props the host hands the `settings.section.icon` slot (SettingsRoot.tsx:92). */
export interface VectrSettingsRailIconProps {
    size: number;
    active: boolean;
}
/**
 * The rail glyph: the plugin's own lightning polygon, never the host's gear.
 * `size` is the host's rail metric and goes straight into the SVG box; `active`
 * paints the accent, inactive inherits the rail's own colour so the glyph follows
 * the theme. The accent falls back to the host violet token because the rail paints
 * before the panel mounts its stylesheet, which is where --vx-accent is defined.
 */
export declare function VectrSettingsRailIcon({ size, active }: VectrSettingsRailIconProps): ReactNode;
//# sourceMappingURL=vectr-settings.d.ts.map