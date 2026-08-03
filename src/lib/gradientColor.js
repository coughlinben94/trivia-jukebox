// Shared OKLab hue math for the gradient color-compatibility gate as it
// applies to the manual color-picker (SongDetailModal). LiveScreen.jsx and
// AlbumGradientMesh.jsx each already carry their own copy of equivalent
// math (an established pattern in this codebase — see either file's own
// rgbToOklab) rather than share one module; this file follows the same
// convention for the same reason: SongDetailModal has no existing OKLab
// dependency, and duplicating ~20 lines here avoids a cross-component
// import for what's otherwise a tiny, self-contained module.

function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
function cbrt(x) { return Math.sign(x) * Math.pow(Math.abs(x), 1 / 3) }

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}
function rgbToHex([r, g, b]) {
  const h = v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}
function rgbToOklab([r, g, b]) {
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
// linearToSrgb clamps internally (Math.max(0, Math.min(255,...))) so a
// clipped channel is invisible to any caller working only with oklabToRgb's
// output. Raw (unclamped) linear-light values are needed to actually DETECT
// clipping before it happens — see maxInGamutChroma below.
function linearToSrgbRaw(c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055 }
function oklabToLinearRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ]
}
function oklabToRgb(lab) {
  return oklabToLinearRgb(lab).map(c => linearToSrgbRaw(c) * 255)
}

// A rotated (L, chroma, hue) triple can fall outside displayable sRGB —
// OKLab's gamut is wider than sRGB's, so naively clamping a clipped channel
// shifts the ACTUAL re-encoded hue away from the target (measured live in
// this file's own test suite: a 30deg-target snap round-tripped through hex
// came back 22deg away from base, not 30, because the naive chroma clipped
// blue to 0 on the way). Binary-search the largest chroma that stays IN
// gamut at this L/hue — checked against the raw, unclamped linear-light
// values (0.0031308 threshold in linearToSrgbRaw is where sRGB's own curve
// changes formula; the *255 scale check below is what actually matters) —
// before converting, so the hue that survives round-tripping through an
// 8-bit hex string is the one that was actually asked for, not whatever a
// silent clamp left behind.
function fitsSrgbGamut(rgb) { return rgb.every(v => v >= -0.5 && v <= 255.5) }
function maxInGamutChroma(L, hueRad, chromaCeiling) {
  const at = c => oklabToLinearRgb([L, c * Math.cos(hueRad), c * Math.sin(hueRad)]).map(v => linearToSrgbRaw(v) * 255)
  if (fitsSrgbGamut(at(chromaCeiling))) return chromaCeiling
  let lo = 0, hi = chromaCeiling
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (fitsSrgbGamut(at(mid))) lo = mid
    else hi = mid
  }
  return lo
}

export function hueDegOf(hex) {
  const [, a, b] = rgbToOklab(hexToRgb(hex))
  return (Math.atan2(b, a) * 180 / Math.PI + 360) % 360
}
export function hueDeltaDeg(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d }

// Mirrors the exact gate LiveScreen's pickGradientColors and
// AlbumGradientMesh's resolveCrossfadeHex both already enforce (30-140deg —
// "not one color, not a gray-moat pair"). Exposed here so the manual picker
// applies the SAME numbers as an input constraint instead of risking drift
// between three independently-tuned copies of "what counts as compatible."
export const COMPATIBLE_MIN = 30
export const COMPATIBLE_MAX = 140

// Auto-snap barrier (2026-08-03, owner spec): rather than block or reject
// an out-of-band manual pick, rotate its hue to the nearest edge of the
// compatible band, preserving its own OKLab lightness and chroma exactly —
// the user still gets close to the color they picked, just nudged enough
// that it can never reproduce the muddy-corridor bug the gate exists to
// prevent. In-band picks pass through byte-for-byte unchanged (no
// re-encoding round-trip, so repeated saves of an already-good pick never
// drift).
export function snapToCompatibleHue(baseHex, candidateHex) {
  const baseHue = hueDegOf(baseHex)
  const [L, a, b] = rgbToOklab(hexToRgb(candidateHex))
  const chroma  = Math.sqrt(a * a + b * b)
  const candHue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360
  const diff = ((candHue - baseHue + 540) % 360) - 180 // signed, (-180, 180]

  let targetHue
  if (Math.abs(diff) < COMPATIBLE_MIN) {
    targetHue = baseHue + (diff === 0 ? 1 : Math.sign(diff)) * COMPATIBLE_MIN
  } else if (Math.abs(diff) > COMPATIBLE_MAX) {
    targetHue = baseHue + Math.sign(diff) * COMPATIBLE_MAX
  } else {
    return candidateHex // already in band -- untouched
  }

  const rad = targetHue * Math.PI / 180
  const safeChroma = maxInGamutChroma(L, rad, chroma)
  return rgbToHex(oklabToRgb([L, safeChroma * Math.cos(rad), safeChroma * Math.sin(rad)]))
}
