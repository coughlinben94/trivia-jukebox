import { beforeEach, describe, expect, it } from 'vitest'
import {
  brightnessOffset, flowSpeedBase, dividerOffsetCap, mixSharpness,
  noiseContrast, blendDurationMs, clearDials, setDial, exportSnippet,
} from '../lib/gradientTuning.js'

// 2026-08-07 — rewired to AlbumGradientMesh.jsx (the OKLab noise-duel/
// rotating-divider engine). The old target here, GradientBackground.jsx's
// two-pool point-light engine, was deleted 2026-08-04; these dials were live
// on the board the whole time in between but connected to nothing the
// renderer actually read.
describe('gradient tuning — wired to AlbumGradientMesh.jsx', () => {
  beforeEach(() => clearDials())

  // MOTION/BLEND/DEPTH frozen 2026-08-09 (5-agent think-tank + Fable
  // critique, "bright/fun/alive" pass) — those 3 no longer read T() at all,
  // so their default-dial value IS their only value now. BRIGHTNESS/SIZE/
  // CROSSFADE stayed live and still reproduce the pre-rewire default.
  it('BRIGHTNESS/SIZE/CROSSFADE hold their pre-rewire default; MOTION/BLEND/DEPTH hold their 2026-08-09 shipped freeze', () => {
    expect(brightnessOffset()).toBe(0)
    expect(flowSpeedBase()).toBeCloseTo(0.575, 10)
    expect(dividerOffsetCap()).toBeCloseTo(0.30, 10)
    expect(mixSharpness()).toBeCloseTo(1.272, 10)
    expect(noiseContrast()).toBeCloseTo(1.58, 10)
    expect(blendDurationMs()).toBe(7500)
  })

  it('SIZE never exceeds the 0.30 bleed-over safety ceiling, at any dial position', () => {
    // The whole point of dividerOffsetCap()'s clamp: this is the exact bug
    // fixed earlier the same day (three sine amplitudes summing past +-0.3
    // let the divider leave the visible screen). A dial that could push past
    // 0.30 would let Ben reintroduce it live from the UI.
    for (let t = 0; t <= 100; t += 5) {
      setDial('SIZE', t)
      expect(dividerOffsetCap()).toBeLessThanOrEqual(0.30)
    }
    setDial('SIZE', 100)
    expect(dividerOffsetCap()).toBeCloseTo(0.30, 10)
  })

  it('SIZE below default genuinely shrinks the cap (not flat the whole range)', () => {
    setDial('SIZE', 0)
    expect(dividerOffsetCap()).toBeCloseTo(0.05, 10)
    setDial('SIZE', 25)
    const capAt25 = dividerOffsetCap()
    setDial('SIZE', 50)
    expect(capAt25).toBeLessThan(dividerOffsetCap())
  })

  it('BRIGHTNESS ranges +-0.06 around neutral', () => {
    setDial('BRIGHTNESS', 0)
    expect(brightnessOffset()).toBeCloseTo(-0.06, 10)
    setDial('BRIGHTNESS', 100)
    expect(brightnessOffset()).toBeCloseTo(0.06, 10)
  })

  it('exports paste-ready declarations for the real derived functions', () => {
    for (const id of ['BRIGHTNESS', 'MOTION', 'SIZE', 'BLEND', 'DEPTH', 'VARIETY', 'CROSSFADE']) {
      setDial(id, 60)
    }
    const snippet = exportSnippet()

    for (const name of [
      'brightnessOffset', 'flowSpeedBase', 'dividerOffsetCap',
      'mixSharpness', 'noiseContrast', 'blendDurationMs',
    ]) expect(snippet).toContain(`export function ${name}()`)
    expect(snippet).toContain('export function varietyToConfig()')
    expect(snippet).toContain('// paletteDefaults.js')
    expect(snippet).not.toMatch(/brightnessAdjustment|anchorAmplitude|seamWidth|wobbleAmount|shadeAmount/)
  })

  it('exports nothing but the header when no dials are touched', () => {
    expect(exportSnippet()).toContain('(no dials moved from default)')
  })
})
