/**
 * Shared visual styling for the vectr console panels (feature E).
 *
 * Every hardcoded color/size is swapped for a host `--dsw-alias-*` design token
 * so the plugin follows the host's light/dark theme automatically. Pseudo-class
 * states (`:hover`, `:focus-visible`, `:disabled`) cannot be expressed in inline
 * styles, so the tokens are wired through a single injected `<style>` block
 * (rendered once by {@link VectrSettings}) and referenced via `className`. Inline
 * `style` keeps only what must be computed per-instance.
 *
 * @module dsh-vectr-client/client/buttons
 */
import type { ReactNode } from 'react';
/** One global stylesheet carrying every vectr control class. Injected once. */
export declare const VECTR_CSS = "\n.vectr-btn { font: inherit; cursor: pointer; transition: background 120ms; border: 1px solid transparent; }\n.vectr-btn:disabled { opacity: .4; cursor: default; }\n.vectr-btn:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }\n.vectr-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }\n.vectr-btn-dense { height: 28px; padding: 0 10px; border-radius: 14px; font-size: 12px; }\n.vectr-btn-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }\n.vectr-btn-secondary { border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }\n.vectr-btn-danger { color: var(--dsw-alias-state-error-primary); }\n.vectr-label { display: block; margin-bottom: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; }\n.vectr-input, .vectr-select { height: 32px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; box-sizing: border-box; }\n.vectr-input:focus, .vectr-select:focus { border-color: var(--dsw-alias-brand-primary); outline: none; }\n.vectr-input::placeholder { color: var(--dsw-alias-label-dimmed); }\n";
/** Render the shared stylesheet once. Place inside the Vectr settings shell. */
export declare function VectrStyles(): ReactNode;
/** className sets for the button variants used across the panels. */
export declare const BTN: {
    /** Inline row action (re-index / test): dense capsule, no fill. */
    readonly action: "vectr-btn vectr-btn-dense";
    /** Secondary action (refresh): bordered, transparent. */
    readonly secondary: "vectr-btn vectr-btn-dense vectr-btn-secondary";
    /** Destructive action (delete): error-colored text. */
    readonly danger: "vectr-btn vectr-btn-dense vectr-btn-danger";
    /** Primary action (create): filled. */
    readonly primary: "vectr-btn vectr-btn-dense vectr-btn-primary";
};
//# sourceMappingURL=buttons.d.ts.map