#!/usr/bin/env node
// Acceptance sim for the 2026-07-30 equal-split restore + displayed-mud
// guard (AlbumGradientMesh.jsx). Committed — unlike the session rigs
// simulate-blob-weights.mjs / simulate-accent-blob.mjs, which were never
// committed and are gone.
//
// Duplicates makeBlobParams()'s rng/antipodal formulas and draw()'s
// per-pixel math VERBATIM (source: AlbumGradientMesh.jsx — keep in sync by
// hand; the whole point is measuring what that file actually draws),
// including the output-stage mud guard from src/lib/mudModel.js (imported
// for real, not copied).
//
// Usage:
//   node scripts/simulate-mesh-restore.mjs                # embedded 8-cover set + refs
//   node scripts/simulate-mesh-restore.mjs <artId> [...]  # fetch live palettes by Spotify art id
//
// Criteria (per cover, 48x27 grid, 60 frames over 30s, T=50 dials:
// idw 3, chromaScale 0.82, orbitSpeed 1.265, radius 0.50):
//   MUD    PASS = zero post-guard pixels with uglyWeight > 0.5 at HSL
//          chroma >= 0.16, on every frame. (Pre-guard fraction reported.)
//   SHARE  PASS = every palette color's mean hue-vote frame share >= 0.05.
//          (Transient per-frame dips reported, not gated.)
//   SEAM   INFORMATIONAL ONLY. The ΔE_OK>0.12-anywhere gate was run against
//          calibration references on 2026-07-30 and INVALIDATED: the
//          accepted-good true-B&W duel measured 58/60 "sharp" frames and
//          the accepted Rocketship palette 59/60, while the actual Fast
//          Car standing-ring bug measured 7/60 — the metric fires on long
//          soft battle lines (the liked look) and misses small standing
//          rings. Sharpness stats are printed for trend-watching; the
//          binding seam judgment is visual (blur-composited render).
import { uglyWeight, mudRescue } from '../src/lib/mudModel.js'

const N = 6, WOB = 2.2, WFLOW = 0.6
const DIALS = { idw: 3, chroma: 0.82, speed: 1.265, size: 0.50 }

// ── verbatim renderer math ──────────────────────────────────────────────────
const rng = (i, s) => { const x = Math.sin((i * 7 + s) * 9301 + 49297) * 233280; return x - Math.floor(x) }
function makeBlobParams(speed, size) {
  const one = i => ({ bx: 0.10 + rng(i, 0) * 0.80, by: 0.10 + rng(i, 1) * 0.80,
    xf: speed / (10 + rng(i, 2) * 7), yf: speed / (10 + rng(i, 3) * 7),
    xp: rng(i, 4) * Math.PI * 2, yp: rng(i, 5) * Math.PI * 2, r: size + rng(i, 6) * 0.13 })
  return Array.from({ length: N }, (_, i) => {
    if (i % 2 === 0) return one(i)
    const p = one(i - 1)
    return { bx: 1 - p.bx, by: 1 - p.by, xf: p.xf, yf: p.yf, xp: p.xp + Math.PI, yp: p.yp + Math.PI, r: size + rng(i, 6) * 0.13 }
  })
}
const h2r = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const s2l = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
const cbr = x => Math.sign(x) * Math.pow(Math.abs(x), 1 / 3)
function rgbToOklab([r, g, b]) {
  r = s2l(r); g = s2l(g); b = s2l(b)
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const l_ = cbr(l), m_ = cbr(m), s_ = cbr(s)
  return [0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
          1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
          0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_]
}
const l2s = c => { c = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, c * 255)) }
function oklabToRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
  return [l2s(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
          l2s(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
          l2s(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s)]
}
const pnoise = (x, y, t) => (Math.sin(x * 1.3 + t) + Math.sin(y * 1.4 - t * 0.7) + Math.sin((x + y) * 0.9 + t * 1.1) + Math.sin((x - y) * 1.1 - t * 0.5)) / 4
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn, l = (mx + mn) / 2
  let h = 0
  if (c > 0) {
    if (mx === r) h = ((g - b) / c) % 6
    else if (mx === g) h = (b - r) / c + 2
    else h = (r - g) / c + 4
    h *= 60; if (h < 0) h += 360
  }
  return [h, c, l]
}
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2
  let r, g, b
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}
function rotationFor(src) {
  const hex = src[0] || '#000000'
  let s = 0
  for (let k = 1; k < hex.length; k++) s += hex.charCodeAt(k)
  return s % src.length
}

