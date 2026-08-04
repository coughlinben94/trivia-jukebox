// Seeded 2D value noise, used only for the two-pool boundary's organic
// wobble (see twoLightBlend.js's prepareTwoPoolField and GradientBackground's
// drawScene). Deliberately low-octave when called with oct<=2 -- a fine,
// multi-octave field breaks the boundary into many small islands instead of
// one flowing line (that's exactly what an earlier candidate got wrong, per
// the owner's "2 pools, not a marbled/mesh texture" correction).
export function makeFlowNoise2D(seed) {
  let s = seed >>> 0
  const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
  const perm = new Uint8Array(512)
  const p = Array.from({ length: 256 }, (_, i) => i)
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = p[i]; p[i] = p[j]; p[j] = tmp
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]
  const grad = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]]
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10)
  const lerp = (a, b, t) => a + (b - a) * t

  function noise(x, y) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255
    const xf = x - Math.floor(x), yf = y - Math.floor(y)
    const gradAt = (ix, iy) => grad[perm[(perm[ix & 255] + iy) & 255] & 7]
    const dot = (gv, gx, gy) => gv[0] * gx + gv[1] * gy
    const n00 = dot(gradAt(X, Y), xf, yf), n10 = dot(gradAt(X + 1, Y), xf - 1, yf)
    const n01 = dot(gradAt(X, Y + 1), xf, yf - 1), n11 = dot(gradAt(X + 1, Y + 1), xf - 1, yf - 1)
    const u = fade(xf), v = fade(yf)
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v)
  }

  function fbm(x, y, octaves = 2) {
    let value = 0, amp = 0.5, freq = 1
    for (let i = 0; i < octaves; i++) {
      value += amp * noise(x * freq, y * freq)
      freq *= 2
      amp *= 0.5
    }
    return value
  }

  return { noise, fbm }
}
