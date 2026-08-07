import { useEffect, useRef, useMemo } from 'react'

// Canvas2D "soft mesh" gradient background — revived 2026-08-04 from
// commit abdf50e (2026-07-19, "rebuild color math as real two-color
// collision, not an 8-way average" — the actual clean rewrite, NOT the
// later c5e9673 "+25% intensity" commit, which was hand-tuned to compensate
// for a since-fixed bad-palette bug and is a worse base). Adapted to the
// app's current 2-color-max data model, and fixed against a second-opinion
// review of the original build (2026-08-04):
//
//  - Accent-color system deleted. The original drew up to 8 colors — 2
//    "anchor" colors always present, plus up to 6 "accent" colors fading in
//    and out — and burned about a week of tuning (mud guards, antipodal
//    blob pairing, chroma floors, hue-distance gating) fighting muddy/ugly
//    results from bad AUTO-EXTRACTED palettes across that many colors. The
//    app is now hard-capped at exactly 2 colors (LiveScreen.pickGradientColors)
//    and both are picker-overridable per song (SongDetailModal) with a
//    cover-art eyedropper — that's what actually solves "bad color," not more
//    blend-math guardrails. Only the 2-anchor duel survives; there's no
//    NUM_COLORS > 2 path left to feed accents.
//  - ANCHOR_FLOOR clamp removed. The original never let either anchor color
//    render at full strength anywhere on screen (clamped to a 18-22%..78-82%
//    mix range) — directly undermining a picker where you choose an exact
//    color and expect to actually see it. Colors now reach full strength
//    wherever an anchor wins; the tanh sharpening still keeps the transition
//    soft, it just isn't artificially prevented from resolving.
//  - Song-to-song crossfade now blends in OKLab, not RGB. The original's
//    per-pixel mix was already OKLab, but the OUTER crossfade between one
//    song's colors and the next was still a plain RGB lerp — exactly the
//    "muddy gray seam" problem this engine exists to avoid, just left
//    unfixed on the transition path. Two opposite-hue picks (e.g. red to
//    blue) now cross through a real perceptual gradient instead of gray.
//  - Grain removed entirely (2026-08-04, Fable's critique) — 700 fillRect
//    calls a frame for ~0.03% pixel coverage on a TV-sized canvas was pure
//    cost with no visible payoff; see the note above the old call site.
//  - Divider motion reworked (2026-08-04, Fable's critique): the single-sine
//    sweep was outweighed 5:1 by the local noise term, so it barely read as
//    travel — swing raised, divider is now 3 incommensurate sine periods so
//    it never exactly repeats, the boundary slowly tilts off-vertical, and
//    FLOW_SPEED breathes instead of sitting at one constant tempo.
//
// Colors are mixed in OKLab (perceptual color space), not composited with
// 'screen' blend like AlbumGradient.jsx (the circle-blobs engine) — screen-
// blending overlapping shapes is additive and is what produced washed-out/
// white blob centers there. OKLab lerp between two colors can only ever
// land between them, never brighter than either.
//
// Same prop contract as AlbumGradient.jsx (colors/nextColors/active/
// shuffleKey/entranceActive) so it drops into LiveScreen.jsx with no other
// changes needed.

