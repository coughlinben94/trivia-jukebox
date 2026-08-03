const GLOW_DELTA_L = 0.28

export function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

function rgbToHex([r, g, b]) {
  const channel = value => Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
function linearToSrgb(c) { c = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, c * 255)) }
function cbrt(x) { return Math.sign(x) * Math.pow(Math.abs(x), 1 / 3) }

export function rgbToOklab([r, g, b]) {
  r = srgbToLinear(r); g = srgbToLinear(g); b = srgbToLinear(b)
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const l_ = cbrt(l), m_ = cbrt(m), s_ = cbrt(s)
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ]
}

export function oklabToRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_
  const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(bb)]
}

export function mixWithSeam(L, a, b, weightA, weightB) {
  const balance = 1 - Math.abs(weightA - weightB)
  const eased = balance * balance * (3 - 2 * balance)
  const chromaScale = 1 - eased * 0.6
  const glowLightness = Math.min(1, L + GLOW_DELTA_L)

  return [L + (glowLightness - L) * eased, a * chromaScale, b * chromaScale]
}

// Prepare once per palette transition, then call the returned function for
// every pixel/frame. Hex parsing and OKLab conversion stay outside the hot
// renderer loop.
export function prepareTwoLightBlend(hexA, hexB) {
  if (!/^#[0-9a-f]{6}$/i.test(hexA) || !/^#[0-9a-f]{6}$/i.test(hexB)) {
    throw new TypeError('Two-light colors must be six-digit hex strings')
  }
  const labA = rgbToOklab(hexToRgb(hexA))
  const labB = rgbToOklab(hexToRgb(hexB))

  return (distA, distB) => {
    if (!Number.isFinite(distA) || !Number.isFinite(distB)) {
      throw new TypeError('Two-light distances must be finite numbers')
    }
    return blendPreparedLights({
      hexA,
      hexB,
      labA,
      labB,
      distA: Math.max(0, distA),
      distB: Math.max(0, distB),
    })
  }
}

function blendPreparedLights({ hexA, hexB, labA, labB, distA, distB }) {
  if (distA === 0 && distB > 0) return hexA
  if (distB === 0 && distA > 0) return hexB

  const rawWeightA = 1 / (distA + 0.001)
  const rawWeightB = 1 / (distB + 0.001)
  const weightSum = rawWeightA + rawWeightB
  const weightA = rawWeightA / weightSum
  const weightB = rawWeightB / weightSum
  const [lightnessA, aA, bA] = labA
  const [lightnessB, aB, bB] = labB
  const mixed = mixWithSeam(
    lightnessA * weightA + lightnessB * weightB,
    aA * weightA + aB * weightB,
    bA * weightA + bB * weightB,
    weightA,
    weightB,
  )
  const result = rgbToHex(oklabToRgb(mixed))

  if (result === '#000000' && hexA.toLowerCase() !== '#000000' && hexB.toLowerCase() !== '#000000') {
    return lightnessA >= lightnessB ? hexA : hexB
  }
  return result
}

export function blendTwoLights({ hexA, hexB, distA, distB }) {
  // Convenience API for isolated samples and tests. Renderers should retain
  // prepareTwoLightBlend(hexA, hexB) instead of calling this per pixel.
  return prepareTwoLightBlend(hexA, hexB)(distA, distB)
}
