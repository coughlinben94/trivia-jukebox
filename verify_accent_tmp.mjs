// Verification for the pickAccentHue() fix (Fast Car / Black Pumas
// isolated-accent-disc bug, 2026-07-30). Imports the REAL exported
// functions from api/palette.js and renders AlbumGradientMesh.jsx's exact
// per-pixel blend (verbatim formulas, same as simulate-accent-blob.mjs) to
// measure seam hardness / accent visibility / mud halo for the accent the
// shipped code will actually emit. Scratch script, same convention as
// verify_rocketship_tmp.mjs.
import { pickAccentHue, warmPocketHueWeight, uglyWeight } from './api/palette.js'

const NUM_BLOBS = 6
const SW = 48, SH = 27
const speed = 1.265, size = 0.50, idwPower = 2, chromaScl = 0.70

// ── verbatim from AlbumGradientMesh.jsx ─────────────────────────────────
function rng(i, slot) {
  const x = Math.sin((i * 7 + slot) * 9301 + 49297) * 233280
  return x - Math.floor(x)
}
function makeOne(i) {
  return {
    baseX: 0.10 + rng(i, 0) * 0.80, baseY: 0.10 + rng(i, 1) * 0.80,
    xAmp: 0.33, yAmp: 0.33,
    xFreq: speed / (10 + rng(i, 2) * 7), yFreq: speed / (10 + rng(i, 3) * 7),
    xPhase: rng(i, 4) * Math.PI * 2, yPhase: rng(i, 5) * Math.PI * 2,
    radius: size + rng(i, 6) * 0.13,
  }
}
function makeBlobParams() {
  return Array.from({ length: NUM_BLOBS }, (_, i) => {
    if (i % 2 === 0) return makeOne(i)
    const p = makeOne(i - 1)
    return { baseX: 1 - p.baseX, baseY: 1 - p.baseY, xAmp: p.xAmp, yAmp: p.yAmp,
      xFreq: p.xFreq, yFreq: p.yFreq, xPhase: p.xPhase + Math.PI, yPhase: p.yPhase + Math.PI,
      radius: size + rng(i, 6) * 0.13 }
  })
}
function allocateBlobCounts(weights) {
  const n = weights.length
  if (n === 0) return []
  if (n === 1) return [NUM_BLOBS]
  const quotas = weights.map(w => w * NUM_BLOBS)
  const counts = quotas.map(Math.floor)
  const remainders = quotas.map((q, i) => q - counts[i])
  const leftover = NUM_BLOBS - counts.reduce((s, c) => s + c, 0)
  const order = weights.map((_, i) => i).sort((a, b) => {
    if (remainders[b] !== remainders[a]) return remainders[b] - remainders[a]
    if (weights[b] !== weights[a]) return weights[b] - weights[a]
    return a - b
  })
  for (let k = 0; k < leftover; k++) counts[order[k]] += 1
  for (let i = 0; i < n; i++) {
    if (weights[i] > 0 && counts[i] === 0) {
      let donor = -1
      for (let j = 0; j < n; j++) if (counts[j] > 1 && (donor === -1 || counts[j] > counts[donor])) donor = j
      if (donor !== -1) { counts[donor] -= 1; counts[i] += 1 }
    }
  }
  return counts
}
const BLOB_PAIRS = [[0, 1], [2, 3], [4, 5]]
function assignColorsToPairs(counts, rotationSeed) {
  const n = counts.length
  const remaining = counts.slice()
  const arenas = []
  for (let p = 0; p < BLOB_PAIRS.length; p++) {
    let a = -1
    for (let i = 0; i < n; i++) if (remaining[i] > 0 && (a === -1 || remaining[i] > remaining[a])) a = i
    remaining[a] -= 1
    let b = -1
    for (let i = 0; i < n; i++) if (i !== a && remaining[i] > 0 && (b === -1 || remaining[i] > remaining[b])) b = i
    if (b === -1) b = a
    remaining[b] -= 1
    arenas.push([a, b])
  }
  const rot = rotationSeed % BLOB_PAIRS.length
  const colorByBlobIndex = new Array(NUM_BLOBS)
  arenas.forEach(([a, b], i) => {
    const [i0, i1] = BLOB_PAIRS[(i + rot) % BLOB_PAIRS.length]
    colorByBlobIndex[i0] = a
    colorByBlobIndex[i1] = b
  })
  return colorByBlobIndex
}
function rotationFor(src, mod = src.length) {
  if (!src.length || !mod) return 0
  const hex = src[0] || '#000000'
  let sum = 0
  for (let k = 1; k < hex.length; k++) sum += hex.charCodeAt(k)
  return sum % mod
}
function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}
function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
function linearToSrgb(c) { c = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, c * 255)) }
function cbrt(x) { return Math.sign(x) * Math.pow(Math.abs(x), 1 / 3) }
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
function oklabToRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
  return [
    linearToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ]
}
function pseudoNoise(x, y, t) {
  return (Math.sin(x * 1.3 + t) + Math.sin(y * 1.4 - t * 0.7) +
    Math.sin((x + y) * 0.9 + t * 1.1) + Math.sin((x - y) * 1.1 - t * 0.5)) / 4
}
const WOBBLE_PX = 2.2, WOBBLE_FLOW_SPEED = 0.6

