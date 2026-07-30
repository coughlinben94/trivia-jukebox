import { useEffect, useRef, useMemo } from 'react'
import { orbitSpeed, blobRadius, meshIdwPower, chromaScale, blendDurationMs } from '../lib/gradientTuning.js'

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

// Weight-proportional blob allocation (2026-07-30). Colors used to get an
// automatic equal share (src[(i+rot) % src.length] handed every blob index
// in turn) — with the antipodal pairing above making each color's share
// STABLE instead of lucky, "equal" became a real structural guarantee, and
// that's exactly what turned a single small accent hue (the synthetic
// color api/palette.js mixes in for a single-real-hue cover, via
// buildWeights()'s ACCENT_WEIGHT=0.15) into a fully competing third of the
// frame — live-reported as "the exact lava lamp thing" on Orleans' "Dance
// with Me." Task 1/2 today threaded a real `weights` array (sums to 1,
// parallel to colors) all the way from api/palette.js's bucket population
// through LiveScreen's pickGradientColors, specifically so blob count could
// finally track how much of the cover a color actually is.
//
// allocateBlobCounts: Hamilton/largest-remainder apportionment of the 6
// blob slots by weight. NOT the "reserve 1 slot per color, then apportion
// the remaining 6-n by weight among all colors" version literally spelled
// out in the weighted-palette plan doc — verified numerically
// (simulate-blob-weights.mjs) that version backfires for a low-weight
// accent specifically: for a real buildWeights()-shaped 2-color
// [0.85, 0.15] palette, reserving 1 to each color first then apportioning
// the remaining 4 by weight gives the accent floor(0.15*4)=0, but its
// remainder (0.6) beats the dominant color's remainder (0.4) out of that
// SMALLER 4-slot pool, so it wins the leftover slot ON TOP OF its reserved
// one -- 2 of 6 blobs (33%) for a 15%-weight color. Running Hamilton
// directly against all 6 slots first already gives every real color >=1
// whenever the math allows it (quotas 5.1/0.9 -> floor 5/0 -> the one
// leftover slot goes to the larger remainder, 0.9, i.e. the accent -- final
// 5/1, matching its real weight). The "must get >=1" guarantee is only
// needed as a rare post-hoc top-up (borrowing 1 slot from whoever currently
// holds the most) for the case direct Hamilton actually can't satisfy on
// its own -- several similarly-low-weight colors where the largest
// remainder happens to fall on the already-biggest quota.
function allocateBlobCounts(weights) {
  const n = weights.length
  if (n === 0) return []
  if (n === 1) return [NUM_BLOBS]
  const quotas = weights.map(w => w * NUM_BLOBS)
  const counts = quotas.map(Math.floor)
  const remainders = quotas.map((q, i) => q - counts[i])
  const leftover = NUM_BLOBS - counts.reduce((s, c) => s + c, 0)
  const order = weights.map((_, i) => i).sort((a, b) => {
    if (remainders[b] !== remainders[a]) return remainders[b] - remainders[a]
    if (weights[b] !== weights[a]) return weights[b] - weights[a]
    return a - b
  })
  for (let k = 0; k < leftover; k++) counts[order[k]] += 1
  // Post-hoc minimum guarantee (see comment above): a color with real
  // weight but 0 blobs borrows 1 from whichever color currently holds the
  // most -- never taking a donor below 1 itself, since the donor search
  // requires counts[j] > 1.
  for (let i = 0; i < n; i++) {
    if (weights[i] > 0 && counts[i] === 0) {
      let donor = -1
      for (let j = 0; j < n; j++) {
        if (counts[j] > 1 && (donor === -1 || counts[j] > counts[donor])) donor = j
      }
      if (donor !== -1) { counts[donor] -= 1; counts[i] += 1 }
    }
  }
  return counts
}

// The fixed antipodal pairs from makeBlobParams() above: (0,1), (2,3),
// (4,5) — each is a mirror-through-center, phase+π pair, geometrically,
// regardless of which color(s) end up assigned to its two slots.
const BLOB_PAIRS = [[0, 1], [2, 3], [4, 5]]

