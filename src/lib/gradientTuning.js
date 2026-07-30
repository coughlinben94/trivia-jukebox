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
// chromaScale nudged back up 0.70 -> 0.80 same day, once LiveScreen also
// capped the palette itself to 2-3 colors (separate fix, same session): that
// cap is what's actually load-bearing against "lava lamp" now — fewer
// distinct hues for the 6 blobs to disagree about, independent of how
// saturated each one is. With that in place, 0.70's blanket desaturation is
// mostly just costing real color: live-checked Abraham Alexander's "Stay"
// (/api/palette real output includes #a37538, chroma 0.42 — a genuinely
// rich golden-brown by the numbers, no ugly-pocket penalty applies to it)
// and it was reading as a flat, dull tan on screen — 0.70 was taking a
// perfectly good brown and washing it out. 0.80 splits the difference: most
// of the anti-oversaturation headroom from the color-count cap, without
// deliberately dulling colors that were never the problem.
export function chromaScale()      { return lerp(0.60, 1.00, T('BRIGHTNESS') / 100) }       // 50 → 0.80 (was 0.70, originally 0.82)
export function circleAlphaMuted() { return lerp(0.45, 0.79, T('BRIGHTNESS') / 100) }       // 50 → 0.62 (was 0.62, exact)
export function circleAlphaSat()   { return lerp(0.21, 0.55, T('BRIGHTNESS') / 100) }       // 50 → 0.38 (was 0.38, exact)

export function orbitSpeed()       { return lerp(0.3, 1.9, T('MOTION') / 100) }             // 50 → 1.1 (was 1.1, exact)

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
    lines.push('', '// AlbumGradient.jsx makeCircleParams / AlbumGradientMesh.jsx makeBlobParams —', '// replace the "1.1 /" numerator in xFreq/yFreq:', `const ORBIT_SPEED = ${fmt(orbitSpeed())}`)
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
