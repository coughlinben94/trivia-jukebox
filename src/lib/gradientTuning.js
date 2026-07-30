// Single source of truth for the 6-dial DJ tuning board (TuningBoard.jsx)
// and the derived values the renderers actually read.
//
// Every dial is a plain 0-100 "feel" value, no units. T(id) returns a live
// board override when present (persisted in localStorage under STORAGE_KEY),
// 50 (the default — reproduces today's live behavior exactly) otherwise.
// Renderers never read T() directly — they call the derived-value functions
// below (chromaScale(), orbitSpeed(), etc.), which do the lerp and, for the
// engine-specific BLEND dial, pick the right curve for whichever renderer
// is asking.
//
// The board is a tuning aid, not the long-term source of truth: COPY VALUES
// (exportSnippet) emits a paste-ready block of the real constants each dial
// currently resolves to, for pasting back over the hardcoded values in
// AlbumGradient.jsx / AlbumGradientMesh.jsx / api/palette.js. Paste, commit,
// then RESET ALL.

import { varietyToConfig } from './paletteDefaults.js'

export const STORAGE_KEY  = 'trivia_gradient_tuning'
export const ENGINE_KEY   = 'trivia_gradient_engine' // pre-existing key — LiveScreen.getMeshGradientFlag() reads it
export const TUNING_EVENT = 'trivia-tuning-change'

export const lerp = (a, b, t) => a + (b - a) * t

// commit: 'live' dials apply every drag frame. 'release' dials take effect
// on pointer-up — they're baked into a useMemo'd blob-params object or (for
// VARIETY) trigger a serverless refetch, both too heavy to do per drag pixel.
export const DIALS = [
  { id: 'BRIGHTNESS', label: 'BRIGHTNESS', commit: 'live' },
  { id: 'MOTION',     label: 'MOTION',     commit: 'release', remount: true },
  { id: 'SIZE',       label: 'SIZE',       commit: 'release', remount: true },
  { id: 'BLEND',      label: 'BLEND',      commit: 'live' },
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
let version = 1

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
    version++
    window.dispatchEvent(new CustomEvent(TUNING_EVENT, {
      detail: { id: '__external', committed: true, remount: true, server: true },
    }))
  })
}

// Monotonic counter — AlbumGradient.jsx compares it against its cached
// CanvasGradient objects so BRIGHTNESS/BLEND turns invalidate the cache
// without an event subscription in the draw loop.
export function tuningVersion() { return version }

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
  version++
  if (committed) persist()
  dispatch(id, committed)
}

export function resetDial(id) {
  if (!(id in overrides)) return
  const next = { ...overrides }
  delete next[id]
  overrides = next
  version++
  persist()
  dispatch(id, true)
}

export function clearDials() {
  overrides = {}
  version++
  persist()
  window.dispatchEvent(new CustomEvent(TUNING_EVENT, {
    detail: { id: '__all', committed: true, remount: true, server: true },
  }))
}

// Engine A/B — reuses the EXISTING trivia_gradient_engine mechanism rather
// than inventing a second one. The ?gradient= URL param still wins inside
// getMeshGradientFlag(); the board should show a small warning when one is
// present in the URL.
export function setEngine(engine) {
  try { localStorage.setItem(ENGINE_KEY, engine) } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(TUNING_EVENT, {
    detail: { id: '__engine', committed: true, remount: true, server: false },
  }))
}

// ── Derived values — what the renderers actually call ──────────────────────
// Every curve is built so T(id)===50 reproduces today's exact hardcoded
// value. `engine` is 'circles' | 'mesh', only needed for BLEND (the two
// renderers express "distinct vs. creamy" through different constants).

