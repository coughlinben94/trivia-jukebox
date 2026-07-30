import { describe, it, expect } from 'vitest'
import { populationFactor, buildWeights, relativeSaturation, uglyWeight, deuglify, mergeHueSiblings } from '../../api/palette.js'

// hue / chroma / lightness triplets for real live-library colors, computed
// exactly the way api/palette.js's own hexToHue/hexToChroma/hexToLightness
// compute them. Each is a real output color from the 2026-07-30 full-library
// scan (140 covers, 651 colors, via the production /api/palette).
const KYRIE_BROWN   = { hex: '#8b6b4d', h: 29.03, c: 62 / 255, L: 216 / 510 }   // Kyrie (Mr. Mister) — flat "poopy" brown
const MUSTARD_TAN   = { hex: '#b18e55', h: 37.17, c: 92 / 255, L: 262 / 510 }   // I Could Drive You Crazy (Sierra Ferrell)
const KHAKI         = { hex: '#a69652', h: 48.57, c: 84 / 255, L: 248 / 510 }   // Love Like That (Mayer Hawthorne)
const MOWGLIS_OLIVE = { hex: '#5b6732', h: 73.58, c: 53 / 255, L: 153 / 510 }   // I Feel Good About This — the pocket's original 2026-07-29 offender
const MUTED_TEAL    = { hex: '#3c7f7e', h: 179.10, c: 67 / 255, L: 187 / 510 }  // Umbrella (Train) — dusty but NOT muddy
const DUSTY_PLUM    = { hex: '#8146b8', h: 271.05, c: 114 / 255, L: 254 / 510 } // 1990something (Sub-Radio)
const RICH_AMBER    = { hex: '#b37a1f', h: 36.89, c: 148 / 255, L: 210 / 510 }  // clean warm control from the scan
const BRICK_CLAY    = { hex: '#8f4c33', h: 16.30, c: 92 / 255, L: 194 / 510 }   // Free (Drake White) — terracotta, reads fine

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

describe('relativeSaturation', () => {
  it('reports the same chroma as rich at low lightness but flat at mid lightness', () => {
    // Absolute chroma 0.36 is most of what L=0.20 can carry...
    expect(relativeSaturation(0.36, 0.20)).toBeCloseTo(0.9, 5)
    // ...but barely a third of what L=0.50 can — this asymmetry is what the
    // old absolute-chroma gate (full weight under 0.26, gone by 0.33) could
    // never express, and why the scan's mustards slipped through it.
    expect(relativeSaturation(0.36, 0.50)).toBeCloseTo(0.36, 5)
  })
  it('is safe at the lightness poles (denominator 0) and clamps to 1', () => {
    expect(relativeSaturation(0, 0)).toBe(0)
    expect(relativeSaturation(0, 1)).toBe(0)
    expect(relativeSaturation(0.9, 0.9)).toBe(1)
  })
})

describe('uglyWeight (generalized muddy-warm pocket, 2026-07-30)', () => {
  it('fully catches the flat browns below hue 40 that the old 40-100 box gave weight 0', () => {
    // Kyrie's #8b6b4d (hue 29): the literal "poopy brown" category.
    expect(uglyWeight(KYRIE_BROWN.h, KYRIE_BROWN.c, KYRIE_BROWN.L)).toBeGreaterThan(0.99)
  })
  it('catches mustards whose ABSOLUTE chroma cleared the old 0.33 gate', () => {
    // #b18e55: chroma 0.361 sailed past the old gate entirely, but its
    // relative saturation is only 0.371 — flat for lightness 0.51.
    expect(MUSTARD_TAN.c).toBeGreaterThan(0.33)
    expect(uglyWeight(MUSTARD_TAN.h, MUSTARD_TAN.c, MUSTARD_TAN.L)).toBeGreaterThan(0.99)
    expect(uglyWeight(KHAKI.h, KHAKI.c, KHAKI.L)).toBeGreaterThan(0.99)
  })
  it('still fully catches the pocket\'s original documented offender (regression)', () => {
    expect(uglyWeight(MOWGLIS_OLIVE.h, MOWGLIS_OLIVE.c, MOWGLIS_OLIVE.L)).toBeGreaterThan(0.99)
  })
  it('leaves equally-dull COOL hues alone — dullness is hue-agnostic, muddiness is not', () => {
    // Same low rel-sat, mid lightness as the browns; visually read as
    // moody/dusty, not dirty, in the 2026-07-30 scan — and Palmer & Schloss
    // found no preference trough for dark blue/purple the way there is for
    // dark orange/yellow.
    expect(uglyWeight(MUTED_TEAL.h, MUTED_TEAL.c, MUTED_TEAL.L)).toBe(0)
    expect(uglyWeight(DUSTY_PLUM.h, DUSTY_PLUM.c, DUSTY_PLUM.L)).toBe(0)
  })
  it('leaves saturated warm colors alone — rel-sat >= 0.55 is clean at any hue', () => {
    expect(uglyWeight(RICH_AMBER.h, RICH_AMBER.c, RICH_AMBER.L)).toBe(0)
  })
  it('leaves terracotta/brick below the hue ramp essentially alone', () => {
    expect(uglyWeight(BRICK_CLAY.h, BRICK_CLAY.c, BRICK_CLAY.L)).toBeLessThan(0.05)
  })
  it('ignores warm-tinted near-grays (neutrality guard) instead of inventing color for them', () => {
    expect(uglyWeight(30, 0.03, 0.4)).toBe(0)
  })
})

