import { describe, it, expect } from 'vitest'
import { uglyWeight, mudRescue, MUD_RESCUE_KNEE } from '../lib/mudModel.js'

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
  // The renderer's displayed-mud guard promises: any pixel with HSL chroma
  // >= 0.16 (rescue gate fully open) exits the rescue with uglyWeight <=
  // MUD_RESCUE_KNEE. Exhaustive grid over the reachable HSL space — this
  // is acceptance criterion (a)'s analytic backbone (the render sim
  // measures the same thing empirically on real palettes).
  it('post-rescue uglyWeight <= KNEE across the full grid at chroma >= 0.16', () => {
    let worst = 0
    for (let h = 0; h < 360; h += 5) {
      for (let s = 0; s <= 1.0001; s += 0.05) {
        for (let l = 0.05; l <= 0.95; l += 0.05) {
          const c = chromaOf(s, l)
          if (c < 0.16) continue
          const sPrime = mudRescue(h, c, l)
          const cPrime = chromaOf(sPrime, l)
          const w = uglyWeight(h, cPrime, l)
          if (w > worst) worst = w
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(MUD_RESCUE_KNEE + 1e-9)
  })
  it('is the identity outside the pocket', () => {
    // a saturated blue and a clean terracotta must pass through unchanged
    for (const hex of ['#1169b6', '#c96f4a']) {
      const [h, c, l] = hexToHsl(hex)
      const s = c / (1 - Math.abs(2 * l - 1))
      expect(mudRescue(h, c, l)).toBeCloseTo(Math.min(1, s), 6)
    }
  })
})
