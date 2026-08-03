import { beforeEach, describe, expect, it } from 'vitest'
import {
  brightnessAdjustment, motionSpeed, lightRadius, seamBlend,
  haloDepth, blendDurationMs, clearDials, setDial,
} from '../lib/gradientTuning.js'

describe('single-renderer gradient tuning', () => {
  beforeEach(() => clearDials())

  it('keeps the shipped two-light defaults neutral', () => {
    expect(brightnessAdjustment()).toBe(0)
    expect(motionSpeed()).toBe(1)
    expect(lightRadius()).toBe(0.6)
    expect(seamBlend()).toBe(0.6)
    expect(haloDepth()).toBe(0.1)
    expect(blendDurationMs()).toBe(7500)
  })

  it('keeps halo depth within the useful 5–15% range', () => {
    setDial('DEPTH', 0)
    expect(haloDepth()).toBe(0.05)
    setDial('DEPTH', 100)
    expect(haloDepth()).toBe(0.15)
  })
})
