import { useEffect, useRef, useMemo } from 'react'
import { orbitSpeed, blobRadius, meshIdwPower, chromaScale, blendDurationMs } from '../lib/gradientTuning.js'
import { mudRescue } from '../lib/mudModel.js'

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

// Circle-blobs (AlbumGradient.jsx) only ever visualizes 6 of the up to 8
// colors api/palette.js can return — matching that here reproduces the same
// look/feel the "flowing and battling" motion was liked from.
const NUM_BLOBS = 6

// ── Blob motion — same orbiting-sine formulas as AlbumGradient.jsx's
// makeCircleParams, evaluated in the tiny canvas's own pixel space.
//
// Antipodal pairing (2026-07-30): odd-index blobs are no longer independently
// seeded — each one mirrors the even blob before it through the canvas center
// (base reflected, same freqs/amps, phase +π, so its position is exactly
// 1 − partner's position at every instant; only radius keeps its own seed).
// Why: parseColors hands colors out by blob index (src[(i+rot) % len]), so
// with a 2-color palette the even blobs are one color and the odd blobs the
// other — and with six INDEPENDENT orbits (each swinging ±0.33 around a
// seeded base on a 9–15s period), how much of the frame each color owns was
// left entirely to chance. Verified numerically against these exact formulas
// (48×27 grid, IDW power 2, default dials): color A's mean share of the frame
// swung 0.29 → 0.72 within a single 9-second stretch — the entire background
// visibly flipping from one palette color to the other MID-SONG with no prop
// change anywhere (live-reported 2026-07-30 as "the first song changes
// palettes halfway through"; the trigger path through nextColors/onFadeStart
// was ruled out — that path always fades the audio out and advances, and the
// audio kept playing). The same chance-driven imbalance is why the blend read
// as "one color at ~90%, the other at ~10%, flipping around" rather than two
// colors actually interacting: at any instant one color's three blobs could
// cluster and own almost everything (measured moments of 58%-vs-11% and
// 6%-vs-61% strongly-dominated area).
// With each color pair mirrored, wherever one color dominates its partner
// dominates the mirror-image region, so the frame-wide balance is pinned by
// construction: measured share range 0.48–0.55 over the same window, with
// both colors always holding comparable strongly-dominant area — always
// co-present, always meeting along moving seams, never flipping. 3-color
// palettes (pickGradientColors' close-hues case) interleave as c0/c1, c2/c0,
// c1/c2 across the three pairs, so every color still appears on both sides;
// measured per-color share tightens from 0.11–0.55 to 0.19–0.48. Motion
// character is unchanged — three of the six paths moved, but they're the same
// seeded orbiting bodies at the same speeds/sizes, and three independent
// pair-frequencies plus the boundary wobble keep the symmetry from reading
// as mechanical. No new constants, no new dials.
function makeBlobParams() {
  function rng(i, slot) {
    const x = Math.sin((i * 7 + slot) * 9301 + 49297) * 233280
    return x - Math.floor(x)
  }
  const speed = orbitSpeed()
  const size  = blobRadius()
  const makeOne = (i) => ({
    baseX:  0.10 + rng(i, 0) * 0.80,
    baseY:  0.10 + rng(i, 1) * 0.80,
    xAmp:   0.33,
    yAmp:   0.33,
    xFreq:  speed / (10 + rng(i, 2) * 7),
    yFreq:  speed / (10 + rng(i, 3) * 7),
    xPhase: rng(i, 4) * Math.PI * 2,
    yPhase: rng(i, 5) * Math.PI * 2,
    radius: size + rng(i, 6) * 0.13,
  })
  return Array.from({ length: NUM_BLOBS }, (_, i) => {
    if (i % 2 === 0) return makeOne(i)
    const p = makeOne(i - 1)
    return {
      baseX:  1 - p.baseX,
      baseY:  1 - p.baseY,
      xAmp:   p.xAmp,
      yAmp:   p.yAmp,
      xFreq:  p.xFreq,
      yFreq:  p.yFreq,
      xPhase: p.xPhase + Math.PI,
      yPhase: p.yPhase + Math.PI,
      radius: size + rng(i, 6) * 0.13,
    }
  })
}

