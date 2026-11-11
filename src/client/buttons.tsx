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
/* --- Design tokens (art direction: "instrumented vector index") ----------------
 * One violet accent marks everything that says "vectr"; every other colour comes
 * from a host --dsw-alias-* token, so light/dark themes and host re-skins carry
 * this panel with no code change. The accent itself is a host alias too: the sheet
 * carries no colour literals at all. --vx-accent resolves through the host's violet
 * (state-done-primary: violet-600 light / violet-400 dark), NOT through
 * brand-primary, which the platform binds to near-black ink in light and near-white
 * in dark. It carries a fallback at its rail use site because the settings rail
 * paints its glyph before this sheet is mounted (the sheet lives with the panel). */
/* The host declares its whole --dsw-alias-* layer on <body> (design-platform.css binds
 * the aliases to body / body[data-ds-dark-theme]), never to :root. var() substitution
 * happens on the element a declaring rule matches, so a token declared on :root that
 * *reads* a host alias is guaranteed-invalid there — and every descendant inherits the
 * invalid value, which silently drops whole declarations (colour, border colour, the
 * focus ring). Declared on body as well, where the alias actually exists. Guarded by
 * tests/e2e/visual-settings.spec.tsx, which reads the computed colour of .vectr-mark.
 * The fallback names an alias every host version in this repo defines, so the accent
 * survives a host without state-done-primary instead of collapsing to inherited ink. */
/* Floor line: the accent is always a host alias, and this single-alias form is the one the
 * design-baseline guard can read. The next line refines it with a fallback chain, which is
 * what actually survives a host that has no --dsw-alias-state-done-primary: a custom property
 * whose value references an undefined alias WITHOUT a fallback turns guaranteed-invalid on
 * body and takes every var(--vx-accent) use with it — colour, border colour and focus ring. */
:root, body { --vx-accent: var(--dsw-alias-brand-primary-new-colorprimary-new-color); }
:root, body { --vx-accent: var(--dsw-alias-state-done-primary, var(--dsw-alias-brand-primary-new-colorprimary-new-color)); --vx-ease: cubic-bezier(.16, 1, .3, 1); --vx-dur: 140ms; }

/* Panel frame: one 720px column, 24px between blocks, instrument-grade 12/1.55 body. */
.vectr-page { max-width: 720px; gap: 24px; font-size: 12px; line-height: 1.55; }
.vectr-section { display: flex; flex-direction: column; gap: 12px; }
/* Eyebrow labels the blocks. text-transform is a no-op on CJK, so the Chinese block
 * labels keep their own lettering instead of being shouted. */
/* label-tertiary is 3.71:1 on a light surface — fine for a glyph, not for 10px text a
 * user has to read. Secondary (5.75:1) keeps the hierarchy: primary value, secondary
 * label, tertiary only for non-text marks. */
/* Display face: the panel's voice — eyebrows and metric numerals — is set in the host's
 * brand family. base.css:10 declares --dsw-font-family-brand: 'Montserrat',
 * var(--dsh-font-family-text-default) with the @font-face in brand-font.css, and nothing in
 * this panel used it. It is written here with its own fallback stack and never as the bare
 * var(): the host token's own value ends in var(--dsh-font-family-text-default), and a
 * declaration whose substituted value contains an undefined var is invalid at computed-value
 * time — the same silent-drop trap that took --vx-accent (see :40-41 above). Montserrat
 * carries no CJK glyphs, so the CJK families below it are what actually paints 全局 /
 * 工作区 if the webfont never loads. Body text, plain labels and every control keep the
 * inherited stack; only these four rules opt in. */
.vectr-eyebrow { margin: 0; font-size: 10px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-family-brand, 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif); }
/* The metric numerals take the same display face as the eyebrows, so the panel's numbers
 * and its block labels read as one voice. Same fallback stack, same reason for writing it
 * out; tabular-nums is restated here because Montserrat ships proportional figures and a
 * numeral rule has to survive the fallback — a chunk count that changes width between two
 * renders is a jittering layout. */
.vectr-stat-value, .vectr-fact-value, .vectr-metric-value { font-family: var(--dsw-font-family-brand, 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif); font-variant-numeric: tabular-nums; }
.vectr-mark { color: var(--vx-accent); }

/* First-load skeleton: the same card silhouette the real list will fill, so the
 * panel never flashes an empty frame. */
