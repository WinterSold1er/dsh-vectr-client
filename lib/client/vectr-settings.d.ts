/**
 * Top-level **Settings → Vectr** section shell (改动1).
 *
 * Replaces the old `settings.plugins.tab` injection that mounted the workspace
 * console and the codebase manager as two separate Plugins-tab panels. Now a
 * single top-level `settings.section` (id `vectr`) hosts both panels behind a
 * tab bar: `Workspaces` and `Codebases`. Each panel keeps fetching its own data
 * from the host; this shell only owns which tab is active.
 *
 * Both panels stay MOUNTED at all times; the inactive one is hidden with
 * `display:none` (review B1). This preserves each panel's local form/fetch
 * state across tab switches and avoids re-fetching + unmounted-setState warnings.
 *
 * @module dsh-vectr-client/client/vectr-settings
 */
import { type ReactNode } from 'react';
/** Tab-bar + active-panel host for the Vectr settings section. */
export declare function VectrSettings(): ReactNode;
//# sourceMappingURL=vectr-settings.d.ts.map