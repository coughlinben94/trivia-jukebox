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
const NUM_COLORS = 5
// Full noise-flow cycle — deliberately much faster than the "barely
// perceptible" version tried during design review. Ben wants colors visibly
// moving across the screen, not just ambient drift.
const FLOW_SPEED = 0.055

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

  useEffect(() => {
    if (isFirstKey.current) { isFirstKey.current = false; return }
    const s     = st.current
    const black = Array.from({ length: NUM_COLORS }, () => [8, 8, 8])
    s.outRgb    = black.map(c => [...c])
    s.inRgb     = black.map(c => [...c])
    s.steadyRgb = black.map(c => [...c])
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
    const t = (ts / 1000) * FLOW_SPEED

    const img = sctx.getImageData(0, 0, SW, SH)
    const data = img.data
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        const u = (x / SW) * 2.6
        const v = (y / SH) * 2.6
        const wx = pseudoNoise(u + 9, v - 4, t * 0.6) * 0.6
        const wy = pseudoNoise(u - 6, v + 8, t * 0.6) * 0.6
        let L = 0, a = 0, b = 0, total = 0
        for (let i = 0; i < NUM_COLORS; i++) {
          const seed = colorSeeds[i]
          const n = pseudoNoise(u + wx + seed.seedU, v + wy + seed.seedV, t + i * 1.3)
          const w = Math.max(0, n * 0.5 + 0.5) // linear — no sharpening, stays a blend
          const [pl, pa, pb] = oklabColors[i]
          L += pl * w; a += pa * w; b += pb * w; total += w
        }
        total = Math.max(total, 0.0001)
        const [r, g, bb] = oklabToRgb([L / total, a / total, b / total])
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