function sweep(name, src) {
  const P = makeBlobParams(DIALS.speed, DIALS.size), SW = 48, SH = 27
  const rot = rotationFor(src)
  const by = Array.from({ length: N }, (_, i) => (i + rot) % src.length)
  const oks = src.map(h => rgbToOklab(h2r(h)))
  const chrs = oks.map(c => Math.hypot(c[1], c[2]))
  const hues = oks.map(c => Math.atan2(c[2], c[1]))
  const dh = (u, v) => { let d = Math.abs(u - v) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d }
  const shSum = src.map(() => 0), shMin = src.map(() => 1)
  let F = 0, sharpFrames = 0, mudBeforeMax = 0, mudAfterMax = 0
  for (let T = 30; T < 60; T += 0.5) {
    const wobT = T * WFLOW
    const blobs = P.map((p, i) => ({
      cx: (p.bx + 0.33 * Math.sin(T * p.xf * Math.PI * 2 + p.xp)) * SW,
      cy: (p.by + 0.33 * Math.sin(T * p.yf * Math.PI * 2 + p.yp)) * SH,
      r: p.r * Math.max(SW, SH), ci: by[i] }))
    const px = new Array(SW * SH); const cnt = src.map(() => 0)
    let mudB = 0, mudA = 0
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
      const wob = pnoise(x * 0.15, y * 0.15, wobT) * WOB
      let wS = 0, L = 0, aS = 0, bS = 0, cS = 0
      for (const bl of blobs) {
        const dx = x - bl.cx, dy = y - bl.cy
        const d = Math.sqrt(dx * dx + dy * dy) + wob
        const dn = Math.max(0.02, d / bl.r), wt = 1 / Math.pow(dn, DIALS.idw)
        wS += wt; L += wt * oks[bl.ci][0]; aS += wt * oks[bl.ci][1]; bS += wt * oks[bl.ci][2]; cS += wt * chrs[bl.ci]
      }
      L /= wS
      const hue = Math.atan2(bS, aS), C = cS / wS
      let [r, g, bb] = oklabToRgb([L, C * Math.cos(hue) * DIALS.chroma, C * Math.sin(hue) * DIALS.chroma])
      {
        const mx = Math.max(r, g, bb) / 255, mn = Math.min(r, g, bb) / 255
        const chr = mx - mn, light = (mx + mn) / 2
        if (chr >= 0.16 && uglyWeight(rgbToHsl(r, g, bb)[0], chr, light) > 0.5) mudB++
        if (chr >= 0.10 && light > 0.13 && light < 0.65) {
          const [h] = rgbToHsl(r, g, bb)
          const d2 = 1 - Math.abs(2 * light - 1)
          const s = d2 > 0 ? Math.min(1, chr / d2) : 0
          const sP = mudRescue(h, chr, light)
          if (sP !== s) [r, g, bb] = hslToRgb(h, sP, light)
        }
        const mx2 = Math.max(r, g, bb) / 255, mn2 = Math.min(r, g, bb) / 255
        const chr2 = mx2 - mn2, li2 = (mx2 + mn2) / 2
        if (chr2 >= 0.16 && uglyWeight(rgbToHsl(r, g, bb)[0], chr2, li2) > 0.5) mudA++
      }
      px[y * SW + x] = rgbToOklab([r, g, bb])
      let best = 0, bd = 1e9
      for (let i = 0; i < src.length; i++) { const d = dh(hue, hues[i]); if (d < bd) { bd = d; best = i } }
      cnt[best]++
    }
    let sharp = false
    outer: for (let y = 0; y < SH; y++) for (let x = 0; x < SW - 1; x++) {
      const p1 = px[y * SW + x], p2 = px[y * SW + x + 1]
      if (Math.hypot(p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]) > 0.12) { sharp = true; break outer }
    }
    if (sharp) sharpFrames++
    mudBeforeMax = Math.max(mudBeforeMax, mudB / (SW * SH))
    mudAfterMax = Math.max(mudAfterMax, mudA / (SW * SH))
    for (let i = 0; i < src.length; i++) { const s = cnt[i] / (SW * SH); shSum[i] += s; shMin[i] = Math.min(shMin[i], s) }
    F++
  }
  const minMean = Math.min(...src.map((_, i) => shSum[i] / F))
  return {
    name,
    MUD: mudAfterMax === 0 ? 'PASS' : 'FAIL',
    mudBeforeMax: +mudBeforeMax.toFixed(3),
    SHARE: (src.length < 2 || minMean >= 0.05) ? 'PASS' : 'FAIL',
    minMeanShare: +minMean.toFixed(3),
    minFrameShare: +Math.min(...shMin).toFixed(3),
    seamSharpFrames_info: `${sharpFrames}/${F}`,
  }
}

// Embedded set: live pv=2 palettes captured 2026-07-30 (the night's named
// offenders + references), so the sim runs offline.
const EMBEDDED = [
  ['Secret Garden', ['#ea513f', '#8799cc']],
  ['Down (Jay Sean)', ['#8e4f49', '#a6b6d9']],
  ['Rocketship', ['#e89c00', '#1169b6', '#cc0000']],
  ['Fast Car', ['#d62b1a', '#394985']],
  ['Dance with Me', ['#824e11', '#6d429b']],
  ['June', ['#b06846', '#a7a6d9']],
  ['Free Ride', ['#da966a', '#5b429b']],
  ['Stay', ['#195786', '#a15636']],
  ['REF true-B&W duel', ['#2b7ca6', '#a65f2b']],
]

const args = process.argv.slice(2)
let covers = EMBEDDED
if (args.length) {
  covers = []
  for (const id of args) {
    const art = `https://i.scdn.co/image/${id}`
    const res = await fetch(`https://trivia-jukebox.vercel.app/api/palette?url=${encodeURIComponent(art)}&pv=4`)
    const j = await res.json()
    covers.push([id, j.colors])
  }
}
let fail = 0
for (const [name, colors] of covers) {
  const r = sweep(name, colors)
  if (r.MUD !== 'PASS' || r.SHARE !== 'PASS') fail++
  console.log(JSON.stringify(r))
}
console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILURES`)
process.exit(fail === 0 ? 0 : 1)