describe('mergeHueSiblings (2026-07-30, the Rocketship hard-bisection fix)', () => {
  it('merges Rocketship\'s real live output down to 3 real hue families, summing population into the dominant member', () => {
    // Real live /api/palette output for Llunr's "Rocketship" before this
    // fix: orange padded twice (#e89c00 hue 40.3, #f2a61b hue 38.8 -- 1.5°
    // apart) and blue padded twice (#1169b6, #005096 -- both hue 208, 0°
    // apart), plus one real red. HUE_GAP_DEG defaults to 25 at VARIETY=50.
    const colors = ['#e89c00', '#1169b6', '#cc0000', '#f2a61b', '#005096']
    const byHex = new Map([
      ['#e89c00', { hue: 40.3, population: 300 }],
      ['#1169b6', { hue: 208,  population: 400 }],
      ['#cc0000', { hue: 0,    population: 150 }],
      ['#f2a61b', { hue: 38.8, population: 300 }],
      ['#005096', { hue: 208,  population: 1200 }], // dominant blue
    ])
    const merged = mergeHueSiblings(colors, byHex, 25)
    expect(merged).toHaveLength(3)
    // darkblue (#005096) had the larger population within its family, so it
    // survives as the representative and inherits BOTH blues' population.
    expect(merged).toContain('#005096')
    expect(merged).not.toContain('#1169b6')
    expect(byHex.get('#005096').population).toBe(1600) // 400 + 1200
    // orange: #e89c00 and #f2a61b tie at 300 -- first-seen wins the tie.
    expect(merged).toContain('#e89c00')
    expect(byHex.get('#e89c00').population).toBe(600)
    expect(merged).toContain('#cc0000')
  })

  it('leaves genuinely distinct hues untouched (no merge when nothing is a sibling)', () => {
    const colors = ['#fec50d', '#1ea48f', '#ff8e84', '#8348bc', '#e48bc3']
    const byHex = new Map([
      ['#fec50d', { hue: 46,  population: 100 }],
      ['#1ea48f', { hue: 172, population: 90 }],
      ['#ff8e84', { hue: 4,   population: 80 }],
      ['#8348bc', { hue: 270, population: 70 }],
      ['#e48bc3', { hue: 320, population: 60 }],
    ])
    expect(mergeHueSiblings(colors, byHex, 25)).toEqual(colors)
  })

  it('is a no-op on a single color', () => {
    const byHex = new Map([['#123456', { hue: 210, population: 50 }]])
    expect(mergeHueSiblings(['#123456'], byHex, 25)).toEqual(['#123456'])
  })
})

describe('deuglify (recolor, never drop)', () => {
  it('rotates a muddy brown to terracotta (hue 18) and lifts its relative saturation', () => {
    const d = deuglify(KYRIE_BROWN.h, KYRIE_BROWN.c, KYRIE_BROWN.L, KYRIE_BROWN.hex)
    expect(d.hue).toBeCloseTo(18, 1)
    expect(relativeSaturation(d.chroma, d.lightness))
      .toBeGreaterThan(relativeSaturation(KYRIE_BROWN.c, KYRIE_BROWN.L))
    expect(d.hex).not.toBe(KYRIE_BROWN.hex)
  })
  it('still lifts a mustard already at chroma 0.36+ (the old flat 0.42 cap zeroed this lift)', () => {
    const d = deuglify(MUSTARD_TAN.h, MUSTARD_TAN.c, MUSTARD_TAN.L, MUSTARD_TAN.hex)
    expect(d.chroma).toBeGreaterThan(MUSTARD_TAN.c)
    expect(d.chroma).toBeLessThanOrEqual(0.45)
  })
  it('rotates the original olive offender to leaf green (hue 108), as the 2026-07-29 fix intended', () => {
    const d = deuglify(MOWGLIS_OLIVE.h, MOWGLIS_OLIVE.c, MOWGLIS_OLIVE.L, MOWGLIS_OLIVE.hex)
    expect(d.hue).toBeCloseTo(108, 1)
  })
  it('passes a clean color through byte-identical', () => {
    const d = deuglify(200, 0.3, 0.4, '#123456')
    expect(d).toEqual({ hue: 200, chroma: 0.3, lightness: 0.4, hex: '#123456' })
  })
})