.vectr-skeleton { display: flex; flex-direction: column; gap: 10px; }
.vectr-skeleton-row { height: 62px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2); background-color: var(--dsw-alias-bg-layer-1); background-image: linear-gradient(90deg, transparent, var(--dsw-alias-border-l2), transparent); background-size: 50% 100%; background-repeat: no-repeat; animation: vectr-skeleton 1200ms var(--vx-ease) infinite; }
@keyframes vectr-skeleton { from { background-position: -50% 0; } to { background-position: 150% 0; } }

/* background: transparent — without it a bare .vectr-btn keeps the UA's grey button
 * face (rgb 239,239,239), which is a second, unintended surface colour that no token owns
 * and that drags the danger-text contrast down to 3.91:1. */
.vectr-btn { font: inherit; box-sizing: border-box; background: transparent; cursor: pointer; white-space: nowrap; transition: background var(--vx-dur) var(--vx-ease), border-color var(--vx-dur) var(--vx-ease), color var(--vx-dur) var(--vx-ease); border: 1px solid transparent; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
/* Disabled reads as inert through tokens, not by fading the whole control: opacity on a
 * control washes its border, its fill and its label together and reads as a rendering
 * fault against a 1px hairline. */
.vectr-btn:disabled { color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l2); cursor: default; }
.vectr-btn:focus-visible { outline: 2px solid var(--vx-accent); outline-offset: 2px; }
.vectr-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.vectr-btn-dense { height: 28px; padding: 0 10px; border-radius: 14px; font-size: 12px; }
/* Icon-only control (a modal's close): a square 28px target instead of a text-sized pill. */
.vectr-btn-icon { width: 28px; height: 28px; padding: 0; font-size: 14px; }
/* A radio/checkbox choice. The label is what a pointer actually aims at, so the 28px
 * minimum lives on the label and the native control stays native. */
.vectr-choice { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; font-size: 13px; cursor: pointer; }
.vectr-choice input[type='radio'], .vectr-choice input[type='checkbox'] { width: 15px; height: 15px; margin: 0; flex-shrink: 0; }
/* Modal header. The title and the action cluster share one row; on a narrow screen the
 * cluster drops below the title instead of grinding the title down to one glyph per line. */
.vectr-drawer-head {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;
  padding: 16px 20px; border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.vectr-drawer-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); white-space: nowrap; }
/* auto-fit, not repeat(4, 1fr): four fixed columns at 390px leaves ~70px per card and every
 * label wraps character by character. */
.vectr-metric-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 12px;
  padding: 14px 20px; border-bottom: 1px solid var(--dsw-alias-border-l2);
}
/* Tab strip: the labels never break mid-word, so the strip wraps onto a second row
 * instead of pushing the card wider than the viewport. */
.vectr-tab-row { display: flex; flex-wrap: wrap; gap: 12px; padding: 0 20px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
/* A bounded scrollport for a table that legitimately needs more width than the viewport. */
.vectr-scroll { min-width: 0; overflow-x: auto; }
.vectr-btn-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.vectr-btn-secondary { border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }
.vectr-btn-danger { color: var(--dsw-alias-state-error-primary); }
.vectr-label { display: block; margin-bottom: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; }
.vectr-input, .vectr-select, .vectr-textarea { padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; box-sizing: border-box; font-size: 13px; }
.vectr-input, .vectr-select { height: 32px; }
.vectr-input:focus, .vectr-select:focus, .vectr-textarea:focus { border-color: var(--vx-accent); outline: 2px solid var(--vx-accent); outline-offset: 1px; }
/* label-dimmed (neutral-bluish-200) is a 1.6:1 whisper on a light surface; a placeholder
 * is still text a user has to read to know what the field wants. */
.vectr-input::placeholder, .vectr-textarea::placeholder { color: var(--dsw-alias-label-tertiary); }

.vectr-modal-backdrop {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: var(--dsw-alias-bg-overlay, rgba(0, 0, 0, 0.45));
  backdrop-filter: blur(2px);
  z-index: 10000;
  display: flex; align-items: center; justify-content: center;
  animation: vectr-fade-in var(--vx-dur) var(--vx-ease);
}
.vectr-modal-card {
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  box-shadow: var(--dsw-alias-shadow-modal, 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04));
  width: 90vw; max-width: 840px; max-height: 88vh;
  display: flex; flex-direction: column; overflow: hidden;
  color: var(--dsw-alias-label-primary);
  animation: vectr-scale-up var(--vx-dur) var(--vx-ease);
}
.vectr-header-capsule {
  font-family: inherit;
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px; border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
  font-size: 11px; font-weight: 500; cursor: pointer;
  font-variant-numeric: tabular-nums;
  transition: all var(--vx-dur) var(--vx-ease);
}
.vectr-header-capsule:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  /* l3, not brand-primary: on this platform brand-primary resolves to near-black ink
   * in light and near-white in dark, so an ink frame read as a defect. */
  border-color: var(--dsw-alias-border-l3);
}
/* Every control in the sheet must state outline-style itself. focus.css supplies only
 * outline-color/width, so a rule that fails to resolve (see --vx-accent above) leaves the
 * control with no ring at all rather than falling back to the UA one. */
