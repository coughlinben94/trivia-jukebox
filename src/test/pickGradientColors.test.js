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

  it('prefers a near-duplicate hue over a near-complementary one when neither is in-band', () => {
    // 2026-08-03: this used to prefer the far complement ("better than
    // showing one color twice"). That's backwards -- near-duplicates are
    // the SAFE fallback (they blend into essentially one hue), and
    // near-complementary is the muddy/gray-moat case this whole gate
    // exists to reject. f0604f (~10 deg, near-dup) now wins over 2fd3c8
    // (~180 deg, near-complementary).
    const onlyFar = pickGradientColors(['#ea513f', '#f0604f', '#2fd3c8'], [0.5, 0.3, 0.2])
    expect(onlyFar.colors).toEqual(['#ea513f', '#f0604f'])
    const onlyTwins = pickGradientColors(['#ea513f', '#f0604f', '#ee5a48'], [0.5, 0.3, 0.2])
    expect(onlyTwins.colors).toEqual(['#ea513f', '#f0604f'])
  })

  it('drops to a single color when every other candidate is near-complementary', () => {
    const onlyComplement = pickGradientColors(['#ea513f', '#2fd3c8'], [0.5, 0.3])
    expect(onlyComplement.colors).toEqual(['#ea513f'])
    expect(onlyComplement.weights).toEqual([1])
  })

  it('gate now runs even at exactly 2 raw colors (the gate-bypass bug)', () => {
    // Live-measured case: John Hollier & the Rêverie, "Somewhere Down the
    // Road" -- api/palette.js returned exactly these 2 colors, 147.5 deg
    // apart, and the OLD code skipped this function's hue check entirely
    // whenever colors.length <= MAX_GRADIENT_COLORS, letting a
    // near-complementary pair through untouched. It must now fall back to
    // single-color instead of passing the muddy pair straight through.
    const result = pickGradientColors(['#fac698', '#54aab9'], [0.57, 0.43])
    expect(result.colors).toEqual(['#fac698'])
    expect(result.weights).toEqual([1])
  })

  it('handles the empty/fallback case without throwing', () => {
    expect(pickGradientColors([], [])).toEqual({ colors: [], weights: [] })
  })
})
