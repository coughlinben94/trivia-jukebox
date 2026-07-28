import { describe, it, expect } from 'vitest'
import { computeFadeBudget } from '../lib/fade'

const FADE_MS = 2500

describe('computeFadeBudget', () => {
  it('gives the full fade budget for a normal-length song', () => {
    // 3.5 min song, no trim — window is 210000ms, way over 2*FADE_MS
    expect(computeFadeBudget(0, 210000, FADE_MS)).toBe(FADE_MS)
  })

  it('gives the full fade budget for a window exactly 2x fade length', () => {
    expect(computeFadeBudget(0, FADE_MS * 2, FADE_MS)).toBe(FADE_MS)
  })

  it('splits the window in half when it is shorter than 2x fade length', () => {
    // 1500ms trim — old code gave fade-in the full 2500ms, leaving nothing
    // for fade-out and causing an instant cutoff. Budget must shrink so both
    // fades fit without overlapping.
    expect(computeFadeBudget(0, 1500, FADE_MS)).toBe(750)
  })

  it('never lets the two fades exceed the window (regression for the overlap bug)', () => {
    const startMs = 4000
    const stopMs = 5200 // 1200ms window
    const budget = computeFadeBudget(startMs, stopMs, FADE_MS)
    expect(budget * 2).toBeLessThanOrEqual(stopMs - startMs)
  })

  it('falls back to the default fade length when stopMs is unset (0 = play to natural end)', () => {
    expect(computeFadeBudget(0, 0, FADE_MS)).toBe(FADE_MS)
  })
})
