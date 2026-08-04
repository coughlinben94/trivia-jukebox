# Gradient Background Rebuild (A1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live-screen animated gradient background's motion/blend engine (the 6-blob IDW mesh + its 3 layered hue-compatibility gates) with a simple, predictable 2-color "dancing lights" renderer that matches the owner's own plain-language spec, while keeping the parts of the current system that are proven and not the source of any live bug reports.

**Architecture:** Two moving radial light sources per song — one per picked color, each with its own ±10% lightness shade halo. Blended once, directly, in OKLab (no multi-body cancellation math). A brightened "white buffer" seam sits wherever the two lights meet at roughly equal strength. Song-to-song transitions crossfade the whole rendered frame (last look of song A dissolving into song B's live render), not individual hues — this removes the entire crossfade-hue-gate bug class (`resolveCrossfadeHex`, family parity, the 51° swing) by construction, because there is no per-hue morphing left to gate.

**Tech Stack:** React function components, Canvas2D (tiny offscreen canvas + CSS blur upscale — same trick as the old mesh, kept because it structurally guarantees no hard edges), vitest for pure-function unit tests, existing `api/palette.js` (Vercel serverless function, untouched except one constant).

---

## Why this shape, not a blank rewrite of everything

Read `src/components/AlbumGradientMesh.jsx` and `api/palette.js` before touching anything — both are full of hard-won, live-verified comments. Two things are true at once:

1. **`api/palette.js` (color extraction) is proven and NOT part of this rebuild.** It already does real work the owner's spec describes: picks the most vivid, most population-weighted colors, avoids "muddy" hues, and — critically — already has a black-cover fallback. Don't touch its median-cut, scoring, or hue-diversity logic.
2. **Every live bug report in this app's history (the hue "flip," the still-unverified dark-collision patch, "each screen has the same animations," the "fishy" ring artifact) traces to the motion/blend layer** — the 6-blob Inverse-Distance-Weighting system and the crossfade hue-gates built on top of it (`pickGradientColors`' tier system, `resolveCrossfadeHex`'s direct/swap/fallback logic). That's what's being thrown out here.

## One concrete bug found in `api/palette.js` to fix while you're in there

The owner's spec: *"for black albums, take the neon purple or pink as a primary color, i dont want black in the background anywhere."*

`api/palette.js`'s true-B&W branch (search for `mostVivid < 0.15`) currently hardcodes:
```js
const accentHues = [200, 20];
colors = accentHues.map(h => hslToHex(h, 0.65, Math.min(0.75, Math.max(0.38, avgLuma))));
```
That's a fixed cool-blue / warm-orange complementary pair — not purple/pink. This is the one line in `api/palette.js` this plan touches. See Task 1.

---

## File structure

**Delete:**
- `src/components/AlbumGradient.jsx` (circle-blobs engine, superseded)
- `src/components/AlbumGradientMesh.jsx` (6-blob IDW mesh engine — the one with every bug report)
- `src/components/AlbumGradientNoise.jsx` (retired WebGL "lava lamp" engine, already dead code)
- `src/components/AlbumCoverBloom.jsx` (abandoned real-photo engine, owner explicitly moved off this direction)
- `src/test/glowSeam.test.js`, `src/test/stabilizeChroma.test.js`, `src/test/resolveCrossfadeHex.test.js`, `src/test/coverBloomDirection.test.js`, `src/test/gradientColor.test.js` (all test the code being deleted)

**Create:**
- `src/lib/twoLightBlend.js` — pure functions: given 2 hex colors + weights + a time value, return the per-pixel OKLab blend for a tiny canvas, including the white-seam brighten. No DOM, no React — fully unit-testable.
- `src/test/twoLightBlend.test.js`
- `src/components/GradientBackground.jsx` — the new (and only) renderer component. Same prop contract LiveScreen already passes today: `colors, weights, nextColors, nextWeights, active, shuffleKey, entranceActive, artUrl, nextArtUrl`.

**Modify:**
- `src/components/LiveScreen.jsx` — remove `getGradientEngine()`/the 3-way engine flag, point `GradientBg` straight at `GradientBackground`. Simplify `pickGradientColors` to always return exactly 2 colors (see Task 4) and add the black-avoidance safety net (Task 3).
- `src/lib/gradientTuning.js` — repoint the `BLEND`/`DEPTH`/`CROSSFADE` dials at the new renderer's constants; drop or repurpose `MOTION`/`SIZE` (they tuned blob orbit specifics that no longer exist in the same form — 2 lights still need a speed/size dial, just simpler math underneath).
- `src/components/TuningBoard.jsx` — update the `exportSnippet` paste-target comment (currently points at `AlbumGradient.jsx` / `AlbumGradientMesh.jsx`).
- `api/palette.js` — the one-line `accentHues` fix (Task 1).

---

### Task 1: Fix the black-album accent hue in `api/palette.js`

**Files:**
- Modify: `api/palette.js` (search for `const accentHues = [200, 20]`)
- Test: `src/test/palette.test.js` (existing file — add one case)

- [ ] **Step 1: Write the failing test**

Open `src/test/palette.test.js`, find how it already tests the monochrome branch (search for `mostVivid` or `accentHues` in that file to match existing patterns), and add:

```js
it('picks a neon purple/pink pair for a true black-and-white cover, never blue/orange', () => {
  // hslToHex(h, s, l) is already imported/used elsewhere in this file —
  // match its existing import path.
  const result = pickMonochromeAccentHues() // see Step 3 for why this helper needs to exist
  const [hueA, hueB] = result
  // Purple/pink band: roughly 270-340 degrees. Reject anything in the old
  // blue (200) or orange (20) neighborhood.
  for (const h of [hueA, hueB]) {
    expect(h).toBeGreaterThanOrEqual(270)
    expect(h).toBeLessThanOrEqual(340)
  }
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npx vitest run src/test/palette.test.js`
Expected: FAIL — `pickMonochromeAccentHues is not a function` (it doesn't exist yet).

- [ ] **Step 3: Extract and fix the constant**

In `api/palette.js`, find:
```js
const accentHues = [200, 20];
colors = accentHues.map(h => hslToHex(h, 0.65, Math.min(0.75, Math.max(0.38, avgLuma))));
```
Replace with an exported, testable function plus the new hues:
```js
// Owner spec (2026-08-04): "for black albums, take the neon purple or pink
// as a primary color, i dont want black in the background anywhere." The
// old fixed pair here (200/20, blue/orange) predates that spec and never
// matched it -- this is the one true-grayscale-cover fallback in the whole
// file, so it's the only place a hardcoded hue choice like this makes
// sense. 300 (magenta-purple) and 330 (hot pink) are 30deg apart -- close
// enough to read as one family (matches the "neon purple OR pink" framing,
// not "pick one arbitrarily and hope"), far enough to still have visible
// gradient motion between them.
export function pickMonochromeAccentHues() {
  return [300, 330];
}
const accentHues = pickMonochromeAccentHues();
colors = accentHues.map(h => hslToHex(h, 0.65, Math.min(0.75, Math.max(0.38, avgLuma))));
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `npx vitest run src/test/palette.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/palette.js src/test/palette.test.js
git commit -m "palette: fix black-album fallback to neon purple/pink (was blue/orange)

Owner spec: for black albums, take neon purple or pink, never black.
The true-grayscale branch's fixed accent pair predated that spec."
```

---

### Task 2: Build the pure 2-light OKLab blend math

**Files:**
- Create: `src/lib/twoLightBlend.js`
- Test: `src/test/twoLightBlend.test.js`

This is the核心 of the rebuild. Keep it framework-free (no canvas, no React) so it's fast to test and easy to reason about. `AlbumGradientMesh.jsx` already has working `rgbToOklab`/`oklabToRgb` conversions and a `hexToRgb` helper — read those before writing new ones; port the math, don't reinvent it.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest'
import { blendTwoLights, mixWithSeam } from '../lib/twoLightBlend.js'

describe('blendTwoLights', () => {
  it('returns colorA exactly at distance 0 from light A, full distance from light B', () => {
    const result = blendTwoLights({
      hexA: '#ff0000', hexB: '#0000ff',
      distA: 0, distB: 1,
    })
    expect(result).toBe('#ff0000')
  })

  it('returns colorB exactly at distance 0 from light B, full distance from light A', () => {
    const result = blendTwoLights({
      hexA: '#ff0000', hexB: '#0000ff',
      distA: 1, distB: 0,
    })
    expect(result).toBe('#0000ff')
  })

  it('brightens toward the seam color at the midpoint between two hue-distant lights', () => {
    // Red and blue are hue-distant (roughly 120-150deg apart in OKLab).
    // At the exact midpoint (distA === distB), the seam should read
    // noticeably brighter than a naive 50/50 OKLab lerp would.
    const naiveLerpL = 0.5 // rough: average of red/blue OKLab L is near this
    const result = blendTwoLights({ hexA: '#ff0000', hexB: '#0000ff', distA: 0.5, distB: 0.5 })
    const L = oklabLFromHex(result)
    expect(L).toBeGreaterThan(naiveLerpL)
  })

  it('never produces a fully black pixel when neither input color is black', () => {
    const result = blendTwoLights({ hexA: '#330000', hexB: '#000033', distA: 0.5, distB: 0.5 })
    expect(result).not.toBe('#000000')
  })
})

describe('mixWithSeam', () => {
  it('is monotonic -- moving distA/distB together toward equal never produces a chroma INCREASE then a hue swap', () => {
    // Sweep from fully-A to fully-B and confirm no frame-to-frame hue
    // reversal -- this is the specific failure class (the "flip") the old
    // mesh's chroma floor caused. With only 2 lights and a direct lerp,
    // there is no third competing direction to cancel against, so this
    // should hold by construction -- this test is what proves it.
    let prevHue = null
    for (let t = 0; t <= 1; t += 0.05) {
      const hex = blendTwoLights({ hexA: '#09b3e1', hexB: '#ec3b6f', distA: t, distB: 1 - t })
      const hue = oklabHueFromHex(hex)
      if (prevHue !== null) {
        const jump = Math.abs(hue - prevHue)
        expect(Math.min(jump, 360 - jump)).toBeLessThan(20) // no single-step jump above 20deg
      }
      prevHue = hue
    }
  })
})

// Test-local helpers -- mirror whatever rgbToOklab/hexToRgb you port into
// twoLightBlend.js so these assertions can inspect L/hue directly.
function oklabLFromHex(hex) { /* same conversion as twoLightBlend.js uses internally */ }
function oklabHueFromHex(hex) { /* same conversion as twoLightBlend.js uses internally */ }
```

Fill in `oklabLFromHex`/`oklabHueFromHex` by importing the same conversion helpers you export from `twoLightBlend.js` in Step 3 (export `rgbToOklab`/`hexToRgb` alongside the main functions specifically so the test file can use them directly instead of duplicating the math).

- [ ] **Step 2: Run tests, confirm they fail**

Run: `npx vitest run src/test/twoLightBlend.test.js`
Expected: FAIL — `twoLightBlend.js` doesn't exist yet.

- [ ] **Step 3: Implement `src/lib/twoLightBlend.js`**

```js
// Two-light OKLab blend -- the entire color-mixing core of the A1 gradient
// rebuild (2026-08-04). Replaces AlbumGradientMesh.jsx's 6-blob
// Inverse-Distance-Weighting system, which is where every recurring bug in
// this app's gradient history lived: the hue "flip" at cancellation points,
// an unverified dark-collision report, motion that turned out to be
// identical every song, and layered crossfade hue-gates needed only because
// multiple independently-blending bodies could disagree with each other.
//
// With exactly 2 lights and one direct OKLab lerp, there is no third
// competing direction to cancel against -- the "flip" failure mode cannot
// occur by construction, not just by tuning. See the monotonic-hue test in
// twoLightBlend.test.js for the proof.

const GLOW_DELTA_L = 0.28 // matches the old glowSeam's owner-approved feel

export function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

function rgbToHex(r, g, b) {
  const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

// Standard sRGB -> OKLab (Bjorn Ottosson). Ported from
// AlbumGradientMesh.jsx's rgbToOklab -- same matrix, so results match the
// rest of the app exactly.
export function rgbToOklab([r, g, b]) {
  const toLinear = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b)
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s)
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
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  const toSrgb = c => { c = Math.max(0, Math.min(1, c)); return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055 }
  return [toSrgb(lr) * 255, toSrgb(lg) * 255, toSrgb(lb) * 255]
}

// distA/distB: normalized 0-1 "how close is this pixel to light A / light
// B" (0 = at the light's center, 1 = at its outer edge or beyond). Weight
// each light inversely by distance -- NOT full Shepard's-method IDW across
// many bodies, just a simple 2-body normalized blend, so weights always sum
// to 1 and there's no "neither light nearby" gap case.
export function blendTwoLights({ hexA, hexB, distA, distB }) {
  const wA_raw = 1 / (distA + 0.001)
  const wB_raw = 1 / (distB + 0.001)
  const sum = wA_raw + wB_raw
  const wA = wA_raw / sum, wB = wB_raw / sum

  const [La, aA, bA] = rgbToOklab(hexToRgb(hexA))
  const [Lb, aB, bB] = rgbToOklab(hexToRgb(hexB))

  let L = La * wA + Lb * wB
  let a = aA * wA + aB * wB
  let b = bA * wA + bB * wB

  ;[L, a, b] = applySeamGlow(L, a, b, wA, wB)

  const [r, g, bl] = oklabToRgb([L, a, b])
  return rgbToHex(r, g, bl)
}

// White-buffer seam: as wA and wB approach equal (the two lights "meeting"
// evenly), OKLab's a/b sum can partially cancel toward gray when the two
// hues are far apart -- real, wanted desaturation, not a bug. Ported
// principle from the old AlbumGradientMesh.jsx glowSeam(): brighten
// LIGHTNESS toward a soft glow as chroma collapses, rather than trying to
// rescue/boost the (unstable, at true cancellation) hue direction. Unlike
// the old mesh, there is only ONE seam here (2 lights, not 6 blobs voting),
// so this never needs the multi-body noise guard the old floor did.
export function applySeamGlow(L, a, b, wA, wB) {
  const balance = 1 - Math.abs(wA - wB) // 0 at fully one light, 1 at perfect 50/50
  const eased = balance * balance * (3 - 2 * balance) // smoothstep
  const chroma = Math.hypot(a, b)
  const suppressed = chroma * (1 - eased * 0.6) // never fully zero -- keep some hue at the seam
  const scale = chroma > 1e-9 ? suppressed / chroma : 0
  const Lglow = Math.min(1, L + GLOW_DELTA_L)
  const Lout = L + (Lglow - L) * eased
  return [Lout, a * scale, b * scale]
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npx vitest run src/test/twoLightBlend.test.js`
Expected: PASS. If the monotonic-hue test fails, print the actual hue sequence (`console.log`) and check `applySeamGlow`'s `eased * 0.6` suppression factor -- it may need to go higher (closer to 1) to fully kill hue noise right at the 50/50 point.

- [ ] **Step 5: Commit**

```bash
git add src/lib/twoLightBlend.js src/test/twoLightBlend.test.js
git commit -m "gradient: add pure 2-light OKLab blend (A1 rebuild core)

Replaces the 6-blob IDW system's color math with a direct 2-body OKLab
lerp plus a white-buffer seam glow. No multi-body cancellation is
possible with only 2 lights, so the historical hue-flip bug cannot
occur here by construction -- see the monotonic-hue test."
```

---

### Task 3: Simplify `pickGradientColors` to always return exactly 2, with black-avoidance

**Files:**
- Modify: `src/components/LiveScreen.jsx` (search for `export function pickGradientColors`)
- Test: `src/test/pickGradientColors.test.js` (existing file)

The owner's spec: *"take the two prettiest colors from the album art... for black albums, take the neon purple or pink as a primary color... i can manually pick the secondary color if needed."*

`api/palette.js` already keeps colors out of true-black territory for whole-cover-is-grayscale cases (Task 1 fixed its hue). But `pickGradientColors` runs client-side on whatever `api/palette.js` returns, and a cover can return a real (non-monochrome-fallback) palette where `colors[0]` itself is still very dark (e.g. a photo with one small bright logo and everything else near-black) -- add a floor here as the last line of defense so the RENDERED background is never near-black, regardless of what the palette said.

- [ ] **Step 1: Write the failing test**

Add to `src/test/pickGradientColors.test.js` (match its existing import/setup style):

```js
it('substitutes a neon pink for a near-black top color instead of rendering black', () => {
  const colors = ['#0a0a0a', '#3355ff'] // near-black "top" color
  const weights = [0.7, 0.3]
  const result = pickGradientColors(colors, weights)
  expect(result.colors[0]).not.toBe('#0a0a0a')
  // Should be a real, visible color, not another near-black.
  const [r, g, b] = [1, 3, 5].map(() => 0) // placeholder, replace with a real luma check:
  const hex = result.colors[0]
  const luma = 0.299 * parseInt(hex.slice(1,3),16) + 0.587*parseInt(hex.slice(3,5),16) + 0.114*parseInt(hex.slice(5,7),16)
  expect(luma).toBeGreaterThan(60)
})
```

- [ ] **Step 2: Run test, confirm it fails**

Run: `npx vitest run src/test/pickGradientColors.test.js`
Expected: FAIL (current code has no luma floor).

- [ ] **Step 3: Add the floor to `pickGradientColors`**

In `src/components/LiveScreen.jsx`, find `export function pickGradientColors(colors, weights) {` and add a substitution pass immediately after the existing partner-selection logic, before the function returns:

```js
// Never-black safety net (owner spec, 2026-08-04): "i dont want black in
// the background anywhere." api/palette.js already keeps a whole-cover
// grayscale fallback out of true black (see pickMonochromeAccentHues), but
// a cover can still hand this function a real, non-fallback top color
// that's individually near-black (a mostly-dark photo with one small
// bright accent). This is the last line of defense before render.
const BLACK_LUMA_FLOOR = 60 // 0-255 scale; #0a0a0a is luma ~10
const NEON_PINK = '#ff2fb0'
function luma(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16)
  return 0.299*r + 0.587*g + 0.114*b
}
function avoidBlack(hex) {
  return luma(hex) < BLACK_LUMA_FLOOR ? NEON_PINK : hex
}
```

Then wrap every `colors:` array in the function's existing return statements with `.map(avoidBlack)`. There are 2 return points in the current implementation (the `partner === -1` single-color fallback, and the final 2-color return) -- apply it to both.

- [ ] **Step 4: Run test, confirm it passes**

Run: `npx vitest run src/test/pickGradientColors.test.js`
Expected: PASS, and confirm the FULL suite for this file still passes (existing tests shouldn't have assumed near-black colors anywhere -- if one did, it was testing an unwanted behavior and should be updated, not this fix reverted).

- [ ] **Step 5: Commit**

```bash
git add src/components/LiveScreen.jsx src/test/pickGradientColors.test.js
git commit -m "gradient: never render a near-black picked color

Owner spec: no black in the background, ever. api/palette.js already
avoids this for whole-cover grayscale; this is the client-side floor
for a real (non-fallback) but individually near-black top color."
```

---

### Task 4: Build `GradientBackground.jsx` -- the new renderer component

**Files:**
- Create: `src/components/GradientBackground.jsx`
- Test: manual (visual) -- this component is a canvas/RAF loop, not unit-testable the way `twoLightBlend.js` is. Rely on `twoLightBlend.test.js` for the math and a live check (Task 6) for the render.

- [ ] **Step 1: Scaffold the component shape**

Match `AlbumGradientMesh.jsx`'s existing prop contract exactly so `LiveScreen.jsx`'s call site doesn't need to change (Task 5 just swaps which component `GradientBg` points to):

```jsx
import { useEffect, useRef, useMemo } from 'react'
import { blendTwoLights } from '../lib/twoLightBlend.js'
import { blendDurationMs } from '../lib/gradientTuning.js'

// Two moving light sources, one per picked color. Each light drifts along
// its own independent, per-song-seeded sine path (see makeLightParams
// below) -- "seeded per song" specifically to fix the historical bug where
// AlbumGradientMesh's blob motion turned out to be byte-identical every
// single shuffle (a dead seed parameter -- see git history if curious).
const TINY_SIZE = 48

function makeLightParams(seedKey) {
  function rng(slot) {
    const x = Math.sin((slot + 1) * 12.9898 + seedKey * 78.233) * 43758.5453
    return x - Math.floor(x)
  }
  function oneLight(offset) {
    return {
      baseX: 0.25 + rng(offset + 0) * 0.5,
      baseY: 0.25 + rng(offset + 1) * 0.5,
      ampX: 0.28, ampY: 0.28,
      freqX: 0.06 + rng(offset + 2) * 0.03,
      freqY: 0.05 + rng(offset + 3) * 0.03,
      phaseX: rng(offset + 4) * Math.PI * 2,
      phaseY: rng(offset + 5) * Math.PI * 2,
      radius: 0.55 + rng(offset + 6) * 0.15,
    }
  }
  return [oneLight(0), oneLight(10)]
}

export default function GradientBackground({
  colors = [], nextColors = [], active = true, shuffleKey = 0,
  entranceActive = false, artUrl, nextArtUrl,
}) {
  const canvasRef = useRef(null)
  const smallCanvasRef = useRef(null)
  const rafRef = useRef(null)
  const mountedRef = useRef(true)
  const lightParams = useMemo(() => makeLightParams(shuffleKey), [shuffleKey])

  // Whole-frame crossfade state: instead of morphing individual hues
  // between songs (the old resolveCrossfadeHex approach and its entire bug
  // class), keep the OUTGOING song's own colors/lights running on a second
  // hidden tiny canvas and cross-dissolve the two canvases' opacity over
  // blendDurationMs(). This is simpler and structurally cannot produce a
  // cross-family hue jump, because no hue ever gets morphed -- only alpha.
  const prevColorsRef = useRef(colors)
  const blendStartRef = useRef(-1)
  const isFirstColors = useRef(true)

  useEffect(() => {
    if (isFirstColors.current) { isFirstColors.current = false; return }
    prevColorsRef.current = prevColorsRef.current // frozen at old value for the crossfade
    blendStartRef.current = performance.now()
  }, [colors])

  useEffect(() => {
    mountedRef.current = true
    const canvas = canvasRef.current
    const small = smallCanvasRef.current
    if (!canvas || !small) return
    small.width = TINY_SIZE; small.height = TINY_SIZE
    const smallCtx = small.getContext('2d')
    const ctx = canvas.getContext('2d')

    function resize() {
      canvas.width = canvas.clientWidth
      canvas.height = canvas.clientHeight
    }
    resize()
    window.addEventListener('resize', resize)

    function draw(ts) {
      if (!mountedRef.current) return
      const t = ts / 1000
      const [hexA, hexB] = colors.length >= 2 ? colors : [colors[0] ?? '#333333', colors[0] ?? '#333333']

      const img = smallCtx.createImageData(TINY_SIZE, TINY_SIZE)
      for (let y = 0; y < TINY_SIZE; y++) {
        for (let x = 0; x < TINY_SIZE; x++) {
          const nx = x / TINY_SIZE, ny = y / TINY_SIZE
          const [lightA, lightB] = lightParams
          const ax = lightA.baseX + Math.sin(t * lightA.freqX + lightA.phaseX) * lightA.ampX
          const ay = lightA.baseY + Math.sin(t * lightA.freqY + lightA.phaseY) * lightA.ampY
          const bx = lightB.baseX + Math.sin(t * lightB.freqX + lightB.phaseX) * lightB.ampX
          const by = lightB.baseY + Math.sin(t * lightB.freqY + lightB.phaseY) * lightB.ampY
          const distA = Math.hypot(nx - ax, ny - ay) / lightA.radius
          const distB = Math.hypot(nx - bx, ny - by) / lightB.radius
          const hex = blendTwoLights({ hexA, hexB, distA, distB })
          const idx = (y * TINY_SIZE + x) * 4
          img.data[idx]   = parseInt(hex.slice(1,3),16)
          img.data[idx+1] = parseInt(hex.slice(3,5),16)
          img.data[idx+2] = parseInt(hex.slice(5,7),16)
          img.data[idx+3] = 255
        }
      }
      smallCtx.putImageData(img, 0, 0)
      ctx.imageSmoothingEnabled = true
      ctx.filter = 'blur(18px)'
      ctx.drawImage(small, 0, 0, canvas.width, canvas.height)
      ctx.filter = 'none'

      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)

    return () => {
      mountedRef.current = false
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(rafRef.current)
    }
  }, [lightParams, colors])

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 0, overflow: 'hidden', background: '#000' }}>
      <canvas ref={smallCanvasRef} style={{ display: 'none' }} />
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
    </div>
  )
}
```

This scaffold intentionally does NOT yet implement the whole-frame crossfade animation (it just resets instantly on a `colors` change) -- that's Step 2.

- [ ] **Step 2: Implement the whole-frame crossfade**

Add a second, identical draw pass for `prevColorsRef.current`'s lights onto a second small/blur canvas, and cross-dissolve via CSS opacity over `blendDurationMs()`. Concretely: render TWO `<canvas>` overlays absolutely positioned on top of each other (old song's render, new song's render), and animate the NEW one's opacity from 0 to 1 over `blendDurationMs()` starting at `blendStartRef.current`, while the OLD one fades 1 to 0 on the same schedule. Once the fade completes (checked each frame against `performance.now() - blendStartRef.current >= blendDurationMs()`), stop rendering the old canvas entirely (skip its draw loop) to save the extra per-frame cost.

- [ ] **Step 3: Wire the black entrance curtain**

Port the existing black overlay from `LiveScreen.jsx` (search for "Entrance black-out" -- it's a sibling `<div>`, not part of the old `AlbumGradientMesh.jsx`) -- **no change needed here**, it already lives in `LiveScreen.jsx` itself and will keep working unchanged once `GradientBg` points at this new component, since it's a sibling overlay, not something the renderer itself needs to know about.

- [ ] **Step 4: Commit**

```bash
git add src/components/GradientBackground.jsx
git commit -m "gradient: add GradientBackground -- 2-light renderer (A1 rebuild)

New renderer replacing the 6-blob mesh. Same prop contract as the old
engines so LiveScreen's call site barely changes. Whole-frame crossfade
between songs instead of per-hue morphing."
```

---

### Task 5: Wire `LiveScreen.jsx` to the new renderer and delete the old ones

**Files:**
- Modify: `src/components/LiveScreen.jsx`
- Delete: `src/components/AlbumGradient.jsx`, `src/components/AlbumGradientMesh.jsx`, `src/components/AlbumGradientNoise.jsx`, `src/components/AlbumCoverBloom.jsx`
- Delete: `src/test/glowSeam.test.js`, `src/test/stabilizeChroma.test.js`, `src/test/resolveCrossfadeHex.test.js`, `src/test/coverBloomDirection.test.js`, `src/test/gradientColor.test.js`

- [ ] **Step 1: Swap the import and remove the engine-flag branching**

In `LiveScreen.jsx`, find:
```js
const [gradientEngine] = useState(getGradientEngine)
const GradientBg = gradientEngine === 'bloom' ? AlbumCoverBloom
  : gradientEngine === 'circles' ? AlbumGradient
  : AlbumGradientMesh
```
Replace with:
```js
import GradientBackground from './GradientBackground.jsx'
// ...
const GradientBg = GradientBackground
```
Remove the now-unused `getGradientEngine`, `AlbumGradient`, `AlbumCoverBloom` imports at the top of the file.

- [ ] **Step 2: Delete the old renderer files and their tests**

```bash
rm src/components/AlbumGradient.jsx src/components/AlbumGradientMesh.jsx src/components/AlbumGradientNoise.jsx src/components/AlbumCoverBloom.jsx
rm src/test/glowSeam.test.js src/test/stabilizeChroma.test.js src/test/resolveCrossfadeHex.test.js src/test/coverBloomDirection.test.js src/test/gradientColor.test.js
```

- [ ] **Step 3: Run the full test suite, fix any remaining import errors**

Run: `npx vitest run`
Expected: any failure here will be a leftover import of a deleted file (e.g. `TestScreen.jsx` or `TuningBoard.jsx` may still reference `AlbumGradient`/`AlbumGradientMesh` directly). Grep for the deleted filenames across `src/` and fix each reference:

```bash
grep -rl "AlbumGradient\b\|AlbumGradientMesh\|AlbumGradientNoise\|AlbumCoverBloom" src/
```

- [ ] **Step 4: Run the full test suite again, confirm clean pass**

Run: `npx vitest run`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "gradient: wire LiveScreen to GradientBackground, delete old engines

Removes AlbumGradient.jsx (circle-blobs), AlbumGradientMesh.jsx (6-blob
IDW mesh -- source of every recurring gradient bug report), 
AlbumGradientNoise.jsx (already-retired WebGL engine), and
AlbumCoverBloom.jsx (abandoned real-photo direction). LiveScreen now
always renders GradientBackground -- no more engine flag."
```

---

### Task 6: Live verification

**Files:** none (manual check against the deployed app, per this repo's own testing constraints)

This repo's CLAUDE.md is explicit: local dev is broken on Vite 8, and Playwright can't get past Spotify OAuth. Test against the real deployed URL.

- [ ] **Step 1: Deploy**

```bash
git push
```
Vercel auto-deploys on push -- no separate deploy command (per this repo's CLAUDE.md).

- [ ] **Step 2: Manually check, on `trivia-jukebox.vercel.app`**

- Hit shuffle. Confirm: black curtain, then colors drift in (the entrance behavior is unchanged by this rebuild -- if it looks different, something in `LiveScreen.jsx`'s entrance effect got disturbed by Task 5's edits, check the diff).
- Skip through at least 5 songs. For each: confirm 2 real colors from that song's actual cover (spot-check by eye against the album art shown), a visible white-ish seam where they meet, no black anywhere in the background, and motion that's clearly NOT identical between songs (confirms the seed fix in `makeLightParams`).
- Specifically load a known black-and-white cover (any of the "true B&W" covers referenced in `api/palette.js`'s comments, e.g. search recent live reports for one) and confirm the background reads as neon purple/pink, never black or blue/orange.
- Watch one full song-to-song transition closely: confirm it reads as the OLD look fading out while the NEW look fades in (whole-frame crossfade), not a hue morphing through intermediate colors.

- [ ] **Step 3: Report back**

Note anything that doesn't match the above with a screenshot or specific description -- do not mark this task done on your own judgment call alone; the owner has been burned before by fixes claimed without live verification (see this app's git history for repeated examples). Get explicit owner confirmation before considering the rebuild complete.

---

## Self-review notes (for whoever executes this plan)

- **Spec coverage:** "2 prettiest colors + white buffer" -> Task 2/4. "Black albums -> neon purple/pink" -> Task 1 (whole-cover case) + Task 3 (per-color safety net). "10% either way shade" -> NOT YET a task above; the `oneLight` radius/lightness-halo needs an explicit ±10% lightness variant baked in during Task 4 Step 1 if it isn't obviously already covered by the OKLab blend's natural falloff -- check this live in Task 6 and add a follow-up task if the shade band isn't reading as ±10%. "Dancing" motion -> Task 4's sine-driven light drift. "Next song's palette takes over just before it swoops in" -> this plan assumes the existing `nextColors`/`onUpcomingTrack` plumbing in `LiveScreen.jsx` (unchanged by this plan) already triggers the crossfade at the right moment; confirm this live in Task 6 rather than assuming.
- **Known gap:** the ±10% shade-fan detail is the least specified part of this plan. Treat Task 4 as a starting point for that specific value, not a locked number -- tune it live against real album art the same way `DEPTH` was tuned in the old system.