const BLEND_DURATION_MS = 7500
// The entrance's own first real-palette blend (near-black -> real colors) is
// much shorter than a normal song-to-song crossfade — see startBlendTo's
// header comment.
const ENTRANCE_BLEND_DURATION_MS = 2000
const NUM_ANCHORS = 2
// Full noise-flow cycle speed — the "dancing" knob (owner feedback on the
// original: "still not enough dance" even after +75%). Now breathes (see
// FLOW_SPEED_at() below) instead of sitting at one constant tempo forever —
// 2026-08-04, per Fable's critique: a fixed speed reads as a metronome
// after a couple hours of a bar shift.
const FLOW_SPEED = 0.55  // 0.79 -> 0.55 (2026-08-04, Ben: noise flow read too fast live)
// colors[0]/colors[1] slowly trade dominance back and forth across the frame.
const ANCHOR_PERIOD_S   = 11.4  // primary divider sweep period (see anchorDivider() — now 3 incommensurate sines, not 1)
// 0.30 -> 0.65 (2026-08-04, Fable's critique): at 0.30 the divider sweep was
// outweighed 5:1 by ANCHOR_NOISE_CONTRAST (1.5), so the noise churn WAS the
// motion and the actual 11.4s travel barely registered — probably why past
// tuning kept reaching for FLOW_SPEED as the only lever that visibly did
// anything. Raising this lets the sweep read as real travel.
const ANCHOR_SWING      = 0.65  // how much the sweeping divider contributes to who's winning, vs. local noise texture
const ANCHOR_SHARPNESS  = 3.5   // divider position->edge transition — lower = blurrier, higher = crisper
const ANCHOR_NOISE_CONTRAST = 1.5  // how much local noise texture (vs. the divider sweep) shapes the boundary's wobble
// 2.4 -> 1.4 (2026-08-04, Fable's critique, second round): owner reported
// each color's DOMINANT interior (not the seam) reading as one flat heavy
// block. Math: deep in a stronghold, edge saturates to ~+-1 (ANCHOR_SHARPNESS
// already does that within ~0.3 screen-widths of the divider), so score sits
// around +-0.65 from swing alone plus noise wobble. At 2.4, tanh(2.4*0.65)
// pins mix ~0.96 even at the LOW end of core wobble -- almost the whole
// stronghold reads as one pinned-near-pure block with only faint texture,
// and the visible blend band (mix 0.25-0.75) is a thin ribbon by comparison.
// At 1.4, a typical core (score 0.65) lands at mix ~0.86 -- strong, but
// breathing, with noise texture visibly modulating it -- while true peaks
// (score ~1.2) still reach ~0.97, so a hand-picked color still renders
// essentially full-strength somewhere (preserves the no-ANCHOR_FLOOR fix
// above). The blend band roughly doubles in width as a side effect.
const ANCHOR_MIX_SHARPNESS  = 1.4  // steepness of the anchor0<->anchor1 transition itself — higher = crisper meeting line
// No ANCHOR_FLOOR — see file header. tanh already keeps the transition soft;
// nothing forces a trace of the "losing" color to survive into its own
// stronghold anymore.

// Divider position, 2026-08-04: sum of three incommensurate periods instead
// of one pure sine. A single sine repeats exactly every ANCHOR_PERIOD_S — on
// an hours-long bar shift the eye eventually clocks the loop. Three periods
// with no common factor (11.4s / 29.3s / 7.1s) mean the combined waveform
// doesn't actually repeat on any timescale a viewer would sit through.
//
// Amplitudes scaled to 0.5x (2026-08-07, Ben live: "there isn't supposed to
// be a max of the sin wave bleeding over into the other color") — the
// original 0.35/0.15/0.10 amplitudes summed to 0.60, so at their combined
// peak the divider left the visible 0-1 screen range entirely (as far as
// -0.10 / 1.10), which saturates the edge term across nearly the whole
// canvas and lets one anchor color swallow the screen. Simulated over a 4hr
// shift: this happened 4.5% of the time. Scaling all three by the same
// factor keeps their relative sizes (same multi-wave "random" shape) while
// capping the combined swing at +-0.3, so the divider always stays within
// 0.2-0.8 — both colors stay visibly present no matter how the three waves
// line up.
export function anchorDivider(tSec) {
  return 0.5
    + 0.175 * Math.sin((tSec / 11.4) * Math.PI * 2)
    + 0.075 * Math.sin((tSec / 29.3) * Math.PI * 2)
    + 0.05  * Math.sin((tSec / 7.1)  * Math.PI * 2)
}

// FLOW_SPEED breathes slowly (2026-08-04, Fable's critique) instead of
// idling at one constant tempo — motion surges and settles on a ~4.5min
// cycle instead of reading as a metronome.
function flowSpeedAt(tSec) {
  return FLOW_SPEED * (1 + 0.25 * Math.sin(tSec / 43))
}