// ── verbatim from api/palette.js (private helpers, not exported) ─────────
function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r, g, b
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const toHexB = v => Math.min(255, Math.max(0, Math.round(v * 255))).toString(16).padStart(2, '0')
  return '#' + toHexB(r + m) + toHexB(g + m) + toHexB(b + m)
}
function hexToHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  if (d === 0) return 0
  let h
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  return h < 0 ? h + 360 : h
}
function hexToChroma(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255
}
function hexToLightness(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255
}

// ── frame renderer + metrics (same as simulate-accent-blob.mjs) ─────────
function renderFrame(hexes, weights, tSec) {
  const rot = rotationFor(hexes, BLOB_PAIRS.length)
  const counts = allocateBlobCounts(weights)
  const colorByBlobIndex = assignColorsToPairs(counts, rot)
  const params = makeBlobParams()
  const oklabColors = hexes.map(h => rgbToOklab(hexToRgb(h)))
  const wobT = tSec * WOBBLE_FLOW_SPEED
  const blobs = params.map((p, i) => {
    const ci = colorByBlobIndex[i]
    const color = oklabColors[ci]
    return {
      cx: (p.baseX + p.xAmp * Math.sin(tSec * p.xFreq * Math.PI * 2 + p.xPhase)) * SW,
      cy: (p.baseY + p.yAmp * Math.sin(tSec * p.yFreq * Math.PI * 2 + p.yPhase)) * SH,
      r: p.radius * Math.max(SW, SH),
      ci, color,
      chroma: Math.sqrt(color[1] ** 2 + color[2] ** 2),
    }
  })
  const buf = Buffer.alloc(SW * SH * 3)
  const visMap = new Uint8Array(SW * SH)
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const wob = pseudoNoise(x * 0.15, y * 0.15, wobT) * WOBBLE_PX
      let wSum = 0, L = 0, aSum = 0, bSum = 0, chromaSum = 0
      for (const bl of blobs) {
        const dx = x - bl.cx, dy = y - bl.cy
        const d = Math.sqrt(dx * dx + dy * dy) + wob
        const dn = Math.max(0.02, d / bl.r)
        const w = 1 / Math.pow(dn, idwPower)
        wSum += w
        L += w * bl.color[0]
        aSum += w * bl.color[1]; bSum += w * bl.color[2]
        chromaSum += w * bl.chroma
      }
      L /= wSum
      const hue = Math.atan2(bSum, aSum)
      const C = chromaSum / wSum
      let a = C * Math.cos(hue), b = C * Math.sin(hue)
      a *= chromaScl; b *= chromaScl
      const [r, g, bb] = oklabToRgb([L, a, b])
      const idx = (y * SW + x)
      buf[idx * 3] = r; buf[idx * 3 + 1] = g; buf[idx * 3 + 2] = bb
      const hueOf = ok => Math.atan2(ok[2], ok[1])
      const dh = (h1, h2) => { let d2 = Math.abs(h1 - h2) % (2 * Math.PI); return d2 > Math.PI ? 2 * Math.PI - d2 : d2 }
      visMap[idx] = dh(hue, hueOf(oklabColors[oklabColors.length - 1])) < dh(hue, hueOf(oklabColors[0])) ? 1 : 0
    }
  }
  return { buf, visMap, counts, colorByBlobIndex }
}

