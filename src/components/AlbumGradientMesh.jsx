import { useEffect, useRef, useMemo } from 'react'

// Canvas2D "soft mesh" gradient background — the second-generation replacement
// for the WebGL noise version (AlbumGradientNoise, retired after it read as
// "lava lamp"/psychedelic marble live). Same prop contract as AlbumGradient.jsx
// (colors/nextColors/active/shuffleKey/entranceActive) so it drops into
// LiveScreen.jsx with no other changes — see LiveScreen.jsx for the flag that
// picks between this and the original canvas-circles version.
//
// Three things fix what the WebGL version got wrong (per design review):
//  1. Colors are mixed in OKLab (perceptual color space), not RGB/screen-blend.
//     Screen-blend is what produced the hot bright veins; naive RGB lerp gives
//     muddy gray seams. OKLab gives the creamy Stripe/Linear-style transitions.
//  2. The noise field is rendered at a TINY internal resolution (~48px) and
//     scaled up + blurred onto the real canvas — that upscale-blur physically
//     cannot produce a hard edge, no matter how the noise math behaves.
//  3. No sharpening exponent on the color weights (the WebGL version's
//     `pow(n, 1.6)` pushed each color toward all-or-nothing, which is what
//     made it read as marble veins instead of a blend).
//
// Palette is 5 colors (up from the original's 6 circles) — api/palette.js
// now ranks median-cut buckets by saturation and falls back to two fixed
// accent hues for near-grayscale album art, so this always has real color to
// work with.

const BLEND_DURATION_MS = 7500
// api/palette.js now returns 5-8 colors (up from a fixed 5) when the cover
// actually has that many distinct real hues — NUM_COLORS caps how many this
// component will ever draw, so it needs to match that ceiling or the extra
// colors api/palette.js worked to find just get silently dropped.
const NUM_COLORS = 8
// Full noise-flow cycle. Previous value (0.055) was a ~2-minute cycle —
// in any 10s glance the pattern moved ~3% of a period, which is why
// nothing looked like it was moving no matter how the color weights were
// tuned. This is the actual "dancing" knob, not the weight exponent below.
// 0.45 → 0.79: +75% per live feedback, still not enough dance.
const FLOW_SPEED = 0.79
// colors[0]/[1] are the two most-saturated palette picks (api/palette.js
// ranks by HSL saturation) — treated as "anchor" colors: always present,
// slowly trading dominance back and forth. colors[2..4] are "accent"
// colors: no floor, each fades fully in and out on its own cycle.
// Anchor/accent periods also cut ~75% (period down = cycle speed up) to
// match the FLOW_SPEED bump — otherwise the color weights would still
// duel/fade at the old slow pace while the noise field flows past faster.
const ANCHOR_COUNT      = 2
const ANCHOR_PERIOD_S   = 11.4  // one full sweep of the divider, edge to edge and back
const ANCHOR_SWING      = 0.30  // how much the sweeping divider contributes to who's winning, vs. local noise texture
const ANCHOR_SHARPNESS  = 3.5   // divider position→edge transition — lower = blurrier, higher = crisper
// Two-color collision tuning (see the ARCHITECTURE CHANGE comment in draw()
// for why this replaced the old N-color weighted average):
const ANCHOR_NOISE_CONTRAST = 1.5  // how much local noise texture (vs. the divider sweep) shapes the boundary's wobble
const ANCHOR_MIX_SHARPNESS  = 2.4  // steepness of the anchor0↔anchor1 transition itself — higher = crisper meeting line
const ANCHOR_FLOOR      = 0.18  // neither anchor ever fully disappears, even on its "losing" side
const ACCENT_BASE_PERIOD_S = 7.4 // each accent's in/out period, staggered below
const ACCENT_EXP    = 1.35 // gentle — accents were reading as "no green at all" under a steeper curve
const ACCENT_BOOST  = 1.6  // compensates so an "in" accent is actually visible, not just a faint tint
const ACCENT_MAX_MIX = 0.5 // hard cap per accent — guarantees the anchor collision underneath can never be washed out

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

