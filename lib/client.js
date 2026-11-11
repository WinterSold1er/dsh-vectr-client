window.__ModuleLoader__.load({ id: "dsh-vectr-client", factory: (require) => {
var exports = { exports: {} }.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");
//#region src/domain/rules.ts
/**
* Domain rules and invariants for Vectr client.
*
* Implements pure validation logic, mode guards, and re-indexing capability checks
* without side-effects or network calls (Layer 1: Domain Core).
*
* @module dsh-vectr-client/domain/rules
*/
/**
* Validation pattern for codebase slugs: alphanumeric, underscores, hyphens, 1-32 chars.
*/
const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/**
* Pattern matching reserved primary codebase slug prefixes and names.
* Any slug equal to "primary" or prefixed with "primary-" is reserved for
* system-generated primary codebases and cannot be used for user codebases.
*/
const PRIMARY_RESERVED_PREFIX_PATTERN = /^primary(-.*)?$/i;
/**
* Test whether a slug uses the reserved primary codebase prefix or name.
* Slugs that match this pattern cannot be created or registered by users.
*/
function isReservedPrimarySlug(slug) {
	if (!slug || typeof slug !== "string") return false;
	return PRIMARY_RESERVED_PREFIX_PATTERN.test(slug.trim());
}
/**
* Canonical directory path (browser-safe: no node:path, this module is also
* bundled into the web client): trimmed, backslashes and duplicate separators
* collapsed, trailing slashes dropped, so `/x/two`, `/x/two//` and `/x\two\`
* all yield one key. Empty input yields ''; the root stays '/'.
*/
function normalizePath(p) {
	if (!p || typeof p !== "string") return "";
	const trimmed = p.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
	if (trimmed === "") return "";
	const stripped = trimmed.replace(/\/+$/, "");
	return stripped === "" ? "/" : stripped;
}
/**
* Test whether a mode string indicates memory_only mode.
*/
function isMemoryOnly(mode) {
	return normalizeMode(mode) === "memory_only";
}
/**
* Test whether a given sessionId represents an active, valid session.
* Absent values, undefined, null, empty strings, whitespace-only strings,
* string literals 'null'/'undefined', and non-finite numbers (NaN, Infinity)
* represent an inactive, blank, or invalid session.
*
* If blank is explicitly true, always returns false (blank session page).
* If blank is explicitly false, verifies valid session ID.
* If blank is undefined, preserves legacy backward-compatible behavior.
*
* (Layer 1: Domain Core - Single Source of Truth for Session Activation)
*/
function hasActiveSession(sessionId, blank) {
	if (blank === true) return false;
	if (sessionId === null || sessionId === void 0) return false;
	if (typeof sessionId === "string") {
		const trimmed = sessionId.trim();
		const lower = trimmed.toLowerCase();
		if (trimmed.length === 0 || lower === "null" || lower === "undefined") return false;
		return true;
	}
	if (typeof sessionId === "number") return Number.isFinite(sessionId);
	return false;
}
/**
* Single source of truth for whether a session is in an activated (non-blank, engaged) state.
*/
function isSessionActivated(state, options) {
	if (!state || typeof state !== "object") return hasActiveSession(state);
	const { sessionId, blank } = state;
	if (blank === true) return false;
	if (blank === false) return hasActiveSession(sessionId, false);
	if (options?.fallbackWhenBlankUndefined === false) return false;
	return hasActiveSession(sessionId, void 0);
}
/**
* Resolve slot visibility across conversation.input.right and conversation.session.header.utilities.
*/
function resolveSessionSlotVisibility(state, options) {
	const isActivated = isSessionActivated(state, options);
	return {
		shouldRenderInputRight: !isActivated,
		shouldRenderHeaderUtility: isActivated
	};
}
/**
* Canonicalize a raw mode string at any trust boundary (registry file -> API -> UI).
*
* The vectr CLI writes both spellings ("memory-only" in instances.json, but the
* daemon's `/v1/status` reports "memory_only"), so every consumer must agree on
* one spelling. Hyphens become underscores, case is folded, whitespace trimmed.
*
* A non-string, empty, or whitespace-only input has no mode to report and yields
* `undefined`; anything else is returned normalized rather than dropped, so an
* unrecognized future mode still reaches callers intact.
*/
function normalizeMode(mode) {
	if (typeof mode !== "string") return void 0;
	const normalized = mode.trim().toLowerCase().replace(/-/g, "_");
	return normalized === "" ? void 0 : normalized;
}
/**
* Normalize raw mode string and liveness state into typed VectrMode.
*/
function formatMode(mode, live) {
	if (live === false) return "offline";
	if (!mode) return "unknown";
	if (mode === "memory-only" || mode === "memory_only") return "memory_only";
	if (mode === "full" || mode === "search_only" || mode === "lite") return mode;
	return "unknown";
}
/**
* Resolve unified lifecycle and operational status across settings and modals.
*/
function resolveUnifiedStatus(input) {
	if (input?.error) return {
		kind: "offline",
		label: "Error",
		isBusy: false,
		description: input.error
	};
	if (!input || input.live !== true) return {
		kind: "offline",
		label: input?.live === void 0 ? "Unknown" : "Offline",
		isBusy: false,
		description: input?.reason ?? (input?.live === void 0 ? "Daemon status unknown" : "Daemon offline or unreachable")
	};
	if (!input.status) return {
		kind: "initializing",
		label: "Initializing",
		isBusy: true,
		description: input.reason ?? "Starting daemon or waiting for status"
	};
	const normalizedMode = formatMode(input.mode, input.live);
	if (normalizedMode === "memory_only") return {
		kind: "memory_only",
		label: "Memory Only",
		isBusy: false,
		description: "Running in working memory mode without persistent index"
	};
	if (normalizedMode === "search_only") return {
		kind: "search_only",
		label: "Search Only",
		isBusy: false,
		description: "Semantic search active without working memory"
	};
	if (input.status?.fully_ready === true) return {
		kind: "ready",
		label: "Ready",
		isBusy: false,
		description: "Daemon fully ready and synchronized",
		background: input.status.reindex_in_progress === true ? "Background re-index in progress" : void 0
	};
	if (input.status?.reindex_in_progress === true) return {
		kind: "indexing",
		label: "Indexing",
		isBusy: true,
		description: "Re-indexing codebase files and embedding vectors"
	};
	if (input.status?.fully_ready === false) return {
		kind: "initializing",
		label: "Initializing",
		isBusy: true,
		description: "Daemon starting or warming up initial index"
	};
	if (normalizedMode === "full" || normalizedMode === "lite") return {
		kind: "ready",
		label: "Ready",
		isBusy: false,
		description: "Daemon fully ready and synchronized"
	};
	return {
		kind: "unknown",
		label: "Unknown",
		isBusy: false,
		description: "Unknown daemon status"
	};
}
//#endregion
//#region src/client/buttons.tsx
/** One global stylesheet carrying every vectr control class. Injected once. */
const VECTR_CSS = `
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
  /* A sheet row: pinned at the top of the card's column. 'flex: 0 0 auto' is what keeps a
   * wrapped phone header (title row + action row) from being squeezed by the growing body
   * below it, and keeps it on screen while the body scrolls. */
  flex: 0 0 auto;
  padding: max(16px, env(safe-area-inset-top)) 20px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
}
.vectr-drawer-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); white-space: nowrap; }
/* auto-fit, not repeat(4, 1fr): four fixed columns at 390px leaves ~70px per card and every
 * label wraps character by character. */
.vectr-metric-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 12px;
  flex: 0 0 auto;
  padding: 14px 20px; border-bottom: 1px solid var(--dsw-alias-border-l2);
}
/* Tab strip: the labels never break mid-word, so the strip wraps onto a second row
 * instead of pushing the card wider than the viewport. */
.vectr-tab-row { display: flex; flex-wrap: wrap; gap: 12px; flex: 0 0 auto; padding: 0 20px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
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
/* Sheet card = a fixed-height column with exactly ONE scrolling child (.vectr-sheet-body).
 * 'overflow: hidden' here is a clip, not a scroll layer: the card stops at max-height so the
 * body is bounded by the card. Before this, the drawer body carried an inline
 * 'min-height: 320px' with the card clipping at 88vh — on a 390x844 phone the header, the
 * metric grid and the wrapped tab strip already eat most of 88vh, so the body's lower half
 * (the whole Init tab) hung below the clip and no amount of swiping could reach it. */
.vectr-modal-card {
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  box-shadow: var(--dsw-alias-shadow-modal, 0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04));
  width: 90vw; max-width: 840px;
  max-height: min(88vh, 900px);
  box-sizing: border-box;
  display: flex; flex-direction: column; overflow: hidden;
  color: var(--dsw-alias-label-primary);
  animation: vectr-scale-up var(--vx-dur) var(--vx-ease);
}
/* Secondary modal (the codebase form) — same sheet, narrower frame. */
.vectr-modal-card--narrow { max-width: 540px; }
/* The sheet's one scroll layer. 'min-height: 0' IS the fix: a flex item's automatic minimum
 * is its min-content, so a body taller than the card refuses to shrink, and the card's clip
 * swallows the rest. Letting it shrink gives overflow-y something to overflow into.
 * overscroll-behavior: contain stops the sheet handing its scroll to the page at either end. */
.vectr-sheet-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  padding: 18px 20px max(16px, env(safe-area-inset-bottom));
}
/* A list that scrolls INSIDE the sheet (recalled notes): two stacked scrollports only behave
 * when each one swallows its own overscroll instead of chaining into the sheet and then the
 * page, which is what makes a phone flick feel like it grabbed the wrong layer. */
.vectr-scrollport {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
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
/* Phone: the sheet IS the screen. The backdrop is position:fixed inset 0, so a card inside it
 * never participates in the document's scroll — a centered 88vh card meant nothing could
 * scroll at all, and whatever the card clipped was simply unreachable. Full-bleed the card,
 * drop its frame, and let its own body scroll the difference. 'height' (not max-height) so the
 * sheet fills the screen; the dvh pair follows the real keyboard-changed viewport. */
@media (max-width: 640px) {
  .vectr-modal-card, .vectr-modal-card--narrow {
    width: 100%; max-width: none;
    height: 100vh; height: 100dvh; max-height: none;
    border-radius: 0;
    border-left: none; border-right: none; border-bottom: none;
  }
  .vectr-metric-grid, .vectr-tab-row { padding-left: 12px; padding-right: 12px; }
  .vectr-drawer-head {
    padding-left: max(12px, env(safe-area-inset-left));
    padding-right: max(12px, env(safe-area-inset-right));
  }
  .vectr-sheet-body {
    padding-left: max(12px, env(safe-area-inset-left));
    padding-right: max(12px, env(safe-area-inset-right));
    padding-bottom: max(16px, env(safe-area-inset-bottom));
  }
  /* 28px is a pointer target, not a thumb target. Every control inside a phone sheet clears
   * 44px (WCAG 2.5.5 / Apple HIG floor). Scoped to the sheet on purpose: the panel's dense
   * inline rows outside a modal keep their own rhythm. */
  .vectr-modal-card .vectr-btn,
  .vectr-modal-card .vectr-btn-dense,
  .vectr-modal-card .vectr-choice,
  .vectr-modal-card .vectr-input,
  .vectr-modal-card .vectr-select,
  .vectr-modal-card .vectr-tab-btn { min-height: 44px; }
  .vectr-modal-card .vectr-btn-icon { width: 44px; height: 44px; }
  .vectr-modal-card .vectr-input, .vectr-modal-card .vectr-select { height: 44px; }
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
`;
/** Render the shared stylesheet once. Place inside the Vectr settings shell or topbar capsule. */
function VectrStyles() {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: VECTR_CSS });
}
/** className sets for the button variants used across the panels. */
const BTN = {
	/** Inline row action (re-index / test): dense capsule, no fill. */
	action: "vectr-btn vectr-btn-dense",
	/** Secondary action (refresh): bordered, transparent. */
	secondary: "vectr-btn vectr-btn-dense vectr-btn-secondary",
	/** Destructive action (delete): error-colored text. */
	danger: "vectr-btn vectr-btn-dense vectr-btn-danger",
	/** Primary action (create): filled. */
	primary: "vectr-btn vectr-btn-dense vectr-btn-primary"
};
//#endregion
//#region src/client/VectrNavIcon.tsx
/**
* Dedicated Vectr mark (lightning polygon) for navigation, headers and toolbars.
* Renders as a named image when `title` is given, otherwise as a decorative glyph.
*/
function VectrNavIcon(props) {
	const size = props.size ?? 16;
	const labelled = props.title !== void 0;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
		width: size,
		height: size,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: "2",
		strokeLinecap: "round",
		strokeLinejoin: "round",
		className: props.className,
		style: {
			display: "inline-block",
			verticalAlign: "middle",
			flexShrink: 0,
			...props.style
		},
		role: labelled ? "img" : void 0,
		"aria-hidden": labelled ? void 0 : true,
		children: [labelled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("title", { children: props.title }) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("polygon", { points: "13 2 3 14 12 14 11 22 21 10 12 10 13 2" })]
	});
}
//#endregion
//#region src/client/vectr-settings.tsx
/** Panel host for the Vectr settings section. */
function VectrSettings() {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "vectr-settings",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VectrStyles, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspaceConsole, {})]
	});
}
/**
* The rail glyph: the plugin's own lightning polygon, never the host's gear.
* `size` is the host's rail metric and goes straight into the SVG box; `active`
* paints the accent, inactive inherits the rail's own colour so the glyph follows
* the theme. The accent falls back to the host violet token because the rail paints
* before the panel mounts its stylesheet, which is where --vx-accent is defined.
*/
function VectrSettingsRailIcon({ size, active }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(VectrNavIcon, {
		size,
		className: "vectr-rail-icon",
		style: active ? { color: "var(--vx-accent, var(--dsw-alias-state-done-primary))" } : void 0
	});
}
/** Header cell style: padding, bottom border, nowrap so headers stay readable. */
const thStyle = {
	padding: "6px 8px",
	borderBottom: "1px solid var(--dsw-alias-border-l2)",
	whiteSpace: "nowrap",
	textAlign: "left"
};
/** Body cell style: padding + bottom border, top-aligned for multi-line cells. */
const tdStyle = {
	padding: "6px 8px",
	borderBottom: "1px solid var(--dsw-alias-border-l2)",
	verticalAlign: "top"
};
/** Ellipsis wrapper style for long text cells: shows a tooltip (title) on hover
* while truncating the visible text so the column stays narrow. */
const ellipsisStyle = {
	display: "block",
	maxWidth: 220,
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap"
};
//#endregion
//#region src/client/DaemonLauncher.tsx
/**
* One-click daemon launcher for the workspace console (改动: 一键拉起全部 daemon).
*
* `DaemonLauncher` owns the request/state; `DaemonLauncherView` is the hook-free
* presentational half (same split as `WorkspaceConsole` / `WorkspaceConsoleView`)
* so it can be rendered headlessly by the client specs — this repo has no jsdom,
* and `react-dom/server` renders one pass without running effects.
*
* The summary line and the per-failure rows come from the REAL response body —
* never from client-side guessing — and a transport/parse failure renders the
* real error text.
*
* @module dsh-vectr-client/client/DaemonLauncher
*/
/**
* Presentational half: the button, the summary line and the per-failure rows.
*
* @param props - see {@link DaemonLauncherViewProps}.
* @returns the launcher markup for the given state.
*/
function DaemonLauncherView(props) {
	const { busy, data, error, onRun } = props;
	const failures = data === null ? [] : data.results.filter((r) => r.status === "failed");
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			display: "flex",
			flexDirection: "column",
			gap: 6
		},
		"aria-busy": busy,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 8,
					flexWrap: "wrap"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: BTN.primary,
					disabled: busy,
					onClick: onRun,
					children: busy ? "正在启动…" : "一键启动全部 Daemon"
				}), data !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "vectr-meta",
					children: `已启动 ${data.started} · 已在运行 ${data.alreadyRunning} · 失败 ${data.failed}`
				})]
			}),
			error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				role: "alert",
				style: {
					fontSize: 11,
					color: "var(--dsw-alias-state-error-primary)"
				},
				children: error
			}),
			failures.map((result) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					fontSize: 11,
					color: "var(--dsw-alias-state-error-primary)"
				},
				children: `${result.workspace}: ${result.error ?? "unknown error"}`
			}, result.workspace))
		]
	});
}
/**
* Button + result panel for "start every registered workspace's daemon".
*
* @param props.onChanged - called after every completed sweep (HTTP 200) so the
*   console can re-fetch its workspace table; the sweep may have started daemons.
* @returns the launcher markup.
*/
function DaemonLauncher(props) {
	const [busy, setBusy] = (0, react.useState)(false);
	const [data, setData] = (0, react.useState)(null);
	const [error, setError] = (0, react.useState)(null);
	const run = () => {
		setBusy(true);
		setError(null);
		fetch("/api/vectr/daemons/start-all", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({})
		}).then(async (res) => ({
			res,
			payload: await res.json()
		})).then(({ res, payload }) => {
			if (!res.ok) {
				setError(payload.error ?? `start-all endpoint returned ${res.status}`);
				return;
			}
			setData(payload);
			props.onChanged?.();
		}).catch((err) => setError(`start-all request error: ${String(err)}`)).finally(() => setBusy(false));
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DaemonLauncherView, {
		busy,
		data,
		error,
		onRun: run
	});
}
//#endregion
//#region src/client/dialogCoordinator.ts
var DialogCoordinator = class {
	listeners = /* @__PURE__ */ new Set();
	state = { isOpen: false };
	subscribe(listener) {
		this.listeners.add(listener);
		listener(this.state);
		return () => {
			this.listeners.delete(listener);
		};
	}
	open(workspace) {
		this.state = {
			isOpen: true,
			workspace
		};
		this.notify();
	}
	close() {
		this.state = {
			isOpen: false,
			workspace: void 0
		};
		this.notify();
	}
	getState() {
		return this.state;
	}
	notify() {
		for (const listener of this.listeners) try {
			listener(this.state);
		} catch {}
	}
};
const dialogCoordinator = new DialogCoordinator();
//#endregion
//#region src/client/SessionHeaderAction.tsx
/**
* Session Header Utility Action for Vectr.
*
* Mounted into the host slot `conversation.session.header.utilities`.
* Dynamically tracks the current active session's working directory (`session.cwd`)
* and displays live status, mode, port, and quick metrics.
* Acts as a pure trigger for `dialogCoordinator.open(workspace)`.
*
* (Layer 4: Presentation)
*
* @module dsh-vectr-client/client/SessionHeaderAction
*/
/**
* Busy indicator for a *ready* daemon that still has background work running.
* `VectrStyles` (buttons.tsx) is owned by another task, so this single class
* lives here until it can be folded into that shared stylesheet. Host tokens
* only — no hardcoded colour.
*/
const BUSY_DOT_CSS = `
.vectr-dot-busy {
  background: var(--dsw-alias-state-warn-primary);
  animation: vectr-dot-pulse 1.4s ease-in-out infinite;
}
@keyframes vectr-dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
`;
/**
* Fetch one workspace's status and report the outcome through `apply`.
*
* A failure must never collapse into a nameless offline state: both a non-ok
* response and a transport/parse failure produce a state whose `error` carries
* the real reason. `resolveUnifiedStatus` then yields label `'Error'` with that
* text as its description, so the capsule renders `Vectr [err]` and the tooltip
* carries the actual cause instead of hiding it.
*
* Exported and taking `apply` so this failure contract is testable without a
* DOM: the repo has no jsdom, and `useEffect` never runs under static rendering.
*/
async function fetchSessionStatus(cwd, signal, apply) {
	if (!cwd) return;
	const failed = (error) => ({
		workspace: cwd,
		live: false,
		mode: "offline",
		codebases: [],
		canReindex: false,
		error
	});
	try {
		const res = await fetch(`/api/vectr/session-status?workspace=${encodeURIComponent(cwd)}`, signal ? { signal } : void 0);
		if (res.ok) {
			apply(await res.json());
			return;
		}
		let detail = "";
		try {
			const body = (await res.text()).trim();
			if (body) detail = ` ${body.slice(0, 200)}`;
		} catch (bodyErr) {
			detail = ` (响应体读取失败: ${String(bodyErr)})`;
		}
		apply(failed(`状态查询失败: HTTP ${res.status}${detail}`));
	} catch (err) {
		if (err?.name === "AbortError" || signal?.aborted) return;
		apply(failed(`状态查询失败: ${String(err)}`));
	}
}
function ActiveSessionHeaderAction(props) {
	const { sessionCwd } = props;
	const [state, setState] = (0, react.useState)(null);
	(0, react.useEffect)(() => {
		if (!sessionCwd || typeof sessionCwd !== "string" || sessionCwd.trim().length === 0) {
			setState(null);
			return;
		}
		const controller = new AbortController();
		fetchSessionStatus(sessionCwd.trim(), controller.signal, setState);
		return () => {
			controller.abort();
		};
	}, [sessionCwd]);
	const unifiedStatus = resolveUnifiedStatus({
		live: state?.live,
		mode: state?.mode,
		status: state?.status,
		reason: state?.reason,
		error: state?.error
	});
	const handleOpen = () => {
		if (typeof sessionCwd === "string" && sessionCwd.trim().length > 0) dialogCoordinator.open(sessionCwd.trim());
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(HeaderCapsule, {
		unifiedStatus,
		port: state?.port,
		sessionCwd,
		onOpen: handleOpen
	});
}
/**
* Hook-free capsule presentation. Everything the user sees in the header badge
* (text, dot state, tooltip) is decided here from the resolved status alone, so
* the status-surface specs can render it headlessly with a payload. The
* hook-bound `ActiveSessionHeaderAction` keeps the fetch, the state and the
* dialog-coordinator hand-off.
*/
function HeaderCapsule({ unifiedStatus, port, sessionCwd, onOpen }) {
	let badgeText = "Vectr";
	if (unifiedStatus.kind === "ready") badgeText = port ? `Vectr [${port}]` : "Vectr";
	else if (unifiedStatus.kind === "memory_only") badgeText = port ? `Vectr [mem:${port}]` : "Vectr [mem]";
	else if (unifiedStatus.kind === "indexing") badgeText = port ? `Vectr [idx:${port}]` : "Vectr [indexing]";
	else if (unifiedStatus.kind === "initializing") badgeText = port ? `Vectr [init:${port}]` : "Vectr [init]";
	else if (unifiedStatus.kind === "search_only") badgeText = port ? `Vectr [search:${port}]` : "Vectr [search]";
	else if (unifiedStatus.label === "Error") badgeText = "Vectr [err]";
	else badgeText = "Vectr [off]";
	const hasBackgroundWork = unifiedStatus.kind === "ready" && Boolean(unifiedStatus.background);
	const dotClass = unifiedStatus.kind === "ready" ? hasBackgroundWork ? "vectr-dot-busy" : "vectr-dot-live" : unifiedStatus.kind === "memory_only" || unifiedStatus.kind === "search_only" ? "vectr-dot-live" : unifiedStatus.isBusy ? "vectr-dot-live" : unifiedStatus.label === "Error" ? "vectr-dot-error" : "vectr-dot-offline";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VectrStyles, {}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: BUSY_DOT_CSS }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			className: "vectr-header-capsule",
			onClick: onOpen,
			title: `Vectr Status: ${unifiedStatus.label}${unifiedStatus.background ? ` — ${unifiedStatus.background}` : ""}${unifiedStatus.description ? ` (${unifiedStatus.description})` : ""}${sessionCwd ? `\nWorkspace: ${sessionCwd}` : ""}`,
			"aria-label": "Vectr status and management",
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `vectr-indicator-dot ${dotClass}` }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: badgeText })]
		})
	] });
}
function SessionsBoundHeaderAction(props) {
	const { useSessions, sessionId } = props;
	const sessionInfo = useSessions((state) => {
		const id = sessionId ? String(sessionId) : "";
		return id ? state?.byId?.[id] : void 0;
	});
	const isBlank = props.blank !== void 0 ? props.blank : sessionInfo?.blank;
	const sessionCwd = sessionInfo?.cwd ?? (typeof props.workspace === "string" ? props.workspace : void 0);
	if (!resolveSessionSlotVisibility({
		sessionId,
		blank: isBlank
	}).shouldRenderHeaderUtility) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActiveSessionHeaderAction, { sessionCwd });
}
function SessionBoundHeaderAction(props) {
	const { useSession, sessionId } = props;
	const singleSession = useSession((s) => s);
	const isBlank = props.blank !== void 0 ? props.blank : singleSession?.blank;
	const sessionCwd = singleSession?.cwd ?? (typeof props.workspace === "string" ? props.workspace : void 0);
	if (!resolveSessionSlotVisibility({
		sessionId,
		blank: isBlank
	}).shouldRenderHeaderUtility) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActiveSessionHeaderAction, { sessionCwd });
}
function DualBoundHeaderAction(props) {
	const { useSession, useSessions, sessionId } = props;
	const singleSession = useSession((s) => s);
	const sessionInfo = useSessions((state) => {
		const id = sessionId ? String(sessionId) : "";
		return id ? state?.byId?.[id] : void 0;
	});
	const isBlank = props.blank !== void 0 ? props.blank : singleSession?.blank !== void 0 ? singleSession.blank : sessionInfo?.blank;
	const sessionCwd = sessionInfo?.cwd ?? singleSession?.cwd ?? (typeof props.workspace === "string" ? props.workspace : void 0);
	if (!resolveSessionSlotVisibility({
		sessionId,
		blank: isBlank
	}).shouldRenderHeaderUtility) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActiveSessionHeaderAction, { sessionCwd });
}
function SessionHeaderAction(props) {
	if (typeof props.useSession === "function" && typeof props.useSessions === "function") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DualBoundHeaderAction, {
		...props,
		useSession: props.useSession,
		useSessions: props.useSessions
	});
	if (typeof props.useSessions === "function") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionsBoundHeaderAction, {
		...props,
		useSessions: props.useSessions
	});
	if (typeof props.useSession === "function") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionBoundHeaderAction, {
		...props,
		useSession: props.useSession
	});
	if (!resolveSessionSlotVisibility({
		sessionId: props.sessionId,
		blank: props.blank
	}).shouldRenderHeaderUtility) return null;
	const sessionCwd = typeof props.workspace === "string" ? props.workspace : void 0;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActiveSessionHeaderAction, { sessionCwd });
}
//#endregion
//#region src/client/ConversationInputRightAction.tsx
function StaticInputRightAction(props) {
	const effectiveWorkspace = typeof props.workspace === "string" && props.workspace ? props.workspace : ".";
	const handleOpen = () => {
		dialogCoordinator.open(effectiveWorkspace);
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VectrStyles, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
		type: "button",
		className: "vectr-btn vectr-btn-dense",
		style: {
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			height: 28,
			padding: "0 8px",
			borderRadius: 6,
			fontSize: 12,
			display: "inline-flex",
			alignItems: "center",
			gap: 5
		},
		onClick: handleOpen,
		title: "Vectr Search & Memory Console",
		"aria-label": "Vectr status and management",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VectrNavIcon, { size: 14 }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "Vectr" })]
	})] });
}
function SessionBoundInputRightAction(props) {
	const { useSession, sessionId } = props;
	const singleSession = useSession((s) => s);
	const isBlank = props.blank !== void 0 ? props.blank : singleSession?.blank;
	const sessionCwd = singleSession?.cwd;
	if (!resolveSessionSlotVisibility({
		sessionId,
		blank: isBlank
	}).shouldRenderInputRight) return null;
	const effectiveWorkspace = sessionCwd || (typeof props.workspace === "string" ? props.workspace : void 0);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StaticInputRightAction, {
		...props,
		workspace: effectiveWorkspace
	});
}
function SessionsBoundInputRightAction(props) {
	const { useSessions, sessionId } = props;
	const sessionInfo = useSessions((state) => {
		const id = sessionId ? String(sessionId) : "";
		return id ? state?.byId?.[id] : void 0;
	});
	const sessionCwd = sessionInfo?.cwd;
	if (!resolveSessionSlotVisibility({
		sessionId,
		blank: props.blank !== void 0 ? props.blank : sessionInfo?.blank
	}).shouldRenderInputRight) return null;
	const effectiveWorkspace = sessionCwd || (typeof props.workspace === "string" ? props.workspace : void 0);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StaticInputRightAction, {
		...props,
		workspace: effectiveWorkspace
	});
}
function DualBoundInputRightAction(props) {
	const { useSession, useSessions, sessionId } = props;
	const singleSession = useSession((s) => s);
	const sessionInfo = useSessions((state) => {
		const id = sessionId ? String(sessionId) : "";
		return id ? state?.byId?.[id] : void 0;
	});
	const sessionCwd = sessionInfo?.cwd ?? singleSession?.cwd;
	if (!resolveSessionSlotVisibility({
		sessionId,
		blank: props.blank !== void 0 ? props.blank : singleSession?.blank !== void 0 ? singleSession.blank : sessionInfo?.blank
	}).shouldRenderInputRight) return null;
	const effectiveWorkspace = sessionCwd || (typeof props.workspace === "string" ? props.workspace : void 0);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StaticInputRightAction, {
		...props,
		workspace: effectiveWorkspace
	});
}
function ConversationInputRightAction(props) {
	if (typeof props.useSession === "function" && typeof props.useSessions === "function") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DualBoundInputRightAction, {
		...props,
		useSession: props.useSession,
		useSessions: props.useSessions
	});
	if (typeof props.useSessions === "function") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionsBoundInputRightAction, {
		...props,
		useSessions: props.useSessions
	});
	if (typeof props.useSession === "function") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionBoundInputRightAction, {
		...props,
		useSession: props.useSession
	});
	if (!resolveSessionSlotVisibility({
		sessionId: props.sessionId,
		blank: props.blank
	}).shouldRenderInputRight) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StaticInputRightAction, { ...props });
}
//#endregion
//#region src/client/CodebaseModal.tsx
/**
* Add Codebase dialog with regex validation, credential isolation, and workspace pre-binding.
*
* (Layer 4: Presentation)
*
* @module dsh-vectr-client/client/CodebaseModal
*/
const SLUG_REGEX = SLUG_PATTERN;
/**
* Auto-derive a valid slug from a local or remote directory path.
* Extracts the basename (last path segment), sanitizes it to match SLUG_PATTERN
* (1-32 chars of [A-Za-z0-9_-]), and avoids reserved primary slug collisions.
*/
function deriveSlugFromPath(inputPath) {
	if (!inputPath || typeof inputPath !== "string") return "";
	const trimmed = inputPath.trim().replace(/[/\\]+$/, "");
	if (!trimmed) return "";
	const segments = trimmed.split(/[/\\]/);
	let sanitized = (segments[segments.length - 1] ?? "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
	if (!sanitized) return "";
	if (isReservedPrimarySlug(sanitized)) sanitized = `cb-${sanitized}`.slice(0, 32).replace(/-+$/, "");
	return sanitized;
}
function CodebaseModal({ workspace, isOpen, onClose, onSuccess }) {
	const [type, setType] = (0, react.useState)("local");
	const [slug, setSlug] = (0, react.useState)("");
	const [slugAutoDerived, setSlugAutoDerived] = (0, react.useState)(true);
	const [path, setPath] = (0, react.useState)("");
	const [host, setHost] = (0, react.useState)("");
	const [remotePath, setRemotePath] = (0, react.useState)("");
	const [remotePort, setRemotePort] = (0, react.useState)("");
	const [authType, setAuthType] = (0, react.useState)("key");
	const [password, setPassword] = (0, react.useState)("");
	const [busy, setBusy] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)(null);
	if (!isOpen) return null;
	const isSlugValid = SLUG_REGEX.test(slug);
	const slugError = slug.length > 0 && !isSlugValid ? "Slug 仅支持 1-32 位字母、数字、下划线及短横线" : null;
	const handleSlugChange = (val) => {
		setSlug(val);
		setSlugAutoDerived(val.length === 0);
	};
	const handlePathChange = (val) => {
		setPath(val);
		if (slugAutoDerived || slug === "") {
			const derived = deriveSlugFromPath(val);
			setSlug(derived);
			setSlugAutoDerived(true);
		}
	};
	const handleRemotePathChange = (val) => {
		setRemotePath(val);
		if (slugAutoDerived || slug === "") {
			const derived = deriveSlugFromPath(val);
			setSlug(derived);
			setSlugAutoDerived(true);
		}
	};
	const handleTypeChange = (nextType) => {
		setType(nextType);
		if (slugAutoDerived) setSlug(deriveSlugFromPath(nextType === "local" ? path : remotePath));
	};
	const handleSubmit = async (e) => {
		e.preventDefault();
		if (!isSlugValid) {
			setError("Slug 格式不符合要求");
			return;
		}
		if (isReservedPrimarySlug(slug)) {
			setError("Slug \"primary\" is reserved for the primary codebase");
			return;
		}
		setBusy(true);
		setError(null);
		const payload = {
			type,
			slug,
			workspace
		};
		if (type === "local") {
			const normalizedPath = normalizePath(path);
			if (!normalizedPath) {
				setError("本地路径不可为空");
				setBusy(false);
				return;
			}
			payload.path = normalizedPath;
		} else {
			const normalizedHost = host.trim();
			const normalizedRemotePath = normalizePath(remotePath);
			if (!normalizedHost || !normalizedRemotePath) {
				setError("远程主机与路径不可为空");
				setBusy(false);
				return;
			}
			payload.host = normalizedHost;
			payload.path = normalizedRemotePath;
			payload.remotePath = normalizedRemotePath;
			const portNum = remotePort.trim() ? parseInt(remotePort.trim(), 10) : void 0;
			if (portNum !== void 0 && !isNaN(portNum) && portNum > 0) payload.remotePort = portNum;
			payload.auth = authType;
			if (authType === "password") {
				if (!password) {
					setError("选择密码认证时必须输入密码");
					setBusy(false);
					return;
				}
				payload.password = password;
			}
		}
		try {
			const res = await fetch("/api/vectr/codebases", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			});
			const data = await res.json();
			if (!res.ok) setError(data.error ?? `创建失败 (${res.status})`);
			else {
				onSuccess(slug);
				onClose();
			}
		} catch (err) {
			setError(`网络异常: ${String(err)}`);
		} finally {
			setBusy(false);
		}
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: "vectr-modal-backdrop",
		onClick: onClose,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "vectr-modal-card vectr-modal-card--narrow",
			onClick: (e) => e.stopPropagation(),
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "vectr-drawer-head",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						fontWeight: 600,
						fontSize: 16
					},
					children: "添加 Codebase"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "vectr-btn vectr-btn-dense vectr-btn-secondary vectr-btn-icon",
					"aria-label": "关闭面板",
					onClick: onClose,
					children: "✕"
				})]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
				onSubmit: handleSubmit,
				className: "vectr-sheet-body",
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 14
				},
				children: [
					error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							padding: "8px 12px",
							borderRadius: 6,
							background: "var(--dsw-alias-interactive-bg-hover-danger)",
							color: "var(--dsw-alias-state-error-primary)",
							fontSize: 12
						},
						children: error
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "vectr-label",
							htmlFor: "codebase-slug",
							children: ["Slug 标识 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { color: "var(--dsw-alias-state-error-primary)" },
								children: "*"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							id: "codebase-slug",
							className: "vectr-input",
							style: { width: "100%" },
							value: slug,
							onChange: (e) => handleSlugChange(e.target.value.trim()),
							placeholder: "e.g. backend-service, auth-api",
							required: true
						}),
						slugError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								color: "var(--dsw-alias-state-error-primary)",
								fontSize: 11,
								marginTop: 4
							},
							children: slugError
						})
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						children: "类型"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 16
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "vectr-choice",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: "cb-type",
								checked: type === "local",
								onChange: () => handleTypeChange("local")
							}), "本地代码库 (Local)"]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "vectr-choice",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "radio",
								name: "cb-type",
								checked: type === "remote",
								onChange: () => handleTypeChange("remote")
							}), "远程代码库 (Remote via SSH)"]
						})]
					})] }),
					type === "local" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: "vectr-label",
						htmlFor: "codebase-path",
						children: ["本地目录路径 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: { color: "var(--dsw-alias-state-error-primary)" },
							children: "*"
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "codebase-path",
						className: "vectr-input",
						style: { width: "100%" },
						value: path,
						onChange: (e) => handlePathChange(e.target.value),
						placeholder: "/path/to/local/project",
						required: true
					})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: 12
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 10
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { flex: 2 },
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "vectr-label",
										htmlFor: "cb-host",
										children: ["远程主机 (Host) ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: { color: "var(--dsw-alias-state-error-primary)" },
											children: "*"
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "cb-host",
										className: "vectr-input",
										style: { width: "100%" },
										value: host,
										onChange: (e) => setHost(e.target.value.trim()),
										placeholder: "user@192.168.1.100",
										required: true
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: { flex: 1 },
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										className: "vectr-label",
										htmlFor: "cb-rport",
										children: "远程端口 (可选)"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: "cb-rport",
										type: "number",
										className: "vectr-input",
										style: { width: "100%" },
										value: remotePort,
										placeholder: "自动检测 (留空即可)",
										onChange: (e) => setRemotePort(e.target.value)
									})]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "vectr-label",
								htmlFor: "cb-rpath",
								children: ["远程工作区路径 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { color: "var(--dsw-alias-state-error-primary)" },
									children: "*"
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								id: "cb-rpath",
								className: "vectr-input",
								style: { width: "100%" },
								value: remotePath,
								onChange: (e) => handleRemotePathChange(e.target.value),
								placeholder: "/home/user/project",
								required: true
							})] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
									className: "vectr-label",
									children: "认证凭据隔离"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										gap: 16,
										marginBottom: 8
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "vectr-choice",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "auth-type",
											checked: authType === "key",
											onChange: () => setAuthType("key")
										}), "SSH Key (免密 / 默认)"]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: "vectr-choice",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "auth-type",
											checked: authType === "password",
											onChange: () => setAuthType("password")
										}), "SSH 密码 (安全隔离存储)"]
									})]
								}),
								authType === "password" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "password",
									className: "vectr-input",
									style: { width: "100%" },
									value: password,
									onChange: (e) => setPassword(e.target.value),
									placeholder: "输入 SSH 密码（不会明文落盘到元数据）",
									required: true
								})
							] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "vectr-meta",
						style: { paddingTop: 4 },
						children: ["挂载归属工作区: ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: workspace })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							justifyContent: "flex-end",
							gap: 10,
							marginTop: 10,
							paddingTop: 14,
							borderTop: "1px solid var(--dsw-alias-border-l2)"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: BTN.secondary,
							onClick: onClose,
							disabled: busy,
							children: "取消"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "submit",
							className: BTN.primary,
							disabled: busy || !isSlugValid || (type === "local" ? !normalizePath(path) : !host.trim() || !normalizePath(remotePath)),
							children: busy ? "创建中…" : "创建 Codebase"
						})]
					})
				]
			})]
		})
	});
}
//#endregion
//#region src/client/MemoryViewer.tsx
/**
* Working Memory Viewer (Recall & Resume) for Vectr.
*
* (Layer 4: Presentation)
*
* @module dsh-vectr-client/client/MemoryViewer
*/
function MemoryViewer({ workspace, port, live }) {
	const [subTab, setSubTab] = (0, react.useState)("recall");
	const [query, setQuery] = (0, react.useState)("");
	const [kind, setKind] = (0, react.useState)("all");
	const [detail, setDetail] = (0, react.useState)("full");
	const [limit, setLimit] = (0, react.useState)(10);
	const [recallBusy, setRecallBusy] = (0, react.useState)(false);
	const [recalledText, setRecalledText] = (0, react.useState)(null);
	const [recallError, setRecallError] = (0, react.useState)(null);
	const [resumeBusy, setResumeBusy] = (0, react.useState)(false);
	const [resumeData, setResumeData] = (0, react.useState)(null);
	const [resumeError, setResumeError] = (0, react.useState)(null);
	const handleRecall = async () => {
		if (!live) return;
		setRecallBusy(true);
		setRecallError(null);
		try {
			const res = await fetch("/api/vectr/notes/recall", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					workspace,
					...port ? { port } : {},
					query: query.trim() || void 0,
					kind: kind !== "all" ? kind : void 0,
					detail,
					limit
				})
			});
			const data = await res.json();
			if (!res.ok || !data.ok) setRecallError(data.error ?? `检索失败 (${res.status})`);
			else setRecalledText(data.notes ?? "未找到相关工作记忆");
		} catch (err) {
			setRecallError(`网络异常: ${String(err)}`);
		} finally {
			setRecallBusy(false);
		}
	};
	const handleResume = async () => {
		if (!live) return;
		setResumeBusy(true);
		setResumeError(null);
		try {
			const params = new URLSearchParams();
			if (workspace) params.set("workspace", workspace);
			if (port) params.set("port", String(port));
			const res = await fetch(`/api/vectr/notes/resume?${params.toString()}`);
			const data = await res.json();
			if (!res.ok || !data.ok) setResumeError(data.error ?? `获取接续状态失败 (${res.status})`);
			else setResumeData(data.data ?? null);
		} catch (err) {
			setResumeError(`网络异常: ${String(err)}`);
		} finally {
			setResumeBusy(false);
		}
	};
	if (!live) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		className: "vectr-state",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			className: "vectr-state-hint",
			children: "Vectr 实例当前处于离线状态，启动后即可访问工作记忆（Recall & Resume）。"
		})
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			display: "flex",
			flexDirection: "column",
			gap: 14
		},
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				display: "flex",
				gap: 8,
				borderBottom: "1px solid var(--dsw-alias-border-l2)",
				paddingBottom: 2
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: `vectr-tab-btn ${subTab === "recall" ? "active" : ""}`,
				onClick: () => setSubTab("recall"),
				children: "Note 记忆检索 (Recall)"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: `vectr-tab-btn ${subTab === "resume" ? "active" : ""}`,
				onClick: () => {
					setSubTab("resume");
					if (!resumeData && !resumeBusy) handleResume();
				},
				children: "任务接续 (Resume)"
			})]
		}), subTab === "recall" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				display: "flex",
				flexDirection: "column",
				gap: 12
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "vectr-form-row",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							className: "vectr-input",
							style: { flex: 1 },
							value: query,
							onChange: (e) => setQuery(e.target.value),
							placeholder: "输入关键词检索 Note (如: architecture, lock, bug, schema)...",
							onKeyDown: (e) => {
								if (e.key === "Enter") handleRecall();
							}
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "vectr-select",
							value: kind,
							onChange: (e) => setKind(e.target.value),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "all",
									children: "类型: 全部"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "directive",
									children: "directive (指令规范)"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "task",
									children: "task (当前任务)"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "gotcha",
									children: "gotcha (易踩坑点)"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "finding",
									children: "finding (发现记录)"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "decision",
									children: "decision (架构决策)"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "vectr-select",
							value: detail,
							onChange: (e) => setDetail(e.target.value),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "full",
								children: "详情: 完整内容"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "index",
								children: "详情: 单行摘要"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							className: "vectr-select",
							value: limit,
							onChange: (e) => setLimit(parseInt(e.target.value, 10)),
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: 5,
									children: "数量: 5"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: 10,
									children: "数量: 10"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: 20,
									children: "数量: 20"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: BTN.primary,
							onClick: () => void handleRecall(),
							disabled: recallBusy,
							children: recallBusy ? "检索中…" : "检索"
						})
					]
				}),
				recallError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "vectr-error",
					children: recallError
				}),
				recalledText !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "vectr-scrollport",
					style: {
						maxHeight: "min(380px, 40dvh)",
						background: "var(--dsw-alias-bg-layer-1)",
						border: "1px solid var(--dsw-alias-border-l2)",
						borderRadius: 8,
						padding: "12px 16px",
						fontSize: 13,
						fontFamily: "var(--ds-font-family-code)",
						whiteSpace: "pre-wrap",
						lineHeight: 1.5
					},
					children: recalledText
				})
			]
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				display: "flex",
				flexDirection: "column",
				gap: 12
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontSize: 13,
							color: "var(--dsw-alias-label-secondary)"
						},
						children: "Deterministic 'pick up where you left off' 状态视图 (上一次任务、快照与 Gotchas)"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: BTN.secondary,
						onClick: () => void handleResume(),
						disabled: resumeBusy,
						children: resumeBusy ? "刷新中…" : "刷新 Resume"
					})]
				}),
				resumeError && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "vectr-error",
					children: resumeError
				}),
				resumeData && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 10
					},
					children: [
						resumeData.last_task && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "vectr-note-card",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontWeight: 600,
									color: "var(--dsw-alias-label-primary)",
									marginBottom: 4
								},
								children: "最近任务 (Last Task)"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: { fontSize: 13 },
								children: resumeData.last_task.title || resumeData.last_task.content || JSON.stringify(resumeData.last_task)
							})]
						}),
						resumeData.gotchas && resumeData.gotchas.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "vectr-note-card",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									fontWeight: 600,
									color: "var(--dsw-alias-state-warn-primary)",
									marginBottom: 4
								},
								children: [
									"关联避坑项 (Gotchas: ",
									resumeData.gotchas.length,
									")"
								]
							}), resumeData.gotchas.map((g, idx) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									marginTop: 4,
									paddingLeft: 8,
									borderLeft: "2px solid var(--dsw-alias-state-warn-primary)"
								},
								children: [g.file_path && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", {
									style: { fontSize: 11 },
									children: [
										"[",
										g.file_path,
										"] "
									]
								}), g.content || g.title]
							}, idx))]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "vectr-scrollport",
							style: {
								maxHeight: "min(300px, 35dvh)",
								background: "var(--dsw-alias-bg-layer-1)",
								border: "1px solid var(--dsw-alias-border-l2)",
								borderRadius: 8,
								padding: "12px 16px",
								fontSize: 12,
								fontFamily: "var(--ds-font-family-code)",
								whiteSpace: "pre-wrap"
							},
							children: resumeData.formatted
						})
					]
				})
			]
		})]
	});
}
//#endregion
//#region src/client/SessionDrawerModal.tsx
/**
* Session Drawer Modal for Vectr status, codebase management, init, and working memory.
*
* (Layer 4: Presentation)
*
* @module dsh-vectr-client/client/SessionDrawerModal
*/
/**
* Bilingual copy for the 运行就绪 row, keyed by the unified status kind.
* Presentation only — the kind always comes from `resolveUnifiedStatus`, so a
* resolver change (e.g. `fully_ready:true` moving off 'indexing') is reflected
* here without re-deriving status from raw daemon flags.
*/
const READINESS_COPY = {
	ready: "已就绪 (Ready)",
	initializing: "构建中…",
	indexing: "构建中…",
	memory_only: "仅记忆 (Memory Only)",
	search_only: "仅检索 (Search Only)",
	offline: "未运行 (Offline)",
	unknown: "未知 (Unknown)"
};
function SessionDrawerModal({ workspace, state, loading, isOpen, onClose, onRefresh, initialTab = "codebases" }) {
	const [activeTab, setActiveTab] = (0, react.useState)(initialTab);
	const [showAddModal, setShowAddModal] = (0, react.useState)(false);
	const [reindexing, setReindexing] = (0, react.useState)(false);
	const [reindexMsg, setReindexMsg] = (0, react.useState)(null);
	const [initHooks, setInitHooks] = (0, react.useState)(true);
	const [initMemoryOnly, setInitMemoryOnly] = (0, react.useState)(false);
	const [initAutoStart, setInitAutoStart] = (0, react.useState)(true);
	const [initBusy, setInitBusy] = (0, react.useState)(false);
	const [initResult, setInitResult] = (0, react.useState)(null);
	const [startingDaemon, setStartingDaemon] = (0, react.useState)(false);
	const [startDaemonMsg, setStartDaemonMsg] = (0, react.useState)(null);
	const [upgrading, setUpgrading] = (0, react.useState)(false);
	const [upgradeMsg, setUpgradeMsg] = (0, react.useState)(null);
	const [busySlug, setBusySlug] = (0, react.useState)(null);
	const [codebaseMsg, setCodebaseMsg] = (0, react.useState)(null);
	const [confirmDeleteSlug, setConfirmDeleteSlug] = (0, react.useState)(null);
	if (!isOpen) return null;
	const live = state?.live === true;
	const status = state?.status;
	const unifiedStatus = resolveUnifiedStatus({
		live,
		mode: state?.mode,
		status,
		reason: state?.reason,
		error: state?.error
	});
	const canonicalMode = formatMode(state?.mode, live);
	const isMemoryOnly$1 = canonicalMode === "memory_only";
	const handleReindex = async () => {
		setReindexing(true);
		setReindexMsg(null);
		try {
			const res = await fetch("/api/vectr/session-reindex", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ workspace })
			});
			const data = await res.json();
			if (res.ok && data.ok) setReindexMsg({
				ok: true,
				text: "重新索引已触发并开始后台构建"
			});
			else setReindexMsg({
				ok: false,
				text: data.error ?? `触发失败 (${res.status})`
			});
		} catch (err) {
			setReindexMsg({
				ok: false,
				text: `请求异常: ${String(err)}`
			});
		} finally {
			setReindexing(false);
		}
	};
	const handleUpgrade = async () => {
		setUpgrading(true);
		setUpgradeMsg(null);
		try {
			const res = await fetch("/api/vectr/upgrade", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ workspace })
			});
			const data = await res.json();
			if (res.ok && data.ok) {
				setUpgradeMsg({
					ok: true,
					text: "工作区已成功升级为完整模式 (Full Mode)！"
				});
				onRefresh();
			} else setUpgradeMsg({
				ok: false,
				text: data.error ?? `升级失败 (${res.status})`
			});
		} catch (err) {
			setUpgradeMsg({
				ok: false,
				text: `升级请求失败: ${String(err)}`
			});
		} finally {
			setUpgrading(false);
		}
	};
	const handleStartSessionDaemon = async () => {
		setStartingDaemon(true);
		setStartDaemonMsg(null);
		try {
			const res = await fetch("/api/vectr/session-start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					workspace,
					memoryOnly: isMemoryOnly$1 || initMemoryOnly
				})
			});
			const data = await res.json();
			if (res.ok && data.ok) {
				setStartDaemonMsg({
					ok: true,
					text: `Vectr 守护进程启动成功${data.port ? ` (端口: ${data.port})` : ""}！`
				});
				onRefresh();
				return true;
			} else {
				setStartDaemonMsg({
					ok: false,
					text: data.error ?? `启动失败 (${res.status})`
				});
				return false;
			}
		} catch (err) {
			setStartDaemonMsg({
				ok: false,
				text: `启动异常: ${String(err)}`
			});
			return false;
		} finally {
			setStartingDaemon(false);
		}
	};
	const handleInit = async () => {
		setInitBusy(true);
		setInitResult(null);
		try {
			const data = await (await fetch("/api/vectr/init", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					workspace,
					hooks: initHooks,
					memoryOnly: initMemoryOnly
				})
			})).json();
			if (data.ok) {
				if (initAutoStart) {
					setInitResult({
						ok: true,
						text: `Vectr 工作区配置已初始化！正在自动拉起守护进程…`
					});
					if (await handleStartSessionDaemon()) setInitResult({
						ok: true,
						text: `✅ Vectr 工作区初始化完成，且守护进程已成功拉起就绪！\n语义检索与工作记忆已正常启用。${data.stdout ? `\n\n${data.stdout}` : ""}`
					});
					else setInitResult({
						ok: false,
						text: `⚠️ 工作区配置文件已生成，但自动拉起守护进程失败。你可以点击“启动守护进程”重试。`
					});
				} else {
					setInitResult({
						ok: true,
						text: `Vectr 工作区初始化完成！\n提示：守护进程尚未运行，请点击“启动守护进程”按钮以启用服务。${data.stdout ? `\n\n${data.stdout}` : ""}`
					});
					onRefresh();
				}
			} else setInitResult({
				ok: false,
				text: `初始化失败: ${data.error || data.stderr || "未知错误"}`
			});
		} catch (err) {
			setInitResult({
				ok: false,
				text: `网络错误: ${String(err)}`
			});
		} finally {
			setInitBusy(false);
		}
	};
	const handleTestCodebase = async (slug) => {
		setBusySlug(slug);
		setCodebaseMsg(null);
		try {
			const wsParam = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
			const res = await fetch(`/api/vectr/codebases/${encodeURIComponent(slug)}/test${wsParam}`, { method: "POST" });
			const data = await res.json();
			if (res.ok && data.ok) setCodebaseMsg({
				ok: true,
				text: `Codebase "${slug}" 连通性测试通过`
			});
			else setCodebaseMsg({
				ok: false,
				text: `Codebase "${slug}" 连通失败: ${data.error ?? res.status}`
			});
			onRefresh();
		} catch (err) {
			setCodebaseMsg({
				ok: false,
				text: `测试请求失败: ${String(err)}`
			});
		} finally {
			setBusySlug(null);
		}
	};
	const handleStartDaemon = async (slug) => {
		setBusySlug(`${slug}:start`);
		setCodebaseMsg(null);
		try {
			const wsParam = workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
			const res = await fetch(`/api/vectr/codebases/${encodeURIComponent(slug)}/start${wsParam}`, { method: "POST" });
			const data = await res.json();
			if (res.ok && data.ok) setCodebaseMsg({
				ok: true,
				text: `Codebase "${slug}" 守护进程已自动拉起并恢复连通！`
			});
			else setCodebaseMsg({
				ok: false,
				text: `拉起守护进程失败: ${data.error ?? res.status}`
			});
			onRefresh();
		} catch (err) {
			setCodebaseMsg({
				ok: false,
				text: `拉起守护进程请求异常: ${String(err)}`
			});
		} finally {
			setBusySlug(null);
		}
	};
	const executeDeleteCodebase = async (slug) => {
		setBusySlug(slug);
		setConfirmDeleteSlug(null);
		setCodebaseMsg(null);
		try {
			const res = await fetch(`/api/vectr/codebases/${encodeURIComponent(slug)}`, { method: "DELETE" });
			if (res.ok) {
				setCodebaseMsg({
					ok: true,
					text: `Codebase "${slug}" 已解绑删除`
				});
				onRefresh();
			} else {
				const data = await res.json();
				setCodebaseMsg({
					ok: false,
					text: `删除失败: ${data.error ?? res.status}`
				});
			}
		} catch (err) {
			setCodebaseMsg({
				ok: false,
				text: `删除请求异常: ${String(err)}`
			});
		} finally {
			setBusySlug(null);
		}
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "vectr-modal-backdrop",
		onClick: onClose,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "vectr-modal-card",
			onClick: (e) => e.stopPropagation(),
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "vectr-drawer-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 10
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "vectr-mark",
							style: { fontSize: 18 },
							"aria-hidden": "true",
							children: "⚡"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: 8,
								flexWrap: "wrap"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "vectr-drawer-title",
									children: "Vectr 会话工作区面板"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: `vectr-pill ${unifiedStatus.kind === "ready" ? "vectr-pill-live vectr-pill-live-filled" : unifiedStatus.isBusy || unifiedStatus.kind === "search_only" || unifiedStatus.kind === "memory_only" ? "vectr-pill-pending vectr-pill-pending-filled" : "vectr-pill-offline"}`,
									title: unifiedStatus.description,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "vectr-pill-dot",
										"aria-hidden": "true"
									}), unifiedStatus.label]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "vectr-pill",
									children: canonicalMode
								}),
								state?.port && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "vectr-meta",
									children: [
										"Port: ",
										state.port,
										" ",
										state.pid ? `(PID ${state.pid})` : ""
									]
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "vectr-card-path",
							title: workspace,
							children: workspace
						})] })]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8
						},
						children: [
							!live && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: BTN.primary,
								onClick: () => void handleStartSessionDaemon(),
								disabled: startingDaemon,
								title: "一键启动当前工作区的 Vectr 守护进程",
								children: startingDaemon ? "启动中…" : "⚡ 启动守护进程"
							}),
							state !== null && !isMemoryOnly(state.mode) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DowngradeButton, {
								workspace,
								onDowngraded: onRefresh
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: BTN.secondary,
								onClick: onRefresh,
								disabled: loading,
								title: "刷新状态",
								children: loading ? "…" : "🔄 刷新"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "vectr-btn vectr-btn-dense vectr-btn-secondary vectr-btn-icon",
								"aria-label": "关闭面板",
								onClick: onClose,
								title: "关闭",
								children: "✕"
							})
						]
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "vectr-metric-grid",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "vectr-metric-card",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "vectr-metric-title",
									children: "索引文件数"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "vectr-metric-value",
									children: isMemoryOnly$1 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "vectr-metric-na",
										children: "N/A (仅记忆)"
									}) : status?.indexed_files ?? (live ? 0 : "-")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "vectr-metric-hint",
									children: isMemoryOnly$1 ? "无代码目录正常工作" : "已入库文件"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "vectr-metric-card",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "vectr-metric-title",
									children: "代码块数"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "vectr-metric-value",
									children: isMemoryOnly$1 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "vectr-metric-na",
										children: "N/A"
									}) : status?.total_chunks ?? (live ? 0 : "-")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "vectr-metric-hint",
									children: isMemoryOnly$1 ? "不建索引" : "语义向量切片"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "vectr-metric-card",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "vectr-metric-title",
									children: "记忆条目数"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "vectr-metric-value",
									children: status?.notes_count ?? (live ? 0 : "-")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "vectr-metric-hint",
									children: "工作记忆 (Notes)"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "vectr-metric-card",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "vectr-metric-title",
									children: "⚡ 运行就绪"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: 14,
										fontWeight: 600
									},
									title: `${unifiedStatus.label}${unifiedStatus.description ? ` — ${unifiedStatus.description}` : ""}`,
									children: READINESS_COPY[unifiedStatus.kind]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "vectr-metric-hint",
									children: status?.embed_model ? status.embed_model.split("/").pop() : "嵌入模型未就绪"
								}),
								unifiedStatus.background && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "vectr-metric-hint",
									children: unifiedStatus.background
								})
							]
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "vectr-tab-row",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: `vectr-tab-btn ${activeTab === "codebases" ? "active" : ""}`,
							onClick: () => setActiveTab("codebases"),
							children: [
								"挂载代码库 (",
								state?.codebases.length ?? 0,
								")"
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: `vectr-tab-btn ${activeTab === "memory" ? "active" : ""}`,
							onClick: () => setActiveTab("memory"),
							children: "工作记忆检索 (Memory)"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: `vectr-tab-btn ${activeTab === "ops" ? "active" : ""}`,
							onClick: () => setActiveTab("ops"),
							children: "维护与初始化 (Init)"
						})
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "vectr-sheet-body",
					children: [
						activeTab === "codebases" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 14
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontSize: 13,
											color: "var(--dsw-alias-label-secondary)"
										},
										children: "当前工作区已绑定的代码库列表："
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: BTN.primary,
										onClick: () => setShowAddModal(true),
										children: "+ 添加 Codebase"
									})]
								}),
								codebaseMsg && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: codebaseMsg.ok ? "vectr-result" : "vectr-error",
									children: codebaseMsg.text
								}),
								!state?.codebases || state.codebases.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "vectr-state",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "vectr-state-hint",
										children: "当前工作区暂未挂载 Codebase，可点击上方“添加 Codebase”进行配置绑定。"
									})
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "vectr-scroll",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
										style: {
											width: "100%",
											minWidth: 620,
											borderCollapse: "collapse",
											fontSize: 13
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
											style: {
												borderBottom: "1px solid var(--dsw-alias-border-l2)",
												textAlign: "left",
												color: "var(--dsw-alias-label-secondary)"
											},
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
													style: { padding: "8px 10px" },
													children: "Slug"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
													style: { padding: "8px 10px" },
													children: "类型"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
													style: { padding: "8px 10px" },
													children: "目标路径 / 主机"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
													style: { padding: "8px 10px" },
													children: "状态"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
													style: {
														padding: "8px 10px",
														textAlign: "right"
													},
													children: "操作"
												})
											]
										}) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: state.codebases.map((cb) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", {
											style: { borderBottom: "1px solid var(--dsw-alias-border-l2)" },
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
													style: {
														padding: "10px",
														fontWeight: 600
													},
													children: [cb.slug, cb.isPrimary && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "vectr-pill vectr-pill-pending",
														style: { marginLeft: 6 },
														children: "Primary"
													})]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: { padding: "10px" },
													children: cb.type === "remote" ? "Remote" : "Local"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: {
														padding: "10px",
														fontFamily: "monospace",
														fontSize: 12
													},
													children: cb.target
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: { padding: "10px" },
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														style: {
															fontWeight: 600,
															color: cb.status === "up" ? "var(--dsw-alias-label-primary)" : cb.status === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-secondary)"
														},
														title: cb.error || "",
														children: cb.status
													})
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
													style: {
														padding: "10px",
														textAlign: "right"
													},
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
														style: {
															display: "inline-flex",
															gap: 6,
															alignItems: "center"
														},
														children: cb.isPrimary ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															className: BTN.secondary,
															disabled: true,
															style: {
																opacity: .5,
																cursor: "not-allowed"
															},
															title: "工作区主代码库不可解绑删除",
															children: "不可删除"
														}) : confirmDeleteSlug === cb.slug ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															className: BTN.danger,
															onClick: () => void executeDeleteCodebase(cb.slug),
															disabled: busySlug === cb.slug,
															children: busySlug === cb.slug ? "删除中…" : "确认解绑？"
														}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															className: BTN.secondary,
															onClick: () => setConfirmDeleteSlug(null),
															disabled: busySlug === cb.slug,
															children: "取消"
														})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																type: "button",
																className: BTN.action,
																onClick: () => void handleTestCodebase(cb.slug),
																disabled: busySlug === cb.slug || busySlug === `${cb.slug}:start`,
																children: "测试连通性"
															}),
															(cb.isPrimary && cb.status !== "up" || !cb.isPrimary && (cb.type === "remote" || cb.status !== "up")) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																type: "button",
																className: BTN.secondary,
																onClick: () => void handleStartDaemon(cb.slug),
																disabled: busySlug === cb.slug || busySlug === `${cb.slug}:start`,
																title: cb.isPrimary ? "拉起当前主工作区 Vectr 守护进程" : "在远端或本地拉起 Vectr 守护进程并重建隧道",
																children: busySlug === `${cb.slug}:start` ? "拉起中…" : "自动拉起"
															}),
															/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
																type: "button",
																className: BTN.danger,
																onClick: () => setConfirmDeleteSlug(cb.slug),
																disabled: busySlug === cb.slug || busySlug === `${cb.slug}:start`,
																children: "解绑/删除"
															})
														] })
													})
												})
											]
										}, cb.slug)) })]
									})
								})
							]
						}),
						activeTab === "memory" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MemoryViewer, {
							workspace,
							port: state?.port,
							live
						}),
						activeTab === "ops" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 20
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									padding: 16,
									border: "1px solid var(--dsw-alias-border-l2)",
									borderRadius: 8
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontWeight: 600,
											fontSize: 14,
											marginBottom: 4
										},
										children: "🔄 触发重新索引 (Re-index)"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											fontSize: 12,
											color: "var(--dsw-alias-label-secondary)",
											marginBottom: 12
										},
										children: [
											"向守护进程发送 ",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "POST /v1/index" }),
											"，更新代码符号与语义向量切片。"
										]
									}),
									isMemoryOnly$1 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											flexDirection: "column",
											gap: 10
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "vectr-result",
												children: [
													"当前工作区运行在 ",
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "memory_only" }),
													" 模式，禁止发起索引请求（原生支持仅工作记忆与 hooks，无需代码目录，不建索引）。"
												]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: BTN.primary,
												disabled: upgrading,
												onClick: () => void handleUpgrade(),
												children: upgrading ? "升级中…" : "⚡ 升级为完整模式 (启用代码检索)"
											}) }),
											upgradeMsg && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
												className: upgradeMsg.ok ? "vectr-result" : "vectr-error",
												children: upgradeMsg.text
											})
										]
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: BTN.primary,
											disabled: !state?.canReindex || reindexing,
											onClick: () => void handleReindex(),
											children: reindexing ? "触发中…" : "立即触发 Re-index"
										}),
										!state?.canReindex && state?.reindexDisabledReason && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: {
												fontSize: 12,
												color: "var(--dsw-alias-label-tertiary)",
												marginLeft: 12
											},
											children: [
												"(",
												state.reindexDisabledReason,
												")"
											]
										}),
										!live && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												marginTop: 12,
												display: "flex",
												alignItems: "center",
												gap: 10
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: BTN.primary,
												disabled: startingDaemon,
												onClick: () => void handleStartSessionDaemon(),
												children: startingDaemon ? "启动中…" : "⚡ 启动 Vectr 守护进程 (vectr start)"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													fontSize: 12,
													color: "var(--dsw-alias-label-secondary)"
												},
												children: "当前未检测到活跃进程，请先启动服务。"
											})]
										})
									] }),
									startDaemonMsg && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: { marginTop: 10 },
										className: startDaemonMsg.ok ? "vectr-result" : "vectr-error",
										children: startDaemonMsg.text
									}),
									reindexMsg && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: { marginTop: 10 },
										className: reindexMsg.ok ? "vectr-result" : "vectr-error",
										children: reindexMsg.text
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									padding: 16,
									border: "1px solid var(--dsw-alias-border-l2)",
									borderRadius: 8
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontWeight: 600,
											fontSize: 14,
											marginBottom: 4
										},
										children: "🚀 初始化工作区 (vectr init)"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 12,
											color: "var(--dsw-alias-label-secondary)",
											marginBottom: 12
										},
										children: "为当前工作区生成 IDE 规范文件（CLAUDE.md、.mcp.json、.vectrignore 等）并配置 Hooks。"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											flexDirection: "column",
											gap: 8,
											marginBottom: 14
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												className: "vectr-choice",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: initHooks,
													onChange: (e) => setInitHooks(e.target.checked)
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
													"写入 Claude Code Hooks (",
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "--hooks" }),
													", 自动注入 SessionStart / UserPrompt 记忆)"
												] })]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												className: "vectr-choice",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: initMemoryOnly,
													onChange: (e) => setInitMemoryOnly(e.target.checked)
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
													"仅工作记忆模式 (",
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "--memory-only" }),
													" / ",
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "--style memory-only" }),
													"，无代码目录正常工作)"
												] })]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												className: "vectr-choice",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "checkbox",
													checked: initAutoStart,
													onChange: (e) => setInitAutoStart(e.target.checked)
												}), "初始化完成后自动启动守护进程 (推荐，一键就绪)"]
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: BTN.primary,
										disabled: initBusy,
										onClick: () => void handleInit(),
										children: initBusy ? "初始化执行中…" : "执行 vectr init"
									}),
									initResult && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: { marginTop: 10 },
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: {
												fontFamily: "var(--ds-font-family-code)",
												whiteSpace: "pre-wrap"
											},
											className: initResult.ok ? "vectr-result" : "vectr-error",
											children: initResult.text
										}), !live && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: { marginTop: 8 },
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: BTN.primary,
												disabled: startingDaemon,
												onClick: () => void handleStartSessionDaemon(),
												children: startingDaemon ? "启动中…" : "▶️ 立即启动守护进程"
											})
										})]
									})
								]
							})]
						})
					]
				})
			]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CodebaseModal, {
			workspace,
			isOpen: showAddModal,
			onClose: () => setShowAddModal(false),
			onSuccess: () => {
				setCodebaseMsg({
					ok: true,
					text: "Codebase 添加成功"
				});
				onRefresh();
			}
		})]
	});
}
//#endregion
//#region src/client/VectrDialogRoot.tsx
/**
* Global singleton modal root for Vectr.
*
* Subscribes to `dialogCoordinator` and renders a single instance of `SessionDrawerModal`.
* Avoids duplicate modals and overlapping backdrops across trigger slots.
*
* @module dsh-vectr-client/client/VectrDialogRoot
*/
function VectrDialogRoot() {
	const [isOpen, setIsOpen] = (0, react.useState)(false);
	const [workspace, setWorkspace] = (0, react.useState)(void 0);
	const [state, setState] = (0, react.useState)(null);
	const [loading, setLoading] = (0, react.useState)(false);
	(0, react.useEffect)(() => {
		return dialogCoordinator.subscribe((coordState) => {
			setIsOpen(coordState.isOpen);
			setWorkspace(coordState.workspace);
		});
	}, []);
	const fetchStatus = async (ws, signal) => {
		if (!ws) return;
		setLoading(true);
		try {
			const res = await fetch(`/api/vectr/session-status?workspace=${encodeURIComponent(ws)}`, signal ? { signal } : void 0);
			if (res.ok) {
				const data = await res.json();
				setState(data);
			} else setState(null);
		} catch (err) {
			if (err?.name === "AbortError" || signal?.aborted) return;
			setState(null);
		} finally {
			if (!signal?.aborted) setLoading(false);
		}
	};
	(0, react.useEffect)(() => {
		if (isOpen && workspace) {
			const controller = new AbortController();
			fetchStatus(workspace, controller.signal);
			return () => {
				controller.abort();
			};
		} else if (!isOpen) setState(null);
	}, [isOpen, workspace]);
	if (!isOpen || !workspace) return null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VectrStyles, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionDrawerModal, {
		workspace,
		state,
		loading,
		isOpen,
		onClose: () => dialogCoordinator.close(),
		onRefresh: () => {
			if (workspace) fetchStatus(workspace);
		}
	})] });
}
//#endregion
//#region src/client/index.tsx
/**
* Browser half of the vectr workspace console (feature A / C1) — **阶段2**: the
* multi-codebase manager is merged INTO this panel (no separate Codebases tab).
*
* A thin React view mounted as the top-level **Settings → Vectr** section via the
* `settings.section` slot (hosted by the VectrSettings shell). All data lives on
* the host: this half only fetches the same-origin relative endpoints the host
* registered (`/api/vectr/workspaces`, `/api/vectr/codebases`,
* `/api/vectr/trigger-index`) and renders:
*
*  - one **workspace card** per registered workspace: identity, state pills
*    (liveness / canonical mode / readiness), the key index facts and the
*    re-index control,
*  - a card toggle that expands a **codebase sub-table** (5 cols: name / type /
*    target / status / actions) listing the codebases whose `workspace` equals
*    that card's workspace,
*  - a create form inside every expanded card, pre-bound to that card's
*    workspace (the 阶段2 "form reports workspace" requirement).
*
* The host serves this bundle from `lib/client.js` (the `dsh.client` dual-face
* declaration), so bare imports of `react` and the slot service resolve through
* the host's module table at runtime. Only `react` is imported as a value; the
* Cordis client context is typed structurally so the host build needs no extra
* type packages.
*
* @module dsh-vectr-client/client
*/
/** Reason a row's re-index button is disabled, or undefined when enabled. */
function reindexDisabledReason(view) {
	if (!view.live) return view.error ?? "daemon offline";
	const mode = normalizeMode(view.mode);
	if (mode === "memory_only" || mode === "search_only") return `daemon in '${mode}' mode cannot be re-indexed`;
	if (view.status?.reindex_in_progress) return "re-index already in progress";
	if (view.status?.fully_ready === false) return "daemon not fully_ready yet";
}
/** Single status pill: the dot carries the colour, the word carries the meaning.
*
* The word used to be painted with the state alias itself. It cannot pass contrast
* that way on this platform: `up` in var(--dsw-alias-state-success-primary) is
* rgb(34,197,94) = 2.28:1 on the panel's light surface — the number
* tests/e2e/visual-settings.spec.tsx carried in KNOWN_CONTRAST as a defect owned by
* this file — and the platform publishes nothing deeper than green-500 as a success
* alias (design-platform.css:270-272 light, :394-396 dark: primary=green-500,
* secondary=green-400, tertiary=green-100/900, a *fill*). So the state colour moves
* into the 6px dot — coloured by .vectr-pill-live / -error / -offline .vectr-pill-dot in
* buttons.tsx — which is decoration (`aria-hidden`, no text requirement), and the
* word sits on the label aliases: label-primary 18.9:1 light / 17.5:1 dark for up and
* error, label-secondary 5.8:1 light / 12.1:1 dark for down. `down` keeps the offline
* pill because "not running" is a neutral fact, not an error. */
function StatusPill(props) {
	const { status, error } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		className: `vectr-pill ${status === "down" ? "vectr-pill-offline" : status === "error" ? "vectr-pill-error" : "vectr-pill-live"}`,
		title: error ?? "",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "vectr-pill-dot",
			"aria-hidden": "true"
		}), status]
	});
}
/** Compact type indicator: 📁 local / 🌐 remote. */
function TypeCell(props) {
	const { type } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		style: { whiteSpace: "nowrap" },
		children: type === "remote" ? "🌐 remote" : "📁 local"
	});
}
/** Render the `target` column: local → path; remote → `host:remotePort → 127.0.0.1:localPort`. */
function TargetCell(props) {
	const { view } = props;
	const text = view.type === "remote" ? `${view.host ?? "?"} → 127.0.0.1:${view.localPort ?? "?"} (remote ${view.remotePort ?? "?"})` : view.path;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
		style: tdStyle,
		title: text,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: {
				...ellipsisStyle,
				maxWidth: 260
			},
			children: text
		})
	});
}
/** One codebase sub-row: 5 columns (name / type / target / status / actions). */
function CodebaseSubRow(props) {
	const { view, onTest, onStart, onDelete, busy } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			title: view.slug,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: ellipsisStyle,
				children: [view.slug, view.isPrimary && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						marginLeft: 4,
						padding: "1px 4px",
						borderRadius: 3,
						fontSize: 10,
						border: "1px solid var(--dsw-alias-label-tertiary)",
						color: "var(--dsw-alias-label-secondary)",
						fontWeight: 600
					},
					children: "Primary"
				})]
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TypeCell, { type: view.type })
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TargetCell, { view }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: tdStyle,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusPill, {
				status: view.status,
				error: view.error
			})
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
			style: {
				...tdStyle,
				whiteSpace: "nowrap"
			},
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					alignItems: "center",
					gap: 4,
					whiteSpace: "nowrap"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: BTN.action,
						disabled: busy,
						onClick: () => onTest(view.slug, view.workspace),
						children: "test"
					}),
					onStart && (view.type === "remote" || view.status !== "up") && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: BTN.secondary,
						disabled: busy,
						title: "自动拉起守护进程",
						onClick: () => onStart(view.slug, view.workspace),
						children: "start"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: BTN.danger,
						disabled: busy || view.isPrimary === true,
						title: view.isPrimary ? "Primary codebase cannot be deleted" : "Delete codebase",
						onClick: () => onDelete(view.slug),
						children: "delete"
					})
				]
			})
		})
	] });
}
/** The 5-column codebase sub-table for one workspace section (no large minWidth). */
function CodebaseSubTable(props) {
	const { entries, onTest, onStart, onDelete, busySlug } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: { margin: "4px 0 8px" },
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
			style: {
				borderCollapse: "collapse",
				width: "100%",
				minWidth: 460
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
					style: thStyle,
					children: "name"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
					style: thStyle,
					children: "type"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
					style: thStyle,
					children: "target"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
					style: thStyle,
					children: "status"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
					style: {
						...thStyle,
						minWidth: 130,
						whiteSpace: "nowrap"
					},
					children: "actions"
				})
			] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: entries.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
				style: tdStyle,
				colSpan: 5,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						color: "var(--dsw-alias-label-tertiary)",
						fontSize: 12
					},
					children: "no codebases in this workspace yet"
				})
			}) }) : entries.map((view) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CodebaseSubRow, {
				view,
				onTest,
				onStart,
				onDelete,
				busy: busySlug === view.slug
			}, view.slug)) })]
		})
	});
}
/** Create form, bound to the workspace card it is rendered in. */
function CodebaseCreateForm(props) {
	const { presetWorkspace, onCreated } = props;
	const [type, setType] = (0, react.useState)("local");
	const [slug, setSlug] = (0, react.useState)("");
	const [path, setPath] = (0, react.useState)(presetWorkspace);
	const [host, setHost] = (0, react.useState)("");
	const [auth, setAuth] = (0, react.useState)("key");
	const [password, setPassword] = (0, react.useState)("");
	const [formError, setFormError] = (0, react.useState)(null);
	const [creating, setCreating] = (0, react.useState)(false);
	const submit = (e) => {
		e.preventDefault();
		setFormError(null);
		if (isReservedPrimarySlug(slug)) {
			setFormError("Slug \"primary\" is reserved for the primary codebase");
			return;
		}
		setCreating(true);
		const reportedWorkspace = presetWorkspace;
		const normalizedPath = normalizePath(path);
		const body = {
			type,
			slug: slug.trim(),
			path: normalizedPath,
			workspace: reportedWorkspace
		};
		if (type === "remote") {
			body.host = host.trim();
			body.remotePath = normalizedPath;
			body.auth = auth;
			if (auth === "password") body.password = password;
		}
		fetch("/api/vectr/codebases", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body)
		}).then((res) => res.json()).then((result) => {
			if (result.error !== void 0) setFormError(result.error);
			else {
				setSlug("");
				setPath("");
				setHost("");
				setPassword("");
				onCreated();
			}
		}).catch((err) => setFormError(`create request error: ${String(err)}`)).finally(() => setCreating(false));
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
		onSubmit: submit,
		style: {
			display: "flex",
			flexDirection: "column",
			gap: 6,
			margin: "6px 0 4px 18px",
			maxWidth: 520
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					gap: 8,
					flexWrap: "wrap"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						htmlFor: "cb-type",
						children: "type"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						id: "cb-type",
						className: "vectr-select",
						value: type,
						onChange: (e) => {
							const nextType = e.target.value;
							setType(nextType);
							if (nextType === "remote") setPath("");
							else if (nextType === "local" && !path) setPath(presetWorkspace);
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "local",
							children: "local"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "remote",
							children: "remote"
						})]
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						htmlFor: "cb-slug",
						children: "slug"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "cb-slug",
						className: "vectr-input",
						value: slug,
						onChange: (e) => setSlug(e.target.value),
						placeholder: "my-codebase",
						required: true
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						htmlFor: "cb-path",
						children: "path"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "cb-path",
						className: "vectr-input",
						value: path,
						onChange: (e) => setPath(e.target.value),
						placeholder: type === "remote" ? "/remote/path/to/codebase" : "/abs/path",
						required: true
					})] })
				]
			}),
			type === "remote" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					gap: 8,
					flexWrap: "wrap"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						htmlFor: "cb-host",
						children: "host"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "cb-host",
						className: "vectr-input",
						value: host,
						onChange: (e) => setHost(e.target.value),
						placeholder: "user@host",
						required: true
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						htmlFor: "cb-auth",
						children: "auth"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						id: "cb-auth",
						className: "vectr-select",
						value: auth,
						onChange: (e) => setAuth(e.target.value),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "key",
							children: "key"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "password",
							children: "password"
						})]
					})] }),
					auth === "password" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						htmlFor: "cb-password",
						children: "password"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "cb-password",
						className: "vectr-input",
						type: "password",
						value: password,
						onChange: (e) => setPassword(e.target.value),
						placeholder: "••••••"
					})] }) : null
				]
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					gap: 8,
					alignItems: "flex-end",
					flexWrap: "wrap"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						flex: "1 1 240px",
						minWidth: 200
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
						className: "vectr-label",
						htmlFor: "cb-workspace",
						children: "workspace"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						id: "cb-workspace",
						className: "vectr-input",
						value: presetWorkspace,
						disabled: true,
						title: "bound to this workspace card"
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "submit",
					className: BTN.primary,
					disabled: creating || slug.length === 0 || path.length === 0,
					children: creating ? "…" : "create"
				})]
			}),
			formError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: { color: "var(--dsw-alias-state-error-primary)" },
				children: formError
			}) : null
		]
	});
}
/** Display name of one language entry ('' when the entry carries no name). */
function languageName(entry) {
	return typeof entry === "string" ? entry : entry.language ?? "";
}
/** `typescript, markdown` for the languages cell ('' when nothing is named). */
function languagesLabel(languages) {
	return (languages ?? []).map(languageName).filter((name) => name !== "").join(", ");
}
/** Per-language files/chunks/symbols for the languages cell tooltip, one line per
* language, so the detail the daemon reports is not thrown away by the label. */
function languagesTitle(languages) {
	return (languages ?? []).map((entry) => typeof entry === "string" ? entry : [
		languageName(entry),
		entry.files !== void 0 ? `${entry.files} files` : "",
		entry.chunks !== void 0 ? `${entry.chunks} chunks` : "",
		entry.symbols !== void 0 ? `symbols: ${entry.symbols ? "yes" : "no"}` : ""
	].filter((part) => part !== "").join(" · ")).filter((line) => line !== "").join("\n");
}
/** Tooltip for the files cell: the chunk count and last-indexed timestamp live
* here instead of in their own columns, so the table fits the settings modal. */
function indexSummary(status) {
	if (status === void 0) return "";
	return [status.total_chunks !== void 0 ? `${status.total_chunks} chunks` : "", `last indexed: ${status.last_indexed ?? "never"}`].filter((part) => part !== "").join(" · ");
}
/** Compact stat tile for the summary strip: a number plus a short label. */
function StatTile(props) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "vectr-stat",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "vectr-stat-value",
			children: props.value
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "vectr-stat-label",
			children: props.label
		})]
	});
}
/** Summary-strip counts, derived from the already-fetched workspace list. Every
* row lands in exactly one bucket, so live + memoryOnly + offline === total. */
function summarizeWorkspaces(views) {
	let live = 0;
	let memoryOnly = 0;
	let offline = 0;
	for (const view of views ?? []) if (isMemoryOnly(view.mode)) memoryOnly += 1;
	else if (view.live) live += 1;
	else offline += 1;
	return {
		total: (views ?? []).length,
		live,
		memoryOnly,
		offline
	};
}
/** Fetch both management endpoints together. A failure keeps the real message
* (`String(err)`, e.g. "Error: workspaces endpoint returned 500") so the panel
* renders the actual error instead of silently showing nothing. */
async function loadConsoleData() {
	const [wsResult, cbResult] = await Promise.allSettled([fetch("/api/vectr/workspaces").then((res) => {
		if (!res.ok) throw new Error(`workspaces endpoint returned ${res.status}`);
		return res.json();
	}), fetch("/api/vectr/codebases").then((res) => {
		if (!res.ok) throw new Error(`codebases endpoint returned ${res.status}`);
		return res.json();
	})]);
	return {
		wsViews: wsResult.status === "fulfilled" ? wsResult.value : null,
		cbViews: cbResult.status === "fulfilled" ? cbResult.value : null,
		wsError: wsResult.status === "rejected" ? String(wsResult.reason) : null,
		cbError: cbResult.status === "rejected" ? String(cbResult.reason) : null
	};
}
/** POST `/api/vectr/daemons/start` for ONE workspace.
*
* Same error handling as the start-all launcher in `DaemonLauncher`: a non-2xx
* body's `error` wins, otherwise the HTTP status is the message; a body that
* claims `ok` but carries no port is a contract violation, not a success. */
async function startWorkspaceDaemon(workspace) {
	const res = await fetch("/api/vectr/daemons/start", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ workspace })
	});
	const payload = await res.json();
	if (!res.ok || payload.ok === false) return {
		ok: false,
		error: payload.error ?? `start endpoint returned ${res.status}`
	};
	if (typeof payload.port !== "number") return {
		ok: false,
		error: "start endpoint returned no port"
	};
	return {
		ok: true,
		port: payload.port,
		...typeof payload.pid === "number" ? { pid: payload.pid } : {}
	};
}
/** POST `/api/vectr/downgrade` for ONE workspace; same error convention as `startWorkspaceDaemon`. */
async function downgradeWorkspace(workspace) {
	const res = await fetch("/api/vectr/downgrade", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ workspace })
	});
	const payload = await res.json();
	if (!res.ok || payload.ok === false) return {
		ok: false,
		error: payload.error ?? `downgrade endpoint returned ${res.status}`
	};
	return { ok: true };
}
/** Presentational half: the Start button plus the inline error text. */
function StartDaemonButtonView(props) {
	const { busy, error, onStart } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			display: "flex",
			flexDirection: "column",
			gap: 4,
			alignItems: "flex-start"
		},
		"aria-busy": busy,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			className: BTN.primary,
			disabled: busy,
			onClick: onStart,
			children: busy ? "starting…" : "start daemon"
		}), error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			className: "vectr-error",
			role: "alert",
			style: {
				margin: 0,
				whiteSpace: "normal",
				overflowWrap: "anywhere"
			},
			children: error
		}) : null]
	});
}
/** Starts one workspace's daemon; `onStarted` is the console re-fetch, so the
* row flips from "not started" to live. Owns its own busy/error state. */
function StartDaemonButton(props) {
	const [busy, setBusy] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)(null);
	const start = () => {
		setBusy(true);
		setError(null);
		startWorkspaceDaemon(props.workspace).then((result) => {
			if (result.ok) props.onStarted();
			else setError(result.error);
		}).catch((err) => setError(`start request error: ${String(err)}`)).finally(() => setBusy(false));
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StartDaemonButtonView, {
		busy,
		error,
		onStart: start
	});
}
function DowngradeButtonView(props) {
	const { busy, error, onDowngrade } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			display: "flex",
			flexDirection: "column",
			gap: 4,
			alignItems: "flex-start"
		},
		"aria-busy": busy,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			className: BTN.secondary,
			disabled: busy,
			onClick: onDowngrade,
			children: busy ? "降级中…" : "降级为仅记忆"
		}), error !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			className: "vectr-error",
			role: "alert",
			style: {
				margin: 0,
				whiteSpace: "normal",
				overflowWrap: "anywhere"
			},
			children: error
		}) : null]
	});
}
/** Downgrades one workspace to memory-only; `onDowngraded` is the console re-fetch. */
function DowngradeButton(props) {
	const [busy, setBusy] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)(null);
	const downgrade = () => {
		setBusy(true);
		setError(null);
		downgradeWorkspace(props.workspace).then((result) => {
			if (result.ok) props.onDowngraded();
			else setError(result.error);
		}).catch((err) => setError(`downgrade request error: ${String(err)}`)).finally(() => setBusy(false));
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DowngradeButtonView, {
		busy,
		error,
		onDowngrade: downgrade
	});
}
/** One workspace as a card: identity + state pills + re-index on the header row,
* the key index facts below it, and the codebase detail when expanded. */
function WorkspaceCard(props) {
	const { view, entries, expanded, onToggle, onReindex, busyPort, onTest, onStart, onDelete, busySlug, onCreated } = props;
	const disabledReason = reindexDisabledReason(view);
	const disabled = disabledReason !== void 0 || busyPort;
	const s = view.status;
	const memOnly = isMemoryOnly(view.mode);
	const langs = languagesLabel(s?.languages);
	const diagnostic = view.reason ?? view.error;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
		className: "vectr-card",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "vectr-card-head",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: BTN.action,
						"aria-expanded": expanded,
						"aria-label": expanded ? "collapse codebases" : "expand codebases",
						title: expanded ? "collapse codebases" : "expand codebases",
						onClick: onToggle,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "vectr-caret",
							children: expanded ? "▾" : "▸"
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "vectr-card-identity",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
							className: "vectr-card-title",
							title: view.workspace,
							children: view.title ?? view.workspace.split("/").slice(-2).join("/")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: "vectr-card-path",
							title: view.workspace,
							children: view.workspace
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "vectr-card-pills",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: `vectr-pill ${view.live ? "vectr-pill-live" : "vectr-pill-offline"}`,
								title: diagnostic ?? (view.live ? "daemon alive" : "daemon offline"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "vectr-pill-dot" }), view.live ? "online" : view.reason === "not started" ? "not started" : "offline"]
							}),
							view.mode !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "vectr-pill",
								title: view.mode,
								children: formatMode(view.mode, view.live)
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: `vectr-pill ${s?.fully_ready === true ? "vectr-pill-ready" : "vectr-pill-pending"}`,
								title: s?.fully_ready === true ? "index fully built" : "index not fully ready yet",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "vectr-pill-dot" }), s?.fully_ready === true ? "ready" : "not ready"]
							}),
							view.registered === false ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "vectr-pill vectr-pill-pending",
								title: "no record in vectr-codebases.json",
								children: "unregistered"
							}) : null
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "vectr-card-actions",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: BTN.action,
								disabled,
								title: disabledReason ?? "Re-index this workspace",
								style: disabled ? {
									color: "var(--dsw-alias-label-tertiary)",
									borderColor: "var(--dsw-alias-border-l2)",
									opacity: 1
								} : void 0,
								onClick: () => {
									if (view.port !== void 0) onReindex(view.port);
								},
								children: busyPort ? "…" : "re-index"
							}),
							view.live ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(StartDaemonButton, {
								workspace: view.workspace,
								onStarted: onCreated
							}),
							memOnly ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DowngradeButton, {
								workspace: view.workspace,
								onDowngraded: onCreated
							})
						]
					})
				]
			}),
			diagnostic !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: "vectr-card-diagnostic",
				title: view.error ?? diagnostic,
				children: diagnostic
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
				className: "vectr-facts",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "vectr-fact",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
							className: "vectr-fact-label",
							children: "port"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
							className: "vectr-fact-value",
							title: view.pid !== void 0 ? `pid ${view.pid}` : "pid unknown",
							children: view.port ?? "—"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "vectr-fact",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
							className: "vectr-fact-label",
							children: "files"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
							className: "vectr-fact-value",
							title: memOnly ? "memory-only mode: no index" : indexSummary(s),
							children: memOnly ? "—" : s?.indexed_files ?? "—"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "vectr-fact",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
							className: "vectr-fact-label",
							children: "notes"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
							className: "vectr-fact-value",
							children: s?.notes_count ?? "—"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "vectr-fact",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", {
							className: "vectr-fact-label",
							children: "languages"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", {
							className: "vectr-fact-value",
							title: languagesTitle(s?.languages),
							children: langs === "" ? "—" : langs
						})]
					})
				]
			}),
			expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "vectr-card-detail",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CodebaseSubTable, {
					entries,
					onTest,
					onStart,
					onDelete,
					busySlug
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CodebaseCreateForm, {
					presetWorkspace: view.workspace,
					onCreated
				})]
			}) : null
		]
	});
}
/** The full merged console panel (workspaces + their codebases). */
function WorkspaceConsole() {
	const [wsViews, setWsViews] = (0, react.useState)(null);
	const [cbViews, setCbViews] = (0, react.useState)(null);
	const [wsError, setWsError] = (0, react.useState)(null);
	const [cbError, setCbError] = (0, react.useState)(null);
	const [loading, setLoading] = (0, react.useState)(false);
	const [busyPort, setBusyPort] = (0, react.useState)(null);
	const [busySlug, setBusySlug] = (0, react.useState)(null);
	const [flash, setFlash] = (0, react.useState)(null);
	const [expanded, setExpanded] = (0, react.useState)(/* @__PURE__ */ new Set());
	const refresh = () => {
		setLoading(true);
		setWsError(null);
		setCbError(null);
		loadConsoleData().then((data) => {
			setWsViews(data.wsViews);
			setCbViews(data.cbViews);
			setWsError(data.wsError);
			setCbError(data.cbError);
		}).finally(() => setLoading(false));
	};
	(0, react.useEffect)(() => {
		refresh();
	}, []);
	const reindex = (port) => {
		setBusyPort(port);
		setFlash(null);
		fetch("/api/vectr/trigger-index", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ port })
		}).then((res) => res.json()).then((result) => {
			if (result.ok) setFlash(`re-index triggered for port ${port}`);
			else setFlash(`re-index failed: ${result.error ?? "unknown error"}`);
			refresh();
		}).catch((err) => setFlash(`re-index request error: ${String(err)}`)).finally(() => setBusyPort(null));
	};
	const run = (slug, method, suffix, okFlash) => {
		setBusySlug(slug);
		setFlash(null);
		fetch(`/api/vectr/codebases/${encodeURIComponent(slug)}${suffix}`, { method }).then((res) => res.json()).then((result) => {
			if (result.ok === false) setFlash(`failed: ${result.error ?? "unknown error"}`);
			else {
				setFlash(okFlash);
				refresh();
			}
		}).catch((err) => setFlash(`request error: ${String(err)}`)).finally(() => setBusySlug(null));
	};
	const test = (slug, ws) => {
		const wsParam = ws ? `?workspace=${encodeURIComponent(ws)}` : "";
		run(slug, "POST", `/test${wsParam}`, `tested ${slug}`);
	};
	const start = (slug, ws) => {
		const wsParam = ws ? `?workspace=${encodeURIComponent(ws)}` : "";
		run(slug, "POST", `/start${wsParam}`, `started ${slug}`);
	};
	const del = (slug) => run(slug, "DELETE", "", `deleted ${slug}`);
	const toggle = (key) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspaceConsoleView, {
		wsViews,
		cbViews,
		wsError,
		cbError,
		loading,
		flash,
		busyPort,
		busySlug,
		expanded,
		onRefresh: refresh,
		onToggle: toggle,
		onReindex: reindex,
		onTest: test,
		onStart: start,
		onDelete: del
	});
}
/** The console's whole visual tree, driven purely by props: no hooks, no fetch.
* Splitting it out of {@link WorkspaceConsole} is what makes the page renderable
* headlessly (`renderToStaticMarkup` never runs effects, so a component that
* fetches its own data could only ever be asserted in its empty state). */
function WorkspaceConsoleView(props) {
	const { wsViews, cbViews, wsError, cbError, loading, flash, busyPort, busySlug, expanded, onRefresh: refresh, onToggle: toggle, onReindex: reindex, onTest: test, onStart: start, onDelete: del } = props;
	const normWs = (w) => normalizePath(w);
	const byWs = /* @__PURE__ */ new Map();
	for (const cb of cbViews ?? []) {
		const ws = cb.workspace;
		if (ws === void 0) continue;
		const key = normWs(ws);
		const list = byWs.get(key);
		if (list === void 0) byWs.set(key, [cb]);
		else list.push(cb);
	}
	const summary = summarizeWorkspaces(wsViews);
	const showEmpty = wsError === null && wsViews !== null && wsViews.length === 0;
	const showList = !showEmpty && wsViews !== null;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "vectr-page",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "vectr-page-head",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: 6
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VectrNavIcon, {
						size: 16,
						className: "vectr-mark",
						title: "Vectr"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: "vectr-page-title",
						children: "Vectr 工作区"
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "vectr-page-subtitle",
					children: "每个已注册的工作区对应一个 vectr daemon；展开任意一行可以查看并管理它的代码库，re-index 会重建该 daemon 的索引。"
				})] })
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "vectr-section",
				"aria-labelledby": "vectr-eyebrow-global",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
					id: "vectr-eyebrow-global",
					className: "vectr-eyebrow",
					children: "全局"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "vectr-card",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "vectr-toolbar",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DaemonLauncher, { onChanged: refresh }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: BTN.secondary,
								disabled: loading,
								onClick: refresh,
								"aria-label": "refresh workspace list",
								children: loading ? "refreshing…" : "refresh"
							}),
							flash !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "vectr-flash",
								children: flash
							}) : loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "vectr-flash",
								children: "loading…"
							}) : null
						]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "vectr-stat-strip",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatTile, {
								value: summary.total,
								label: "已注册"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatTile, {
								value: summary.live,
								label: "在线"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatTile, {
								value: summary.memoryOnly,
								label: "仅记忆"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatTile, {
								value: summary.offline,
								label: "离线"
							})
						]
					})]
				})]
			}),
			wsError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				className: "vectr-error",
				role: "alert",
				children: ["failed to load workspaces: ", wsError]
			}) : null,
			cbError !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				className: "vectr-error",
				role: "alert",
				children: ["failed to load codebases: ", cbError]
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "vectr-section",
				"aria-labelledby": "vectr-eyebrow-ws",
				"aria-busy": loading,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", {
						id: "vectr-eyebrow-ws",
						className: "vectr-eyebrow",
						children: "工作区"
					}),
					loading && wsViews === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "vectr-skeleton",
						"aria-hidden": "true",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "vectr-skeleton-row" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "vectr-skeleton-row" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { className: "vectr-skeleton-row" })
						]
					}) : null,
					showEmpty ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "vectr-state",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(VectrNavIcon, {
								size: 22,
								className: "vectr-state-icon",
								title: "Vectr"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "vectr-state-title",
								children: "尚未注册任何 vectr 工作区"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "vectr-state-hint",
								children: "在某个项目目录里首次使用 vectr 工具（或在该目录完成一次 vectr 初始化）后，这个工作区就会出现在这里。"
							})
						]
					}) : null,
					showList ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "vectr-ws-list",
						children: wsViews?.map((view) => {
							const affiliated = byWs.get(normWs(view.workspace)) ?? [];
							const key = `ws:${view.workspace}`;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspaceCard, {
								view,
								entries: affiliated,
								expanded: expanded.has(key),
								onToggle: () => toggle(key),
								onReindex: reindex,
								busyPort: busyPort === view.port,
								onTest: test,
								onStart: start,
								onDelete: del,
								busySlug,
								onCreated: refresh
							}, key);
						})
					}) : null
				]
			})
		]
	});
}
/** Services required by the client half (informational; host resolves them). */
const inject = ["slots"];
/** Order of the Vectr top-level Settings section in the host nav. The built-in
* General/Models/Presets sections use 0–20; 200 keeps Vectr after them. */
const VECTR_SECTION_ORDER = 200;
/** Mount the Vectr shell as a top-level **Settings → Vectr** section. The shell
* owns the single merged panel (workspaces + their codebases). `slots.inject`
* runs its callback as a Cordis effect, so the callback returns the disposer
* `slots.register` yields (not a plain descriptor) or the loader rejects it. */
/**
* Registers a slot injection wrapped inside ctx.effect so that Cordis HMR reload
* cleans up previous injections, avoiding duplicate modals and buttons.
*/
function effectInject(ctx, key, callback, name) {
	let executed = false;
	ctx.effect(() => {
		executed = true;
		return ctx.slots.inject(key, callback);
	}, name);
	if (!executed) ctx.slots.inject(key, callback);
}
/** Mount the Vectr shell as a top-level **Settings → Vectr** section. The shell
* owns the single merged panel (workspaces + their codebases). `slots.inject`
* runs its callback as a Cordis effect, so the callback returns the disposer
* `slots.register` yields (not a plain descriptor) or the loader rejects it. */
function apply(ctx) {
	effectInject(ctx, "settings.section", () => {
		const disposeSection = ctx.slots.register({
			name: "settings.section",
			id: "vectr",
			order: VECTR_SECTION_ORDER,
			label: () => "Vectr"
		}, VectrSettings);
		let disposeIcon;
		try {
			disposeIcon = ctx.slots.register({
				name: "settings.section.icon",
				id: "vectr",
				order: VECTR_SECTION_ORDER,
				label: () => "Vectr"
			}, VectrSettingsRailIcon);
		} catch (err) {
			console.warn("[vectr] settings.section.icon slot unavailable; the rail keeps its default gear:", err);
		}
		return () => {
			disposeSection();
			if (disposeIcon !== void 0) disposeIcon();
		};
	}, "vectr: settings.section");
	effectInject(ctx, "conversation.session.header.utilities", () => ctx.slots.register({
		name: "conversation.session.header.utilities",
		id: "vectr-session-header-utility",
		order: 120,
		label: () => "Vectr"
	}, SessionHeaderAction), "vectr: conversation.session.header.utilities");
	effectInject(ctx, "conversation.input.right", () => ctx.slots.register({
		name: "conversation.input.right",
		id: "vectr-conversation-input-right",
		order: 120,
		label: () => "Vectr"
	}, ConversationInputRightAction), "vectr: conversation.input.right");
	effectInject(ctx, "shell.overlay", () => ctx.slots.register({
		name: "shell.overlay",
		id: "vectr-dialog-root",
		order: 100
	}, VectrDialogRoot), "vectr: shell.overlay");
}
//#endregion
exports.CodebaseModal = CodebaseModal;
exports.ConversationInputRightAction = ConversationInputRightAction;
exports.DialogCoordinator = DialogCoordinator;
exports.DowngradeButton = DowngradeButton;
exports.DowngradeButtonView = DowngradeButtonView;
exports.MemoryViewer = MemoryViewer;
exports.SessionBoundInputRightAction = SessionBoundInputRightAction;
exports.SessionDrawerModal = SessionDrawerModal;
exports.SessionHeaderAction = SessionHeaderAction;
exports.SessionsBoundHeaderAction = SessionsBoundHeaderAction;
exports.SessionsBoundInputRightAction = SessionsBoundInputRightAction;
exports.StartDaemonButton = StartDaemonButton;
exports.StartDaemonButtonView = StartDaemonButtonView;
exports.VectrDialogRoot = VectrDialogRoot;
exports.VectrNavIcon = VectrNavIcon;
exports.WorkspaceCard = WorkspaceCard;
exports.WorkspaceConsole = WorkspaceConsole;
exports.WorkspaceConsoleView = WorkspaceConsoleView;
exports.apply = apply;
exports.dialogCoordinator = dialogCoordinator;
exports.downgradeWorkspace = downgradeWorkspace;
exports.inject = inject;
exports.loadConsoleData = loadConsoleData;
exports.startWorkspaceDaemon = startWorkspaceDaemon;
exports.summarizeWorkspaces = summarizeWorkspaces;

return exports; } });
//# sourceMappingURL=client.js.map