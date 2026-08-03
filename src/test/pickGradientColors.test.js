import { describe, it, expect } from 'vitest'
import { pickGradientColors } from '../components/LiveScreen.jsx'

describe('pickGradientColors', () => {
  it('selects the server-ranked first two colors in order and normalizes their weights', () => {
    const result = pickGradientColors(
      ['#ea513f', '#f0604f', '#e8a33d'],
      [0.5, 0.3, 0.2],
    )
    expect(result.colors).toEqual(['#ea513f', '#f0604f'])
    expect(result.weights[0]).toBeCloseTo(0.625)
    expect(result.weights[1]).toBeCloseTo(0.375)
  })

  it('retains a complementary pair instead of applying a hue compatibility gate', () => {
    const result = pickGradientColors(['#ea513f', '#2fd3c8'], [0.5, 0.3])
    expect(result.colors).toEqual(['#ea513f', '#2fd3c8'])
    expect(result.weights[0]).toBeCloseTo(0.625)
    expect(result.weights[1]).toBeCloseTo(0.375)
  })

  it('duplicates one color with equal weights', () => {
    expect(pickGradientColors(['#ea513f'], [1])).toEqual({
      colors: ['#ea513f', '#ea513f'],
      weights: [0.5, 0.5],
    })
  })

  it('returns a safe empty result when no colors are available', () => {
    expect(pickGradientColors([], [])).toEqual({ colors: [], weights: [] })
  })

  it('substitutes neon pink for a selected near-black color', () => {
    expect(pickGradientColors(['#080808', '#e8a33d'], [0.7, 0.3])).toEqual({
      colors: ['#ff2fb0', '#e8a33d'],
      weights: [0.7, 0.3],
    })
  })

  it('sanitizes both selected colors independently', () => {
    const result = pickGradientColors(['#000000', '#202020', '#ea513f'], [0.6, 0.3, 0.1])
    expect(result.colors).toEqual(['#ff2fb0', '#ff2fb0'])
    expect(result.weights[0]).toBeCloseTo(2 / 3)
    expect(result.weights[1]).toBeCloseTo(1 / 3)
  })
})