// assignColorsToPairs: places each color's allocateBlobCounts() share onto
// the 3 fixed arenas above. Greedy round-robin per arena — give the first
// slot to whichever color currently has the most blobs left to place, give
// the second slot to the NEXT-largest color that still needs one (i.e.
// prefer a DIFFERENT color per arena), and only fall back to the SAME
// color for both slots when every other color has already been fully
// placed. This maximizes how many arenas any given color shares with a
// DIFFERENT color (each such arena is a real antipodal mirror pair, so its
// two occupants' combined share is pinned near-constant by the same
// geometry the antipodal fix already relies on) and only concentrates a
// color into a same-color "full" pair for whatever's left once nothing
// else needs a partner.
//
// This matters more than it looks: an earlier version of this function
// filled whole SAME-color pairs first (floor(count/2) each), leaving only
// the leftover odd blobs to share arenas. For an exactly-equal true-B&W
// fallback ([0.5, 0.5] -> 3 blobs each), that produced 1 full pair per
// color plus 1 shared arena — concentrating ALL of the pairing-based
// balance guarantee into a single arena instead of spreading it across all
// 3, which measured a 0.355 swing (range 0.45-0.80) in
// simulate-blob-weights.mjs, most of the way back to the ORIGINAL
// un-paired bug's 0.43 swing (0.29-0.72) this session already fixed once.
// This round-robin version reproduces the exact already-shipped/verified
// alternating (0,1,0,1,0,1) arrangement for that same equal-weight case
// (falls out of the algorithm automatically, not a special case), which
// measured a much tighter 0.158 swing (0.43-0.59) under the same sim.
function assignColorsToPairs(counts, rotationSeed) {
  const n = counts.length
  const remaining = counts.slice()
  const arenas = []
  for (let p = 0; p < BLOB_PAIRS.length; p++) {
    let a = -1
    for (let i = 0; i < n; i++) {
      if (remaining[i] > 0 && (a === -1 || remaining[i] > remaining[a])) a = i
    }
    remaining[a] -= 1
    let b = -1
    for (let i = 0; i < n; i++) {
      if (i !== a && remaining[i] > 0 && (b === -1 || remaining[i] > remaining[b])) b = i
    }
    if (b === -1) b = a // nothing else left to place -- forced same-color pair
    remaining[b] -= 1
    arenas.push([a, b])
  }
  // Rotate WHICH physical arena (0, 1, or 2) each queue entry lands on, per
  // cover — same reasoning as rotationFor() above: without this, the
  // arena built first (always the most-dominant color, by construction of
  // the greedy loop) would always land on physical pair (0,1) — blob 0's
  // FIXED, same-every-song orbit — reintroducing the exact "always the
  // same corner" bug rotationFor was written to fix, just one layer up, at
  // the pair level instead of the single-blob level.
  const rot = rotationSeed % BLOB_PAIRS.length
  const colorByBlobIndex = new Array(NUM_BLOBS)
  arenas.forEach(([a, b], i) => {
    const [i0, i1] = BLOB_PAIRS[(i + rot) % BLOB_PAIRS.length]
    colorByBlobIndex[i0] = a
    colorByBlobIndex[i1] = b
  })
  return colorByBlobIndex
}

// Numeric verification of all of the above lives in
// simulate-blob-weights.mjs (plain Node, run 2026-07-30) — it copies
// makeBlobParams()'s rng/antipodal formulas and draw()'s IDW formula
// verbatim and measures each color's real per-instant frame share on the
// same 48x27 tiny-canvas grid. Actual printed results (10s window, 0.1s
// steps, current gradientTuning.js T=50 defaults):
//   3-color [0.6, 0.25, 0.15]  -> blob counts [4, 1, 1] -> mean share
//     0.673 / 0.198 / 0.130, ranges [0.548,0.787] / [0.129,0.293] /
//     [0.014,0.255] -- ordering matches weight ordering throughout (the
//     dominant color's minimum, 0.548, always exceeds both minors' maximums).
//   2-color accent [0.85, 0.15] (buildWeights()'s real single-hue+accent
//     shape) -> blob counts [5, 1] -> mean share 0.802 / 0.198, ranges
//     [0.707,0.871] / [0.129,0.293] -- accent never exceeds 0.293, never
//     swings toward dominance.
//   True B&W [0.5, 0.5] -> blob counts [3, 3] -> mean share 0.518 / 0.482,
//     ranges [0.429,0.587] / [0.413,0.571] -- matches today's already-
//     shipped equal-weight antipodal behavior (falls out to the same
//     alternating 0,1,0,1,0,1 arrangement).
function parseColors(hexArr, weightsArr, n) {
  const src = hexArr.length ? hexArr : ['#080808']
  const weights = (Array.isArray(weightsArr) && weightsArr.length === src.length)
    ? weightsArr
    : src.map(() => 1 / src.length)
  const rot = rotationFor(src, BLOB_PAIRS.length)
  const counts = allocateBlobCounts(weights)
  const colorByBlobIndex = assignColorsToPairs(counts, rot)
  return Array.from({ length: n }, (_, i) => [...hexToRgb(src[colorByBlobIndex[i]])])
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
    const initial = parseColors(colors, weights, NUM_BLOBS)
    st.current = {
      steadyRgb:  initial.map(c => [...c]),
      outRgb:     initial.map(c => [...c]),
      inRgb:      initial.map(c => [...c]),
      blendStart: -1,
    }
  }

  function startBlendTo(newHex, newWeights) {
    const s   = st.current
    const now = performance.now()
    if (s.blendStart >= 0 && (now - s.blendStart) < blendDurationMs()) {
      const t = easeInOut(Math.min((now - s.blendStart) / blendDurationMs(), 1))
      s.outRgb = s.outRgb.map((c, i) => blendPairRgb(c, s.inRgb[i], t))
    } else {
      s.outRgb = s.steadyRgb.map(c => [...c])
    }
    s.inRgb      = parseColors(newHex, newWeights, NUM_BLOBS)
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
      pendingBlendRef.current = { colors: nextColors, weights: nextWeights }
      return
    }
    startBlendTo(nextColors, nextWeights)
    pendingFromNextRef.current = true
  }, [nextColors])

  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; return }
    if (pendingFromNextRef.current) {
      pendingFromNextRef.current = false
      pendingBlendRef.current = null
      const s = st.current
      s.inRgb     = parseColors(colors, weights, NUM_BLOBS)
      s.steadyRgb = parseColors(colors, weights, NUM_BLOBS)
    } else {
      if (entranceActiveRef.current) { pendingBlendRef.current = { colors, weights }; return }
      startBlendTo(colors, weights)
    }
  }, [colors])

  useEffect(() => {
    entranceActiveRef.current = entranceActive
    if (!entranceActive && pendingBlendRef.current) {
      const pending = pendingBlendRef.current
      pendingBlendRef.current = null
      startBlendTo(pending.colors, pending.weights)
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
