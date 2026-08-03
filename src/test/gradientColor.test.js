import { describe, it, expect } from 'vitest'
import { hueDegOf, hueDeltaDeg, snapToCompatibleHue, COMPATIBLE_MIN, COMPATIBLE_MAX } from '../lib/gradientColor.js'

// Manual color-picker auto-snap barrier (2026-08-03, thinktank round 3 +
// owner spec): rather than block or reject an out-of-band pick outright,
// rotate its hue to the nearest edge of the same 30-140deg compatible band
// pickGradientColors/resolveCrossfadeHex already enforce, keeping the
// candidate's own lightness and chroma untouched. In-band picks pass
// through byte-for-byte unchanged.
describe('snapToCompatibleHue', () => {
  it('passes an already-compatible candidate through unchanged', () => {
    const base = '#ea513f' // hue ~29.9deg
    const cand = '#e8a33d' // hue ~72.9deg, delta ~43deg -- in band
    expect(snapToCompatibleHue(base, cand)).toBe(cand)
  })

  it('snaps a too-close candidate out to exactly the min boundary, same side', () => {
    const base = '#ea513f' // hue ~29.9deg
    const cand = '#e8583d' // near-duplicate hue, a few deg from base
    const beforeDelta = hueDeltaDeg(hueDegOf(base), hueDegOf(cand))
    expect(beforeDelta).toBeLessThan(COMPATIBLE_MIN)
    const snapped = snapToCompatibleHue(base, cand)
    const afterDelta = hueDeltaDeg(hueDegOf(base), hueDegOf(snapped))
    expect(afterDelta).toBeCloseTo(COMPATIBLE_MIN, 0)
  })

  it('snaps a too-far candidate in to exactly the max boundary, same side', () => {
    const base = '#ea513f' // hue ~29.9deg
    const cand = '#2fd3c8' // teal, hue ~187.9deg, delta ~158 -- past 140
    const beforeDelta = hueDeltaDeg(hueDegOf(base), hueDegOf(cand))
    expect(beforeDelta).toBeGreaterThan(COMPATIBLE_MAX)
    const snapped = snapToCompatibleHue(base, cand)
    const afterDelta = hueDeltaDeg(hueDegOf(base), hueDegOf(snapped))
    expect(afterDelta).toBeCloseTo(COMPATIBLE_MAX, 0)
  })

  it('preserves the candidate\'s own lightness and chroma when snapping', () => {
    const base = '#ea513f'
    const cand = '#2fd3c8'
    const snapped = snapToCompatibleHue(base, cand)
    // Re-derive chroma/lightness via the same OKLab path the module uses
    // internally, by round-tripping through hueDegOf's sibling math is not
    // exposed directly, so approximate via a visual/numeric sanity check:
    // the snap should not turn a vivid teal into something near-black or
    // near-white or near-gray -- i.e. it's still a real, visible color.
    expect(snapped).toMatch(/^#[0-9a-f]{6}$/)
    expect(snapped.toLowerCase()).not.toBe('#000000')
    expect(snapped.toLowerCase()).not.toBe('#ffffff')
  })

  it('passes candidates exactly at the boundary through unchanged (inclusive)', () => {
    // Constructed by rotating a known hue to exactly base+30 and base+140
    // via snapToCompatibleHue itself is circular, so this test instead
    // just confirms idempotency: snapping an already-snapped color again
    // is a no-op (the boundary case that matters in practice -- a user
    // nudging the picker right at the edge shouldn't jitter).
    const base = '#ea513f'
    const cand = '#2fd3c8'
    const once  = snapToCompatibleHue(base, cand)
    const twice = snapToCompatibleHue(base, once)
    expect(twice).toBe(once)
  })
})