export function hexToRgb(hex) {
  if (!hex || hex.length < 7) return [8, 8, 8]
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

function parseColors(hexArr, n) {
  const src = hexArr.length ? hexArr : ['#080808']
  return Array.from({ length: n }, (_, i) => [...hexToRgb(src[i % src.length])])
}

function easeInOut(t) {
  t = Math.max(0, Math.min(1, t))
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}

function lerp(a, b, t) { return a + (b - a) * t }

// Signed shortest angular delta h1->h2, in (-pi, pi].
export function shortestDelta(h1, h2) {
  let d = (h2 - h1) % (2 * Math.PI)
  if (d > Math.PI) d -= 2 * Math.PI
  if (d < -Math.PI) d += 2 * Math.PI
  return d
}

// Polar OKLab lerp — rewritten 2026-08-07 (Opus review) after the version
// that shipped 2026-08-04..08-06 was proven to be a NO-OP, bit for bit
// identical to a plain Cartesian lerp of the a/b channels (algebra + a
// 300k-random-pair numeric check, max deviation 3.9e-16, float noise only).
// Full history, for the next person who touches this:
//
//   1. (2026-08-04) Original bug: two near-complementary hues (e.g.
//      orange/blue) point roughly opposite directions in the a/b plane, so
//      their vector SUM cancels toward the origin at the midpoint -- chroma
//      collapses near 0 (gray) even though L and each endpoint's own chroma
//      are both fine. Fixed by blending unit hue VECTORS (not raw atan2 hues
//      + a shortest-path branch, which flips discretely as live-drifting
//      anchors sweep their hue gap past +-180deg, producing a full-width
//      single-frame color jump mid-crossfade).
//
//   2. (2026-08-06) That vector blend's magnitude (`ulen`) naturally shrinks
//      toward 0 near exact antipodality (180deg apart) -- atan2 near the
//      origin is ill-defined, so the resolved hue swung between two
//      arbitrary values a hair's-width apart in t while chroma held its
//      full lerped value, committing to a wrong saturated hue right at the
//      unstable point ("swimming ring" bug, live-verified on Out Tonight /
//      Penelope Road, #115867/#e45a34, ~180deg apart). Fixed by scaling
//      output chroma by `ulen`.
//
//   Fix #2 is the bug. `ulen` is EXACTLY the ratio between the unit-vector
//   blend's magnitude and the Cartesian lerp's magnitude -- multiplying it
//   back in after computing hue/magnitude from the unit vectors algebraically
//   reconstructs the plain Cartesian lerp of (a,b), i.e. fix #1, undone.
//   Every comment that used to be here describing "chroma can't cancel, it's
//   a scalar magnitude" was describing intent, not the code beneath it.
//
// The actual fix for both bugs at once: don't re-derive hue direction PER
// PIXEL at all. The unit-vector trick existed only to make direction
// continuous as the CALLER's two input hues drift frame to frame (draw()
// calls this once per pixel per frame with the SAME pair of live-moving
// anchors) -- but if the caller instead fixes the traversal arc ONCE per
// frame (see hueArcRef in draw()), every pixel that frame uses the same
// monotone hue path, so there's no per-pixel instability left to guard
// against, and chroma can lerp as a true scalar magnitude with nothing
// scaling it down. The `dh` param carries that caller-fixed arc; frame-to-
// frame stability (the actual antipodality hazard, now once-per-frame
// instead of once-per-pixel) is an unwrap in draw(), not anything in here —
// see hueArcRef there for why it's an unwrap and not a threshold/hysteresis.
//
// L lerps linearly. Chroma lerps as a scalar magnitude — two positive
// numbers can't average to something smaller than both, so this is where
// bug #1 actually stays fixed. Hue lerps along `dh` (or the shortest path
// between a/b's own hues, if the caller has no per-frame drift to worry
// about — see the crossfade call in currentOklab(), whose endpoints are
// fixed for the life of one blend), with the blend fraction itself
// chroma-weighted (unchanged from the original design): a near-achromatic
// endpoint has an arbitrary atan2 hue and should barely vote on the result.
export function lerpOklabPolar(a, b, t, dh) {
  const [L1, a1, b1] = a
  const [L2, a2, b2] = b
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const L = lerp(L1, L2, t)
  const C = lerp(C1, C2, t)

  const denom = C1 * (1 - t) + C2 * t
  const th = denom > 1e-4 ? (C2 * t) / denom : t

  const h1 = Math.atan2(b1, a1)
  const arc = dh ?? shortestDelta(h1, Math.atan2(b2, a2))
  const h = h1 + arc * th

  return [L, C * Math.cos(h), C * Math.sin(h)]
}

// ── OKLab conversion — standard Bjorn Ottosson formulas.

function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
function linearToSrgb(c) { c = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, c * 255)) }
function cbrt(x) { return Math.sign(x) * Math.pow(Math.abs(x), 1 / 3) }

export function rgbToOklab([r, g, b]) {
  r = srgbToLinear(r); g = srgbToLinear(g); b = srgbToLinear(b)
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const l_ = cbrt(l), m_ = cbrt(m), s_ = cbrt(s)
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ]
}

export function oklabToRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(bb)]
}

// Cheap 2D pseudo-noise (sum of offset sines) — not simplex, but visually
// comparable for this purpose and far cheaper per-pixel in plain JS.
function pseudoNoise(x, y, t) {
  return (
    Math.sin(x * 1.3 + t) +
    Math.sin(y * 1.4 - t * 0.7) +
    Math.sin((x + y) * 0.9 + t * 1.1) +
    Math.sin((x - y) * 1.1 - t * 0.5)
  ) / 4
}

function makeColorSeeds() {
  function rng(i, slot) {
    const x = Math.sin((i * 7 + slot) * 9301 + 49297) * 233280
    return x - Math.floor(x)
  }
  return Array.from({ length: NUM_ANCHORS }, (_, i) => ({
    seedU: rng(i, 0) * 9,
    seedV: rng(i, 1) * 9,
  }))
}

