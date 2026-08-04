import { describe, expect, it } from 'vitest'
import { makeFlowNoise2D } from '../lib/flowNoise.js'

describe('makeFlowNoise2D', () => {
  it('is deterministic for a given seed', () => {
    const a = makeFlowNoise2D(42)
    const b = makeFlowNoise2D(42)
    expect(a.noise(1.3, 2.7)).toBe(b.noise(1.3, 2.7))
    expect(a.fbm(1.3, 2.7, 3)).toBe(b.fbm(1.3, 2.7, 3))
  })

  it('differs across seeds', () => {
    const a = makeFlowNoise2D(1)
    const b = makeFlowNoise2D(2)
    expect(a.noise(1.3, 2.7)).not.toBe(b.noise(1.3, 2.7))
  })

  it('stays within a bounded, finite range', () => {
    const n = makeFlowNoise2D(7)
    for (let i = 0; i < 200; i++) {
      const x = i * 0.37, y = i * 0.71
      expect(Number.isFinite(n.noise(x, y))).toBe(true)
      expect(Math.abs(n.noise(x, y))).toBeLessThanOrEqual(1.01)
      expect(Number.isFinite(n.fbm(x, y, 3))).toBe(true)
    }
  })

  it('is continuous -- small position steps produce small value changes, no lattice seams', () => {
    const n = makeFlowNoise2D(99)
    for (let x = 0; x < 5; x += 0.1) {
      const a = n.noise(x, 2.5)
      const b = n.noise(x + 0.01, 2.5)
      expect(Math.abs(a - b)).toBeLessThan(0.2)
    }
  })

  // Guards the exact bug an independent audit found (2026-08-04):
  // GradientBackground.jsx multiplies fbm(...,2)'s output by an "amount"
  // assuming it spans roughly [-1,1] -- it doesn't, it peaks well under
  // that -- and every wobble/shade/drift/speed amount was silently
  // delivering a fraction of what it claimed as a result. FBM_PEAK in
  // GradientBackground.jsx hardcodes the empirically-measured peak (0.53)
  // for octaves=2 as a normalization divisor. If fbm's actual range ever
  // drifts outside the bound this test checks, FBM_PEAK is now
  // miscalibrated and needs re-measuring -- this is the tripwire for that,
  // not a claim that 0.53 is exact for every possible seed forever.
  it('keeps 2-octave fbm peak magnitude within the range FBM_PEAK (0.53, GradientBackground.jsx) was calibrated against', () => {
    let maxAbs = 0
    for (let seed = 0; seed < 20; seed++) {
      const n = makeFlowNoise2D(seed * 1000 + 7)
      for (let i = 0; i < 2000; i++) {
        const x = (Math.sin(i * 12.9898) + 1) * 50
        const y = (Math.sin(i * 78.233) + 1) * 50
        maxAbs = Math.max(maxAbs, Math.abs(n.fbm(x, y, 2)))
      }
    }
    expect(maxAbs).toBeGreaterThan(0.40)
    expect(maxAbs).toBeLessThan(0.65)
  })
})
