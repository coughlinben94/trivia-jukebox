const GLOW_DELTA_L = 0.28
const HALO_DELTA_L = 0.1

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

function clampRgb(rgb) {
  return rgb.map(value => Math.max(0, Math.min(255, Math.round(value))))
}

function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
function linearToSrgb(c) { c = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, c * 255)) }
function cbrt(x) { return Math.sign(x) * Math.pow(Math.abs(x), 1 / 3) }

function seamEased(weightA, weightB) {
  const balance = 1 - Math.abs(weightA - weightB)
  return balance * balance * (3 - 2 * balance)
}

function writeOklabToRgb(L, a, b, target, offset) {
  const lRoot = L + 0.3963377774 * a + 0.2158037573 * b
  const mRoot = L - 0.1055613458 * a - 0.0638541728 * b
  const sRoot = L - 0.0894841775 * a - 1.2914855480 * b
  const l = lRoot * lRoot * lRoot
  const m = mRoot * mRoot * mRoot
  const s = sRoot * sRoot * sRoot
  target[offset] = linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
  target[offset + 1] = linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
  target[offset + 2] = linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)
  return target
}

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
  const target = [0, 0, 0]
  writeOklabToRgb(L, a, b, target, 0)
  return target
}

export function mixWithSeam(L, a, b, weightA, weightB) {
  const eased = seamEased(weightA, weightB)
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

function blendPreparedLights({ hexA, hexB, labA, labB, distA, distB, asRgb = false }) {
  if (distA === 0 && distB > 0 && !asRgb) return hexA
  if (distB === 0 && distA > 0 && !asRgb) return hexB

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
  const rgb = clampRgb(oklabToRgb(mixed))
  const result = rgbToHex(rgb)

  if (result === '#000000' && hexA.toLowerCase() !== '#000000' && hexB.toLowerCase() !== '#000000') {
    return asRgb
      ? hexToRgb(lightnessA >= lightnessB ? hexA : hexB)
      : (lightnessA >= lightnessB ? hexA : hexB)
  }
  return asRgb ? rgb : result
}

// Prepared Canvas hot-path API. Each light's family is 10% lighter at its
// center and 10% darker at the edge of its normalized radius. Color parsing
// and sRGB-to-OKLab conversion happen once, while seam behavior continues to
// use blendPreparedLights/mixWithSeam above.
export function prepareTwoLightField(hexA, hexB, options = {}) {
  if (!/^#[0-9a-f]{6}$/i.test(hexA) || !/^#[0-9a-f]{6}$/i.test(hexB)) {
    throw new TypeError('Two-light colors must be six-digit hex strings')
  }
  const baseA = rgbToOklab(hexToRgb(hexA))
  const baseB = rgbToOklab(hexToRgb(hexB))
  const baseAr = parseInt(hexA.slice(1, 3), 16)
  const baseAg = parseInt(hexA.slice(3, 5), 16)
  const baseAb = parseInt(hexA.slice(5, 7), 16)
  const baseBr = parseInt(hexB.slice(1, 3), 16)
  const baseBg = parseInt(hexB.slice(3, 5), 16)
  const baseBb = parseInt(hexB.slice(5, 7), 16)
  const baseAL = baseA[0], baseAa = baseA[1], baseAbLab = baseA[2]
  const baseBL = baseB[0], baseBa = baseB[1], baseBbLab = baseB[2]
  const brightnessAdjustment = options.brightnessAdjustment ?? 0
  const haloDepth = options.haloDepth ?? HALO_DELTA_L
  const seamBlend = options.seamBlend ?? 0.6

  function sampleInto(distA, distB, target, offset = 0) {
    if (!Number.isFinite(distA) || !Number.isFinite(distB)) {
      throw new TypeError('Two-light distances must be finite numbers')
    }
    distA = Math.max(0, distA)
    distB = Math.max(0, distB)
    const lightnessA = Math.max(0, Math.min(1, baseAL + brightnessAdjustment + haloDepth * (1 - 2 * Math.min(1, distA))))
    const lightnessB = Math.max(0, Math.min(1, baseBL + brightnessAdjustment + haloDepth * (1 - 2 * Math.min(1, distB))))
    const rawWeightA = 1 / (distA + 0.001)
    const rawWeightB = 1 / (distB + 0.001)
    const weightSum = rawWeightA + rawWeightB
    const weightA = rawWeightA / weightSum
    const weightB = rawWeightB / weightSum
    const eased = seamEased(weightA, weightB)
    const chromaScale = 1 - eased * seamBlend
    let L = lightnessA * weightA + lightnessB * weightB
    L += (Math.min(1, L + GLOW_DELTA_L) - L) * eased
    const a = (baseAa * weightA + baseBa * weightB) * chromaScale
    const b = (baseAbLab * weightA + baseBbLab * weightB) * chromaScale

    writeOklabToRgb(L, a, b, target, offset)
    if (target[offset] === 0 && target[offset + 1] === 0 && target[offset + 2] === 0 &&
        hexA.toLowerCase() !== '#000000' && hexB.toLowerCase() !== '#000000') {
      const useA = lightnessA >= lightnessB
      target[offset] = useA ? baseAr : baseBr
      target[offset + 1] = useA ? baseAg : baseBg
      target[offset + 2] = useA ? baseAb : baseBb
    }
    target[offset + 3] = 255
    return target
  }

  const sample = (distA, distB) => {
    const target = new Uint8ClampedArray(4)
    sampleInto(distA, distB, target, 0)
    return [target[0], target[1], target[2]]
  }
  sample.sampleInto = sampleInto
  return sample
}

export function blendTwoLights({ hexA, hexB, distA, distB }) {
  // Convenience API for isolated samples and tests. Renderers should retain
  // prepareTwoLightBlend(hexA, hexB) instead of calling this per pixel.
  return prepareTwoLightBlend(hexA, hexB)(distA, distB)
}
