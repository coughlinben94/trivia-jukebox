import { describe, it, expect } from 'vitest'
import { anchorDivider } from '../components/AlbumGradientMesh.jsx'

// 2026-08-07 — anchorDivider() is a pure function of raw tSec, driven in
// draw() by (ts - hiddenOffsetMsRef.current) / 1000. Pins the property that
// fix depends on: after a long tab-hide, offsetting tSec by the hidden
// duration must keep the divider's value continuous frame-to-frame, same as
// if the tab had never gone hidden — vs. a raw wall-clock jump, which snaps
// it to a near-arbitrary point on its 3-sine cycle.
describe('anchorDivider hidden-tab continuity', () => {
  it('stays continuous across a hide when the caller subtracts the hidden duration', () => {
    const tBeforeHide = 100
    const hiddenSec = 723 // long tab-hide (~12min)
    const frameSec = 1 / 60

    const before = anchorDivider(tBeforeHide)
    const resumedNoOffset = anchorDivider(tBeforeHide + hiddenSec + frameSec)
    const resumedWithOffset = anchorDivider((tBeforeHide + hiddenSec + frameSec) - hiddenSec)

    const jumpNoOffset = Math.abs(resumedNoOffset - before)
    const jumpWithOffset = Math.abs(resumedWithOffset - before)

    // Without the offset, a 500s hide can land anywhere on the divider's
    // range (up to ~0.6 wide) — this hide length happens to produce a large
    // jump, demonstrating the bug the fix prevents.
    expect(jumpNoOffset).toBeGreaterThan(0.1)
    // With the offset, resuming is just one more normal frame (1/60s) later.
    expect(jumpWithOffset).toBeLessThan(0.01)
  })
})
