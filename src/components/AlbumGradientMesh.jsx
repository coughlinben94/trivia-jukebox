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
function anchorDivider(tSec) {
  return 0.5
    + 0.35 * Math.sin((tSec / 11.4) * Math.PI * 2)
    + 0.15 * Math.sin((tSec / 29.3) * Math.PI * 2)
    + 0.10 * Math.sin((tSec / 7.1)  * Math.PI * 2)
}

// FLOW_SPEED breathes slowly (2026-08-04, Fable's critique) instead of
// idling at one constant tempo — motion surges and settles on a ~4.5min
// cycle instead of reading as a metronome.
function flowSpeedAt(tSec) {
  return FLOW_SPEED * (1 + 0.25 * Math.sin(tSec / 43))
}

function hexToRgb(hex) {
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

// Polar OKLab lerp (2026-08-04, fixes the muddy-gray-band bug) — replaces
// lerpOklab everywhere colors actually blend. lerpOklab above is a straight
// Cartesian lerp of (a,b): two near-complementary hues (e.g. orange/blue)
// point roughly opposite directions in the a/b plane, so their vector sum
// cancels toward the origin at the midpoint -- chroma collapses near 0 (gray)
// even though L and each endpoint's own chroma are both fine. This project
// hit and fixed the identical bug once before in an earlier, more complex
// mesh build (git a5dc1cc) via hue/chroma blending instead of vector
// averaging; this is that fix adapted to the current 2-anchor lerp model.
//
// L lerps linearly (unaffected by the bug). Chroma lerps as a scalar
// magnitude (can't cancel -- averaging two positive numbers never produces
// something smaller than both). Hue lerps via shortest angular path, but
// with the *blend fraction* itself weighted by each endpoint's own chroma
// (Fable review, 2026-08-04): a near-achromatic endpoint (e.g. the B&W-cover
// offwhite fallback, chroma ~0.01) has an arbitrary atan2 hue, and a plain
// t-weighted hue lerp would swing the mid-fade through that arbitrary hue at
// rising chroma -- a faint wrong-colored tint where the result should read
// neutral. Chroma-weighting means a near-zero-chroma color barely votes on
// hue at all. Endpoint hues are fixed for the life of one call (h1/h2 come
// from the two OKLab colors passed in, not from any per-frame state), so
// there's no frame-to-frame "which way around the circle" instability within
// a single crossfade -- the direction is only decided once, at each call's
// own fixed inputs.
function lerpOklabPolar(a, b, t) {
  const [L1, a1, b1] = a
  const [L2, a2, b2] = b
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const L = lerp(L1, L2, t)
  const C = lerp(C1, C2, t)

  const denom = C1 * (1 - t) + C2 * t
  const th = denom > 1e-4 ? (C2 * t) / denom : t
  const h1 = Math.atan2(b1, a1)
  const h2 = Math.atan2(b2, a2)
  let dh = h2 - h1
  while (dh > Math.PI) dh -= Math.PI * 2
  while (dh < -Math.PI) dh += Math.PI * 2
  const h = h1 + dh * th

  return [L, C * Math.cos(h), C * Math.sin(h)]
}

// ── OKLab conversion — standard Bjorn Ottosson formulas.

function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
function linearToSrgb(c) { c = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, c * 255)) }
function cbrt(x) { return Math.sign(x) * Math.pow(Math.abs(x), 1 / 3) }

