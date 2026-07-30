import { describe, it, expect } from 'vitest'
import { pickGradientColors } from '../components/LiveScreen.jsx'

describe('pickGradientColors', () => {
  it('passes everything through untouched when at or under the blob budget (6)', () => {
    const colors = ['#fec50d', '#1ea48f', '#ff8e84', '#8348bc', '#e48bc3']
    const weights = [0.3, 0.3, 0.2, 0.1, 0.1]
    expect(pickGradientColors(colors, weights)).toEqual({ colors, weights })
  })

  it('does NOT drop a real distinct color just because two others are already distinct -- the 1990something regression', () => {
    // Server already found 5 genuinely distinct hues; nothing here should be thrown away.
    const colors = ['#fec50d', '#1ea48f', '#ff8e84', '#8348bc', '#e48bc3']
    const weights = [0.35, 0.3, 0.2, 0.1, 0.05]
    const result = pickGradientColors(colors, weights)
    expect(result.colors).toHaveLength(5)
    expect(result.colors).toEqual(colors)
  })

  it('drops only the lowest-weight colors when there are more than MAX_GRADIENT_COLORS (6)', () => {
    const colors  = ['#a', '#b', '#c', '#d', '#e', '#f', '#g', '#h'].map((_, i) => `#${i}00000`)
    const weights = [0.30, 0.25, 0.15, 0.10, 0.08, 0.06, 0.04, 0.02]
    const result = pickGradientColors(colors, weights)
    expect(result.colors).toHaveLength(6)
    expect(result.colors).toEqual(colors.slice(0, 6))
    // dropped weights (0.04 + 0.02 = 0.06) get redistributed, kept weights still sum to 1
    expect(result.weights.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 5)
  })

  it('handles the empty/fallback case without throwing', () => {
    expect(pickGradientColors([], [])).toEqual({ colors: [], weights: [] })
  })
})
