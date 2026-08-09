// Single source of truth for the seven-dial DJ tuning board and the values
// consumed by AlbumGradientMesh.jsx and palette extraction.
//
// Every dial is a plain 0-100 "feel" value, no units. T(id) returns a live
// board override when present (persisted in localStorage under STORAGE_KEY),
// 50 (the default — reproduces today's live behavior exactly) otherwise.
// The renderer calls the named derived-value functions below.
//
// Rewired 2026-08-07 (Ben: "tuning dial rewire, go") — this whole derived-
// value section used to target GradientBackground.jsx's two-pool point-light
// engine, which was deleted 2026-08-04 and replaced by AlbumGradientMesh.jsx
// (the OKLab noise-duel/rotating-divider engine). Nothing here was ever
// updated to match — every dial except VARIETY (which only ever touched the
// server-side palette call, untouched by the renderer swap) was live on the
// board but silently connected to nothing; AlbumGradientMesh.jsx read its own
// hardcoded module consts instead. Six dials rewired below to the real
// per-frame constants that engine actually reads.
//
// The board is a tuning aid, not the long-term source of truth: COPY VALUES
// (exportSnippet) emits a paste-ready block of the real constants each dial
// currently resolves to, for pasting back over the derived-value functions
// below (this file — AlbumGradientMesh.jsx calls them directly now, it has
// no hardcoded consts of its own left for these 6 dials) or, for VARIETY,
// over api/palette.js. Paste, commit, then RESET ALL.

import { varietyToConfig } from './paletteDefaults.js'

export const STORAGE_KEY  = 'trivia_gradient_tuning'
export const TUNING_EVENT = 'trivia-tuning-change'

export const lerp = (a, b, t) => a + (b - a) * t

// commit: 'live' dials apply every drag frame — AlbumGradientMesh.jsx has no
// prepared/baked scene state (draw() recomputes every constant from tSec
// fresh every rAF frame, same as anchorDivider()/flowSpeedAt()), so a dial
// change is picked up on the very next frame with nothing to rebuild. This
// is why `remount` (force a full LiveScreen/turntable remount — killing
// in-flight playback UI just to apply a gradient number) no longer exists on
// any dial here: it was load-bearing for the OLD renderer's prepared field,
// not this one. Only VARIETY still needs 'release'+server — an actual
// network refetch of the extracted palette, genuinely too heavy to fire on
// every drag pixel.
export const DIALS = [
  { id: 'BRIGHTNESS', label: 'BRIGHTNESS', commit: 'live' },
  { id: 'MOTION',     label: 'MOTION',     commit: 'live' },
  { id: 'SIZE',       label: 'SIZE',       commit: 'live' },
  { id: 'BLEND',      label: 'BLEND',      commit: 'live' },
  { id: 'DEPTH',      label: 'DEPTH',      commit: 'live' },
  { id: 'VARIETY',    label: 'VARIETY',    commit: 'release', server: true },
  { id: 'CROSSFADE',  label: 'CROSSFADE',  commit: 'live' },
]
const DIAL_BY_ID = Object.fromEntries(DIALS.map(d => [d.id, d]))
const DEFAULT_VALUE = 50

// ── Runtime store ─────────────────────────────────────────────────────────────

let overrides = {}
if (typeof window !== 'undefined') {
  try { overrides = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {} }
  catch { overrides = {} }
}

// Cross-tab resurrection bug (found 2026-07-30, twice in one day): this
// module's `overrides` is hydrated from localStorage ONCE, at load. If tab A
// clears STORAGE_KEY (e.g. via devtools, or the board's own RESET ALL) while
// tab B stayed open with a stale in-memory `overrides`, tab B never hears
// about it — the browser's own `storage` event fires on OTHER tabs when
// localStorage changes, which is exactly the gap here, but nothing was
// listening. The next single dial touch in tab B then calls setDial(), which
// spreads `{...overrides}` (tab B's stale copy, old values intact) into a
// FRESH localStorage write — silently resurrecting an override that had
// already been cleared elsewhere, with a couple of values changed. This is
// the confirmed mechanism behind the SECOND "lava lamp is back" report,
// which had different override values than the first (a stale board touched
// again, not a fresh one). Listening for `storage` and re-hydrating closes
// the gap: any tab with this module loaded now converges on whatever's
// actually in localStorage, instead of trusting its own load-time snapshot
// forever. Re-dispatches TUNING_EVENT so the Tune-button indicator and any
// live renderer listeners pick up the correction immediately, same as a
// local setDial/clearDials call would.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    try { overrides = e.newValue ? JSON.parse(e.newValue) : {} }
    catch { overrides = {} }
    window.dispatchEvent(new CustomEvent(TUNING_EVENT, {
      detail: { id: '__external', committed: true, remount: true, server: true },
    }))
  })
}

