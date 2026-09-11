/**
 * Shared visual styling for the vectr console panels (feature E) and session UI.
 *
 * Every hardcoded color/size is swapped for a host `--dsw-alias-*` design token
 * so the plugin follows the host's light/dark theme automatically. Pseudo-class
 * states (`:hover`, `:focus-visible`, `:disabled`) cannot be expressed in inline
 * styles, so the tokens are wired through a single injected `<style>` block
 * and referenced via `className`.
 *
 * @module dsh-vectr-client/client/buttons
 */

import type { ReactNode } from 'react'

/** One global stylesheet carrying every vectr control class. Injected once. */
export const VECTR_CSS = `
.vectr-btn { font: inherit; cursor: pointer; transition: background 120ms, border-color 120ms; border: 1px solid transparent; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.vectr-btn:disabled { opacity: .4; cursor: default; }
.vectr-btn:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.vectr-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.vectr-btn-dense { height: 28px; padding: 0 10px; border-radius: 14px; font-size: 12px; }
.vectr-btn-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.vectr-btn-secondary { border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }
.vectr-btn-danger { color: var(--dsw-alias-state-error-primary); }
.vectr-label { display: block; margin-bottom: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; }
.vectr-input, .vectr-select, .vectr-textarea { padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; box-sizing: border-box; font-size: 13px; }
.vectr-input, .vectr-select { height: 32px; }
.vectr-input:focus, .vectr-select:focus, .vectr-textarea:focus { border-color: var(--dsw-alias-brand-primary); outline: none; box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }
.vectr-input::placeholder, .vectr-textarea::placeholder { color: var(--dsw-alias-label-dimmed); }

.vectr-modal-backdrop {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: var(--dsw-alias-bg-overlay, rgba(0, 0, 0, 0.45));
  backdrop-filter: blur(2px);
  z-index: 10000;
  display: flex; align-items: center; justify-content: center;
  animation: vectr-fade-in 150ms ease-out;
}
.vectr-modal-card {
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  box-shadow: var(--dsw-alias-shadow-modal, 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04));
  width: 90vw; max-width: 840px; max-height: 88vh;
  display: flex; flex-direction: column; overflow: hidden;
  color: var(--dsw-alias-label-primary);
  animation: vectr-scale-up 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
.vectr-header-capsule {
  display: inline-flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 8px; border-radius: 13px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
  font-size: 11px; font-weight: 500; cursor: pointer;
  transition: all 140ms ease;
}
.vectr-header-capsule:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  border-color: var(--dsw-alias-brand-primary);
}
.vectr-indicator-dot {
  width: 7px; height: 7px; border-radius: 50%;
  display: inline-block; flex-shrink: 0;
}
.vectr-dot-live { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 4px var(--dsw-alias-state-success-primary); }
.vectr-dot-offline { background: var(--dsw-alias-label-tertiary); }
.vectr-dot-error { background: var(--dsw-alias-state-error-primary); }

.vectr-metric-card {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; padding: 10px 14px;
  display: flex; flex-direction: column; gap: 4px;
}
.vectr-tab-btn {
  padding: 8px 16px; border: none; background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px; font-weight: 500; cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 120ms;
}
.vectr-tab-btn.active {
  color: var(--dsw-alias-brand-primary);
  border-bottom-color: var(--dsw-alias-brand-primary);
  font-weight: 600;
}
.vectr-tab-btn:hover:not(.active) {
  color: var(--dsw-alias-label-primary);
}
.vectr-note-card {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; padding: 12px; margin-bottom: 8px;
  font-size: 13px; line-height: 1.5;
}

@keyframes vectr-fade-in {
  from { opacity: 0; } to { opacity: 1; }
}
@keyframes vectr-scale-up {
  from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); }
}
`

/** Render the shared stylesheet once. Place inside the Vectr settings shell or topbar capsule. */
export function VectrStyles(): ReactNode {
  return <style>{VECTR_CSS}</style>
}

/** className sets for the button variants used across the panels. */
export const BTN = {
  /** Inline row action (re-index / test): dense capsule, no fill. */
  action: 'vectr-btn vectr-btn-dense',
  /** Secondary action (refresh): bordered, transparent. */
  secondary: 'vectr-btn vectr-btn-dense vectr-btn-secondary',
  /** Destructive action (delete): error-colored text. */
  danger: 'vectr-btn vectr-btn-dense vectr-btn-danger',
  /** Primary action (create): filled. */
  primary: 'vectr-btn vectr-btn-dense vectr-btn-primary',
} as const