export default function AlbumGradientMesh({ colors = [], nextColors = [], active = true, shuffleKey = 0, entranceActive = false }) {
  const canvasRef          = useRef(null)
  const smallCanvasRef     = useRef(null)
  const activeRef          = useRef(active)
  const mountedRef         = useRef(true)
  const rafRef             = useRef(null)
  const isFirst             = useRef(true)
  const isFirstNext         = useRef(true)
  const isFirstKey          = useRef(true)
  const entranceActiveRef  = useRef(entranceActive)
  const pendingBlendRef    = useRef(null)
  const colorSeeds         = useMemo(makeColorSeeds, [])
  const tinySizeRef        = useRef({ w: 48, h: 48 })
  // Snap detector (2026-08-04) — watches the actual RENDERED output frame to
  // frame, not the state. If this ever fires again, its own console.warn
  // payload (blendStart/elapsed/dur/hidden) is the starting point — the
  // startBlendTo diagnostic log this comment used to point to was removed
  // 2026-08-07 (production log cleanup); triage from the warn's own fields
  // and recent code changes instead.
  const anchorHistRef      = useRef({ a0: null, a1: null, ts: 0 })
  // Committed once-per-frame hue traversal arc for the per-pixel blend in
  // draw() (2026-08-07) — see lerpOklabPolar's header for why this exists.
  // Reset to null in startBlendTo/settleNow/on natural blend completion so a
  // new song doesn't inherit the previous anchor pair's committed direction.
  const hueArcRef          = useRef(null)
  // Integrated flow phase (2026-08-07). flowSpeedAt() is an INSTANTANEOUS
  // speed, so phase is its running integral, not speed x elapsed-time — the
  // old `tSec * flowSpeedAt(tSec)` scaled the breathing sine by the full
  // elapsed seconds, which over a multi-hour show grows without bound and
  // makes the flow run away and periodically reverse instead of breathing.
  // NOT reset on song changes (unlike hueArcRef) — this is continuous
  // background motion with no relation to per-song blend state; resetting it
  // would jump the noise domain. Only the timestamp is reset, in startLoop(),
  // so a stopped/restarted RAF can't compute one giant bogus dt.
  const flowPhaseRef       = useRef(0)
  const flowPhaseTsRef     = useRef(null)
  // Accumulated hidden-tab time (2026-08-07), same fix pattern as blendStart
  // below but for anchorDivider()/tilt in draw(), which are pure functions of
  // raw wall-clock tSec (not integrated like flowPhaseRef) — a long tab-hide
  // otherwise still snaps the divider/tilt position on resume even though the
  // color-blend and noise-flow snaps were already fixed. Subtracted from ts
  // before deriving tSec so those two keep animating from wherever they
  // genuinely were, instead of jumping to wherever raw wall-clock says they
  // should be.
  const hiddenOffsetMsRef  = useRef(0)

  const st = useRef(null)
  if (!st.current) {
    const initial = parseColors(colors, NUM_ANCHORS)
    st.current = {
      steadyRgb:  initial.map(c => [...c]),
      outRgb:     initial.map(c => [...c]),
      inRgb:      initial.map(c => [...c]),
      blendStart: -1,
      blendDurationMs: BLEND_DURATION_MS,
    }
  }

  // 2026-08-04 — Opus review after a FOURTH live color-snap report survived
  // three rounds of per-site patches. Root cause of the pattern, not just
  // one instance of it: this state used to have THREE independent places
  // that each re-derived "where is the blend right now" by hand (startBlendTo's
  // re-trigger branch, the shuffleKey reset, draw() itself) — and a fourth,
  // the visibilitychange handler, that didn't derive it at all and just
  // teleported to the destination color, which is itself an unconditional
  // snap whenever a tab-switch happens mid-blend (the DOMINANT way this
  // actually gets seen live, per CLAUDE.md: tested against the deployed URL
  // in a browser tab, not headless). Every future entry point was one more
  // chance to get that math wrong, and half of them already had.
  //
  // Collapsed to a single source of truth: currentOklab() is now the ONLY
  // interpolation in this file. Every writer below calls startBlendTo (set a
  // new target) or settleNow (stop animating, freeze wherever we are) —
  // neither one contains any lerp math of its own, so there's nothing left
  // for a new call site to get wrong.
  function currentOklab(now = performance.now()) {
    const s = st.current
    if (s.blendStart < 0) return s.steadyRgb.map(rgbToOklab)
    const t = easeInOut(Math.min((now - s.blendStart) / s.blendDurationMs, 1))
    return s.outRgb.map((c, i) => lerpOklabPolar(rgbToOklab(c), rgbToOklab(s.inRgb[i]), t))
  }
  const currentRgb = (now) => currentOklab(now).map(oklabToRgb)

  // durationMs: the entrance's own first real-palette blend uses
  // ENTRANCE_BLEND_DURATION_MS (2026-08-04, owner: the full 7.5s
  // song-to-song duration was still visibly shifting tint well after the
  // tonearm had already dropped and the song was audibly playing — by the
  // time the black curtain lifts (LiveScreen.jsx) the record's already
  // settled, so a multi-second color creep afterward reads as unfinished,
  // not as "floating in"). Every other caller keeps the default song-to-song
  // duration.
  function startBlendTo(newHex, durationMs = BLEND_DURATION_MS) {
    const s = st.current
    // No branch, no gate — currentRgb() already handles "no blend running"
    // (returns steadyRgb) and "blend already expired" (clamps to inRgb)
    // correctly on its own. The old version only re-snapshotted when
    // `elapsed < duration`; when a tab went hidden mid-blend and stayed
    // hidden well past its expiry, that gate fell through to the stale
    // pre-blend steadyRgb instead — a real corrupt-state snap.
    s.outRgb          = currentRgb()
    s.inRgb           = parseColors(newHex, NUM_ANCHORS)
    s.blendStart      = performance.now()
    s.blendDurationMs = durationMs
    hueArcRef.current = null
    if (!rafRef.current && mountedRef.current) startLoop()
  }

  // Stop animating without changing the target — freeze wherever the blend
  // currently is into steadyRgb. Used by the shuffleKey reset below (a new
  // session starting shouldn't force a black snap, just stop tracking the
  // old blend) and could be reused anywhere else a caller needs "hold here."
  function settleNow() {
    const s = st.current
    s.steadyRgb  = currentRgb()
    s.blendStart = -1
    hueArcRef.current = null
  }

  // shuffleKey: new session starts. No black snap — a forced black reset
  // meant one for a chunk of the 7.5s entrance blend every time. Just settle
  // wherever the blend currently is; the colors-effect below crossfades
  // straight from there into the new song's palette.
  useEffect(() => {
    if (isFirstKey.current) { isFirstKey.current = false; return }
    settleNow()
  }, [shuffleKey])

  useEffect(() => {
    if (isFirstNext.current) { isFirstNext.current = false; return }
    if (!nextColors.length) return
    if (nextColors.every(c => c === '#080808')) return
    // Don't defer into pendingBlendRef during entrance (2026-08-04, sweep
    // finding): the colors-effect below defers the CURRENT song's own
    // palette into that same ref while entranceActive, so the entrance can
    // reveal it once the curtain lifts. nextColors is a background
    // optimization -- it warms the UPCOMING song's palette early (during
    // song 1's own playback, well before any fade-out) so that transition
    // has a head start later. If that prefetch resolves during entrance and
    // wrote into the same ref AFTER the current song's own colors did, it
    // would silently overwrite them -- entrance would reveal song 2's colors
    // instead of song 1's the first time this ever runs in a session. Simply
    // skip the optimization during entrance; the real fade-out-triggered
    // nextColors update (onFadeStart, well before song 2 actually plays)
    // still runs normally for every later transition.
    if (entranceActiveRef.current) return
    startBlendTo(nextColors)
  }, [nextColors])

  // Un-animated hard-swap branch removed (2026-08-04, Ben live: "literally
  // just snapped from 2 colors to 2 diff colors"). This used to trust that
  // pendingFromNextRef meant a blend toward these exact colors had already
  // run via the nextColors effect below, and would just directly overwrite
  // inRgb/steadyRgb with no animation at all -- correct ONLY if that earlier
  // blend actually started and had time to run its course before this fired.
  // Any timing skew (a quick skip, a retry, the entrance's own deferred
  // pendingBlendRef path clearing pendingBlendRef but not this flag) could
  // leave pendingFromNextRef true with no real blend behind it, producing a
  // raw, instant color assignment. startBlendTo is always safe to call
  // unconditionally here -- its own re-trigger snapshot logic (see its
  // header comment) already anchors from wherever the CURRENT visual state
  // actually is, so if a nextColors pre-blend already got most of the way
  // there this just continues smoothly instead of restarting from scratch;
  // it can never produce a hard jump.
  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; return }
    // Missing loading-sentinel guard (2026-08-04, Opus review): the
    // nextColors effect above already skips an all-#080808 update; this one
    // didn't. usePalette hands back the sentinel on every cache miss, so an
    // uncached cover was starting a full 7.5s blend toward near-black before
    // the real palette landed, then another full blend back to the real
    // colors once it did — two back-to-back blends where there should be
    // one, which is where a lot of the "still snapping" reports likely trace
    // back to.
    // Sentinel check now runs BEFORE clearing pendingBlendRef (2026-08-04,
    // Opus review) — clearing it first meant a sentinel palette arriving
    // during entrance discarded a real palette that was already queued for
    // the curtain lift, even though this update itself has nothing worth
    // queuing. Only clear the pending slot for updates we're actually about
    // to act on.
    if (colors.length && colors.every(c => c === '#080808')) return
    pendingBlendRef.current = null
    if (entranceActiveRef.current) { pendingBlendRef.current = colors; return }
    startBlendTo(colors)
  }, [colors])

  useEffect(() => {
    entranceActiveRef.current = entranceActive
    if (!entranceActive && pendingBlendRef.current) {
      const pending = pendingBlendRef.current
      pendingBlendRef.current = null
      startBlendTo(pending, ENTRANCE_BLEND_DURATION_MS)
    }
  }, [entranceActive])

  // Visibility resume (2026-08-04, Opus review) — the earlier per-site
  // visibilitychange handler was deleted on the theory that draw()'s own
  // resume logic already handled a tab going hidden mid-blend correctly.
  // It doesn't: rAF simply stops firing while hidden, but blendStart is a
  // wall-clock timestamp (performance.now()), so it keeps "elapsing" the
  // whole time the tab is backgrounded. The first frame back computes
  // currentOklab() using the FULL real-world gap as elapsed time, which for
  // any hide longer than a fraction of the blend duration lands past the
  // blend's end — a full jump straight to the destination color on refocus.
  // Fix: on visibility resume, shift blendStart forward by exactly how long
  // the tab was hidden, so the blend picks back up from wherever it
  // genuinely was instead of wherever wall-clock time says it should be.
  useEffect(() => {
    let hiddenAt = null
    function onVisibility() {
      if (document.hidden) {
        hiddenAt = performance.now()
        return
      }
      if (hiddenAt == null) return
      const hiddenMs = performance.now() - hiddenAt
      hiddenAt = null
      const s = st.current
      if (s.blendStart >= 0) s.blendStart += hiddenMs
      hiddenOffsetMsRef.current += hiddenMs
      if (mountedRef.current && !rafRef.current) startLoop()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    activeRef.current = active
    if (active && !rafRef.current && mountedRef.current) startLoop()
  }, [active])

  function startLoop() {
    // Drop the previous run's last frame timestamp so the first frame of this
    // run integrates dt = 0 instead of the whole gap since the loop stopped.
    flowPhaseTsRef.current = null
    rafRef.current = requestAnimationFrame(tick)
  }

  function tick(ts) {
    draw(ts)
    if (mountedRef.current && (activeRef.current || st.current.blendStart >= 0)) {
      rafRef.current = requestAnimationFrame(tick)
    } else {
      rafRef.current = null
    }
  }

  function draw(ts) {
    const canvas = canvasRef.current
    const small  = smallCanvasRef.current
    if (!canvas || !small) return
    const W = canvas.width, H = canvas.height
    if (!W || !H) return
    const ctx  = canvas.getContext('2d')
    const sctx = small.getContext('2d')
    const { w: SW, h: SH } = tinySizeRef.current

    const s = st.current

    // Crossfade in OKLab, not RGB — a plain RGB lerp between e.g. red and
    // blue passes through a muddy gray at the midpoint; OKLab keeps it a
    // real perceptual gradient the whole way. currentOklab() is the single
    // source of truth for "what color is on screen right now" — see its
    // definition above; nothing else in this file hand-computes this lerp.
    const [anchor0, anchor1] = currentOklab(ts)
    if (s.blendStart >= 0 && ts - s.blendStart >= s.blendDurationMs) {
      s.steadyRgb  = s.inRgb.map(c => [...c])
      s.blendStart = -1
      // Do NOT reset hueArcRef here (2026-08-07, second Opus critique pass —
      // this was a real regression the first "for symmetry" version shipped
      // with). The anchor COLORS don't change at this instant — inRgb just
      // gets promoted to steadyRgb, currentOklab() keeps returning the same
      // values next frame. Nulling the ref forced the very next frame to
      // re-derive rawArc via shortestDelta, which clamps to (-pi, pi] — but
      // the accumulated unwrapped arc right before completion is routinely
      // well past that range on a real crossfade (anchors drift independently
      // in currentOklab() and can carry the arc past +-180deg). The reset
      // was a full-arc snap disguised as a no-op: simulated at ~32% of
      // transitions producing a >60-unit single-frame RGB jump at the exact
      // moment a blend lands, versus 0% with no reset at all. startBlendTo/
      // settleNow DO reset it, correctly — those fire when the target colors
      // themselves change, where the old arc genuinely has nothing to do
      // with the new pair. This is not that case.
    }

    // Snap detector — a 7.5s blend can move at most ~0.04 OKLab units per
    // 16ms frame at this threshold. The entrance uses a shorter
    // ENTRANCE_BLEND_DURATION_MS (2000ms), which moves proportionally
    // faster per frame — scale the threshold by the blend actually running
    // so the entrance doesn't over-trigger false positives (2026-08-04,
    // Opus review).
    const hist = anchorHistRef.current
    const snapThreshold = 0.04 * (BLEND_DURATION_MS / Math.max(s.blendDurationMs, 1))
    if (hist.a0) {
      const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
      const d0 = dist(anchor0, hist.a0), d1 = dist(anchor1, hist.a1)
      if (d0 > snapThreshold || d1 > snapThreshold) {
        console.warn('[grad] SNAP', {
          d0: +d0.toFixed(3), d1: +d1.toFixed(3),
          dtMs: Math.round(ts - hist.ts),
          blendStart: s.blendStart,
          elapsed: s.blendStart < 0 ? null : Math.round(ts - s.blendStart),
          dur: s.blendDurationMs,
          hidden: document.hidden,
        })
      }
    }
    hist.a0 = anchor0; hist.a1 = anchor1; hist.ts = ts

    const tSec = (ts - hiddenOffsetMsRef.current) / 1000  // raw seconds minus
                                              // accumulated hidden-tab time —
                                              // anchor duel timing stays on its
                                              // own clock, independent of
                                              // FLOW_SPEED tuning, but no longer
                                              // jumps on tab resume (see
                                              // hiddenOffsetMsRef above)
    // Integrate the instantaneous flow speed over real elapsed time — see
    // flowPhaseRef's declaration for why this can't be speed x tSec. Clamped
    // to 0.05s (2026-08-07, Opus review): rAF just stops firing while the tab
    // is hidden rather than clearing rafRef, so the visibility-resume effect
    // above's `!rafRef.current` check never sees it as stopped and never
    // calls startLoop() to reset this timestamp — the first frame back would
    // otherwise integrate the ENTIRE hidden gap in one step, snapping the
    // noise field instead of resuming it. A normal dropped frame or two is
    // far under this cap; only a real backgrounding gets clamped.
    const prevTs = flowPhaseTsRef.current
    const dtSec  = prevTs === null ? 0 : Math.min(0.05, Math.max(0, tSec - prevTs))
    flowPhaseTsRef.current = tSec
    flowPhaseRef.current  += dtSec * flowSpeedAt(tSec)
    const t    = flowPhaseRef.current        // drives noise domain warp/flow

    // Two-color LERP between whichever anchor "wins" at a given point — like
    // two liquids meeting, not an N-color average (an average of many colors
    // structurally can't read as "two colors colliding," it just trends
    // toward one blended pastel). `mix` blends local noise texture (so the
    // boundary isn't a perfectly straight line) with the sweeping divider
    // position (so the boundary visibly travels).
    const divider = anchorDivider(tSec)

    // Commit the hue traversal arc ONCE per frame, not per pixel (2026-08-07,
    // see lerpOklabPolar's header) — anchor1/anchor0 are this frame's live-
    // drifting colors, fixed for every pixel below.
    //
    // UNWRAP, not hysteresis (2026-08-07, Opus review — the hysteresis
    // version shipped first and was a real regression, caught before this
    // reached a live TV): a sign-flip THRESHOLD only delays the flip, it
    // doesn't remove it — the anchors' hue gap sweeps continuously during a
    // 7.5s crossfade, so by the time the gap clears the threshold and
    // "releases," the released arc can be ~180deg away from the previous
    // frame's, producing exactly the full-width single-frame color jump
    // this whole rewrite exists to prevent (simulated: ~27% of random
    // transitions hit a >60 RGB-unit single-frame jump with the threshold
    // version, worst case 377 — matches the historical "~34% of vivid
    // near-complementary pairs" figure from the original bug report).
    // Unwrapping instead accumulates the arc continuously: each frame's raw
    // shortest-path delta gets folded onto the PREVIOUS frame's arc via its
    // own shortest delta, so a small change in the anchors' raw hue gap can
    // only ever produce a small change in the committed arc, even as the
    // raw value itself wraps across +-pi. Same simulation with the unwrap:
    // 0% of transitions exceed a 60-unit jump, worst case 19.
    const hue1 = Math.atan2(anchor1[2], anchor1[1])
    const hue0 = Math.atan2(anchor0[2], anchor0[1])
    const rawArc = shortestDelta(hue1, hue0)
    const prevArc = hueArcRef.current
    const hueArc = prevArc === null ? rawArc : prevArc + shortestDelta(prevArc, rawArc)
    hueArcRef.current = hueArc

    const img = sctx.getImageData(0, 0, SW, SH)
    const data = img.data
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        const u = (x / SW) * 5.5
        const v = (y / SH) * 5.5
        const wx = pseudoNoise(u + 9, v - 4, t * 0.6) * 0.6
        const wy = pseudoNoise(u - 6, v + 8, t * 0.6) * 0.6
        // Divider edge — POSITION-based (x/SW, plain 0-1 across the canvas),
        // not the noise-scaled u/v above. tanh gives a soft +-1 transition
        // centered on the divider instead of a hard cut. 2026-08-04, Fable's
        // critique: a slow y-dependent lean so the meeting line doesn't sit
        // perfectly vertical forever — tilt is a fraction of a screen-width,
        // its own ~30s period so it doesn't lock to the divider's rhythm.
        const tilt = 0.15 * Math.sin(tSec / 31) * (y / SH - 0.5)
        const edge = Math.tanh((x / SW - divider + tilt) * ANCHOR_SHARPNESS)

        const n0 = pseudoNoise(u + wx + colorSeeds[0].seedU, v + wy + colorSeeds[0].seedV, t) * 0.5 + 0.5
        const n1 = pseudoNoise(u + wx + colorSeeds[1].seedU, v + wy + colorSeeds[1].seedV, t + 1.3) * 0.5 + 0.5
        // score > 0 -> anchor0 winning at this pixel; < 0 -> anchor1 winning.
        const score = (n0 - n1) * ANCHOR_NOISE_CONTRAST + edge * ANCHOR_SWING
        const mix = 0.5 + 0.5 * Math.tanh(score * ANCHOR_MIX_SHARPNESS)  // no floor clamp — see file header

        // Polar blend along this frame's committed hueArc (see above) — a
        // plain per-channel lerp(anchor1, anchor0, mix) is what produced the
        // muddy gray band on near-complementary anchor pairs; see
        // lerpOklabPolar's header comment for the full fix history.
        const [L, a, b] = lerpOklabPolar(anchor1, anchor0, mix, hueArc)

        const [r, g, bb] = oklabToRgb([L, a, b])
        const idx = (y * SW + x) * 4
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = bb; data[idx + 3] = 255
      }
    }
    sctx.putImageData(img, 0, 0)

    // Upscale + blur — this, not the noise math, is the actual guarantee
    // against hard edges. Overdraw slightly past the canvas bounds so the
    // blur doesn't create a visible vignette from sampling outside the source.
    ctx.filter = 'blur(24px)'
    ctx.clearRect(0, 0, W, H)
    const pad = Math.max(W, H) * 0.06
    ctx.drawImage(small, -pad, -pad, W + pad * 2, H + pad * 2)
    ctx.filter = 'none'
    // Grain removed 2026-08-04 (Fable's critique): 700 single-pixel rects at
    // alpha 0.03 across a full TV-sized canvas is ~0.03% coverage — invisible
    // from across a bar, and static, so on the rare frame it WAS visible it
    // read as stuck dust rather than film grain. Pure cost, no payoff.
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const small = document.createElement('canvas')
    smallCanvasRef.current = small

    function resize() {
      const p = canvas.parentElement
      const w = Math.round((p ? p.clientWidth  : 0) || window.innerWidth)
      const h = Math.round((p ? p.clientHeight : 0) || window.innerHeight)
      canvas.width  = w
      canvas.height = h
      // Tiny internal canvas tracks aspect ratio, clamped so it never gets
      // expensive even on an ultrawide display — 48px on the long edge.
      const aspect = w / h
      const tw = aspect >= 1 ? 48 : Math.max(24, Math.round(48 * aspect))
      const th = aspect >= 1 ? Math.max(24, Math.round(48 / aspect)) : 48
      tinySizeRef.current = { w: tw, h: th }
      small.width = tw
      small.height = th
    }
    resize()
    window.addEventListener('resize', resize)

    mountedRef.current = true
    // !rafRef.current guard added (2026-08-07, Opus review) for consistency
    // with every other startLoop() call site (:346, :459, :467) — on
    // FIRST mount this was harmless in practice (React runs effects in
    // declaration order, so the [active] effect above already ran and
    // bailed on `mountedRef.current === false` at that point, meaning this
    // was the only startLoop() call). But it's still a real gap on any
    // later re-run of THIS effect (its own dep is [colorSeeds], which is a
    // stable useMemo so that's rare, but not impossible) without a matching
    // unmount/cleanup having nulled rafRef first. Cheap to close either way.
    if (activeRef.current && !rafRef.current) startLoop()

    return () => {
      mountedRef.current = false
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      window.removeEventListener('resize', resize)
    }
  }, [colorSeeds])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        display: 'block',
        willChange: 'transform',
        transform: 'translateZ(0)',
      }}
    />
  )
}