// Inverse-distance-weighting power — how sharply a blob's own color
// dominates near its center vs. blending with neighbors further out. Higher
// = more distinct "bodies" with crisper (pre-blur) boundaries where two
// blobs meet, closer to how circle-blobs read; lower = creamier/more
// averaged, closer to the old noise-field feel. Now the BLEND dial
// (gradientTuning.js meshIdwPower()) — 3 (its default-position value) sits
// close to the circle-blobs side since that's the explicitly requested
// target — the blur pass below still guarantees the final on-screen
// boundary is soft either way.
//
// The blob-IDW model has no built-in dampening (unlike the old anchor/accent
// system's ANCHOR_FLOOR/ACCENT_MAX_MIX caps) — every pixel is a full-strength
// blend of real palette hues, which read as more saturated throughout than
// the original circle-blobs renderer (whose alpha falloff diluted color
// toward black at each blob's edge). Scaling OKLab's a/b channels (which
// directly encode chroma) down before converting back to RGB dials that back
// without touching hue or lightness — now the BRIGHTNESS dial
// (gradientTuning.js chromaScale()). 1.0 = no change.
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

// Found 2026-07-30: blob motion (baseX/baseY/frequencies/phases from
// makeBlobParams) is memoized with an EMPTY dependency array — verified
// numerically, e.g. blob index 0 always orbits around baseX=0.771/
// baseY=0.175 (never reaches the bottom or left edge — max extent is
// x:[0.44,1.10] y:[-0.16,0.51]), while blob index 4 always orbits around
// baseX=0.108/baseY=0.692 (range x:[-0.22,0.44] y:[0.36,1.02] — the one
// whose fixed path actually sweeps the bottom-left corner). That per-mount
// fixed-orbit memoization is intentional and stays untouched — it's what
// gives the tuning board's "same six bodies" continuity.
//
// The actual structural bug is one level up: draw() always pulled each
// blob's color as oklabColors[i % oklabColors.length], and this function
// always filled that array as src[i % src.length] — so blob index 0 (a
// FIXED orbit path, same every song, same every page load) always got
// colors[0]. api/palette.js hands colors[] back most-vivid-first, so the
// single most-interesting hue was pinned to whichever screen region blob
// 0's fixed orbit happens to cover, forever, on every single song — a
// structural artifact ("hard-edged magenta pool always in the same corner"
// / "blue pool always behind the record"), not per-song bad luck.
//
// Fix: rotate which palette index feeds which blob slot, per palette (not
// per pixel/frame) — a deterministic hash of the incoming array's first hex
// string, mod the array length. Deterministic (not Math.random() or a
// mount-time counter) so re-rendering the SAME album cover always resolves
// to the SAME mapping — no flicker if this function gets called twice for
// one song — but DIFFERENT covers almost always hash to a different
// rotation, which is enough to stop one fixed blob slot from being the
// eternal home of colors[0]. Critically, this only changes which index of
// hexArr gets READ here — it can't destabilize the crossfade contract in
// startBlendTo/draw, because by the time blendPairRgb() runs, outRgb[i]/
// inRgb[i] are already-resolved RGB triplets sitting in blob-index slots;
// blendPairRgb blends two concrete colors per slot and has no notion of
// (and no dependency on) which palette index either one came from, or
// whether the rotation differed between the outgoing and incoming call.
function rotationFor(src, mod = src.length) {
  if (!src.length || !mod) return 0
  const hex = src[0] || '#000000'
  let sum = 0
  for (let k = 1; k < hex.length; k++) sum += hex.charCodeAt(k)
  return sum % mod
}

