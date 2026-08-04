// Single source of truth for the seven-dial DJ tuning board and the values
// consumed by GradientBackground and palette extraction.
//
// Every dial is a plain 0-100 "feel" value, no units. T(id) returns a live
// board override when present (persisted in localStorage under STORAGE_KEY),
// 50 (the default — reproduces today's live behavior exactly) otherwise.
// The renderer calls the named derived-value functions below.
//
// The board is a tuning aid, not the long-term source of truth: COPY VALUES
// (exportSnippet) emits a paste-ready block of the real constants each dial
// currently resolves to, for pasting back over the hardcoded values in
// GradientBackground.jsx / twoLightBlend.js / api/palette.js. Paste, commit,
// then RESET ALL.

import { varietyToConfig } from './paletteDefaults.js'

export const STORAGE_KEY  = 'trivia_gradient_tuning'
export const TUNING_EVENT = 'trivia-tuning-change'

export const lerp = (a, b, t) => a + (b - a) * t

// commit: 'live' dials apply every drag frame. 'release' dials take effect
// on pointer-up — they're baked into prepared scene/field values or (for
// VARIETY) trigger a serverless refetch, both too heavy to do per drag pixel.
export const DIALS = [
  { id: 'BRIGHTNESS', label: 'BRIGHTNESS', commit: 'release', remount: true },
  { id: 'MOTION',     label: 'MOTION',     commit: 'release', remount: true },
  { id: 'SIZE',       label: 'SIZE',       commit: 'release', remount: true },
  { id: 'BLEND',      label: 'BLEND',      commit: 'release', remount: true },
  // DEPTH is baked into the prepared two-light field.
  { id: 'DEPTH',      label: 'DEPTH',      commit: 'release', remount: true },
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
export function T(id) { return overrides[id] ?? DEFAULT_VALUE }

export function isOverridden(id) { return overrides[id] !== undefined && overrides[id] !== DEFAULT_VALUE }
export function hasOverrides() { return Object.keys(overrides).some(isOverridden) }

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)) }
  catch { /* storage full/blocked — overrides still apply in-memory this session */ }
}

function dispatch(id, committed) {
  const d = DIAL_BY_ID[id]
  window.dispatchEvent(new CustomEvent(TUNING_EVENT, {
    detail: { id, committed, remount: !!d?.remount, server: !!d?.server },
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

// ── Derived values — what the renderers actually call ──────────────────────
export function blendDurationMs()  { return lerp(12000, 3000, T('CROSSFADE') / 100) }       // 50 → 7500 (was 7500, exact)

// GradientBackground's two-light renderer. Field-building values remount on
// release so the Canvas hot path retains parsed numbers and allocates nothing.
export function brightnessAdjustment() { return lerp(-0.10, 0.10, T('BRIGHTNESS') / 100) } // 50 → neutral
export function motionSpeed()          { return lerp(0.50, 1.50, T('MOTION') / 100) }       // 50 → current speed
// 0.45-0.75 (50 -> 0.60, 2026-08-03) let each light's influence stay
// entirely within the canvas -- combined with the halo's old fixed-radius
// clamp (see twoLightBlend.js), the reachable edge of a light's circle
// landed inside the frame on every song, reading as a spotlight/orb
// floating around rather than a blended field ("the circle floating
// around has to go... no shapes, mesh" -- owner, live). Widened so a
// light's radius exceeds the canvas at every dial position: the visible
// frame only ever samples the smooth INTERIOR of each light's falloff,
// never reaches a point where it's fully "spent," matching the standard
// aurora/mesh-gradient technique of sizing blobs past the viewport.
export function lightRadius()          { return lerp(0.90, 1.50, T('SIZE') / 100) }         // 50 → 1.20
export function seamBlend()            { return T('BLEND') === 50 ? 0.6 : lerp(0.30, 0.90, T('BLEND') / 100) }
export function haloDepth()            { return lerp(0.05, 0.15, T('DEPTH') / 100) }        // 50 → exact 0.10

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
    lines.push('', '// gradientTuning.js — replace brightnessAdjustment():', `export function brightnessAdjustment() { return ${fmt(brightnessAdjustment())} }`)
  }
  if (isOverridden('MOTION')) {
    lines.push('', '// gradientTuning.js — replace motionSpeed():', `export function motionSpeed() { return ${fmt(motionSpeed())} }`)
  }
  if (isOverridden('SIZE')) {
    lines.push('', '// gradientTuning.js — replace lightRadius():', `export function lightRadius() { return ${fmt(lightRadius())} }`)
  }
  if (isOverridden('BLEND')) {
    lines.push('', '// gradientTuning.js — replace seamBlend():', `export function seamBlend() { return ${fmt(seamBlend())} }`)
  }
  if (isOverridden('DEPTH')) {
    lines.push('', '// gradientTuning.js — replace haloDepth():', `export function haloDepth() { return ${fmt(haloDepth())} }`)
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
