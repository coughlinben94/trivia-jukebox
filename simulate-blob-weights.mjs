// Numeric simulation for AlbumGradientMesh.jsx's weight-proportional blob
// allocation (2026-07-30, Task 3 of docs/superpowers/plans/2026-07-30-weighted-palette.md).
//
// Scratch verification script (plain Node, `node simulate-blob-weights.mjs`,
// no build step) -- not committed as part of the AlbumGradientMesh.jsx
// change, same as the antipodal-pairing fix's own /tmp/blobs.mjs and
// /tmp/blobs2.mjs earlier today. Kept at the repo root (not /tmp) so it's
// easy to find again given the file's own comments cite its output.
//
// Copies makeBlobParams()'s rng/antipodal-mirror formulas and draw()'s IDW
// formula (dn = max(0.02, d/r); w = 1/dn^idwPower) verbatim, plus the real
// allocateBlobCounts()/assignColorsToPairs() allocation logic verbatim, to
// measure each color's actual per-instant frame share on the same 48x27
// tiny-canvas grid the live renderer draws at.

const NUM_BLOBS = 6
const SW = 48, SH = 27 // matches tinySizeRef's 48px-long-edge sizing for a 16:9 canvas

// Current gradientTuning.js defaults (T=50 on every dial -- no board overrides):
const speed = 1.265   // orbitSpeed()
const size  = 0.50    // blobRadius()
const idwPower = 2    // meshIdwPower()

function rng(i, slot) {
  const x = Math.sin((i * 7 + slot) * 9301 + 49297) * 233280
  return x - Math.floor(x)
}

function makeOne(i) {
  return {
    baseX:  0.10 + rng(i, 0) * 0.80,
    baseY:  0.10 + rng(i, 1) * 0.80,
    xAmp:   0.33,
    yAmp:   0.33,
    xFreq:  speed / (10 + rng(i, 2) * 7),
    yFreq:  speed / (10 + rng(i, 3) * 7),
    xPhase: rng(i, 4) * Math.PI * 2,
    yPhase: rng(i, 5) * Math.PI * 2,
    radius: size + rng(i, 6) * 0.13,
  }
}

function makeBlobParams() {
  return Array.from({ length: NUM_BLOBS }, (_, i) => {
    if (i % 2 === 0) return makeOne(i)
    const p = makeOne(i - 1)
    return {
      baseX:  1 - p.baseX,
      baseY:  1 - p.baseY,
      xAmp:   p.xAmp,
      yAmp:   p.yAmp,
      xFreq:  p.xFreq,
      yFreq:  p.yFreq,
      xPhase: p.xPhase + Math.PI,
      yPhase: p.yPhase + Math.PI,
      radius: size + rng(i, 6) * 0.13,
    }
  })
}

// ── Verbatim copy of AlbumGradientMesh.jsx's allocation logic ───────────

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
      for (let j = 0; j < n; j++) {
        if (counts[j] > 1 && (donor === -1 || counts[j] > counts[donor])) donor = j
      }
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
    for (let i = 0; i < n; i++) {
      if (remaining[i] > 0 && (a === -1 || remaining[i] > remaining[a])) a = i
    }
    remaining[a] -= 1
    let b = -1
    for (let i = 0; i < n; i++) {
      if (i !== a && remaining[i] > 0 && (b === -1 || remaining[i] > remaining[b])) b = i
    }
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

// ── Simulation ───────────────────────────────────────────────────────────

