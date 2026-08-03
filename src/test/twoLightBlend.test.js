import { describe, expect, it } from 'vitest'
import {
  blendTwoLights,
  hexToRgb,
  mixWithSeam,
  oklabToRgb,
  prepareTwoLightBlend,
  rgbToOklab,
} from '../lib/twoLightBlend.js'

function hueAndChromaFromHex(hex) {
  const [, a, b] = rgbToOklab(hexToRgb(hex))
  return {
    hue: (Math.atan2(b, a) * 180 / Math.PI + 360) % 360,
    chroma: Math.hypot(a, b),
  }
}

describe('OKLab conversion helpers', () => {
  it('round-trips an sRGB color', () => {
    const rgb = hexToRgb('#09b3e1')
    const roundTrip = oklabToRgb(rgbToOklab(rgb))

    roundTrip.forEach((channel, index) => {
      expect(channel).toBeCloseTo(rgb[index], 3)
    })
  })
})

describe('mixWithSeam', () => {
  it('adds the full 0.28 lightness glow at an even seam', () => {
    const [L] = mixWithSeam(0.5, 0.08, -0.04, 0.5, 0.5)

    expect(L).toBeCloseTo(0.78, 10)
  })

  it('leaves lightness and chroma unchanged at either endpoint', () => {
    expect(mixWithSeam(0.5, 0.08, -0.04, 1, 0)).toEqual([0.5, 0.08, -0.04])
    expect(mixWithSeam(0.5, 0.08, -0.04, 0, 1)).toEqual([0.5, 0.08, -0.04])
  })
})

describe('blendTwoLights', () => {
  it('returns colorA exactly at distance 0 from light A', () => {
    expect(blendTwoLights({ hexA: '#ff0000', hexB: '#0000ff', distA: 0, distB: 1 })).toBe('#ff0000')
  })

  it('returns colorB exactly at distance 0 from light B', () => {
    expect(blendTwoLights({ hexA: '#ff0000', hexB: '#0000ff', distA: 1, distB: 0 })).toBe('#0000ff')
  })

  it('brightens the midpoint with a smooth seam glow', () => {
    const naiveL = (
      rgbToOklab(hexToRgb('#ff0000'))[0] +
      rgbToOklab(hexToRgb('#0000ff'))[0]
    ) / 2
    const resultL = rgbToOklab(hexToRgb(
      blendTwoLights({ hexA: '#ff0000', hexB: '#0000ff', distA: 0.5, distB: 0.5 }),
    ))[0]

    expect(resultL).toBeGreaterThan(naiveL + 0.2)
  })

  it('never produces black when neither input is black', () => {
    expect(blendTwoLights({ hexA: '#330000', hexB: '#000033', distA: 0.5, distB: 0.5 })).not.toBe('#000000')
  })

  it.each([
    ['cyan to pink', '#09b3e1', '#ec3b6f'],
    ['red to cyan', '#ff2400', '#00cfe8'],
    ['orange to blue', '#ff8a00', '#2457ff'],
    ['green to magenta', '#19b56b', '#dc3fc0'],
  ])('keeps visible hue moving in one direction for %s', (_name, hexA, hexB) => {
    const chromaThreshold = 0.03
    const reversalTolerance = 3
    const startHue = hueAndChromaFromHex(hexA).hue
    const endHue = hueAndChromaFromHex(hexB).hue
    const expectedDirection = Math.sign(((endHue - startHue + 540) % 360) - 180)
    let previousHue = null

    for (let step = 0; step <= 40; step += 1) {
      const t = step / 40
      const { hue, chroma } = hueAndChromaFromHex(blendTwoLights({
        hexA,
        hexB,
        distA: t,
        distB: 1 - t,
      }))

      // Hue is not perceptually meaningful near neutral. Only police the
      // trajectory while enough chroma remains for a direction change to be
      // visible as a flip.
      if (chroma >= chromaThreshold && previousHue !== null) {
        const signedStep = ((hue - previousHue + 540) % 360) - 180
        // Integer sRGB output can jitter by a degree or two after gamut
        // clipping. A larger reversal while chroma is visible is the flip
        // users can perceive and this test is intended to catch.
        expect(signedStep * expectedDirection).toBeGreaterThanOrEqual(-reversalTolerance)
        expect(Math.abs(signedStep)).toBeLessThan(20)
      }
      previousHue = chroma >= chromaThreshold ? hue : null
    }
  })
})

describe('prepareTwoLightBlend', () => {
  it('prepares colors once and reuses them for many pixel-distance samples', () => {
    const blendPrepared = prepareTwoLightBlend('#ff0000', '#0000ff')

    expect(blendPrepared(0, 1)).toBe('#ff0000')
    expect(blendPrepared(0.5, 0.5)).toBe(
      blendTwoLights({ hexA: '#ff0000', hexB: '#0000ff', distA: 0.5, distB: 0.5 }),
    )
    expect(blendPrepared(1, 0)).toBe('#0000ff')
  })

  it.each(['red', '#fff', '#gg0000', '#1234567', null])('rejects invalid six-digit hex input %j', invalidHex => {
    expect(() => prepareTwoLightBlend(invalidHex, '#0000ff')).toThrow(TypeError)
  })

  it('clamps negative distances to the nearest light endpoint', () => {
    const blendPrepared = prepareTwoLightBlend('#ff0000', '#0000ff')

    expect(blendPrepared(-1, 1)).toBe('#ff0000')
    expect(blendPrepared(1, -1)).toBe('#0000ff')
  })

  it.each([NaN, Infinity, -Infinity])('rejects non-finite distance %s', distance => {
    const blendPrepared = prepareTwoLightBlend('#ff0000', '#0000ff')

    expect(() => blendPrepared(distance, 1)).toThrow(TypeError)
  })
})
