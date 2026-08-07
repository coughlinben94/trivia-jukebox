import { describe, it, expect } from 'vitest'
import { hexToRgb, shortestDelta, lerpOklabPolar, rgbToOklab, oklabToRgb } from '../components/AlbumGradientMesh.jsx'

// 2026-08-07 — this file exists because lerpOklabPolar had ZERO test
// coverage from 2026-08-04 through 2026-08-07, during which a one-line
// change (4a8a44d, the "swimming ring" fix) silently turned it into an
// exact no-op duplicate of a plain Cartesian lerp, undoing the muddy-gray-
// band fix it was built to provide. Nobody caught it because nothing here
// exercised the actual chroma/hue math. These pin the two properties that
// matter: chroma must not collapse toward gray on a near-complementary
// blend, and hue must move monotonically along one fixed arc (no
// per-pixel/per-frame flip).

function chroma([, a, b]) { return Math.hypot(a, b) }

// Named pairs from the file's own commit history — 4a8a44d's swimming-ring
// report (Out Tonight / Penelope Road, ~180deg apart) and its stated control
// pair (Why Can't I Touch It, ~119.5deg apart, "must look unchanged").
const RING_PAIR_A = ['#115867', '#e45a34']   // ~179.9deg apart
const RING_PAIR_B = ['#fdbc5a', '#3185d3']   // ~175.1deg apart
const CONTROL_PAIR = ['#f2c14e', '#7a4fd1']  // ~119.5deg-ish saturated pair

function oklabPair([hexA, hexB]) {
  return [rgbToOklab(hexToRgb(hexA)), rgbToOklab(hexToRgb(hexB))]
}