function metrics(name, frame) {
  const { buf, visMap } = frame
  const n = visMap.length
  let visArea = 0
  for (let i = 0; i < n; i++) visArea += visMap[i]
  const okAt = i => rgbToOklab([buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]])
  let maxDE = 0, seamPx = 0, mudPx = 0
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW - 1; x++) {
    const i = y * SW + x
    const o1 = okAt(i), o2 = okAt(i + 1)
    const de = Math.hypot(o1[0] - o2[0], o1[1] - o2[1], o1[2] - o2[2])
    if (de > maxDE) maxDE = de
    if (de > 0.06) seamPx++
  }
  // mud halo: fraction of displayed pixels landing in the muddy-warm pocket
  // per api/palette.js's own exported uglyWeight (HSL h/c/l of the pixel).
  for (let i = 0; i < n; i++) {
    const hex = '#' + [buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
    if (uglyWeight(hexToHue(hex), hexToChroma(hex), hexToLightness(hex)) > 0.3) mudPx++
  }
  console.log(`${name}: accent-visible ${(visArea / n * 100).toFixed(1)}%, max dE ${maxDE.toFixed(3)}, seam px ${seamPx}, mud px ${(mudPx / n * 100).toFixed(1)}%`)
}

// ── 1. Fast Car end-to-end with the REAL shipped pickAccentHue ──────────
const RED = '#d72a1b'
const AVG_LUMA_CLAMPED = 0.3725 // measured for this cover in simulate-accent-blob.mjs
const ACCENT_SAT = 0.40
const baseHue = hexToHue(RED)
const accentHue = pickAccentHue(RED, ACCENT_SAT, AVG_LUMA_CLAMPED)
const accent = hslToHex(accentHue, ACCENT_SAT, AVG_LUMA_CLAMPED)
console.log(`Fast Car base ${RED} hue ${baseHue.toFixed(2)} -> pickAccentHue = ${accentHue.toFixed(2)} -> ${accent}`)
console.log('  (old shipped 180 accent was ~#397f85 teal)')
for (const t of [0, 3, 6]) metrics(`  OLD 180 teal   t=${t}`, renderFrame([RED, '#397f85'], [0.85, 0.15], t))
for (const t of [0, 3, 6]) metrics(`  NEW pickAccent t=${t}`, renderFrame([RED, accent], [0.85, 0.15], t))

// ── 2. Sign proof: the rejected green side for this base wears mud ──────
const rejected = hslToHex((baseHue + 120) % 360, ACCENT_SAT, AVG_LUMA_CLAMPED)
metrics(`  REJECTED green side ${rejected} t=3`, renderFrame([RED, rejected], [0.85, 0.15], 3))

// ── 3. Sweeps: accent never in pocket; OKLab separation pinned at ~120 ──
let maxPocket = 0, maxSep = 0, maxSepAt = -1, minSep = 360, minSepAt = -1
for (let h = 0; h < 360; h++) {
  const baseHex = hslToHex(h, 0.60, 0.45)
  const acc = pickAccentHue(baseHex, ACCENT_SAT, 0.3725)
  maxPocket = Math.max(maxPocket, warmPocketHueWeight(acc))
  const okB = rgbToOklab(hexToRgb(baseHex))
  const okA = rgbToOklab(hexToRgb(hslToHex(acc, ACCENT_SAT, 0.3725)))
  const hB = Math.atan2(okB[2], okB[1]), hA = Math.atan2(okA[2], okA[1])
  let d = Math.abs(hB - hA) * 180 / Math.PI % 360
  if (d > 180) d = 360 - d
  if (d > maxSep) { maxSep = d; maxSepAt = h }
  if (d < minSep) { minSep = d; minSepAt = h }
}
console.log(`sweep 0-359: max pocket weight of chosen accent = ${maxPocket}, OKLab separation range ${minSep.toFixed(1)} (base ${minSepAt}) - ${maxSep.toFixed(1)} deg (base ${maxSepAt})`)

// ── 3b. Render the OLD worst case (green base HSL 152 — under HSL-±120
// its accent sat 149.3 deg away in OKLab, 14-15 hard-seam px) with the
// OKLab-pinned accent, to confirm the seam is gone. ─────────────────────
{
  const base = hslToHex(152, 0.60, 0.45)
  const accH = pickAccentHue(base, ACCENT_SAT, 0.3725)
  const acc = hslToHex(accH, ACCENT_SAT, 0.3725)
  for (const t of [0, 3, 6]) metrics(`  GREEN-BASE h152 ${base} + accent h${accH} ${acc} t=${t}`, renderFrame([base, acc], [0.85, 0.15], t))
}

// ── 4. Regression: blob allocation unchanged for the other palette shapes ─
console.log('allocateBlobCounts([0.85,0.15]) =', allocateBlobCounts([0.85, 0.15]), '(single-hue+accent, expect [5,1])')
console.log('allocateBlobCounts([0.5,0.5])   =', allocateBlobCounts([0.5, 0.5]), '(true B&W, expect [3,3])')
console.log('allocateBlobCounts([0.191,0.762,0.048]) =', allocateBlobCounts([0.191, 0.762, 0.048]), '(real Rocketship post-merge weights)')