function rgbToOklab([r, g, b]) {
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

function oklabToRgb([L, a, b]) {
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
  const pendingFromNextRef  = useRef(false)
  const entranceActiveRef  = useRef(entranceActive)
  const pendingBlendRef    = useRef(null)
  const colorSeeds         = useMemo(makeColorSeeds, [])
  const tinySizeRef        = useRef({ w: 48, h: 48 })

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

  // durationMs: the entrance's own first real-palette blend uses
  // ENTRANCE_BLEND_DURATION_MS (2026-08-04, owner: the full 7.5s
  // song-to-song duration was still visibly shifting tint well after the
  // tonearm had already dropped and the song was audibly playing — by the
  // time the black curtain lifts (LiveScreen.jsx) the record's already
  // settled, so a multi-second color creep afterward reads as unfinished,
  // not as "floating in"). Every other caller keeps the default song-to-song
  // duration.
  function startBlendTo(newHex, durationMs = BLEND_DURATION_MS) {
    const s   = st.current
    const now = performance.now()
    if (s.blendStart >= 0 && (now - s.blendStart) < s.blendDurationMs) {
      // Snapshot the CURRENT OKLab-blended position (not a fresh RGB lerp)
      // as the new outgoing point, so re-triggering mid-blend doesn't
      // reintroduce an RGB step. Uses the OUTGOING blend's own duration,
      // not the new one about to start.
      const t = easeInOut(Math.min((now - s.blendStart) / s.blendDurationMs, 1))
      s.outRgb = s.outRgb.map((c, i) =>
        oklabToRgb(lerpOklabPolar(rgbToOklab(c), rgbToOklab(s.inRgb[i]), t))
      )
    } else {
      s.outRgb = s.steadyRgb.map(c => [...c])
    }
    s.inRgb          = parseColors(newHex, NUM_ANCHORS)
    s.blendStart      = performance.now()
    s.blendDurationMs = durationMs
    if (!rafRef.current && mountedRef.current) startLoop()
  }

  // shuffleKey: new session starts. No black snap — a forced black reset
  // meant one for a chunk of the 7.5s entrance blend every time. Just clear
  // blend-tracking state; the colors-effect below crossfades straight from
  // whatever's on screen into the new song's palette.
  useEffect(() => {
    if (isFirstKey.current) { isFirstKey.current = false; return }
    const s = st.current
    s.blendStart = -1
    pendingFromNextRef.current = false
  }, [shuffleKey])

  useEffect(() => {
    if (isFirstNext.current) { isFirstNext.current = false; return }
    if (!nextColors.length) return
    if (nextColors.every(c => c === '#080808')) return
    if (entranceActiveRef.current) {
      pendingFromNextRef.current = true
      pendingBlendRef.current = nextColors
      return
    }
    startBlendTo(nextColors)
    pendingFromNextRef.current = true
  }, [nextColors])

  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; return }
    if (pendingFromNextRef.current) {
      pendingFromNextRef.current = false
      pendingBlendRef.current = null
      const s = st.current
      s.inRgb     = parseColors(colors, NUM_ANCHORS)
      s.steadyRgb = parseColors(colors, NUM_ANCHORS)
    } else {
      if (entranceActiveRef.current) { pendingBlendRef.current = colors; return }
      startBlendTo(colors)
    }
  }, [colors])

  useEffect(() => {
    entranceActiveRef.current = entranceActive
    if (!entranceActive && pendingBlendRef.current) {
      const pending = pendingBlendRef.current
      pendingBlendRef.current = null
      startBlendTo(pending, ENTRANCE_BLEND_DURATION_MS)
    }
  }, [entranceActive])

  useEffect(() => {
    activeRef.current = active
    if (active && !rafRef.current && mountedRef.current) startLoop()
  }, [active])

  function startLoop() {
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
    // real perceptual gradient the whole way. (This was the one place the
    // original build still used an RGB lerp — everything else was already
    // OKLab.)
    let anchor0, anchor1
    const outOklab = s.outRgb.map(rgbToOklab)
    const inOklab  = s.inRgb.map(rgbToOklab)
    if (s.blendStart >= 0) {
      const t = easeInOut(Math.min((ts - s.blendStart) / s.blendDurationMs, 1))
      ;[anchor0, anchor1] = outOklab.map((c, i) => lerpOklabPolar(c, inOklab[i], t))
      if (t >= 1) {
        s.steadyRgb = s.inRgb.map(c => [...c])
        s.blendStart = -1
      }
    } else {
      ;[anchor0, anchor1] = s.steadyRgb.map(rgbToOklab)
    }

    const tSec = ts / 1000                   // raw seconds — anchor duel timing
                                              // stays on its own clock, independent
                                              // of FLOW_SPEED tuning
    const t    = tSec * flowSpeedAt(tSec)    // drives noise domain warp/flow

    // Two-color LERP between whichever anchor "wins" at a given point — like
    // two liquids meeting, not an N-color average (an average of many colors
    // structurally can't read as "two colors colliding," it just trends
    // toward one blended pastel). `mix` blends local noise texture (so the
    // boundary isn't a perfectly straight line) with the sweeping divider
    // position (so the boundary visibly travels).
    const divider = anchorDivider(tSec)

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

        // Polar blend, not lerp(anchor1, anchor0, mix) on each L/a/b channel
        // separately — see lerpOklabPolar's header comment. Cartesian a/b
        // lerp is exactly what produced the muddy gray band on near-
        // complementary anchor pairs.
        const [L, a, b] = lerpOklabPolar(anchor1, anchor0, mix)

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
    if (activeRef.current) startLoop()

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