// BRIGHTNESS ranges are centered on the values that were hardcoded before the
// board existed, so a dial sitting at 50 draws exactly what shipped yesterday.
// (They were off by a hair — 0.85/0.625/0.40 vs 0.82/0.62/0.38 — which broke
// the board's core promise that "touch nothing, change nothing".)
// BRIGHTNESS/BLEND defaults lowered 2026-07-30 (T=50 now resolves to a
// calmer value than the original hardcoded constant, unlike every other
// dial here which reproduces yesterday's exact behavior at 50). Today's
// palette.js fixes (recolor real green/gold instead of flattening them
// toward neon fallbacks) feed the mesh renderer real, more vivid, more
// varied color than it saw when these dials were tuned — AlbumGradientMesh
// itself already warned about exactly this ("no built-in dampening...
// every pixel is a full-strength blend of real palette hues, which read as
// more saturated throughout") and LiveScreen.jsx flagged it as a watch-item.
// Reported live: distinct saturated color pools drifting independently read
// as "lava lamp," not ambient wash. Two levers, chosen deliberately over a
// third (blobRadius/SIZE, left untouched — more overlap would ALSO smooth
// pooling, but changing three knobs at once from an unverified guess is
// worse than two well-targeted ones):
//   - chromaScale down (0.82 -> 0.70 at 50): less saturated throughout,
//     directly countering the oversaturation the mesh's own comment predicted.
//   - meshIdwPower down (3 -> 2 at 50): per its own comment, lower = more
//     "creamy/averaged," closer to the pre-blob noise-field feel that never
//     read as distinct pooled bodies — the literal opposite of "lava lamp."
//
// chromaScale nudged up 0.70 -> 0.80 same day (for a dull-brown complaint on
// Abraham Alexander's "Stay"), then reverted right back down within the same
// session once a sharper problem showed up: the mesh's chroma-preserving
// blend (see AlbumGradientMesh.jsx's spatial-blend comment, 2026-07-28) means
// wherever two blobs of different hue meet, chroma is the WEIGHTED MEAN of
// both — it never dips at the seam. Turning chromaScale up doesn't just
// enrich single-hue-dominated regions like that brown; it also pushes every
// SEAM between two different colors to a more vivid, more distinct blend —
// live-reported 2026-07-30 as "where the two colors are connecting is where
// I'm having my major issues," directly after the 0.80 bump. That's the more
// frequent, more disruptive complaint (lava-lamp seams) vs. the narrower one
// (one dull brown), so back to 0.70. The brown-richness problem still
// exists; it needs a fix that helps single-color regions without also
// juicing every seam (e.g. damping chroma specifically where multiple blobs
// have comparable weight, not a blanket multiplier) — not attempted here,
// left for a future pass once the seam problem itself is confirmed calmer.
export function chromaScale()      { return lerp(0.40, 1.00, T('BRIGHTNESS') / 100) }       // 50 → 0.70 (was 0.82)
export function circleAlphaMuted() { return lerp(0.45, 0.79, T('BRIGHTNESS') / 100) }       // 50 → 0.62 (was 0.62, exact)
export function circleAlphaSat()   { return lerp(0.21, 0.55, T('BRIGHTNESS') / 100) }       // 50 → 0.38 (was 0.38, exact)

// Whole curve scaled x1.15 (2026-07-30, live request: "movement overall
// brought up 15%") -- both endpoints multiplied rather than just shifting
// the T=50 default, so the dial's relative feel across its whole 0-100
// range stays the same, just 15% faster throughout. Breaks this file's
// usual "T=50 reproduces yesterday's exact behavior" promise for MOTION
// specifically -- a deliberate, requested change, not a bug.
export function orbitSpeed()       { return lerp(0.345, 2.185, T('MOTION') / 100) }         // 50 → 1.265 (was 1.1 -- +15%)

export function blobRadius()       { return lerp(0.30, 0.70, T('SIZE') / 100) }             // 50 → 0.50 (was 0.50, exact)

export function meshIdwPower()     { return lerp(1, 3, T('BLEND') / 100) }                  // 50 → 2 (was 3)
export function circleFalloffPow() { return lerp(0.2, 2.8, T('BLEND') / 100) }              // 50 → 1.5 (was 1.5, exact)

export function blendDurationMs()  { return lerp(12000, 3000, T('CROSSFADE') / 100) }       // 50 → 7500 (was 7500, exact)

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
    lines.push('', '// AlbumGradientMesh.jsx — replace CHROMA_SCALE:', `const CHROMA_SCALE = ${fmt(chromaScale())}`)
    lines.push('// AlbumGradient.jsx — inside buildBlobGradient, replace the peakAlpha lerp:', `const peakAlpha = lerp(${fmt(circleAlphaMuted())}, ${fmt(circleAlphaSat())}, chroma)`)
  }
  if (isOverridden('MOTION')) {
    lines.push('', '// AlbumGradient.jsx makeCircleParams / AlbumGradientMesh.jsx makeBlobParams —', '// replace the ORBIT_SPEED numerator in xFreq/yFreq (speed / (10 + ...)):', `const ORBIT_SPEED = ${fmt(orbitSpeed())}`)
  }
  if (isOverridden('SIZE')) {
    lines.push('', '// Both makeCircleParams/makeBlobParams — replace "radius: 0.50 + rng(i, 6) * 0.13":', `radius: ${fmt(blobRadius())} + rng(i, 6) * 0.13`)
  }
  if (isOverridden('BLEND')) {
    lines.push('', '// AlbumGradientMesh.jsx — replace IDW_POWER:', `const IDW_POWER = ${fmt(meshIdwPower())}`)
    lines.push('// AlbumGradient.jsx buildBlobGradient — replace Math.pow(1 - t, 1.5):', `Math.pow(1 - t, ${fmt(circleFalloffPow())})`)
  }
  if (isOverridden('VARIETY')) {
    const cfg = varietyConfig()
    lines.push('', '// api/palette.js — replace the MIN_COLORS/HUE_GAP_DEG in the const line:', `MIN_COLORS = ${cfg.MIN_COLORS}, HUE_GAP_DEG = ${cfg.HUE_GAP_DEG}`)
  }
  if (isOverridden('CROSSFADE')) {
    lines.push('', '// Both files — replace BLEND_DURATION_MS:', `const BLEND_DURATION_MS = ${Math.round(blendDurationMs())}`)
  }
  return lines.join('\n')
}
