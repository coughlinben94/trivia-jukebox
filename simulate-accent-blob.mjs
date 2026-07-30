// Diagnostic rig for the Fast Car (Black Pumas) isolated-accent-blob bug
// (2026-07-30). Renders REAL frames of AlbumGradientMesh.jsx's per-pixel
// blend (verbatim formulas: makeBlobParams rng/antipodal mirror, IDW
// dn = max(0.02, d/r), hue = atan2 of a/b weighted sum, chroma = scalar
// weighted mean, chromaScale 0.70) to PNG via sharp, plus quantitative
// metrics, for the live production palette ["#d72a1b","#397f85"],
// weights [0.85, 0.15]. Scratch script, same convention as
// simulate-blob-weights.mjs.
import sharp from 'sharp'

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

// ── hsl helper (verbatim from api/palette.js, for candidate accent hues) ──
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
  const toHex = v => Math.min(255, Math.max(0, Math.round(v * 255))).toString(16).padStart(2, '0')
  return '#' + toHex(r + m) + toHex(g + m) + toHex(b + m)
}

// ── frame renderer, parameterized so candidates plug in ─────────────────
// opts: { radiusScalePerColor: [..] (multiplies p.radius by color's factor) }
function renderFrame(hexes, weights, tSec, opts = {}) {
  const rot = rotationFor(hexes, BLOB_PAIRS.length)
  const counts = opts.countsOverride ?? allocateBlobCounts(weights)
  const colorByBlobIndex = assignColorsToPairs(counts, rot)
  const params = makeBlobParams()
  const oklabColors = hexes.map(h => rgbToOklab(hexToRgb(h)))
  const wobT = tSec * WOBBLE_FLOW_SPEED
  const blobs = params.map((p, i) => {
    const ci = colorByBlobIndex[i]
    const color = oklabColors[ci]
    const rScale = opts.radiusScalePerColor ? opts.radiusScalePerColor[ci] : 1
    return {
      cx: (p.baseX + p.xAmp * Math.sin(tSec * p.xFreq * Math.PI * 2 + p.xPhase)) * SW,
      cy: (p.baseY + p.yAmp * Math.sin(tSec * p.yFreq * Math.PI * 2 + p.yPhase)) * SH,
      r: p.radius * Math.max(SW, SH) * rScale,
      ci, color,
      chroma: Math.sqrt(color[1] ** 2 + color[2] ** 2),
    }
  })
  const buf = Buffer.alloc(SW * SH * 3)
  const shareMap = new Float64Array(SW * SH) // accent (color index 1+) share
  const visMap = new Uint8Array(SW * SH)     // displayed color closer to accent than base?
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const wob = pseudoNoise(x * 0.15, y * 0.15, wobT) * WOBBLE_PX
      let wSum = 0, L = 0, aSum = 0, bSum = 0, chromaSum = 0
      const perColorW = new Array(hexes.length).fill(0)
      for (const bl of blobs) {
        const dx = x - bl.cx, dy = y - bl.cy
        const d = Math.sqrt(dx * dx + dy * dy) + wob
        const dn = Math.max(0.02, d / bl.r)
        const w = 1 / Math.pow(dn, idwPower)
        wSum += w
        perColorW[bl.ci] += w
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
      // metrics: share of NON-dominant colors (index != 0)
      shareMap[idx] = 1 - perColorW[0] / wSum
      // displayed-pixel OKLab hue distance to base vs accent hue
      const hueOf = ok => Math.atan2(ok[2], ok[1])
      const dh = (h1, h2) => { let d = Math.abs(h1 - h2) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d }
      const baseH = hueOf(oklabColors[0]); const accH = hueOf(oklabColors[oklabColors.length - 1])
      visMap[idx] = dh(hue, accH) < dh(hue, baseH) ? 1 : 0
    }
  }
  return { buf, shareMap, visMap, counts, colorByBlobIndex, blobs }
}

async function savePng(buf, path) {
  // approximate the live pipeline: upscale to ~960x540 + gaussian blur.
  // canvas filter blur(24px) at ~1080p ~= sigma 12 at 1080p ~= sigma 6 at 540p.
  await sharp(buf, { raw: { width: SW, height: SH, channels: 3 } })
    .resize(960, 540, { kernel: 'cubic' })
    .blur(6)
    .png()
    .toFile(path)
}

