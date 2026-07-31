import { describe, it, expect } from 'vitest'
import { pickGradientColors } from '../components/LiveScreen.jsx'

// MAX_GRADIENT_COLORS went 6 -> 3 on 2026-07-30 (late): under the equal
// alternating blob split, 5-6 palette colors dilute to ~1 blob each — the
// same lone-blob failure the equal-split restore killed, in miniature
// (live: "fishes swimming", "look at the blue"). At 3 the split is always
// 2/2/2 — every color owns a full antipodal arena. The old tests here
// (5-color passthrough, the "1990something keeps all 5" regression test)
// encoded the 6-cap design and were retired with it: dropping to the top
// 3 by weight is now the intended behavior, not a regression.
describe('pickGradientColors (top-3-by-weight cap)', () => {
  it('passes through untouched at or under 3 colors', () => {
    const colors = ['#fec50d', '#1ea48f', '#ff8e84']
    const weights = [0.5, 0.3, 0.2]
    expect(pickGradientColors(colors, weights)).toEqual({ colors, weights })
  })

  it('keeps the top 3 by weight from a 5-color palette, renormalized', () => {
    const colors = ['#fec50d', '#1ea48f', '#ff8e84', '#8348bc', '#e48bc3']
    const weights = [0.35, 0.3, 0.2, 0.1, 0.05]
    const result = pickGradientColors(colors, weights)
    expect(result.colors).toEqual(['#fec50d', '#1ea48f', '#ff8e84'])
    expect(result.weights.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 5)
    // relative order of kept weights preserved
    expect(result.weights[0]).toBeGreaterThan(result.weights[1])
    expect(result.weights[1]).toBeGreaterThan(result.weights[2])
  })

  it('sorts by weight, not input order, when picking the top 3', () => {
    const colors = ['#111111', '#222222', '#333333', '#444444']
    const weights = [0.1, 0.4, 0.2, 0.3]
    const result = pickGradientColors(colors, weights)
    expect(result.colors).toEqual(['#222222', '#444444', '#333333'])
  })

  it('handles the empty/fallback case without throwing', () => {
    expect(pickGradientColors([], [])).toEqual({ colors: [], weights: [] })
  })
})