function runCase(name, weights, rotationSeed) {
  const counts = allocateBlobCounts(weights)
  const colorByBlobIndex = assignColorsToPairs(counts, rotationSeed)
  const blobParams = makeBlobParams()

  console.log(`\n=== ${name} ===`)
  console.log('weights:', weights)
  console.log('blob counts per color:', counts)
  console.log('color-by-blob-index:', colorByBlobIndex)

  const nColors = weights.length
  const perColorShareOverTime = Array.from({ length: nColors }, () => [])

  const DURATION_S = 10
  const DT = 0.1
  for (let t = 0; t <= DURATION_S; t += DT) {
    const blobs = blobParams.map((p, i) => ({
      cx: (p.baseX + p.xAmp * Math.sin(t * p.xFreq * Math.PI * 2 + p.xPhase)) * SW,
      cy: (p.baseY + p.yAmp * Math.sin(t * p.yFreq * Math.PI * 2 + p.yPhase)) * SH,
      r:  p.radius * Math.max(SW, SH),
      color: colorByBlobIndex[i],
    }))

    const colorSum = new Array(nColors).fill(0)
    let totalW = 0
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        let wSum = 0
        const wPerBlob = new Array(NUM_BLOBS)
        for (let i = 0; i < blobs.length; i++) {
          const bl = blobs[i]
          const dx = x - bl.cx, dy = y - bl.cy
          const d = Math.sqrt(dx * dx + dy * dy)
          const dn = Math.max(0.02, d / bl.r)
          const w = 1 / Math.pow(dn, idwPower)
          wPerBlob[i] = w
          wSum += w
        }
        for (let i = 0; i < blobs.length; i++) {
          colorSum[blobs[i].color] += wPerBlob[i]
        }
        totalW += wSum
      }
    }
    for (let c = 0; c < nColors; c++) {
      perColorShareOverTime[c].push(colorSum[c] / totalW)
    }
  }

  for (let c = 0; c < nColors; c++) {
    const series = perColorShareOverTime[c]
    const mean = series.reduce((s, v) => s + v, 0) / series.length
    const min = Math.min(...series)
    const max = Math.max(...series)
    console.log(`  color ${c} (weight ${weights[c].toFixed(3)}, blobs ${counts[c]}): mean share ${mean.toFixed(3)}, range [${min.toFixed(3)}, ${max.toFixed(3)}], swing ${(max - min).toFixed(3)}`)
  }
}

runCase('3-color case [0.6, 0.25, 0.15]', [0.6, 0.25, 0.15], 1)
runCase('2-color accent case [0.85, 0.15] (real buildWeights() shape)', [0.85, 0.15], 1)
runCase('True B&W fallback [0.5, 0.5]', [0.5, 0.5], 1)
runCase('Single-hue + accent [0.595, 0.255, 0.15]', [0.595, 0.255, 0.15], 1)

// Numerically confirms why the plan's literally-described "reserve 1 slot
// per color first, then apportion the rest" method was NOT used.
console.log('\n=== Comparison: literal "reserve 1 per color, apportion rest" for [0.85, 0.15] ===')
function reserveFirstAllocate(weights) {
  const n = weights.length
  const remaining = NUM_BLOBS - n
  const quotas = weights.map(w => w * remaining)
  const counts = quotas.map(Math.floor)
  const remainders = quotas.map((q, i) => q - counts[i])
  let leftover = remaining - counts.reduce((s, c) => s + c, 0)
  const order = weights.map((_, i) => i).sort((a, b) => remainders[b] - remainders[a])
  for (let k = 0; k < leftover; k++) counts[order[k]] += 1
  return counts.map(c => c + 1)
}
const rejected = reserveFirstAllocate([0.85, 0.15])
console.log('reserve-first counts:', rejected, '(vs. Hamilton-direct used in the actual fix:', allocateBlobCounts([0.85, 0.15]), ')')

// Real live case that just broke: Llunr's "Rocketship" (2026-07-30, later
// the same day) -- api/palette.js returned 5 colors that are really just 2
// hue families (2 near-duplicate blues + 2 near-duplicate oranges + a tiny
// red), weights [0.0953, 0.3809, 0.0475, 0.0953, 0.3809]. Reported live as a
// hard blue/orange SPLIT with a visible seam -- not the smooth "distinct
// bodies colliding" look. Test across multiple rotation seeds since
// rotationFor()'s actual value depends on the cover's hex string.
console.log('\n=== Rocketship (real live weights) -- reproducing the reported split ===')
for (const seed of [0, 1, 2]) {
  runCase(`Rocketship rot=${seed}`, [0.0953, 0.3809, 0.0475, 0.0953, 0.3809], seed)
}