.vectr-header-capsule:focus-visible { outline: 2px solid var(--vx-accent); outline-offset: 2px; }
.vectr-indicator-dot {
  width: 7px; height: 7px; border-radius: 50%;
  display: inline-block; flex-shrink: 0;
}
.vectr-dot-live { background: var(--dsw-alias-state-success-primary); }
.vectr-dot-offline { background: var(--dsw-alias-label-tertiary); }
.vectr-dot-error { background: var(--dsw-alias-state-error-primary); }

.vectr-metric-card {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; padding: 10px 14px;
  display: flex; flex-direction: column; gap: 4px;
  font-variant-numeric: tabular-nums;
}
/* The three roles inside a metric card. They were inline styles in the drawer, which is
 * how the hint text ended up at 3.71:1 and the value at an inherited colour. */
.vectr-metric-title { font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.vectr-metric-value { font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.vectr-metric-hint { font-size: 10px; letter-spacing: .04em; color: var(--dsw-alias-label-secondary); }
.vectr-metric-na { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.vectr-tab-btn {
  /* A <button> does not inherit font-family (the UA sheet pins it to its control font), so
   * without this the tab labels render in Arial next to panel text in the app's own stack. */
  font-family: inherit; white-space: nowrap;
  padding: 8px 16px; border: none; background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px; font-weight: 500; cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all var(--vx-dur) var(--vx-ease);
}
.vectr-tab-btn.active {
  /* The one accent in the sheet's interactive states: brand-primary would render the
   * active tab in near-black ink (light) / near-white (dark) on this platform. */
  color: var(--vx-accent);
  border-bottom-color: var(--vx-accent);
  font-weight: 600;
}
.vectr-tab-btn:hover:not(.active) {
  color: var(--dsw-alias-label-primary);
}
.vectr-tab-btn:focus-visible {
  outline: 2px solid var(--vx-accent);
  outline-offset: 2px;
}
.vectr-note-card {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px; padding: 12px; margin-bottom: 8px;
  font-size: 13px; line-height: 1.5;
}

/* --- Settings → Vectr page (T3): header, stat strip, pills, table polish --- */
.vectr-page { display: flex; flex-direction: column; }
.vectr-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.vectr-page-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.vectr-page-subtitle { margin: 4px 0 0; max-width: 52ch; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.vectr-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.vectr-flash { font-size: 12px; color: var(--dsw-alias-label-secondary); }
/* One shared 11px secondary-label line, for the small operational facts (port, pid, mode)
 * that every panel needs and that were being re-typed as inline styles per component. */
.vectr-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.vectr-stat-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 8px; }
.vectr-stat { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.vectr-stat-value { font-size: 20px; font-weight: 600; line-height: 1.2; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.vectr-stat-label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.vectr-pill { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 11px; background: transparent; color: var(--dsw-alias-label-primary); font-size: 11px; font-weight: 500; white-space: nowrap; }
.vectr-pill-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: currentColor; }
/* The state colour lives in the dot, the word stays readable. state-success-primary
 * (green-500) is 2.28:1 on a light surface and this platform exposes no darker success
 * or warn alias, so a green *word* can never reach 4.5:1 here; the dot carries the
 * colour and the label carries the meaning (the pair is also readable in a monochrome
 * screenshot). */
.vectr-pill-live { color: var(--dsw-alias-label-primary); }
.vectr-pill-live .vectr-pill-dot { background: var(--dsw-alias-state-success-primary); }
.vectr-pill-offline { color: var(--dsw-alias-label-secondary); }
.vectr-pill-offline .vectr-pill-dot { background: var(--dsw-alias-label-tertiary); }
.vectr-pill-ready { color: var(--dsw-alias-label-primary); }
.vectr-pill-ready .vectr-pill-dot { background: var(--dsw-alias-state-success-primary); }
.vectr-pill-pending { color: var(--dsw-alias-label-secondary); }
.vectr-pill-pending .vectr-pill-dot { background: var(--dsw-alias-state-warn-primary); }
.vectr-pill-error { color: var(--dsw-alias-label-primary); }
.vectr-pill-error .vectr-pill-dot { background: var(--dsw-alias-state-error-primary); }
/* Filled variants, for the one place a state must be read at a glance (the session
 * drawer's header chip). On this platform each state publishes a FILL layer and a deep
 * layer, and the two are not interchangeable: -tertiary is amber-100 rgb(254,245,231) /
 * green-100 rgb(230,250,237) in light and amber-900 rgb(39,36,31) / green-900
 * rgb(35,60,44) in dark (design-platform.css:276/:272 light, :400/:396 dark) — as *text*
 * those measure 1.08:1 and 1.18:1, i.e. invisible — while -primary (amber-500 /
 * green-500) is deep enough to read as the ring. The word is pinned to label-primary on
 * the fill: 17.5:1 light / 14.8:1 dark on amber, 17.3:1 / 11.5:1 on green. Declared here
 * rather than inline per component so the role split is stated once, in the same sheet
 * that states the dot rule above. */
.vectr-pill-live-filled { background: var(--dsw-alias-state-success-tertiary); border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-label-primary); }
.vectr-pill-pending-filled { background: var(--dsw-alias-state-warn-tertiary); border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-label-primary); }
.vectr-state { padding: 18px 16px; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; text-align: center; }
.vectr-state-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.vectr-state-icon { color: var(--vx-accent); margin-bottom: 6px; }
.vectr-state-hint { margin: 6px 0 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.vectr-error { margin: 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.5; }
/* Same silhouette as .vectr-error for the "it worked" case: the surface carries the
 * message, so the words can stay at label-primary instead of a 2.3:1 state colour. */
.vectr-result { margin: 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.5; }
/* --- Settings → Vectr workspace cards (T18: the table dump is gone) --- */
.vectr-settings { display: block; padding: 2px 0 6px; }
.vectr-ws-list { display: flex; flex-direction: column; gap: 10px; }
.vectr-card { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.vectr-card:hover { border-color: var(--dsw-alias-border-l3); }
/* T23: nowrap so the action cell never drops to a second row when a card carries
   three pills (memory_only is the widest case); the identity/pills shrink instead. */
.vectr-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; }
.vectr-caret { display: inline-block; width: 10px; text-align: center; }
.vectr-card-identity { display: flex; flex-direction: column; gap: 1px; flex: 1 1 200px; min-width: 0; }
.vectr-card-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vectr-card-path { margin: 0; font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vectr-card-pills { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vectr-card-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; white-space: nowrap; }
/* Below the width where identity + 3 pills + 3 actions can no longer share a line, the
 * head wraps on purpose and the actions sit on their own row at the right edge. That is
 * a designed second row, not the accidental drop T23's nowrap was written to prevent. */
@media (max-width: 480px) {
  .vectr-card-head { flex-wrap: wrap; }
  .vectr-card-actions { margin-left: auto; }
}
.vectr-card-diagnostic { margin: 0; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.vectr-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap: 4px 10px; margin: 0; }
.vectr-fact { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.vectr-fact-label { font-size: 10px; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.vectr-fact-value { margin: 0; font-size: 12px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The codebase sub-table keeps its own min-width (index.tsx), so on a phone it is wider
 * than the card. Bounding it here as a scrollport is what keeps the *page* from scrolling
 * sideways: without it the 668px table pushes .vectr-card, .vectr-ws-list and the document
 * to scrollWidth 700 at 390px viewport width. */
.vectr-card-detail { padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l2); min-width: 0; overflow-x: auto; }

/* Hover reads as a border lifting l2 → l3 (see .vectr-card:hover); no shadows outside
 * the modal, per the art direction. */
.vectr-card, .vectr-stat, .vectr-state, .vectr-note-card { transition: border-color var(--vx-dur) var(--vx-ease); }

/* The one motion budget: 140ms on the same curve everywhere, and all of it off when
 * the user asked for reduced motion. */
@media (prefers-reduced-motion: reduce) {
  .vectr-modal-backdrop, .vectr-modal-card, .vectr-skeleton-row { animation: none; transition: none; }
  .vectr-btn, .vectr-card, .vectr-stat, .vectr-state, .vectr-note-card, .vectr-tab-btn, .vectr-header-capsule { transition: none; }
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
