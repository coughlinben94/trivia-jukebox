import { describe, it, expect } from 'vitest'
import { populationFactor, buildWeights } from '../../api/palette.js'

describe('populationFactor', () => {
  it('returns 1.0 at popRel=1 (the largest bucket)', () => {
    expect(populationFactor(1)).toBeCloseTo(1.0, 5)
  })
  it('returns 0.5 at popRel=0 (a vanishingly small bucket)', () => {
    expect(populationFactor(0)).toBeCloseTo(0.5, 5)
  })
  it('is monotonically increasing', () => {
    expect(populationFactor(0.25)).toBeLessThan(populationFactor(0.5))
    expect(populationFactor(0.5)).toBeLessThan(populationFactor(1))
  })
  it('never lets population alone beat a real vividness gap -- a chroma-0.9 color at popRel 0.25 still outranks a chroma-0.45 color at popRel 1.0', () => {
    const vivid = 0.902 * populationFactor(0.25) // real 1990something yellow
    const dominant = 0.494 * populationFactor(1.0) // real 1990something teal
    expect(vivid).toBeGreaterThan(dominant)
  })
})

describe('buildWeights', () => {
  it('normalizes population shares to sum to 1', () => {
    const w = buildWeights([{ population: 3 }, { population: 1 }])
    expect(w[0]).toBeCloseTo(0.75, 5)
    expect(w[1]).toBeCloseTo(0.25, 5)
    expect(w[0] + w[1]).toBeCloseTo(1, 5)
  })
  it('gives a synthetic (population=null) entry a fixed small weight, real entries split the remainder proportionally', () => {
    const w = buildWeights([{ population: 900 }, { population: 100 }, { population: null }])
    // synthetic gets ACCENT_WEIGHT (0.15), the two real entries split the
    // remaining 0.85 in their 900:100 (9:1) ratio
    expect(w[2]).toBeCloseTo(0.15, 5)
    expect(w[0]).toBeCloseTo(0.85 * 0.9, 5)
    expect(w[1]).toBeCloseTo(0.85 * 0.1, 5)
    expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 5)
  })
  it('splits evenly when every entry is synthetic (true B&W fallback, no real population at all)', () => {
    const w = buildWeights([{ population: null }, { population: null }])
    expect(w[0]).toBeCloseTo(0.5, 5)
    expect(w[1]).toBeCloseTo(0.5, 5)
  })
})
