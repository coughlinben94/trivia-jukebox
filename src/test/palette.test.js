import { describe, it, expect } from 'vitest'
import * as usePaletteModule from '../hooks/usePalette.js'
import { pickMonochromeAccentHues } from '../../api/palette.js'

describe('palette client cache version', () => {
  // Canary, not a real assertion about behavior (2026-08-07) — pins the
  // current version so a bump to api/palette.js's output (which needs a
  // matching PALETTE_VERSION bump to invalidate Vercel's 24h edge cache,
  // see usePalette.js's own header) can't land without a deliberate touch
  // to this number. v7->v8 shipped 2026-08-07 for exactly the failure this
  // guards: two real server-output changes (83a0ffd, 33c61dc) shipped
  // earlier without a bump, so the CDN kept serving pre-fix palettes.
  it('pins PALETTE_VERSION so a bump requires touching this test', () => {
    expect(usePaletteModule.PALETTE_VERSION).toBe(8)
  })
})

// api/palette.js was simplified 2026-08-04 (owner request) — dropped the
// muddy-hue recoloring model, OKLab accent-placement math, MIN_COLORS
// padding/round-robin, and hue-sibling merging that used to live here,
// since every song's two colors are picked/adjustable by hand in
// SongDetailModal's popup anyway. See api/palette.js's own header comment
// for the full reasoning; the removed functions' old tests (populationFactor,
// buildWeights, relativeSaturation, uglyWeight, deuglify, mergeHueSiblings,
// warmPocketHueWeight, hexToOklabHueDeg, pickAccentHue) are gone with them —
// still in git history if any of that math is ever needed again.
describe('pickMonochromeAccentHues', () => {
  it('picks a neon purple/pink pair for a true black-and-white cover, never blue/orange', () => {
    const [hueA, hueB] = pickMonochromeAccentHues()
    for (const h of [hueA, hueB]) {
      expect(h).toBeGreaterThanOrEqual(270)
      expect(h).toBeLessThanOrEqual(340)
    }
  })
})
