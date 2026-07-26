import { useEffect, useRef, useMemo } from 'react'

// Canvas2D "soft mesh" gradient background — third generation. Same prop
// contract as AlbumGradient.jsx (colors/nextColors/active/shuffleKey/
// entranceActive) so it drops into LiveScreen.jsx with no other changes —
// see LiveScreen.jsx for the flag that picks between this and the
// circle-blobs version.
//
// History: gen 1 (AlbumGradientNoise, WebGL) read as "lava lamp"/marble,
// retired. Gen 2 (this file, until 2026-07-26) rendered a pure noise field
// with two "anchor" colors dueling via a sweeping divider plus accent colors
// fading in/out on independent cycles — solid at not having hard edges, but
// the motion read as an abstract flowing field, not distinct moving bodies.
// Gen 3 (below) keeps every anti-hard-edge guarantee from gen 2 but replaces
// the noise-field/anchor-duel color math with the ACTUAL moving blob centers
// from AlbumGradient.jsx (circle-blobs) — same orbiting sine motion, same
// per-blob seeded variety — because that's specifically what read as
// "flowing and battling" and the noise field never fully recreated it.
//
// What's unchanged from gen 2 (the parts that actually solve hard edges):
//  1. Colors are mixed in OKLab (perceptual color space), not RGB/screen-blend.
//  2. The color field is computed at a TINY internal resolution (~48px) and
//     scaled up + blurred onto the real canvas — that upscale-blur physically
//     cannot produce a hard edge, no matter what the per-pixel color math does.
//
// What's new: each pixel's color is an inverse-distance-weighted OKLab blend
// of the NUM_BLOBS moving blob centers (Shepard's method) — always sums to
// 1 across all blobs, so there's no "no blob nearby" case and thus no black
// gaps, while still concentrating each blob's own color strongly near its
// own center. That's what gives the "distinct moving bodies colliding," not
// an averaged-out haze.

const BLEND_DURATION_MS = 7500
// Circle-blobs (AlbumGradient.jsx) only ever visualizes 6 of the up to 8
// colors api/palette.js can return — matching that here reproduces the same
// look/feel the "flowing and battling" motion was liked from.
const NUM_BLOBS = 6

// ── Blob motion — identical formulas to AlbumGradient.jsx's makeCircleParams,
// just evaluated in the tiny canvas's own pixel space instead of the real
// canvas's. Same seeded per-index variety (position, speed, phase, size) so
// the motion feels like the same six bodies people already liked.
function makeBlobParams() {
  function rng(i, slot) {
    const x = Math.sin((i * 7 + slot) * 9301 + 49297) * 233280
    return x - Math.floor(x)
  }
  return Array.from({ length: NUM_BLOBS }, (_, i) => ({
    baseX:  0.10 + rng(i, 0) * 0.80,
    baseY:  0.10 + rng(i, 1) * 0.80,
    xAmp:   0.33,
    yAmp:   0.33,
    xFreq:  1.1 / (10 + rng(i, 2) * 7),
    yFreq:  1.1 / (10 + rng(i, 3) * 7),
    xPhase: rng(i, 4) * Math.PI * 2,
    yPhase: rng(i, 5) * Math.PI * 2,
    radius: 0.50 + rng(i, 6) * 0.13,
  }))
}

// Inverse-distance-weighting power — how sharply a blob's own color
// dominates near its center vs. blending with neighbors further out. Higher
// = more distinct "bodies" with crisper (pre-blur) boundaries where two
// blobs meet, closer to how circle-blobs read; lower = creamier/more
// averaged, closer to the old noise-field feel. 3 sits close to the
// circle-blobs side since that's the explicitly requested target — the blur
// pass below still guarantees the final on-screen boundary is soft either way.
const IDW_POWER = 3
// Small per-pixel jitter on each blob's effective distance so boundaries
// wobble organically instead of forming perfect ellipses — in tiny-canvas
// pixels, so keep it small relative to the ~48px canvas.
const WOBBLE_PX = 2.2
// How fast the wobble texture itself drifts — independent of blob orbit speed.
const WOBBLE_FLOW_SPEED = 0.6

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
// frame, on whatever's actually driving the display. Used only for the
// small boundary-wobble jitter now (see WOBBLE_PX above).
function pseudoNoise(x, y, t) {
  return (
    Math.sin(x * 1.3 + t) +
    Math.sin(y * 1.4 - t * 0.7) +
    Math.sin((x + y) * 0.9 + t * 1.1) +
    Math.sin((x - y) * 1.1 - t * 0.5)
  ) / 4
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
  const blobParams         = useMemo(makeBlobParams, [])
  const tinySizeRef        = useRef({ w: 48, h: 48 })

  const st = useRef(null)
  if (!st.current) {
    const initial = parseColors(colors, NUM_BLOBS)
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
    s.inRgb      = parseColors(newHex, NUM_BLOBS)
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
      s.inRgb     = parseColors(colors, NUM_BLOBS)
      s.steadyRgb = parseColors(colors, NUM_BLOBS)
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
    const tSec = ts / 1000
    const wobT = tSec * WOBBLE_FLOW_SPEED

    // This frame's blob centers, computed once (not per pixel) — identical
    // orbiting-sine motion to AlbumGradient.jsx's circleParams, evaluated in
    // the tiny canvas's own pixel space so it upscales to the same relative
    // motion regardless of the real canvas's size.
    const blobs = blobParams.map((p, i) => ({
      cx:    (p.baseX + p.xAmp * Math.sin(tSec * p.xFreq * Math.PI * 2 + p.xPhase)) * SW,
      cy:    (p.baseY + p.yAmp * Math.sin(tSec * p.yFreq * Math.PI * 2 + p.yPhase)) * SH,
      r:     p.radius * Math.max(SW, SH),
      color: oklabColors[i % oklabColors.length],
    }))

    const img = sctx.getImageData(0, 0, SW, SH)
    const data = img.data
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        // Inverse-distance-weighted OKLab blend across all blobs (Shepard's
        // method) — weights always sum to 1, so every pixel gets real color
        // (no black gaps) while still concentrating strongly near each
        // blob's own center (weight grows large as distance → 0), which is
        // what makes them read as distinct moving bodies rather than one
        // averaged haze.
        const wob = pseudoNoise(x * 0.15, y * 0.15, wobT) * WOBBLE_PX

        let wSum = 0, L = 0, a = 0, b = 0
        for (let i = 0; i < blobs.length; i++) {
          const bl = blobs[i]
          const dx = x - bl.cx, dy = y - bl.cy
          const d  = Math.sqrt(dx * dx + dy * dy) + wob
          const dn = Math.max(0.02, d / bl.r)
          const w  = 1 / Math.pow(dn, IDW_POWER)
          wSum += w
          L += w * bl.color[0]; a += w * bl.color[1]; b += w * bl.color[2]
        }
        L /= wSum; a /= wSum; b /= wSum

        const [r, g, bb] = oklabToRgb([L, a, b])
        const idx = (y * SW + x) * 4
        data[idx] = r; data[idx + 1] = g; data[idx + 2] = bb; data[idx + 3] = 255
      }
    }
    sctx.putImageData(img, 0, 0)

    // Upscale + blur — this, not the per-pixel color math, is the actual
    // guarantee against hard edges. Overdraw slightly past the canvas bounds
    // so the blur doesn't create a visible vignette from sampling outside
    // the source.
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
  }, [blobParams])

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