// Equal split RESTORED 2026-07-30 (owner call, end of the weighted-palette
// day): every palette color gets an equal alternating share of the 6 blobs
// — src[(i+rot) % len] — the exact math that was live on 2026-07-27 and
// remembered as "looked real nice." The weight-driven blob allocation that
// replaced it earlier today (Hamilton apportionment + greedy arena
// assignment) measured 22/30 covers broken in a 30-cover live audit: a
// 15%-weight color got exactly 1 of 6 blobs, and 1 blob is either
// INVISIBLE (mean 2% frame share — it loses the chroma-weighted hue vote
// everywhere but its own core; reported as "one color on screen") or a
// LONE ORBITING DISC (a compact pool circling one fixed orbit all song;
// reported as "lava lamp" / "blue blob going round and round"). Equal
// split scored 27/30 clean on the same covers, same math, same frames.
// Weights still order the palette server-side (most-dominant first) and
// still gate LiveScreen's >6-color cap; the renderer just no longer sizes
// by them. The weights/nextWeights props stay accepted-and-unused so the
// engine A/B contract with LiveScreen needs no change.
//
// With modulo assignment over the fixed antipodal arenas ((0,1),(2,3),
// (4,5), odd mirrors even), the two slots of every arena get DIFFERENT
// colors at every palette length 2-6 (len 2: (c0,c1)x3; len 3: (c0,c1),
// (c2,c0),(c1,c2); len 4: (c0,c1),(c2,c3),(c0,c1); len 5: (c0,c1),
// (c2,c3),(c4,c0)) — so the antipodal balance-pinning (frame share range
// ~0.43-0.59, no mid-song 90/10 flips) applies to every arena at every
// palette size. That stabilizer is the one piece of the weighted-era work
// that stays: it fixes a measured 07-27 defect (0.29→0.72 share swings)
// without changing the look class.
function parseColors(hexArr, n) {
  const src = hexArr.length ? hexArr : ['#080808']
  const rot = rotationFor(src, src.length)
  return Array.from({ length: n }, (_, i) => [...hexToRgb(src[(i + rot) % src.length])])
}

