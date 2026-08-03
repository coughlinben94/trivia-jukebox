import { describe, it, expect } from 'vitest'
import { pickGradientColors } from '../components/LiveScreen.jsx'

// TWO PRETTIEST, COMPATIBLE (2026-08-03, owner spec). colors[] arrives in
// the server's prettiness (score) order. Keep index 0; partner = highest-
// ranked color whose OKLab hue is 30-140 deg away (closer reads as one
// color; near-complementary cancels to gray). Fallbacks: first >=30 deg,
// then index 1. Earlier cap eras (6, then 3) and their tests are retired —
// see the spec doc's addenda for why each died.
describe('pickGradientColors (two prettiest, compatible)', () => {
  it('passes through at or under 2 colors', () => {
    const colors = ['#ea513f', '#7b92d9']
    const weights = [0.7, 0.3]
    expect(pickGradientColors(colors, weights)).toEqual({ colors, weights })
  })

  it('skips a near-duplicate hue for a compatible partner', () => {
    // red first; #f0604f is the same red family (~10 deg away) and must be
    // skipped; #e8a33d gold (~55 deg) is the first in-band partner.
    const colors = ['#ea513f', '#f0604f', '#e8a33d', '#3a6fd8']
    const result = pickGradientColors(colors, [0.4, 0.3, 0.2, 0.1])
    expect(result.colors).toEqual(['#ea513f', '#e8a33d'])
    expect(result.weights[0] + result.weights[1]).toBeCloseTo(1, 5)
  })

  it('skips a near-complementary hue for a compatible partner', () => {
    // red first; #2fd3c8 teal sits ~180 deg away (gray-moat pair) and must
    // be skipped even though it ranks higher than the in-band violet.
    const colors = ['#ea513f', '#2fd3c8', '#8460c8']
    const result = pickGradientColors(colors, [0.5, 0.3, 0.2])
    expect(result.colors).toEqual(['#ea513f', '#8460c8'])
  })

  it('falls back to any distinct hue, then to index 1', () => {
    // only near-duplicates and one far complement available -> takes the
    // >=30 deg fallback (the complement) over showing one color twice
    const onlyFar = pickGradientColors(['#ea513f', '#f0604f', '#2fd3c8'], [0.5, 0.3, 0.2])
    expect(onlyFar.colors).toEqual(['#ea513f', '#2fd3c8'])
    const onlyTwins = pickGradientColors(['#ea513f', '#f0604f', '#ee5a48'], [0.5, 0.3, 0.2])
    expect(onlyTwins.colors).toEqual(['#ea513f', '#f0604f'])
  })

  it('handles the empty/fallback case without throwing', () => {
    expect(pickGradientColors([], [])).toEqual({ colors: [], weights: [] })
  })
})
