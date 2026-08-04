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
})