// Frame-share alone can look fine while the SPATIAL STRUCTURE is a hard
// bisection (one color's whole territory on one side, another's on the
// opposite side, joined by a sharp seam) rather than genuinely intermixed.
// Measure each color's weighted CENTROID (mean x,y position, weighted by
// its own IDW contribution) over time, then check the correlation between
// the two heaviest colors' centroid positions -- strongly ANTI-correlated
// (one goes left when the other goes right, consistently) is the actual
// signature of "hard seam," regardless of what the raw share numbers say.
function centroidCase(name, weights, rotationSeed) {
  const counts = allocateBlobCounts(weights)
  const colorByBlobIndex = assignColorsToPairs(counts, rotationSeed)
  const blobParams = makeBlobParams()
  const nColors = weights.length
  const centroidX = Array.from({ length: nColors }, () => [])

  const DURATION_S = 10, DT = 0.1
  for (let t = 0; t <= DURATION_S; t += DT) {
    const blobs = blobParams.map((p, i) => ({
      cx: (p.baseX + p.xAmp * Math.sin(t * p.xFreq * Math.PI * 2 + p.xPhase)) * SW,
      cy: (p.baseY + p.yAmp * Math.sin(t * p.yFreq * Math.PI * 2 + p.yPhase)) * SH,
      r:  p.radius * Math.max(SW, SH),
      color: colorByBlobIndex[i],
    }))
    const wx = new Array(nColors).fill(0), wsum = new Array(nColors).fill(0)
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        for (let i = 0; i < blobs.length; i++) {
          const bl = blobs[i]
          const dx = x - bl.cx, dy = y - bl.cy
          const d = Math.sqrt(dx * dx + dy * dy)
          const dn = Math.max(0.02, d / bl.r)
          const w = 1 / Math.pow(dn, idwPower)
          wx[bl.color] += w * x
          wsum[bl.color] += w
        }
      }
    }
    for (let c = 0; c < nColors; c++) centroidX[c].push(wx[c] / wsum[c] / SW) // normalized 0-1
  }

  // Pearson correlation between the two heaviest colors' centroid-X series.
  const order = weights.map((_, i) => i).sort((a, b) => weights[b] - weights[a])
  const [c1, c2] = order
  const s1 = centroidX[c1], s2 = centroidX[c2]
  const mean = arr => arr.reduce((s, v) => s + v, 0) / arr.length
  const m1 = mean(s1), m2 = mean(s2)
  let cov = 0, v1 = 0, v2 = 0
  for (let i = 0; i < s1.length; i++) {
    cov += (s1[i] - m1) * (s2[i] - m2)
    v1 += (s1[i] - m1) ** 2
    v2 += (s2[i] - m2) ** 2
  }
  const corr = cov / Math.sqrt(v1 * v2)
  console.log(`  ${name}: centroid-X correlation between the 2 heaviest colors (${c1} & ${c2}) = ${corr.toFixed(3)} (near -1 = hard seam/bisection, near 0 = independent/intermixed)`)
}
console.log('\n=== Centroid anti-correlation check (hard-seam diagnostic) ===')
for (const seed of [0, 1, 2]) {
  centroidCase(`Rocketship rot=${seed}`, [0.0953, 0.3809, 0.0475, 0.0953, 0.3809], seed)
}
centroidCase('3-color [0.6,0.25,0.15] (previously verified good)', [0.6, 0.25, 0.15], 1)
centroidCase('True B&W [0.5,0.5] (previously verified good)', [0.5, 0.5], 1)
