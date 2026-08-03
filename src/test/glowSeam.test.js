import { describe, it, expect } from 'vitest'
import { glowSeam } from '../components/AlbumGradientMesh.jsx'

// Owner-described fix (2026-08-04): where two hue-distant blobs meet, the
// Cartesian a/b sum naturally cancels toward gray -- real, wanted
// desaturation (see the REVERTED-to-Cartesian comment in draw()). The old
// chroma floor tried to rescue that cancellation by boosting the vector's
// MAGNITUDE while keeping its raw, noise-prone DIRECTION -- verified
// (verify_flip3/4.mjs) to cause real frame-to-frame hue swings up to ~51deg
// at the gate's own legal 140deg ceiling, read live as "two colors meet,
// form a shape, then flip."
//
// glowSeam replaces that rescue entirely: instead of amplifying an unstable
// hue at the cancellation point, it brightens LIGHTNESS toward a soft glow
// and SUPPRESSES chroma further toward true neutral. A near-white seam has
// no hue to flip -- there's nothing directional being amplified anymore, so
// this is safe by construction, not just tuned to be safer. Owner's own
// description: "a small white line... being the barrier" between the two
// colors, as an intentional design element rather than an artifact to hide.
describe('glowSeam', () => {
  it('passes L unchanged and does not touch a/b when chroma is already healthy', () => {
    const [L, a, b] = glowSeam(0.5, 0.08, 0.08, 0.045)
    expect(L).toBe(0.5)
    expect(a).toBe(0.08)
    expect(b).toBe(0.08)
  })

  it('brightens L toward the glow target as chroma approaches true cancellation', () => {
    const [L] = glowSeam(0.5, 0.001, 0.001, 0.045)
    expect(L).toBeGreaterThan(0.5)
  })

  it('suppresses chroma further (never amplifies it) inside the seam zone', () => {
    const [, a, b] = glowSeam(0.5, 0.03, 0.02, 0.045)
    const rawChroma = Math.hypot(0.03, 0.02)
    const resultChroma = Math.hypot(a, b)
    expect(resultChroma).toBeLessThanOrEqual(rawChroma)
  })

  it('is at its brightest / most desaturated exactly at true cancellation (a=b=0)', () => {
    const [L, a, b] = glowSeam(0.5, 0, 0, 0.045)
    expect(a).toBe(0)
    expect(b).toBe(0)
    expect(L).toBeGreaterThan(0.5)
  })

  it('never overshoots past the glow ceiling', () => {
    const [L] = glowSeam(0.95, 0, 0, 0.045)
    expect(L).toBeLessThanOrEqual(1)
  })

  it('has no hue to flip -- a and b both collapse toward zero as chroma drops, never swap sign unpredictably', () => {
    // Sweep chromaNow from the floor down to zero and confirm a/b shrink
    // monotonically in magnitude (no direction is ever amplified).
    let prevChroma = Infinity
    for (let c = 0.045; c >= 0; c -= 0.005) {
      const angle = Math.PI / 3
      const [, a, b] = glowSeam(0.5, Math.cos(angle) * c, Math.sin(angle) * c, 0.045)
      const chroma = Math.hypot(a, b)
      expect(chroma).toBeLessThanOrEqual(prevChroma + 1e-9)
      prevChroma = chroma
    }
  })
})