function metrics(name, frame) {
  const { shareMap, visMap } = frame
  const n = shareMap.length
  let visArea = 0
  for (let i = 0; i < n; i++) visArea += visMap[i]
  // seam sharpness: max horizontal neighbor ΔE (OKLab distance of displayed
  // colors, pre-blur) and count of "seam" pixels (ΔE > 0.06/px)
  const { buf } = frame
  const okAt = i => rgbToOklab([buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]])
  let maxDE = 0, seamPx = 0
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW - 1; x++) {
    const i = y * SW + x
    const o1 = okAt(i), o2 = okAt(i + 1)
    const de = Math.hypot(o1[0] - o2[0], o1[1] - o2[1], o1[2] - o2[2])
    if (de > maxDE) maxDE = de
    if (de > 0.06) seamPx++
  }
  console.log(`${name}: accent-visible area ${(visArea / n * 100).toFixed(1)}%, max neighbor dE ${maxDE.toFixed(3)}, seam px (dE>0.06/px) ${seamPx}`)
}

// ── the real Fast Car case ───────────────────────────────────────────────
const RED = '#d72a1b', TEAL = '#397f85'
const okRed = rgbToOklab(hexToRgb(RED)), okTeal = rgbToOklab(hexToRgb(TEAL))
const chromaOf = ok => Math.sqrt(ok[1] ** 2 + ok[2] ** 2)
const hueDegOf = ok => (Math.atan2(ok[2], ok[1]) * 180 / Math.PI + 360) % 360
console.log(`RED  ${RED}: OKLab L=${okRed[0].toFixed(3)} C=${chromaOf(okRed).toFixed(3)} h=${hueDegOf(okRed).toFixed(1)}`)
console.log(`TEAL ${TEAL}: OKLab L=${okTeal[0].toFixed(3)} C=${chromaOf(okTeal).toFixed(3)} h=${hueDegOf(okTeal).toFixed(1)}`)
console.log('allocateBlobCounts([0.85,0.15]) =', allocateBlobCounts([0.85, 0.15]))
console.log('rotationFor([\'#d72a1b\',...], 3) =', rotationFor([RED, TEAL], 3))
console.log('colorByBlobIndex =', assignColorsToPairs(allocateBlobCounts([0.85, 0.15]), rotationFor([RED, TEAL], 3)))

const outDir = process.argv[2] || '.'
const T = [0, 3, 6]
for (const t of T) {
  const f = renderFrame([RED, TEAL], [0.85, 0.15], t)
  metrics(`baseline t=${t}`, f)
  await savePng(f.buf, `${outDir}/fastcar_baseline_t${t}.png`)
}

// ── candidate fixes ─────────────────────────────────────────────────────
// C: reduced accent hue offset (palette-side). base HSL hue 4.79, accent
// lightness clamp(avgLuma)=0.3725, sat 0.40 as shipped.
const BASE_H = 4.79, ACC_L = 0.3725, ACC_S = 0.40
for (const off of [165, 135, 120, -120, -100]) {
  const hex = hslToHex(((BASE_H + off) % 360 + 360) % 360, ACC_S, ACC_L)
  const ok = rgbToOklab(hexToRgb(hex))
  const f = renderFrame([RED, hex], [0.85, 0.15], 3)
  metrics(`C offset ${off} (${hex}, okC=${chromaOf(ok).toFixed(3)} okH=${hueDegOf(ok).toFixed(0)})`, f)
  await savePng(f.buf, `${outDir}/fastcar_C_off${off}.png`)
}
// B: chroma-matched accent at 180 (sat raised to 0.85)
{
  const hex = hslToHex((BASE_H + 180) % 360, 0.85, ACC_L)
  const ok = rgbToOklab(hexToRgb(hex))
  const f = renderFrame([RED, hex], [0.85, 0.15], 3)
  metrics(`B chroma-matched 180 (${hex}, okC=${chromaOf(ok).toFixed(3)})`, f)
  await savePng(f.buf, `${outDir}/fastcar_B_sat085.png`)
}
// A: accent radius x0.5
{
  const f = renderFrame([RED, TEAL], [0.85, 0.15], 3, { radiusScalePerColor: [1, 0.5] })
  metrics('A radius x0.5', f)
  await savePng(f.buf, `${outDir}/fastcar_A_r05.png`)
}
