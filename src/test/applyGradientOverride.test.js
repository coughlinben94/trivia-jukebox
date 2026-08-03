import { describe, it, expect } from 'vitest'
import { applyGradientOverride } from '../components/LiveScreen.jsx'

describe('applyGradientOverride', () => {
  it('passes the auto-picked result through unchanged when there is no override', () => {
    const auto = { colors: ['#ea513f', '#e8a33d'], weights: [0.6, 0.4] }
    expect(applyGradientOverride(auto, ['#ea513f', '#e8a33d'], null)).toBe(auto)
    expect(applyGradientOverride(auto, ['#ea513f', '#e8a33d'], undefined)).toBe(auto)
  })

  it('replaces only the second color with the override, keeping the server\'s top pick', () => {
    const auto = { colors: ['#ea513f'], weights: [1] } // auto had rejected to single-color
    const rawColors = ['#ea513f', '#54aab9']
    const result = applyGradientOverride(auto, rawColors, '#3355ff')
    expect(result.colors).toEqual(['#ea513f', '#3355ff'])
    expect(result.weights).toEqual([0.5, 0.5])
  })

  it('passes through unchanged when raw colors are empty (no server data yet)', () => {
    const auto = { colors: [], weights: [] }
    expect(applyGradientOverride(auto, [], '#3355ff')).toBe(auto)
  })

  it('preserves the sanitized auto-picked primary when applying an override', () => {
    const auto = { colors: ['#ff2fb0', '#e8a33d'], weights: [0.7, 0.3] }
    const result = applyGradientOverride(auto, ['#080808', '#e8a33d'], '#3355ff')
    expect(result).toEqual({ colors: ['#ff2fb0', '#3355ff'], weights: [0.5, 0.5] })
  })

  it.each(['#080808', '#000000', 'not-a-color', '#12345g'])('sanitizes unsafe override %s', override => {
    const auto = { colors: ['#ea513f', '#e8a33d'], weights: [0.5, 0.5] }
    expect(applyGradientOverride(auto, ['#ea513f', '#e8a33d'], override)).toEqual({
      colors: ['#ea513f', '#ff2fb0'],
      weights: [0.5, 0.5],
    })
  })

  it('normalizes a valid override to lowercase', () => {
    const auto = { colors: ['#ea513f', '#e8a33d'], weights: [0.5, 0.5] }
    expect(applyGradientOverride(auto, ['#ea513f'], '#ABCDEF').colors).toEqual(['#ea513f', '#abcdef'])
  })
})
