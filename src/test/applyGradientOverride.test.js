import { describe, it, expect } from 'vitest'
import { applyGradientOverride } from '../components/LiveScreen.jsx'

describe('applyGradientOverride', () => {
  it('passes the auto-picked result through unchanged when there is no override', () => {
    const auto = { colors: ['#ea513f', '#e8a33d'], weights: [0.6, 0.4] }
    expect(applyGradientOverride(auto, ['#ea513f', '#e8a33d'], null, null)).toBe(auto)
    expect(applyGradientOverride(auto, ['#ea513f', '#e8a33d'], undefined, undefined)).toBe(auto)
  })

  it('replaces only the second color with the color-2 override, keeping the server\'s top pick', () => {
    const auto = { colors: ['#ea513f'], weights: [1] } // auto had rejected to single-color
    const rawColors = ['#ea513f', '#54aab9']
    const result = applyGradientOverride(auto, rawColors, null, '#3355ff')
    expect(result.colors).toEqual(['#ea513f', '#3355ff'])
    expect(result.weights).toEqual([0.5, 0.5])
  })

  it('replaces only the first color with the color-1 override, keeping the server\'s second pick', () => {
    const auto = { colors: ['#ea513f', '#54aab9'], weights: [0.5, 0.5] }
    const rawColors = ['#ea513f', '#54aab9']
    const result = applyGradientOverride(auto, rawColors, '#3355ff', null)
    expect(result.colors).toEqual(['#3355ff', '#54aab9'])
    expect(result.weights).toEqual([0.5, 0.5])
  })

  it('replaces both colors when both overrides are set', () => {
    const auto = { colors: ['#ea513f', '#54aab9'], weights: [0.5, 0.5] }
    const rawColors = ['#ea513f', '#54aab9']
    const result = applyGradientOverride(auto, rawColors, '#3355ff', '#00ff00')
    expect(result.colors).toEqual(['#3355ff', '#00ff00'])
    expect(result.weights).toEqual([0.5, 0.5])
  })

  it('passes through unchanged when raw colors are empty (no server data yet)', () => {
    const auto = { colors: [], weights: [] }
    expect(applyGradientOverride(auto, [], null, '#3355ff')).toBe(auto)
  })

  it('preserves the sanitized auto-picked primary when applying a color-2 override', () => {
    const auto = { colors: ['#ff2fb0', '#e8a33d'], weights: [0.7, 0.3] }
    const result = applyGradientOverride(auto, ['#080808', '#e8a33d'], null, '#3355ff')
    expect(result).toEqual({ colors: ['#ff2fb0', '#3355ff'], weights: [0.5, 0.5] })
  })

  it.each(['#080808', '#000000', 'not-a-color', '#12345g'])('sanitizes unsafe color-2 override %s', override => {
    const auto = { colors: ['#ea513f', '#e8a33d'], weights: [0.5, 0.5] }
    expect(applyGradientOverride(auto, ['#ea513f', '#e8a33d'], null, override)).toEqual({
      colors: ['#ea513f', '#ff2fb0'],
      weights: [0.5, 0.5],
    })
  })

  it('normalizes a valid override to lowercase', () => {
    const auto = { colors: ['#ea513f', '#e8a33d'], weights: [0.5, 0.5] }
    expect(applyGradientOverride(auto, ['#ea513f'], null, '#ABCDEF').colors).toEqual(['#ea513f', '#abcdef'])
  })

  it('leaves an all-sentinel auto-picked palette unchanged regardless of override', () => {
    const auto = { colors: ['#080808', '#080808'], weights: [0.5, 0.5] }
    expect(applyGradientOverride(auto, ['#080808', '#080808'], null, '#3355ff')).toBe(auto)
  })
})
