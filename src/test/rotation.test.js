import { describe, it, expect } from 'vitest'
import { dividerAngle, dividerEdge } from '../components/AlbumGradientMesh.jsx'

// 2026-08-07 — dividerEdge replaced the old fixed-lean `tilt` hack with a
// real rotating-line projection (Ben live: "that sin wave mesh is also
// supposed to move on a random axis rotating"). Pins the property the whole
// design leans on (Opus review): at theta=0 the new signed-distance formula
// must be IDENTICAL to the old `x/SW - divider` formula it replaces, since
// dividerAngle(0) === 0 and every render starts there — no regression on the
// one orientation that was already live and tuned.
describe('dividerEdge theta=0 regression', () => {
  it('matches the old x/SW - divider formula exactly at theta=0', () => {
    const sharpness = 3.5
    const cases = [
      { x: 0,    y: 0,    offset: 0,    aspect: 1 },
      { x: 1,    y: 1,    offset: 0.3,  aspect: 16 / 9 },
      { x: 0.37, y: 0.82, offset: -0.3, aspect: 16 / 9 },
      { x: 0.6,  y: 0.1,  offset: 0.12, aspect: 1 },
    ]
    for (const { x, y, offset, aspect } of cases) {
      const divider = 0.5 + offset
      const oldEdge = Math.tanh((x - divider) * sharpness)
      const newEdge = dividerEdge(x, y, 0, aspect, offset, sharpness)
      expect(newEdge).toBeCloseTo(oldEdge, 12)
    }
  })
})

describe('dividerAngle', () => {
  it('starts at 0 — no jump from the old fixed-vertical orientation on mount', () => {
    expect(dividerAngle(0)).toBe(0)
  })

  it('is not a constant-rate clock hand — genuinely stalls/reverses', () => {
    let sawReversal = false
    let prev = dividerAngle(0)
    for (let t = 0.1; t < 600; t += 0.1) {
      const cur = dividerAngle(t)
      if (cur < prev) { sawReversal = true; break }
      prev = cur
    }
    expect(sawReversal).toBe(true)
  })
})