// The one call the board and renderers make for a dial's raw 0-100 value.
// Number.isFinite guard (2026-08-07, Opus review): before the tuning dial
// rewire, a garbage override was inert — nothing read the derived values.
// Now they're live per-frame renderer inputs (SIZE feeds a Math.min clamp,
// others feed straight into tanh/OKLab math), so a non-numeric value
// (corrupted localStorage, another tab's bad JSON via the storage-rehydrate
// listener above) would propagate as NaN through the whole per-pixel loop —
// every pixel resolves to black. Falling back to DEFAULT_VALUE keeps a
// corrupted override inert again, same as it always was pre-rewire.
export function T(id) { const v = overrides[id]; return Number.isFinite(v) ? v : DEFAULT_VALUE }

export function isOverridden(id) { return overrides[id] !== undefined && overrides[id] !== DEFAULT_VALUE }
export function hasOverrides() { return Object.keys(overrides).some(isOverridden) }

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)) }
  catch { /* storage full/blocked — overrides still apply in-memory this session */ }
}

function dispatch(id, committed) {
  const d = DIAL_BY_ID[id]
  // No per-dial `remount` anymore (2026-08-07 rewire, Opus nitpick) — no
  // DIALS entry sets it, so this was always dispatching false. The two
  // broader resync events below (__external/__all) still hardcode
  // remount:true directly — those are real, deliberate full-resync signals
  // (another tab's overrides landed, or RESET ALL), unrelated to any single
  // dial's own config.
  window.dispatchEvent(new CustomEvent(TUNING_EVENT, {
    detail: { id, committed, server: !!d?.server },
  }))
}

// committed=false during a drag on a 'release' dial: the store + version
// still update (so the knob's own readout tracks the drag) but listeners
// that do heavy work (palette refetch, remount) wait for committed=true on
// pointer-up.
export function setDial(id, value, committed = true) {
  if (!DIAL_BY_ID[id]) return
  const clamped = Math.min(100, Math.max(0, Math.round(value)))
  overrides = { ...overrides, [id]: clamped }
  if (committed) persist()
  dispatch(id, committed)
}

export function resetDial(id) {
  if (!(id in overrides)) return
  const next = { ...overrides }
  delete next[id]
  overrides = next
  persist()
  dispatch(id, true)
}

export function clearDials() {
  overrides = {}
  persist()
  window.dispatchEvent(new CustomEvent(TUNING_EVENT, {
    detail: { id: '__all', committed: true, remount: true, server: true },
  }))
}

// ── Derived values — what AlbumGradientMesh.jsx actually calls ─────────────
// Every range below is centered so T=50 reproduces the exact value
// AlbumGradientMesh.jsx had hardcoded before this rewire — an untouched dial
// changes nothing about tonight's show.
export function blendDurationMs()  { return lerp(12000, 3000, T('CROSSFADE') / 100) }       // 50 → 7500 (song-to-song crossfade length, ms)

// L-channel offset applied to both anchor colors before the per-pixel blend
// (draw(), right after currentOklab()) — the one dial with no pre-existing
// mechanism to hook into; this section didn't exist in AlbumGradientMesh.jsx
// before this rewire. +-0.06 in OKLab L (roughly 0-1 scale) is a visible but
// not washed-out/crushed swing at either extreme.
export function brightnessOffset() { return lerp(-0.06, 0.06, T('BRIGHTNESS') / 100) }      // 50 → 0 (neutral)

// FLOW_SPEED's base value (flowSpeedAt() still layers its own +-25% breathing
// cycle on top of whatever this returns — MOTION sets the average tempo, not
// the breathing itself).
//
// Frozen 2026-08-09 (5-agent think-tank + Fable critique, "bright/fun/alive"
// tuning pass for the public TV during grading breaks): MOTION=55 -> 0.575,
// a small nudge up from the 0.55 default, still under the 0.79 an earlier
// live session rejected as "too fast." Was live off T('MOTION') via
// gradientTuning's DIALS board; now a frozen constant per this file's own
// COPY VALUES workflow (see header) — the MOTION dial on the tuning board is
// now a no-op for this value until someone unfreezes it back to the T() form.
export function flowSpeedBase()    { return 0.575 }

// The divider's offset-from-center amplitude cap — see anchorDivider()'s own
// header for why this exists (the 2026-08-07 bleed-over fix: three sine
// amplitudes summing past +-0.3 let the divider leave the visible screen
// entirely, letting one color swallow the frame). SIZE is "how far the
// boundary wanders" — the literal thing this cap controls — but the safety
// property has to survive every dial position, not just the default, so the
// output is hard-clamped to the same 0.3 ceiling regardless of T: raw lerp
// peaks at 0.55, and everything from T=50 up collapses flat to 0.30. Below
// 50, SIZE genuinely shrinks the boundary's travel toward near-stationary.
export function dividerOffsetCap() { return Math.min(0.30, lerp(0.05, 0.55, T('SIZE') / 100)) }  // 50 → 0.30 (== today's fixed cap)

