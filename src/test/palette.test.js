import { describe, it, expect } from 'vitest'
import { populationFactor, buildWeights, relativeSaturation, uglyWeight, deuglify, mergeHueSiblings, warmPocketHueWeight, hexToOklabHueDeg, pickAccentHue } from '../../api/palette.js'

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

// Real live-library colors for the pickAccentHue tests. FASTCAR_RED is the
// production /api/palette colors[0] for Black Pumas' "Fast Car"
// (["#d72a1b","#397f85"], weights [0.85,0.15], fetched live 2026-07-30 —
// the isolated-teal-disc bug report). JUNE_TAN is Black Match's "June"
// (the real single-hue muted tan that motivated deriving the accent from
// the cover's own hue in the first place). ROCKETSHIP_BLUE is Llunr's
// "Rocketship" dominant blue, standing in for a cool base. The 0.40/0.3725
// sat/lightness are what the single-hue branch actually feeds
// pickAccentHue for the Fast Car cover (ACCENT_SAT and the avgLuma clamp,
// measured in simulate-accent-blob.mjs).
const FASTCAR_RED     = '#d72a1b' // HSL hue 4.79, OKLab hue 29.88
const FASTCAR_TEAL    = '#397f85' // the OLD 180-degree accent this fix replaces
const JUNE_TAN        = '#a57d61' // OKLab hue 56.22
const ROCKETSHIP_BLUE = '#1169b6' // OKLab hue 251.34
const GREEN_STRESS    = '#2eb877' // HSL 152 — the base where HSL-±120 hit 149.3° OKLab
const ACCENT_SAT = 0.40, ACCENT_L = 0.3725

describe('warmPocketHueWeight (the pocket hue band, shared with uglyWeight)', () => {
  it('matches the uglyWeight band: full weight 28-88, zero outside 16/102', () => {
    expect(warmPocketHueWeight(10)).toBe(0)
    expect(warmPocketHueWeight(58)).toBe(1)   // pocket centre
    expect(warmPocketHueWeight(110)).toBe(0)
    expect(warmPocketHueWeight(200)).toBe(0)  // cool hues never in the pocket
  })
  it('ramps smoothly across the edges instead of snapping', () => {
    const onRamp = warmPocketHueWeight(22) // midway up the 16-28 in-ramp
    expect(onRamp).toBeGreaterThan(0)
    expect(onRamp).toBeLessThan(1)
  })
  it('agrees with uglyWeight on the original offender (regression: the factor-out changed nothing)', () => {
    // MOWGLIS_OLIVE sits at hue 73.58, deep inside the band — uglyWeight
    // full-catches it (tested above), so the band must report 1 here.
    expect(warmPocketHueWeight(MOWGLIS_OLIVE.h)).toBe(1)
  })
})

describe('hexToOklabHueDeg', () => {
  it('reproduces the OKLab hues measured in the Fast Car rig (simulate-accent-blob.mjs)', () => {
    expect(hexToOklabHueDeg(FASTCAR_RED)).toBeCloseTo(29.9, 1)
    expect(hexToOklabHueDeg(FASTCAR_TEAL)).toBeCloseTo(202.9, 1)
  })
})

describe('pickAccentHue (2026-07-30, the Fast Car isolated-accent-disc fix)', () => {
  it('sends Fast Car\'s red to the blue-violet side, not the mustard-halo green side', () => {
    // 227 is the HSL hue whose sat-0.40 accent (#394985) sits 120° from
    // the red in OKLab — verified in verify_accent_tmp.mjs to render with
    // ZERO hard-seam pixels and 0.0% muddy-pocket pixels at t=0/3/6,
    // vs the old 180° teal's 14-24 seam px and 1.2-2.6% mud. The rejected
    // +120 green side renders soft too but wears a 3.1% mustard halo.
    const h = pickAccentHue(FASTCAR_RED, ACCENT_SAT, ACCENT_L)
    expect(h).toBe(227)
    expect(h).toBeGreaterThan(200) // blue-violet band, robust to retuning
    expect(h).toBeLessThan(280)
  })
  it('pins the separation at ~120° in OKLab hue, not HSL hue', () => {
    for (const base of [FASTCAR_RED, JUNE_TAN, ROCKETSHIP_BLUE, GREEN_STRESS]) {
      const accHslHue = pickAccentHue(base, ACCENT_SAT, ACCENT_L)
      // Rebuild the accent hex the branch will emit (same math as
      // api/palette.js's hslToHex at ACCENT_SAT/ACCENT_L) and measure.
      const accHex = hslToHexLocal(accHslHue, ACCENT_SAT, ACCENT_L)
      const d0 = Math.abs(hexToOklabHueDeg(base) - hexToOklabHueDeg(accHex)) % 360
      const sep = d0 > 180 ? 360 - d0 : d0
      // ±3° covers the 1°-integer-HSL scan quantization.
      expect(sep).toBeGreaterThan(117)
      expect(sep).toBeLessThan(123)
    }
  })
  it('never lands the accent inside the muddy-warm pocket, for any base hue', () => {
    // An arc that ENDS deep in the pocket necessarily swept into it, so
    // the cleaner-arc rule keeps the accent itself clean — full-360 sweep
    // in verify_accent_tmp.mjs measured max pocket weight exactly 0;
    // sample every 10° here to keep the suite fast.
    for (let h = 0; h < 360; h += 10) {
      const base = hslToHexLocal(h, 0.60, 0.45)
      expect(warmPocketHueWeight(pickAccentHue(base, ACCENT_SAT, ACCENT_L))).toBe(0)
    }
  })
  it('gives a cool base a warm accent on the clean-tie side (Rocketship blue -> pink/red)', () => {
    // Both 120° arcs from a deep blue avoid the pocket entirely (the
    // pocket sits in the wedge OPPOSITE the base) — the tie prefers the
    // + side, a warm accent against a cool base.
    const h = pickAccentHue(ROCKETSHIP_BLUE, ACCENT_SAT, ACCENT_L)
    expect(h).toBe(350)
    expect(warmPocketHueWeight(h)).toBe(0)
  })
  it('handles the single-real-muted-tan cover that motivated hue-derived accents (June)', () => {
    const h = pickAccentHue(JUNE_TAN, ACCENT_SAT, ACCENT_L)
    expect(h).toBe(260) // violet — clean side; the other side sweeps the whole pocket
  })
})

// Local copy of api/palette.js's private hslToHex, only to rebuild the
// accent hex the branch emits so the OKLab-separation test can measure it.
function hslToHexLocal(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r, g, b
  if (h < 60)       [r, g, b] = [c, x, 0]
  else if (h < 120)  [r, g, b] = [x, c, 0]
  else if (h < 180)  [r, g, b] = [0, c, x]
  else if (h < 240)  [r, g, b] = [0, x, c]
  else if (h < 300)  [r, g, b] = [x, 0, c]
  else               [r, g, b] = [c, 0, x]
  const toHex = v => Math.min(255, Math.max(0, Math.round(v * 255))).toString(16).padStart(2, '0')
  return '#' + toHex(r + m) + toHex(g + m) + toHex(b + m)
}

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
