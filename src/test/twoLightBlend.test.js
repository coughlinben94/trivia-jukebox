import { describe, expect, it } from 'vitest'
import {
  blendTwoLights,
  hexToRgb,
  mixWithSeam,
  oklabToRgb,
  rgbToOklab,
} from '../lib/twoLightBlend.js'

function hueFromHex(hex) {
  const [, a, b] = rgbToOklab(hexToRgb(hex))
  return (Math.atan2(b, a) * 180 / Math.PI + 360) % 360
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

  it('sweeps hue without a step larger than 20 degrees', () => {
    let previousHue = null

    for (let step = 0; step <= 20; step += 1) {
      const t = step / 20
      const hue = hueFromHex(blendTwoLights({
        hexA: '#09b3e1',
        hexB: '#ec3b6f',
        distA: t,
        distB: 1 - t,
      }))

      if (previousHue !== null) {
        const jump = Math.abs(hue - previousHue)
        expect(Math.min(jump, 360 - jump)).toBeLessThan(20)
      }
      previousHue = hue
    }
  })
})