// Steepness of the anchor0<->anchor1 mix transition itself (ANCHOR_MIX_SHARPNESS
// in AlbumGradientMesh.jsx) — this is the dial BLEND's own hint describes
// ("sharp pool edges vs. a soft, wide gradient where they meet"): lower is a
// wider, softer band where the two colors visibly mix; higher snaps to a
// crisper line with less visible in-between.
// Frozen 2026-08-09 (5-agent think-tank + Fable critique): BLEND=42 -> 1.272,
// softer than the 1.4 default — wider visible in-between hue band, "melts"
// rather than "cuts." Fable verified this stays clear of the mud/gray failure
// modes this file's history describes fighting (those were all chroma-
// cancellation bugs, fixed elsewhere in lerpOklabPolar; softening mixSharpness
// doesn't reopen them) and that hand-picked colors still render near-full-
// strength (tanh(1.272*1.2)≈0.955 vs 0.967 default — the no-ANCHOR_FLOOR
// guarantee holds). Was live off T('BLEND'); now frozen per COPY VALUES.
export function mixSharpness()     { return 1.272 }

// How much local noise texture (vs. the divider sweep) shapes the boundary's
// wobble and each pool's internal richness (ANCHOR_NOISE_CONTRAST) — DEPTH's
// hint: "how much the edge flows, and how much each color shades within
// itself."
// Frozen 2026-08-09 (5-agent think-tank + Fable critique): DEPTH=55 -> 1.58,
// a small lift from the 1.5 default for a touch more internal shading/
// richness ("aliveness") within each color's stronghold. Was live off
// T('DEPTH'); now frozen per COPY VALUES.
export function noiseContrast()    { return 1.58 }

// VARIETY resolves through the SAME curve as the server (paletteDefaults.js)
// — used client-side only for the board's own readout; the actual palette
// extraction always happens server-side.
export function varietyConfig()    { return varietyToConfig(T('VARIETY')) }

// Query-string fragment for /api/palette calls — empty string when VARIETY
// is untouched, so default sessions keep byte-identical URLs (and therefore
// their warm CDN cache entries).
export function paletteQuery() {
  return isOverridden('VARIETY') ? `&t_VARIETY=${T('VARIETY')}` : ''
}

// Paste-ready export — the board is a tuning aid; proven values go back into
// source and get committed. Emits the real constant each touched dial
// currently resolves to, annotated with which file/line it replaces.
export function exportSnippet() {
  const fmt = v => String(+(+v).toFixed(4))
  const lines = [`// trivia-jukebox gradient tuning — exported ${new Date().toISOString()}`]
  const touched = DIALS.filter(d => isOverridden(d.id))
  if (!touched.length) { lines.push('// (no dials moved from default)'); return lines.join('\n') }
  if (isOverridden('BRIGHTNESS')) {
    lines.push('', '// gradientTuning.js — replace brightnessOffset():', `export function brightnessOffset() { return ${fmt(brightnessOffset())} }`)
  }
  if (isOverridden('MOTION')) {
    lines.push('', '// gradientTuning.js — replace flowSpeedBase():', `export function flowSpeedBase() { return ${fmt(flowSpeedBase())} }`)
  }
  if (isOverridden('SIZE')) {
    lines.push('', '// gradientTuning.js — replace dividerOffsetCap():', `export function dividerOffsetCap() { return ${fmt(dividerOffsetCap())} }`)
  }
  if (isOverridden('BLEND')) {
    lines.push('', '// gradientTuning.js — replace mixSharpness():', `export function mixSharpness() { return ${fmt(mixSharpness())} }`)
  }
  if (isOverridden('DEPTH')) {
    lines.push('', '// gradientTuning.js — replace noiseContrast():', `export function noiseContrast() { return ${fmt(noiseContrast())} }`)
  }
  if (isOverridden('VARIETY')) {
    const cfg = varietyConfig()
    lines.push('', '// paletteDefaults.js — replace varietyToConfig() to freeze these values:', `export function varietyToConfig() { return { HUE_GAP_DEG: ${cfg.HUE_GAP_DEG}, MIN_COLORS: ${cfg.MIN_COLORS} } }`)
  }
  if (isOverridden('CROSSFADE')) {
    lines.push('', '// gradientTuning.js — replace blendDurationMs():', `export function blendDurationMs() { return ${Math.round(blendDurationMs())} }`)
  }
  return lines.join('\n')
}
