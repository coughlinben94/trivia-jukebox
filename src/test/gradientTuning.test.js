import { beforeEach, describe, expect, it } from 'vitest'
import {
  brightnessAdjustment, motionSpeed, anchorAmplitude, seamWidth,
  wobbleAmount, shadeAmount, blendDurationMs, clearDials, setDial,
  exportSnippet,
} from '../lib/gradientTuning.js'

describe('single-renderer gradient tuning', () => {
  beforeEach(() => clearDials())

  it('keeps the shipped two-pool defaults neutral', () => {
    expect(brightnessAdjustment()).toBe(0)
    expect(motionSpeed()).toBeCloseTo(1.2, 10)
    expect(anchorAmplitude()).toBeCloseTo(0.15, 10)
    expect(seamWidth()).toBeCloseTo(0.125, 10)
    expect(wobbleAmount()).toBeCloseTo(0.106, 10)
    expect(shadeAmount()).toBeCloseTo(0.105, 10)
    expect(blendDurationMs()).toBe(7500)
  })

  it('keeps wobble amount within its x0.53-rescaled range (2.65%-18.55%, was 5-35% pre-normalization-fix)', () => {
    setDial('DEPTH', 0)
    expect(wobbleAmount()).toBeCloseTo(0.0265, 10)
    setDial('DEPTH', 100)
    expect(wobbleAmount()).toBeCloseTo(0.1855, 10)
  })

  it('keeps shade amount (the +-10% pool shading) in lockstep with wobble on the same DEPTH dial', () => {
    setDial('DEPTH', 0)
    expect(shadeAmount()).toBeCloseTo(0.03, 10)
    setDial('DEPTH', 100)
    expect(shadeAmount()).toBeCloseTo(0.18, 10)
  })

  it('exports paste-ready declarations for real derived functions', () => {
    for (const id of ['BRIGHTNESS', 'MOTION', 'SIZE', 'BLEND', 'DEPTH', 'VARIETY', 'CROSSFADE']) {
      setDial(id, 60)
    }
    const snippet = exportSnippet()

    for (const name of [
      'brightnessAdjustment', 'motionSpeed', 'anchorAmplitude',
      'seamWidth', 'wobbleAmount', 'shadeAmount', 'blendDurationMs',
    ]) expect(snippet).toContain(`export function ${name}()`)
    expect(snippet).toContain('export function varietyToConfig()')
    expect(snippet).toContain('// paletteDefaults.js')
    expect(snippet).not.toMatch(/BLEND_DURATION_MS|brightnessAdjustment:|motionSpeed:/)
  })
})