// ── OKLab conversion — standard Björn Ottosson formulas, used only for the
// per-pixel multi-color mix (the outer song-to-song crossfade stays plain RGB
// lerp, unchanged from the proven original — OKLab only where the actual
// muddy/hot-vein problem was).

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
// comparable for this purpose and far cheaper per-pixel in plain JS, which
// matters since this runs at every pixel of the tiny internal canvas, every
// frame, on whatever's actually driving the display.
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
  return Array.from({ length: NUM_COLORS }, (_, i) => ({
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
    const initial = parseColors(colors, NUM_COLORS)
    st.current = {
      steadyRgb:  initial.map(c => [...c]),
      outRgb:     initial.map(c => [...c]),
      inRgb:      initial.map(c => [...c]),
      blendStart: -1,
    }
  }

  function startBlendTo(newHex) {
    const s   = st.current
    const now = performance.now()
    if (s.blendStart >= 0 && (now - s.blendStart) < BLEND_DURATION_MS) {
      const t = easeInOut(Math.min((now - s.blendStart) / BLEND_DURATION_MS, 1))
      s.outRgb = s.outRgb.map((c, i) => [
        lerp(c[0], s.inRgb[i][0], t),
        lerp(c[1], s.inRgb[i][1], t),
        lerp(c[2], s.inRgb[i][2], t),
      ])
    } else {
      s.outRgb = s.steadyRgb.map(c => [...c])
    }
    s.inRgb      = parseColors(newHex, NUM_COLORS)
    s.blendStart = performance.now()
    if (!rafRef.current && mountedRef.current) startLoop()
  }

  // shuffleKey: new session starts. No black snap — same reasoning as
  // AlbumGradient.jsx: Ben doesn't want a black gradient ever, and forcing a
  // black reset meant one for a chunk of the 7.5s entrance blend every time.
  // Just clear blend-tracking state; the colors-effect below crossfades
  // straight from whatever's on screen into the new song's palette.
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
      s.inRgb     = parseColors(colors, NUM_COLORS)
      s.steadyRgb = parseColors(colors, NUM_COLORS)
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
      startBlendTo(pending)
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
    let liveColors
    if (s.blendStart >= 0) {
      const t = easeInOut(Math.min((ts - s.blendStart) / BLEND_DURATION_MS, 1))
      liveColors = s.outRgb.map((c, i) => [
        lerp(c[0], s.inRgb[i][0], t),
        lerp(c[1], s.inRgb[i][1], t),
        lerp(c[2], s.inRgb[i][2], t),
      ])
      if (t >= 1) {
        s.steadyRgb = s.inRgb.map(c => [...c])
        s.blendStart = -1
      }
    } else {
      liveColors = s.steadyRgb
    }

    const oklabColors = liveColors.map(rgbToOklab)
    const t    = (ts / 1000) * FLOW_SPEED   // drives noise domain warp/flow
    const tSec = ts / 1000                   // raw seconds — anchor duel + accent
                                              // fade timing stay on their own clock,
                                              // independent of FLOW_SPEED tuning

    // ARCHITECTURE CHANGE, verified against a real screen recording: the
    // previous approach normalized a weighted OKLab average across all 8
    // colors at every pixel. Averaging N colors together always trends
    // toward one blended pastel, no matter how the individual weights are
    // tuned — three rounds of tuning that same average (exponent, floor,
    // spatial divider bias) all still produced one flat hue on screen. That
    // was the wrong lever: an average of many things is structurally
    // incapable of reading as "two colors colliding."
    //
    // New model: the two anchors are a genuine two-color LERP (not an
    // N-color average) between whichever one "wins" at a given point — like
    // two liquids meeting, not eight paints mixed in a bucket. `mix` blends
    // local noise texture (so the boundary isn't a perfectly straight line)
    // with the sweeping divider position (so the boundary visibly travels).
    // Accents then layer on top of that two-color base one at a time, each
    // capped at ACCENT_MAX_MIX so no accent can ever wash the base out.
    const anchorDivider = 0.5 + 0.5 * Math.sin((tSec / ANCHOR_PERIOD_S) * Math.PI * 2)
    // Accents: independent period per index (staggered so they don't all fade
    // in/out in lockstep) and pow(…, 1.5) on the 0–1 envelope so each one
    // actually spends real time near-zero (true "out") instead of just
    // wobbling in the middle of its range.
    const accentEnvelope = Array.from({ length: NUM_COLORS - ANCHOR_COUNT }, (_, j) => {
      const period = ACCENT_BASE_PERIOD_S + j * 5
      const phase  = j * (Math.PI * 2 / 3)
      const raw01  = (Math.sin((tSec / period) * Math.PI * 2 + phase) + 1) / 2
      return Math.pow(raw01, 1.5)
    })

    const [anchor0, anchor1] = oklabColors

    const img = sctx.getImageData(0, 0, SW, SH)
    const data = img.data
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        // Scale 2.6 → 5.5: at 2.6, less than one noise period fit on screen —
        // every color read as one broad soft ramp. 5.5 puts a few distinct
        // features per axis so the boundary between the two anchors has real
        // texture instead of being a dead-straight line.
        const u = (x / SW) * 5.5
        const v = (y / SH) * 5.5
        const wx = pseudoNoise(u + 9, v - 4, t * 0.6) * 0.6
        const wy = pseudoNoise(u - 6, v + 8, t * 0.6) * 0.6
        // Divider edge — POSITION-based (x/SW, plain 0–1 across the canvas),
        // not the noise-scaled u/v above. tanh gives a soft ±1 transition
        // centered on the divider instead of a hard cut.
        const edge = Math.tanh((x / SW - anchorDivider) * ANCHOR_SHARPNESS)

        const n0 = pseudoNoise(u + wx + colorSeeds[0].seedU, v + wy + colorSeeds[0].seedV, t) * 0.5 + 0.5
        const n1 = pseudoNoise(u + wx + colorSeeds[1].seedU, v + wy + colorSeeds[1].seedV, t + 1.3) * 0.5 + 0.5
        // score > 0 → anchor0 winning at this pixel; < 0 → anchor1 winning.
        // Local noise texture (n0 - n1) gives the boundary organic wobble;
        // the divider term is what makes that boundary sweep across the
        // whole canvas over time instead of just sitting there wobbling.
        const score = (n0 - n1) * ANCHOR_NOISE_CONTRAST + edge * ANCHOR_SWING
        let mix = 0.5 + 0.5 * Math.tanh(score * ANCHOR_MIX_SHARPNESS)
        mix = Math.min(1 - ANCHOR_FLOOR, Math.max(ANCHOR_FLOOR, mix)) // never fully 0 or 1 — a trace of the "losing" anchor always shows

        let L = lerp(anchor1[0], anchor0[0], mix)
        let a = lerp(anchor1[1], anchor0[1], mix)
        let b = lerp(anchor1[2], anchor0[2], mix)

        // Accents layer on top of the anchor base one at a time, each capped
        // at ACCENT_MAX_MIX — nudges the color toward itself proportionally,
        // never fully replaces what's already there.
        for (let i = ANCHOR_COUNT; i < NUM_COLORS; i++) {
          const seed = colorSeeds[i]
          const n = pseudoNoise(u + wx + seed.seedU, v + wy + seed.seedV, t + i * 1.3) * 0.5 + 0.5
          const base = Math.pow(Math.max(0, n), ACCENT_EXP)
          const w = Math.min(ACCENT_MAX_MIX, base * accentEnvelope[i - ANCHOR_COUNT] * ACCENT_BOOST)
          if (w <= 0) continue
          const [pl, pa, pb] = oklabColors[i]
          L = lerp(L, pl, w); a = lerp(a, pa, w); b = lerp(b, pb, w)
        }

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

    // Subtle grain — standard fix for 8-bit-panel banding on smooth dark
    // gradients (a TV, not a computer monitor, is driving this).
    ctx.globalAlpha = 0.03
    for (let i = 0; i < 700; i++) {
      ctx.fillStyle = Math.random() > 0.5 ? '#fff' : '#000'
      ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1)
    }
    ctx.globalAlpha = 1
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
