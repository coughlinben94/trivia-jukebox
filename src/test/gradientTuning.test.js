import { beforeEach, describe, expect, it } from 'vitest'
import {
  brightnessAdjustment, motionSpeed, anchorAmplitude, seamWidth,
  wobbleAmount, blendDurationMs, clearDials, setDial,
  exportSnippet,
} from '../lib/gradientTuning.js'

describe('single-renderer gradient tuning', () => {
  beforeEach(() => clearDials())

  it('keeps the shipped two-pool defaults neutral', () => {
    expect(brightnessAdjustment()).toBe(0)
    expect(motionSpeed()).toBe(1)
    expect(anchorAmplitude()).toBeCloseTo(0.15, 10)
    expect(seamWidth()).toBeCloseTo(0.25, 10)
    expect(wobbleAmount()).toBeCloseTo(0.20, 10)
    expect(blendDurationMs()).toBe(7500)
  })

  it('keeps wobble amount within the useful 5–35% range', () => {
    setDial('DEPTH', 0)
    expect(wobbleAmount()).toBeCloseTo(0.05, 10)
    setDial('DEPTH', 100)
    expect(wobbleAmount()).toBeCloseTo(0.35, 10)
  })

  it('exports paste-ready declarations for real derived functions', () => {
    for (const id of ['BRIGHTNESS', 'MOTION', 'SIZE', 'BLEND', 'DEPTH', 'VARIETY', 'CROSSFADE']) {
      setDial(id, 60)
    }
    const snippet = exportSnippet()

    for (const name of [
      'brightnessAdjustment', 'motionSpeed', 'anchorAmplitude',
      'seamWidth', 'wobbleAmount', 'blendDurationMs',
    ]) expect(snippet).toContain(`export function ${name}()`)
    expect(snippet).toContain('export function varietyToConfig()')
    expect(snippet).toContain('// paletteDefaults.js')
    expect(snippet).not.toMatch(/BLEND_DURATION_MS|brightnessAdjustment:|motionSpeed:/)
  })
})