describe('lerpOklabPolar', () => {
  it('is NOT a Cartesian lerp — chroma at a wide-hue-gap midpoint exceeds a plain a/b average', () => {
    const [a, b] = oklabPair(RING_PAIR_A)
    const dh = shortestDelta(Math.atan2(a[2], a[1]), Math.atan2(b[2], b[1]))
    const mid = lerpOklabPolar(a, b, 0.5, dh)
    const cartesianMid = [
      (a[0] + b[0]) / 2,
      (a[1] + b[1]) / 2,
      (a[2] + b[2]) / 2,
    ]
    // The bug (4a8a44d..08313ae window): lerpOklabPolar(a,b,t) === Cartesian
    // lerp, bit for bit. If this ever regresses to that, chroma at the
    // midpoint of a near-180deg pair will match the Cartesian value (near 0)
    // instead of the true scalar-magnitude average (roughly half of each
    // endpoint's own chroma, i.e. NOT collapsed).
    expect(chroma(mid)).toBeGreaterThan(chroma(cartesianMid) + 0.02)
  })

  it.each([
    ['near-180deg pair A', RING_PAIR_A],
    ['near-180deg pair B', RING_PAIR_B],
    ['control pair (~120deg)', CONTROL_PAIR],
  ])('%s: chroma never collapses toward gray anywhere in the blend', (_label, pair) => {
    const [a, b] = oklabPair(pair)
    const dh = shortestDelta(Math.atan2(a[2], a[1]), Math.atan2(b[2], b[1]))
    const minEndpointChroma = Math.min(chroma(a), chroma(b))
    for (let t = 0; t <= 1; t += 0.05) {
      const c = chroma(lerpOklabPolar(a, b, t, dh))
      // Scalar-magnitude lerp of two positive chromas can never produce
      // something smaller than the smaller endpoint (the whole point of
      // fix #1, 2026-08-04) — allow a hair of float slack.
      expect(c).toBeGreaterThanOrEqual(minEndpointChroma - 1e-6)
    }
  })

  // 2026-08-07 — this replaces an earlier version of this test that only
  // asserted Number.isFinite(h) and didn't actually exercise frame-to-frame
  // behavior. That gap is exactly how a real regression shipped: the first
  // version of draw()'s frame-to-frame hue tracking used a sign-flip
  // threshold ("hysteresis") instead of an unwrap, which only DELAYS a
  // direction flip rather than removing it — an Opus review caught it by
  // simulating a full drifting crossfade and measuring frame-to-frame RGB
  // jumps, which is what this test now does directly, using the same
  // unwrap formula draw() uses (shortestDelta(prevArc, rawArc) accumulated
  // onto prevArc, not re-derived from scratch each frame).
  it('frame-to-frame: a drifting crossfade never produces a single-frame color jump', () => {
    const rgbDist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])

    // Simulate ~450 frames (7.5s @ 60fps) of two anchors independently
    // drifting in hue while a crossfade's `t` sweeps 0->1 — the exact
    // shape of draw()'s real inputs (anchor0/anchor1 come from
    // currentOklab(ts), which changes every frame during a blend).
    const FRAMES = 450
    const startHueA = 0.3, endHueA = 4.6      // radians, sweeps past +-pi
    const startHueB = 3.4, endHueB = -0.2
    const C = 0.15, L = 0.6
    const anchorAt = (h) => [L, C * Math.cos(h), C * Math.sin(h)]

    let prevArc = null
    let prevMidRgb = null
    let maxJump = 0
    for (let f = 0; f < FRAMES; f++) {
      const frac = f / (FRAMES - 1)
      const anchor1 = anchorAt(lerp(startHueA, endHueA, frac))
      const anchor0 = anchorAt(lerp(startHueB, endHueB, frac))
      const hue1 = Math.atan2(anchor1[2], anchor1[1])
      const hue0 = Math.atan2(anchor0[2], anchor0[1])
      const rawArc = shortestDelta(hue1, hue0)
      const hueArc = prevArc === null ? rawArc : prevArc + shortestDelta(prevArc, rawArc)
      prevArc = hueArc

      const midOklab = lerpOklabPolar(anchor1, anchor0, 0.5, hueArc)
      const midRgb = oklabToRgb(midOklab)
      if (prevMidRgb) maxJump = Math.max(maxJump, rgbDist(midRgb, prevMidRgb))
      prevMidRgb = midRgb
    }

    // A smooth ~450-frame sweep should never move the mid-band color by a
    // huge RGB distance in a single frame — that's what a direction flip
    // looks like. Real per-frame motion here is a few RGB units; 60 is a
    // generous margin, not a tight tolerance.
    expect(maxJump).toBeLessThan(60)
  })

  function lerp(a, b, t) { return a + (b - a) * t }

  it('control pair: full-strength blend at t=0/t=1 returns the endpoints unchanged', () => {
    const [a, b] = oklabPair(CONTROL_PAIR)
    const dh = shortestDelta(Math.atan2(a[2], a[1]), Math.atan2(b[2], b[1]))
    const at0 = lerpOklabPolar(a, b, 0, dh)
    const at1 = lerpOklabPolar(a, b, 1, dh)
    expect(at0[0]).toBeCloseTo(a[0], 5)
    expect(chroma(at0)).toBeCloseTo(chroma(a), 5)
    expect(at1[0]).toBeCloseTo(b[0], 5)
    expect(chroma(at1)).toBeCloseTo(chroma(b), 5)
  })

  it('exact antipodal hues (180.0deg) stay saturated at the midpoint — NOT the old ulen-desaturation behavior', () => {
    // The pre-2026-08-07 design (the ulen patch) treated exact antipodality
    // as a genuine singularity: the per-PIXEL unit-vector average is
    // ill-defined there (no single "average direction" between two exactly
    // opposite colors), so it desaturated toward gray as a fallback.
    // shortestDelta committing to ONE direction per FRAME removes the
    // singularity entirely -- (h2-h1) % 2*PI at exactly PI apart is a
    // well-defined, deterministic value, not an ill-defined average -- so
    // there's no more case where desaturating is "more correct" than
    // picking a stable hue and staying saturated. This is a deliberate
    // behavior change, not an oversight: it also matches the file's own
    // ORIGINAL, pre-ulen design intent that chroma never collapses, full
    // stop, with no exception carved out for the exact-antipodal case.
    const a = rgbToOklab(hexToRgb('#ff0000'))
    const h = Math.atan2(a[2], a[1])
    // Construct b as the exact antipode of a in the a/b plane, same L/chroma.
    const C = Math.hypot(a[1], a[2])
    const b = [a[0], C * Math.cos(h + Math.PI), C * Math.sin(h + Math.PI)]
    const dh = shortestDelta(h, Math.atan2(b[2], b[1]))
    const mid = lerpOklabPolar(a, b, 0.5, dh)
    expect(chroma(mid)).toBeCloseTo(C, 5)
  })

  it('oklab round-trip sanity: rgbToOklab -> oklabToRgb recovers the input color', () => {
    for (const hex of [...RING_PAIR_A, ...RING_PAIR_B, ...CONTROL_PAIR, '#080808', '#ffffff']) {
      const rgb = hexToRgb(hex)
      const [r, g, b] = oklabToRgb(rgbToOklab(rgb))
      expect(r).toBeCloseTo(rgb[0], 0)
      expect(g).toBeCloseTo(rgb[1], 0)
      expect(b).toBeCloseTo(rgb[2], 0)
    }
  })
})
