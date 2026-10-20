/**
 * Standalone Vectr mark for the surfaces this plugin renders itself: the
 * settings panel header, the input-bar capsule and status badges.
 *
 * It is deliberately NOT a gear/cog: a single lightning polygon, one geometric
 * idea, stroked with `currentColor` so it follows the host theme at any size.
 *
 * Note (T28 finding): the settings RAIL glyph is chosen by the host, not by us —
 * `ui-settings-general/src/client/SettingsRoot.tsx:32-40` maps a hardcoded set of
 * section ids to icons and falls back to the settings gear for unknown ids, and
 * `shell-contract.ts`'s `SettingsSectionRow` carries no `icon` field at all, so
 * the `icon: VectrNavIcon` we register is dropped before it reaches the rail.
 * Everything we render ourselves uses this component.
 *
 * @module dsh-vectr-client/client/VectrNavIcon
 */
import type { CSSProperties, ReactNode } from 'react';
export interface VectrNavIconProps {
    size?: number | undefined;
    className?: string | undefined;
    style?: CSSProperties | undefined;
    /**
     * Accessible name. Omit it where a visible label already names the context
     * (the rail row, the input capsule): the mark is then decorative and stays
     * `aria-hidden`. Pass it when the mark is the only thing naming the surface.
     */
    title?: string | undefined;
}
/**
 * Dedicated Vectr mark (lightning polygon) for navigation, headers and toolbars.
 * Renders as a named image when `title` is given, otherwise as a decorative glyph.
 */
export declare function VectrNavIcon(props: VectrNavIconProps): ReactNode;
//# sourceMappingURL=VectrNavIcon.d.ts.map