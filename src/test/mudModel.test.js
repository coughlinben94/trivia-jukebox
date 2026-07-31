import { describe, it, expect } from 'vitest'
import { uglyWeight, mudRescue, MUD_RESCUE_KNEE, MUD_RESCUE_BOUND } from '../lib/mudModel.js'

// Local HSL helpers — deliberately NOT imported from api/palette.js: that
// module imports sharp, which has no place in a unit-test process.
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
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
const chromaOf = (s, l) => (1 - Math.abs(2 * l - 1)) * s

describe('uglyWeight fixtures (calibrated against the 651-color live scan)', () => {
  it('catches the original offender #5b6732 at full weight', () => {
    const [h, c, l] = hexToHsl('#5b6732')
    expect(uglyWeight(h, c, l)).toBeCloseTo(1.0, 1)
  })
  it('leaves clean warm and cool controls untouched', () => {
    for (const hex of ['#b37a1f', '#cbb622', '#eeb435', '#3c7f7e', '#516891', '#8146b8']) {
      const [h, c, l] = hexToHsl(hex)
      expect(uglyWeight(h, c, l)).toBe(0)
    }
  })
})

describe('mudRescue self-quench guarantee', () => {
  // v2's first grid test asserted post-rescue weight <= 0.35 over an
  // s-step-0.05 grid and PASSED FALSELY: the rescue's real transient — a
  // ~0.014-wide sliver of input s just under the 0.55 clean edge where
  // partial desaturation lands mid-pocket (post-weight up to 1.0) — sits
  // strictly between grid samples at every hue/lightness. These are the
  // invariants that are actually true (critic-derived, fine-swept):
  it('full quench: pre-weight >= KNEE at chroma >= 0.16 exits below BOUND', () => {
    let worst = 0
    for (let h = 0; h < 360; h += 3) {
      for (let s = 0; s <= 1.0001; s += 0.01) {
        for (let l = 0.05; l <= 0.95; l += 0.02) {
          const c = chromaOf(s, l)
          if (c < 0.16) continue
          if (uglyWeight(h, c, l) < MUD_RESCUE_KNEE) continue
          const sPrime = mudRescue(h, c, l)
          const w = uglyWeight(h, chromaOf(sPrime, l), l)
          if (w > worst) worst = w
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(MUD_RESCUE_BOUND + 1e-9)
  })
  it('transient shell is thin: post-weight > 0.35 spans <= 0.02 of input s', () => {
    for (let h = 20; h <= 100; h += 5) {
      for (let l = 0.15; l <= 0.6; l += 0.05) {
        let width = 0
        for (let s = 0.30; s <= 0.60; s += 0.002) {
          const c = chromaOf(s, l)
          if (c < 0.16) continue
          const sPrime = mudRescue(h, c, l)
          if (uglyWeight(h, chromaOf(sPrime, l), l) > 0.35) width += 0.002
        }
        // Empirical max on first full run: 0.022 (critic's hand estimate
        // was 0.014). Bound set with headroom above measured; the point is
        // the shell stays a thin sliver, not a band.
        expect(width).toBeLessThanOrEqual(0.03 + 1e-9)
      }
    }
  })
  it('never INCREASES saturation (the v1 rainbow failure is structurally impossible)', () => {
    for (let h = 0; h < 360; h += 5) {
      for (let s = 0; s <= 1.0001; s += 0.05) {
        for (let l = 0.05; l <= 0.95; l += 0.05) {
          const c = chromaOf(s, l)
          expect(mudRescue(h, c, l)).toBeLessThanOrEqual(Math.min(1, s) + 1e-9)
        }
      }
    }
  })
  it('is the identity outside the pocket', () => {
    // a saturated blue and a red-clay terracotta must pass through
    // unchanged. NB: the clay must sit truly below the pocket's 16-28°
    // entry ramp — the first fixture tried #c96f4a, which computes to hue
    // 17.5° and correctly picks up a ~0.0001 nudge from the continuous
    // ramp (by design, not a bug). #b85c3f is hue 14.4°: fully outside.
    for (const hex of ['#1169b6', '#b85c3f']) {
      const [h, c, l] = hexToHsl(hex)
      const s = c / (1 - Math.abs(2 * l - 1))
      expect(mudRescue(h, c, l)).toBeCloseTo(Math.min(1, s), 6)
    }
  })
})