// ── HSL helpers for the displayed-mud guard in draw() ───────────────────────
// Port of api/palette.js's cylinder math minus hex formatting. The mud
// bands (src/lib/mudModel.js) were calibrated in HSL hue/rel-sat/lightness,
// so the guard converts each candidate pixel INTO that space rather than
// refitting the bands in OKLab — one definition of mud, no drift. At
// 48x27 = 1,296 px this is noise next to the per-pixel IDW loop.
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn, l = (mx + mn) / 2
  let h = 0
  if (c > 0) {
    if (mx === r) h = ((g - b) / c) % 6
    else if (mx === g) h = (b - r) / c + 2
    else h = (r - g) / c + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, c, l]
}
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r, g, b
  if (h < 60)       [r, g, b] = [c, x, 0]
  else if (h < 120)  [r, g, b] = [x, c, 0]
  else if (h < 180)  [r, g, b] = [0, c, x]
  else if (h < 240)  [r, g, b] = [0, x, c]
  else if (h < 300)  [r, g, b] = [x, 0, c]
  else               [r, g, b] = [c, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
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

function rgbToOklch(rgb) {
  const [L, a, b] = rgbToOklab(rgb)
  return [L, Math.sqrt(a * a + b * b), Math.atan2(b, a)]
}

function oklchToRgb(L, C, H) {
  return oklabToRgb([L, C * Math.cos(H), C * Math.sin(H)])
}

// Bakes a small tile of random black/white 1px dots ONCE and returns a
// repeating canvas pattern, instead of the 700 individual fillRect() calls
// (each with its own fillStyle string toggle and Math.random() pair) the
// grain pass used to do every single animation frame (2026-07-30 — reported
// live as visible chop, most noticeable on the spinning record, alongside
// everything else this file already does per frame: the 48×48 IDW blend
// loop, then a blur(24px) filter over the full canvas). One drawImage-backed
// pattern fill replaces those 700 draw calls with effectively one, at the
// same ~0.03-alpha sparse density. Static (not re-randomized per frame) is a
// deliberate trade — at this density and alpha the difference from
// per-frame noise is imperceptible against a moving color field, and a
// static tile can be built once and reused for the component's whole
// lifetime instead of costing anything per frame at all.
const GRAIN_TILE = 256
const GRAIN_DOTS = 45   // ~same density as the old 700-over-full-canvas version at ~1MP (not 1080p -- 45/256^2 is roughly 2x 700/1080p's dots-per-px^2; invisible at 0.03 alpha either way)
function makeGrainPattern(ctx) {
  const tile = document.createElement('canvas')
  tile.width = GRAIN_TILE
  tile.height = GRAIN_TILE
  const tctx = tile.getContext('2d')
  for (let i = 0; i < GRAIN_DOTS; i++) {
    tctx.fillStyle = Math.random() > 0.5 ? '#fff' : '#000'
    tctx.fillRect(Math.random() * GRAIN_TILE, Math.random() * GRAIN_TILE, 1, 1)
  }
  return ctx.createPattern(tile, 'repeat')
}

// Shortest-arc hue interpolation (radians) — without this, lerping hue
// straight (e.g. 10° -> 350°) sweeps the LONG way around the wheel through
// every hue in between instead of the short 20° hop.
function hueLerp(h1, h2, t) {
  let delta = h2 - h1
  delta = ((delta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
  return h1 + delta * t
}

// Found 2026-07-28 (same day as the spatial-blend hue/chroma fix below, same
// root cause): the song-to-song crossfade (outRgb -> inRgb, one color per
// blob) was a flat per-channel RGB lerp. Two near-complementary hues (say a
// warm orange fading into a near-black/purple cover) lerp straight through
// their RGB midpoint, which desaturates toward gray-brown at t=0.5 — visible
// on screen as a muddy sludge wash across the whole transition, independent
// of the per-pixel spatial fix (that one only touches how multiple blobs mix
// within a single frame; this is two colors mixing across time). Fix here is
// the 2-point analog: interpolate L and chroma as plain scalars, hue along
// the shortest arc, instead of lerping the raw RGB channels or the raw a/b
// vector (either of which can cancel toward gray the same way).
function blendPairRgb(rgbA, rgbB, t) {
  const [La, Ca, Ha] = rgbToOklch(rgbA)
  const [Lb, Cb, Hb] = rgbToOklch(rgbB)
  return oklchToRgb(lerp(La, Lb, t), lerp(Ca, Cb, t), hueLerp(Ha, Hb, t))
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

// weights/nextWeights are accepted and UNUSED since the 2026-07-30 equal-
// split restore (see parseColors) — kept so LiveScreen's GradientBg line
// and the engine A/B contract with AlbumGradient.jsx need no change.
export default function AlbumGradientMesh({ colors = [], nextColors = [], weights = [], nextWeights = [], active = true, shuffleKey = 0, entranceActive = false }) {
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
  const grainPatternRef    = useRef(null)

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
    if (s.blendStart >= 0 && (now - s.blendStart) < blendDurationMs()) {
      const t = easeInOut(Math.min((now - s.blendStart) / blendDurationMs(), 1))
      s.outRgb = s.outRgb.map((c, i) => blendPairRgb(c, s.inRgb[i], t))
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
      pendingBlendRef.current = { colors: nextColors }
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
      if (entranceActiveRef.current) { pendingBlendRef.current = { colors }; return }
      startBlendTo(colors)
    }
  }, [colors])

  useEffect(() => {
    entranceActiveRef.current = entranceActive
    if (!entranceActive && pendingBlendRef.current) {
      const pending = pendingBlendRef.current
      pendingBlendRef.current = null
      startBlendTo(pending.colors)
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
      const t = easeInOut(Math.min((ts - s.blendStart) / blendDurationMs(), 1))
      liveColors = s.outRgb.map((c, i) => blendPairRgb(c, s.inRgb[i], t))
      if (t >= 1) {
        s.steadyRgb = s.inRgb.map(c => [...c])
        s.blendStart = -1
      }
    } else {
      liveColors = s.steadyRgb
    }

    const oklabColors = liveColors.map(rgbToOklab)
    const idwPower  = meshIdwPower()
    const chromaScl = chromaScale()
    const tSec = ts / 1000
    const wobT = tSec * WOBBLE_FLOW_SPEED

    // This frame's blob centers, computed once (not per pixel) — identical
    // orbiting-sine motion to AlbumGradient.jsx's circleParams, evaluated in
    // the tiny canvas's own pixel space so it upscales to the same relative
    // motion regardless of the real canvas's size.
    const blobs = blobParams.map((p, i) => {
      const color = oklabColors[i % oklabColors.length]
      return {
        cx:    (p.baseX + p.xAmp * Math.sin(tSec * p.xFreq * Math.PI * 2 + p.xPhase)) * SW,
        cy:    (p.baseY + p.yAmp * Math.sin(tSec * p.yFreq * Math.PI * 2 + p.yPhase)) * SH,
        r:     p.radius * Math.max(SW, SH),
        color,
        // Chroma magnitude of this blob's a/b vector, precomputed once per
        // blob per frame (static — doesn't depend on pixel position). Used
        // by the polar blend below so a low-chroma blob can't destabilize
        // the hue vote the way its raw a/b would.
        chroma: Math.sqrt(color[1] * color[1] + color[2] * color[2]),
      }
    })

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

        // L (lightness) and the a/b vector's raw weighted sum accumulate
        // exactly as before. What changes is what we DO with the a/b sum:
        // see below.
        let wSum = 0, L = 0, aSum = 0, bSum = 0, chromaSum = 0
        for (let i = 0; i < blobs.length; i++) {
          const bl = blobs[i]
          const dx = x - bl.cx, dy = y - bl.cy
          const d  = Math.sqrt(dx * dx + dy * dy) + wob
          const dn = Math.max(0.02, d / bl.r)
          const w  = 1 / Math.pow(dn, idwPower)
          wSum += w
          L += w * bl.color[0]
          aSum += w * bl.color[1]; bSum += w * bl.color[2]
          chromaSum += w * bl.chroma
        }
        L /= wSum

        // Found 2026-07-28: two blobs on opposite sides of the color wheel
        // (say rust-red vs. green) sitting at ~50/50 weight used to average
        // straight in a/b Cartesian space — two vectors pointing opposite
        // ways partially cancel, so the midpoint pixel landed near a=b=0,
        // i.e. gray/muddy-olive, even though neither blob's own color was
        // ugly. That's a vector-geometry artifact, not a bad color choice,
        // so it couldn't be fixed in api/palette.js (that only picks which
        // colors get used, not how they blend on screen).
        //
        // Fix: blend hue and chroma separately instead of blending the a/b
        // vector directly. atan2(bSum, aSum) is exactly the hue of the OLD
        // (buggy) vector sum — same direction as before, so the "which way
        // does the blend lean" feel is unchanged. The actual fix is chroma:
        // instead of using the SUM vector's magnitude (which is what
        // collapses toward zero on cancellation), we use the weighted
        // AVERAGE of each blob's own chroma — a plain scalar mean can never
        // cancel toward zero the way two opposing vectors can. Re-deriving
        // a/b from (hue, chroma) then gives a midpoint that keeps real
        // color instead of going gray.
        const hue = Math.atan2(bSum, aSum)
        const C   = chromaSum / wSum
        let a = C * Math.cos(hue)
        let b = C * Math.sin(hue)
        a *= chromaScl; b *= chromaScl

        let [r, g, bb] = oklabToRgb([L, a, b])

        // Displayed-mud guard (2026-07-30). The polar blend above displays
        // every hue along the short OKLab arc between simultaneously-
        // present colors — spatially at seams, temporally across the 7.5s
        // crossfade — so the screen can show muddy warm shades that exist
        // in NO palette entry and that api/palette.js's own recolor can
        // never catch. This is the last stage before pixels leave the
        // tiny canvas, downstream of everything (spatial blend, crossfade,
        // chroma dial), so it bounds displayed color no matter what
        // upstream ships next. Chroma-lift at fixed hue/lightness (see
        // mudRescue in src/lib/mudModel.js for the full design: why hue
        // stays untouched, why near-neutrals are exempt, the self-quench
        // guarantee). Runs in the same HSL space the mud bands were
        // calibrated in; identity outside the pocket, continuous inside;
        // blur(24px) below absorbs the (already-C0) transition.
        {
          const mx = Math.max(r, g, bb) / 255, mn = Math.min(r, g, bb) / 255
          const chr = mx - mn, light = (mx + mn) / 2
          // cheap pre-gates replicating mudRescue's own zero regions
          if (chr >= 0.10 && light > 0.13 && light < 0.65) {
            const [h] = rgbToHsl(r, g, bb)
            const denom = 1 - Math.abs(2 * light - 1)
            const s = denom > 0 ? Math.min(1, chr / denom) : 0
            const sPrime = mudRescue(h, chr, light)
            if (sPrime !== s) [r, g, bb] = hslToRgb(h, sPrime, light)
          }
        }

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
    // gradients (a TV, not a computer monitor, is driving this). Built once
    // (see makeGrainPattern above) and reused every frame — was 700
    // individual fillRect() calls per frame, now one pattern-filled
    // fillRect() call.
    if (!grainPatternRef.current) grainPatternRef.current = makeGrainPattern(ctx)
    ctx.globalAlpha = 0.03
    ctx.fillStyle = grainPatternRef.current
    ctx.fillRect(0, 0, W, H)
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
