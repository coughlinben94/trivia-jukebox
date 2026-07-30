// v2: replaces the "fill full-pairs first" assignColorsToPairs with a
// greedy round-robin (largest-remaining-first, prefer a DIFFERENT color
// for the arena's second slot, falling back to same-color only when no
// other color has anything left). Investigating whether this fixes a
// regression found in v1 for the true-B&W (equal weight) case.

const NUM_BLOBS = 6
const SW = 48, SH = 27
const speed = 1.265, size = 0.50, idwPower = 2

function rng(i, slot) {
  const x = Math.sin((i * 7 + slot) * 9301 + 49297) * 233280
  return x - Math.floor(x)
}
function makeOne(i) {
  return {
    baseX: 0.10 + rng(i,0)*0.80, baseY: 0.10 + rng(i,1)*0.80,
    xAmp: 0.33, yAmp: 0.33,
    xFreq: speed/(10+rng(i,2)*7), yFreq: speed/(10+rng(i,3)*7),
    xPhase: rng(i,4)*Math.PI*2, yPhase: rng(i,5)*Math.PI*2,
    radius: size + rng(i,6)*0.13,
  }
}
function makeBlobParams() {
  return Array.from({ length: NUM_BLOBS }, (_, i) => {
    if (i % 2 === 0) return makeOne(i)
    const p = makeOne(i - 1)
    return { baseX: 1-p.baseX, baseY: 1-p.baseY, xAmp: p.xAmp, yAmp: p.yAmp,
      xFreq: p.xFreq, yFreq: p.yFreq, xPhase: p.xPhase+Math.PI, yPhase: p.yPhase+Math.PI,
      radius: size + rng(i,6)*0.13 }
  })
}

function allocateBlobCounts(weights) {
  const n = weights.length
  if (n === 0) return []
  if (n === 1) return [NUM_BLOBS]
  const quotas = weights.map(w => w * NUM_BLOBS)
  const counts = quotas.map(Math.floor)
  const remainders = quotas.map((q, i) => q - counts[i])
  let leftover = NUM_BLOBS - counts.reduce((s, c) => s + c, 0)
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

const BLOB_PAIRS = [[0,1],[2,3],[4,5]]

// NEW: greedy round-robin arena assignment
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

function runCase(name, weights, rotationSeed) {
  const counts = allocateBlobCounts(weights)
  const colorByBlobIndex = assignColorsToPairs(counts, rotationSeed)
  const blobParams = makeBlobParams()
  console.log(`\n=== ${name} ===`)
  console.log('weights:', weights, 'counts:', counts, 'color-by-blob-index:', colorByBlobIndex)
  const nColors = weights.length
  const series = Array.from({ length: nColors }, () => [])
  const DURATION_S = 10, DT = 0.1
  for (let t = 0; t <= DURATION_S; t += DT) {
    const blobs = blobParams.map((p, i) => ({
      cx: (p.baseX + p.xAmp*Math.sin(t*p.xFreq*Math.PI*2+p.xPhase))*SW,
      cy: (p.baseY + p.yAmp*Math.sin(t*p.yFreq*Math.PI*2+p.yPhase))*SH,
      r: p.radius*Math.max(SW,SH), color: colorByBlobIndex[i],
    }))
    const colorSum = new Array(nColors).fill(0)
    let totalW = 0
    for (let y=0;y<SH;y++) for (let x=0;x<SW;x++) {
      let wSum = 0
      const wPerBlob = new Array(NUM_BLOBS)
      for (let i=0;i<blobs.length;i++) {
        const bl = blobs[i]
        const dx=x-bl.cx, dy=y-bl.cy
        const d = Math.sqrt(dx*dx+dy*dy)
        const dn = Math.max(0.02, d/bl.r)
        const w = 1/Math.pow(dn, idwPower)
        wPerBlob[i]=w; wSum+=w
      }
      for (let i=0;i<blobs.length;i++) colorSum[blobs[i].color]+=wPerBlob[i]
      totalW += wSum
    }
    for (let c=0;c<nColors;c++) series[c].push(colorSum[c]/totalW)
  }
  for (let c=0;c<nColors;c++) {
    const s = series[c]
    const mean = s.reduce((a,b)=>a+b,0)/s.length
    const min = Math.min(...s), max = Math.max(...s)
    console.log(`  color ${c} (weight ${weights[c].toFixed(3)}, blobs ${counts[c]}): mean ${mean.toFixed(3)}, range [${min.toFixed(3)}, ${max.toFixed(3)}], swing ${(max-min).toFixed(3)}`)
  }
}

runCase('3-color [0.6, 0.25, 0.15]', [0.6, 0.25, 0.15], 1)
runCase('2-color accent [0.85, 0.15]', [0.85, 0.15], 1)
runCase('True B&W [0.5, 0.5]', [0.5, 0.5], 1)
runCase('Single-hue+accent [0.595, 0.255, 0.15]', [0.595, 0.255, 0.15], 1)
