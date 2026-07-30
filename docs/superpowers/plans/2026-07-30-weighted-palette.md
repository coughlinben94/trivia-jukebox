# Weighted Palette (population-aware color extraction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the root cause behind three real live-cover mismatches today (Miles On It, Dance with Me, 1990something) — `api/palette.js` ranks candidate colors by vividness (chroma) alone with no sense of how much of the cover a color actually covers, and the client's `pickGradientColors` then truncates the server's already-computed list down to 2-3 colors regardless of how many real, distinct hues survived. Both stages discard real color information; neither has any concept of "how much."

**Architecture:** Thread bucket population (pixel count) through `medianCut` → candidate ranking → final output as a `weights` array parallel to `colors` (same order, normalized to sum 1). Client passes weights straight through and stops hard-truncating to 2-3 — it now only caps at the render budget (`NUM_BLOBS`, 6), and even then sorts by weight so the least-significant colors are the ones dropped, not an arbitrary index cut. Renderer allocates blob count/size per color proportional to weight instead of an equal `i % length` split, so a synthetic accent color can finally be "small" instead of structurally guaranteed a third of the frame.

**Tech Stack:** Node/Vercel serverless function (`api/palette.js`, uses `sharp`), React client (`src/hooks/usePalette.js`, `src/components/LiveScreen.jsx`), Canvas2D renderer (`src/components/AlbumGradientMesh.jsx`).

**Calibration evidence (already gathered, see chat history):** Live-extracted real bucket data for Sub-Radio's "1990something" cover showed the actual dominant color (a salmon/pink background, two buckets each covering 12.5% of sampled pixels, `popRel: 0.5`) ranked 7th-8th by pure chroma, behind a small 6.3%-of-image yellow patch (`popRel: 0.25`, chroma 0.902) that won the "top color" slot purely on vividness. A population-dampened score (`oldScore * (0.5 + 0.5 * sqrt(popRel))`) keeps CHROMA_FLOOR as the primary gate (a boring gray background still can't win — it fails the floor before population ever applies) while correctly promoting large-but-less-vivid regions enough to compete for top ranking order. Verified this doesn't flip the yellow/coral cases that were already correct — it only re-orders ties/near-ties toward the more area-dominant candidate.

---

### Task 1: `api/palette.js` — population weight through extraction + scoring + response

**Files:**
- Modify: `api/palette.js:438-477` (`medianCut`), `api/palette.js:63-101` (candidate ranking), `api/palette.js:132-235` (vivid pick + padding), `api/palette.js:287-414` (monochrome/single-hue fallback branches), `api/palette.js:416-420` (response)
- Test: `api/palette.test.js` (new — pure-function unit tests, no network/sharp dependency)

- [ ] **Step 1: Write failing tests for the new pure population/scoring helpers**

Create `api/palette.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { populationFactor, buildWeights } from './palette.js'

describe('populationFactor', () => {
  it('returns 1.0 at popRel=1 (the largest bucket)', () => {
    expect(populationFactor(1)).toBeCloseTo(1.0, 5)
  })
  it('returns 0.5 at popRel=0 (a vanishingly small bucket)', () => {
    expect(populationFactor(0)).toBeCloseTo(0.5, 5)
  })
  it('is monotonically increasing', () => {
    expect(populationFactor(0.25)).toBeLessThan(populationFactor(0.5))
    expect(populationFactor(0.5)).toBeLessThan(populationFactor(1))
  })
  it('never lets population alone beat a real vividness gap -- a chroma-0.9 color at popRel 0.25 still outranks a chroma-0.45 color at popRel 1.0', () => {
    const vivid  = 0.902 * populationFactor(0.25) // real 1990something yellow
    const dominant = 0.494 * populationFactor(1.0) // real 1990something teal
    expect(vivid).toBeGreaterThan(dominant)
  })
})

describe('buildWeights', () => {
  it('normalizes population shares to sum to 1', () => {
    const w = buildWeights([{ population: 3 }, { population: 1 }])
    expect(w[0]).toBeCloseTo(0.75, 5)
    expect(w[1]).toBeCloseTo(0.25, 5)
    expect(w[0] + w[1]).toBeCloseTo(1, 5)
  })
  it('gives a synthetic (population=null) entry a fixed small weight, real entries split the remainder proportionally', () => {
    const w = buildWeights([{ population: 900 }, { population: 100 }, { population: null }])
    // synthetic gets ACCENT_WEIGHT (0.15), the two real entries split the
    // remaining 0.85 in their 900:100 (9:1) ratio
    expect(w[2]).toBeCloseTo(0.15, 5)
    expect(w[0]).toBeCloseTo(0.85 * 0.9, 5)
    expect(w[1]).toBeCloseTo(0.85 * 0.1, 5)
    expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 5)
  })
  it('splits evenly when every entry is synthetic (true B&W fallback, no real population at all)', () => {
    const w = buildWeights([{ population: null }, { population: null }])
    expect(w[0]).toBeCloseTo(0.5, 5)
    expect(w[1]).toBeCloseTo(0.5, 5)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Projects/baynes-trivia/trivia-jukebox && npx vitest run api/palette.test.js`
Expected: FAIL — `populationFactor` and `buildWeights` are not exported (don't exist yet).

- [ ] **Step 3: `medianCut` returns population alongside hex**

Replace `api/palette.js:469-477`:

```js
  // Represent each bucket by its single most VIVID pixel, not the bucket
  // average. This was the real bug behind flat/muted backgrounds on covers
  // like a mostly-skin-tone photo with a small colored logo: median-cut
  // splits by pixel-value range, so it keeps re-splitting the large neutral
  // region instead of isolating the small saturated one — a real pink logo
  // or blue background patch ends up sharing a bucket with a lot of tan
  // skin, and averaging that bucket blends the color away to nothing.
  // Picking the most chromatic pixel keeps it intact. Verified against a
  // live album cover: averaging returned 5 shades of tan/gray (max chroma
  // 0.10); this returns real pink/teal/orange (chroma up to 0.71).
  //
  // Also returns `population` (bucket.length, i.e. how many of the ~7500
  // sampled pixels landed in this bucket) alongside the hex. This was
  // previously discarded entirely once medianCut returned — the single
  // biggest architectural gap found in the 2026-07-30 root-cause review:
  // every candidate was ranked by vividness alone with zero sense of how
  // much of the cover it actually represents, which is why a small vivid
  // accent could out-rank a large muted background that a viewer would
  // call "the cover's real color." See populationFactor()/buildWeights()
  // below for what consumes this.
  return buckets.map(bucket => {
    let best = bucket[0], bestChroma = -1;
    for (const p of bucket) {
      const c = pixelChroma(p);
      if (c > bestChroma) { bestChroma = c; best = p; }
    }
    return { hex: toHex(best[0], best[1], best[2]), population: bucket.length };
  });
```

- [ ] **Step 4: Add `populationFactor` and thread population through candidate ranking + scoring**

Add near the top of the "Color helpers" section (after `hexToChroma`, before `hexToLuma`, `api/palette.js:502`):

```js
// Dampens population's effect on sort order so a large boring bucket can't
// win purely on size — CHROMA_FLOOR (below) still gates real color first;
// this only re-orders candidates that already cleared it. sqrt compresses
// the dynamic range (a bucket 4x bigger than another gets only 2x the
// factor, not 4x) so a modestly-larger muted region can't bury a smaller
// genuinely vivid one. Range 0.5 (smallest bucket) to 1.0 (largest) means
// population can at most HALVE a candidate's score, never zero it out or
// let it alone create a top pick from nothing -- chroma still has to be
// real to begin with. Calibrated 2026-07-30 against live extraction data
// from Sub-Radio's "1990something": the cover's actual dominant salmon-pink
// background (two buckets, each 12.5% of sampled pixels, popRel 0.5) was
// ranked 7th-8th by chroma alone, behind a 6.3%-of-image yellow patch
// (popRel 0.25, chroma 0.902) — this factor promotes the dominant color
// enough to compete for the top ranking slot without letting population
// override a real vividness gap (see palette.test.js).
export function populationFactor(popRel) {
  return 0.5 + 0.5 * Math.sqrt(Math.max(0, Math.min(1, popRel)));
}
```

Then update the ranking map (`api/palette.js:64-87`) to compute and carry population through:

```js
    const candidates = medianCut(source, 12);
    const maxPopulation = Math.max(...candidates.map(c => c.population));
    const ranked = candidates
      .map(({ hex, population }) => {
        const rawChroma = hexToChroma(hex);
        const rawHue = hexToHue(hex);
        const rawLightness = hexToLightness(hex);
        // Recolor (not just discount) anything in the "ugly olive/khaki"
        // pocket — see deuglify() below. Everything downstream (score,
        // hue-gap dedup, the final output hex) operates on the RECOLORED
        // values; only `rawChroma` survives separately, because the
        // monochrome-fallback check further down must judge the art's real
        // vividness, not a color this function invented.
        const { hue, chroma, lightness, hex: displayHex } =
          deuglify(rawHue, rawChroma, rawLightness, hex);
        const popRel = maxPopulation > 0 ? population / maxPopulation : 0;
        // `score` (not `chroma`) drives sort order below — see uglyPenalty()
        // and populationFactor() above.
        return {
          hex: displayHex,
          chroma,
          hue,
          lightness,
          rawChroma,
          luma: hexToLuma(hex),
          population,
          popRel,
          score: chroma * uglyPenalty(hue, chroma, lightness) * populationFactor(popRel),
        };
      })
```

(The rest of the `ranked` pipeline — `.filter(luma >= LUMA_THRESHOLD)`, `.sort((a,b) => b.score - a.score)` — is unchanged; it already sorts on `.score`.)

- [ ] **Step 5: Add `buildWeights` and call it for every path that produces a final `colors` array**

Add next to `populationFactor`:

```js
// Builds a normalized (sum=1) weight per final output color, for the
// renderer to allocate blob count/size proportionally instead of an equal
// split. `entries` is an array of { population } -- population is the real
// bucket pixel-count for a color that came from `ranked`, or `null` for a
// synthetic color (the monochrome/single-hue-accent fallbacks below, which
// have no real bucket to measure). Synthetic entries each get a fixed
// ACCENT_WEIGHT share; the real entries split what's left, proportional to
// their own population. If EVERY entry is synthetic (the true-B&W fallback,
// exactly 2 fixed hues, nothing real behind either), there's nothing to be
// proportional to -- split evenly instead of collapsing to a divide-by-zero.
const ACCENT_WEIGHT = 0.15;
export function buildWeights(entries) {
  const real = entries.filter(e => e.population != null);
  const synthetic = entries.filter(e => e.population == null);
  if (!real.length) {
    const even = 1 / entries.length;
    return entries.map(() => even);
  }
  const totalReal = real.reduce((s, e) => s + e.population, 0);
  const realBudget = synthetic.length ? 1 - ACCENT_WEIGHT * synthetic.length : 1;
  return entries.map(e =>
    e.population == null ? ACCENT_WEIGHT : realBudget * (e.population / totalReal)
  );
}
```

Now wire it into the two places `colors` is finalized:

1. Normal path (no monochrome fallback) — right after the padding block ends (`api/palette.js:235`, just before the `mostVivid`/`hueSpread` monochrome check), add:

```js
    // `colors` is real (vivid picks + padding), so every entry has a real
    // population from `ranked` -- look each one up by hex to carry it
    // through. (The monochrome/single-hue branches below build their own
    // `weights` directly, since they mix in synthetic colors that were
    // never in `ranked` to begin with.)
    const byHex = new Map(ranked.map(c => [c.hex, c]));
    let weights = buildWeights(colors.map(hex => ({ population: byHex.get(hex)?.population ?? null })));
```

2. True-B&W branch (`api/palette.js:331-332`), right after `colors = accentHues.map(...)`:

```js
        weights = buildWeights(colors.map(() => ({ population: null })));
```

3. Single-real-hue + accent branch (`api/palette.js:412`), right after `colors = [colors[0], colors[1], accent, ...colors.slice(2, 4)].filter(Boolean);`:

```js
        weights = buildWeights(colors.map(hex =>
          hex === accent ? { population: null } : { population: byHex.get(hex)?.population ?? null }
        ));
```

- [ ] **Step 6: Return `weights` in the response**

Replace `api/palette.js:420`:

```js
    return res.status(200).json({ colors, weights });
```

- [ ] **Step 7: Run the unit tests**

Run: `cd ~/Projects/baynes-trivia/trivia-jukebox && npx vitest run api/palette.test.js`
Expected: PASS (all 6 tests)

- [ ] **Step 8: Syntax-verify the whole file (vitest can't exercise the `sharp`/network path in this sandbox)**

Run: `cd ~/Projects/baynes-trivia/trivia-jukebox && node --check api/palette.js`
Expected: no output (clean parse)

- [ ] **Step 9: Commit**

```bash
cd ~/Projects/baynes-trivia/trivia-jukebox
for f in .git/*.lock; do [ -e "$f" ] && mv "$f" "$f.bak_$(date +%s%N)"; done
git add api/palette.js api/palette.test.js
git commit -m "palette.js: thread bucket population through to a weights array

Root cause of today's Miles On It / Dance with Me / 1990something
mismatches, per the 2026-07-30 deep-debug review: candidates were ranked
by vividness (chroma) alone, with population (how much of the cover a
color actually covers) discarded at medianCut and never recovered. A
small vivid patch could outrank a large muted region that's obviously
'the cover's color' to a viewer -- verified live on 1990something, where
the actual dominant salmon-pink background (two buckets, 12.5% of the
image each) ranked 7th-8th behind a 6.3%-of-image yellow patch.

populationFactor() dampens (sqrt) population's effect on sort order so it
can re-rank close calls but never manufacture a top pick from a boring
bucket alone -- CHROMA_FLOOR still gates real color first. buildWeights()
produces a normalized per-color weight (real colors proportional to their
bucket population; synthetic monochrome-fallback colors get a fixed small
share) for the renderer to use instead of an equal per-color blob split."
```

---

### Task 2: Client wiring — `usePalette.js` + `LiveScreen.jsx` drop the 2/3 cap

**Files:**
- Modify: `src/hooks/usePalette.js` (whole file, currently 69 lines)
- Modify: `src/components/LiveScreen.jsx:89-123` (`pickGradientColors` and its two callers)

- [ ] **Step 1: `usePalette` returns `{ colors, weights }` instead of a bare `colors` array**

Replace the whole file:

```js
import { useState, useEffect, useRef } from 'react';
import { paletteQuery } from '../lib/gradientTuning.js';

const cache = new Map();

// Fallback while a palette is loading/fails — near-black, all gradient
// components cycle through whatever-length array is given so this doesn't
// need to match either gradient's exact color count. Equal weights since
// there's no real data to weight by.
const FALLBACK_COLORS = ['#080808', '#080808', '#080808', '#080808', '#080808'];
const FALLBACK = { colors: FALLBACK_COLORS, weights: FALLBACK_COLORS.map(() => 0.2) };

// Cache key includes the tuning query so a VARIETY-overridden fetch never
// collides with (or overwrites) the default-palette entry for the same art.
const cacheKey = (url) => url + paletteQuery();

// Older cached/fetched responses (or a stale deploy mid-rollout) may not
// carry `weights` yet — fall back to an even split rather than crashing
// downstream consumers that expect `weights.length === colors.length`.
function normalize(data) {
  const colors = data.colors;
  const weights = Array.isArray(data.weights) && data.weights.length === colors.length
    ? data.weights
    : colors.map(() => 1 / colors.length);
  return { colors, weights };
}

// Warm the cache ahead of need (e.g. the upcoming song's art the moment the
// current song starts) so the fade-out blend gets a cache hit and the full
// encroachment window, instead of losing it to a cold serverless fetch.
export function prefetchPalette(albumArtUrl) {
  if (!albumArtUrl) return;
  const key = cacheKey(albumArtUrl)
  if (cache.has(key)) return;
  fetch(`/api/palette?url=${encodeURIComponent(albumArtUrl)}${paletteQuery()}`)
    .then(r => r.json())
    .then(data => {
      if (data.colors?.length >= 2) cache.set(key, normalize(data));
    })
    .catch(() => {});
}

export function usePalette(albumArtUrl) {
  const [palette, setPalette] = useState(FALLBACK);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!albumArtUrl) return;
    const key = cacheKey(albumArtUrl)

    if (cache.has(key)) {
      setPalette(cache.get(key));
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPalette(FALLBACK);

    fetch(`/api/palette?url=${encodeURIComponent(albumArtUrl)}${paletteQuery()}`, {
      signal: controller.signal,
    })
      .then(r => r.json())
      .then(data => {
        if (data.colors?.length >= 2) {
          const p = normalize(data);
          cache.set(key, p);
          setPalette(p);
        }
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          console.warn('[usePalette] falling back to defaults:', err.message);
        }
      });

    return () => controller.abort();
  }, [albumArtUrl, paletteQuery()]);

  return palette;
}
```

- [ ] **Step 2: Find every `usePalette(` call site and update destructuring**

Run: `cd ~/Projects/baynes-trivia/trivia-jukebox && grep -rn "usePalette(" src/`

For each call site currently doing `const paletteColorsFull = usePalette(...)` (or similarly named), change to destructure `{ colors, weights }` — exact variable names depend on what's found; keep whatever naming convention the surrounding code already uses (e.g. `paletteColorsFull` → `{ colors: paletteColorsFull, weights: paletteWeightsFull }`).

- [ ] **Step 3: Rewrite `pickGradientColors` to use weights instead of a 2/3 hue-distance cap**

Replace `src/components/LiveScreen.jsx:89-123` (everything from the `abPlaneDist` comment block through the end of `pickGradientColors`):

```js
// Weight-based selection (2026-07-30, replaces the 2-colors-3-max cap).
// Per the deep-debug root-cause review: capping to 2-3 regardless of how
// many real distinct colors palette.js found was itself the core bug on
// covers like Sub-Radio's "1990something" -- the server correctly extracted
// 5 genuinely distinct hues (yellow/teal/coral/purple/pink), and this
// function threw 3 of them away every time, because the old rule only ever
// reached past index 2 when the top 2 were "too close." Busy, colorful
// covers -- the ones a cap like that should matter LEAST for -- got hit
// EVERY time; a live scan found every cover with 3+ real color families
// got clipped to 2, while the "reach for a 3rd" trigger only ever fired on
// covers that already had 2 or fewer.
//
// Now that api/palette.js returns a real `weights` array (population-
// derived, see buildWeights() there), there's no need to guess how many
// colors are "safe" to show — pass all of them through, sorted by weight
// so the least-significant colors are what gets dropped if there are more
// colors than the mesh has blobs to represent (NUM_BLOBS, 6 -- importing
// the renderer's own constant here would create a circular import between
// LiveScreen and AlbumGradientMesh, so it's duplicated as MAX_GRADIENT_COLORS;
// keep both in sync if NUM_BLOBS ever changes).
const MAX_GRADIENT_COLORS = 6;
function pickGradientColors(colors, weights) {
  if (colors.length <= MAX_GRADIENT_COLORS) return { colors, weights };
  const paired = colors.map((hex, i) => [hex, weights[i]]).sort((a, b) => b[1] - a[1]);
  const top = paired.slice(0, MAX_GRADIENT_COLORS);
  const keptWeight = top.reduce((s, [, w]) => s + w, 0);
  return {
    colors: top.map(([hex]) => hex),
    // Renormalize so the kept colors' weights still sum to 1 after dropping
    // the tail -- otherwise a heavily-truncated palette (8 colors -> 6)
    // would hand the renderer weights that only sum to ~0.9, silently
    // shrinking every blob instead of the dropped colors' share going to
    // the ones that survived.
    weights: top.map(([, w]) => w / keptWeight),
  };
}
```

- [ ] **Step 4: Update `pickGradientColors` call sites**

Find the two call sites (`paletteColors`/`upcomingPaletteColors`, built via `useMemo`). Replace with:

```js
const palette         = useMemo(() => pickGradientColors(paletteColorsFull, paletteWeightsFull), [paletteColorsFull, paletteWeightsFull])
const upcomingPalette  = useMemo(() => pickGradientColors(upcomingPaletteColorsFull, upcomingPaletteWeightsFull), [upcomingPaletteColorsFull, upcomingPaletteWeightsFull])
```

(Keep the `useMemo` wrapper — see the existing comment a few lines above about why: `AlbumGradientMesh`'s blend-trigger `useEffect`s key off `[colors]`/`[nextColors]` by reference, and a fresh array every render would restart the crossfade continuously.)

Update every prop passed down to `<AlbumGradient>`/`<AlbumGradientMesh>` from `colors={paletteColors}` to `colors={palette.colors} weights={palette.weights}` (and the `next`-prefixed equivalents for `upcomingPalette`).

- [ ] **Step 5: Syntax-verify**

Run: `cd ~/Projects/baynes-trivia/trivia-jukebox && npx esbuild --loader:.jsx=jsx src/components/LiveScreen.jsx --outfile=/tmp/ls-check.js && npx esbuild --loader:.js=js src/hooks/usePalette.js --outfile=/tmp/up-check.js`
Expected: both print a "Done in Xms" success line, no errors.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/baynes-trivia/trivia-jukebox
for f in .git/*.lock; do [ -e "$f" ] && mv "$f" "$f.bak_$(date +%s%N)"; done
git add src/hooks/usePalette.js src/components/LiveScreen.jsx
git commit -m "LiveScreen/usePalette: drop the 2/3 color cap, pass weights through

pickGradientColors no longer truncates to 2-3 colors by a hue/OKLab
distance test -- it passes all of palette.js's real diverse picks through,
only capping at MAX_GRADIENT_COLORS (6, matching the mesh's blob count) by
DROPPING THE LOWEST-WEIGHT colors, not an arbitrary index cut. usePalette
now returns { colors, weights } instead of a bare colors array."
```

---

### Task 3: `AlbumGradientMesh.jsx` — weight-proportional blob allocation

**Files:**
- Modify: `src/components/AlbumGradientMesh.jsx` (blob-to-color assignment; the existing antipodal-pairing `makeBlobParams()` and the `oklabColors[i % oklabColors.length]` per-frame color lookup)

**Context for whoever implements this (subagent or otherwise):** Today, earlier in this same session, `makeBlobParams()` was rewritten so blob `i` and blob `i+1` (for even `i`) are forced into exact antipodal (mirror-through-center, phase-shifted-by-π) pairs — this fixed a bug where 6 blobs cycling through colors via `i % colors.length` left color dominance to chance (measured swinging 0.29-0.72 mean frame-share with zero prop change). Colors are currently assigned to blobs via `oklabColors[i % oklabColors.length]` (search for this in the file) — with the antipodal pairing, every color that appears gets an equal 2-of-6 (or similar even split) blob share by construction, regardless of how visually important that color actually is. That equal-weight assumption is what turned a "just one small accent color" (the single-real-hue fallback in `api/palette.js`) into a fully competing, equally-weighted color once the antipodal fix made its share stable instead of lucky — reported live as "the exact lava lamp thing" on Orleans' "Dance with Me."

Task 2 above makes `colors` and a parallel `weights` array (summing to 1) available as props. This task's job: assign blobs to colors proportional to `weights` instead of equal `i % length`, while KEEPING antipodal pairing's balance guarantee for whichever colors DO share a blob pair (i.e. don't reintroduce the "left to chance" bug this session already fixed once).

- [ ] **Step 1: Find the exact current color-assignment code**

Run: `cd ~/Projects/baynes-trivia/trivia-jukebox && grep -n "oklabColors\[i % oklabColors.length\]\|NUM_BLOBS\|makeBlobParams" src/components/AlbumGradientMesh.jsx`

Read the surrounding ~30 lines above and below each match before changing anything — this file has several interacting pieces (`makeBlobParams()`'s antipodal pairing, `rotationFor()`'s per-cover hue rotation, the per-frame `oklabColors[i % oklabColors.length]` lookup in the draw loop) that all need to keep agreeing with each other after this change.

- [ ] **Step 2: Design and implement weight-proportional blob allocation**

Requirements (verify your own implementation against all of these before moving on):
1. Given `weights` (sums to 1, length = number of colors, up to 6), allocate exactly `NUM_BLOBS` (6) blob slots across colors proportional to weight — e.g. largest-remainder / Hamilton apportionment (round each `weight * NUM_BLOBS` down, then hand out the leftover slots to the colors with the largest fractional remainder, until exactly 6 are allocated). Every color with weight > 0 must get at least 1 blob (a color that's present at all should be visible at all, even a single small one) — reserve 1 slot per real color first, then apportion the remaining slots by weight among all colors.
2. `rotationFor()`'s existing per-cover hash rotation must still apply — don't hardcode which physical blob index gets which color family independent of the cover, or you'll reintroduce the corner-pooling bug that fix solved.
3. Whichever colors end up with 2+ blobs must have THEIR OWN blobs antipodally paired with each other (same mirror-through-center, phase+π relationship as today), so a dominant color's own multiple blobs don't independently drift and cause the SAME mid-song-flip/imbalance bug this session already fixed once, just at a finer grain. A color with exactly 1 blob has nothing to pair — that's fine, it's meant to read as a minor accent, not a competing pooling body.
4. Write a numeric simulation (plain Node script, same style as the antipodal-pairing fix's own verification) that: builds blob params for a synthetic 3-color case (weights e.g. `[0.6, 0.25, 0.15]`), runs the position formulas over a simulated time range (reuse the existing antipodal fix's simulation approach — same `rng()`/`sin()`-based position functions, just import or copy them), and measures each color's mean visible frame-share (nearest-blob-per-pixel-sample or similar proxy) over that range. Confirm: (a) frame-share ordering matches weight ordering (0.6-weight color visibly dominant, 0.15-weight color visibly minor, not equal), (b) no color's share swings wildly over time the way the original un-paired bug did (bound the swing similarly to how the antipodal fix bounded it, ~0.48-0.55 for the equal-weight case — for unequal weights the bound should scale with weight, not be a flat band).
5. Confirm the true-B&W and single-real-hue-plus-accent cases from `api/palette.js` (2 and 3 colors respectively, with the accent-branch weights being `[real, real, 0.15]`-shaped per `buildWeights()`) look right under the new allocation: the accent should land as a single minor blob, not an antipodal pair, given its low weight relative to 2 real colors typically summing well above the 1-blob threshold.

- [ ] **Step 3: Run the simulation script, paste its actual output into your summary**

No placeholder/assumed numbers — run it for real, read the printed frame-share numbers, and report them.

- [ ] **Step 4: Syntax-verify**

Run: `cd ~/Projects/baynes-trivia/trivia-jukebox && npx esbuild --loader:.jsx=jsx src/components/AlbumGradientMesh.jsx --outfile=/tmp/mesh-check.js`
Expected: success line, no errors.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/baynes-trivia/trivia-jukebox
for f in .git/*.lock; do [ -e "$f" ] && mv "$f" "$f.bak_$(date +%s%N)"; done
git add src/components/AlbumGradientMesh.jsx
git commit -m "mesh: weight-proportional blob allocation, replaces equal i%length split

Completes the weighted-palette fix (see the two prior commits on
api/palette.js and LiveScreen.jsx/usePalette.js today). Each color now
gets blob count proportional to its real weight instead of an automatic
equal share -- this is the actual structural fix for the Orleans 'Dance
with Me' lava-lamp complaint: the single-hue-family accent color can
finally be genuinely minor (1 small blob) instead of a guaranteed 1/3 of
the frame. Colors with 2+ blobs keep the antipodal (mirror-through-center)
pairing from earlier today so a dominant color's own blobs still don't
drift independently and reintroduce the mid-song-flip bug at a finer
grain."
```

---

### Task 4: Live verification pass

**Files:** none modified — this task is entirely running things and reading output.

- [ ] **Step 1: Run the full unit test suite**

Run: `cd ~/Projects/baynes-trivia/trivia-jukebox && npx vitest run`
Expected: all existing suites (shuffle.js, track.js, SongDetailModal.jsx) still pass, plus the new `api/palette.test.js` from Task 1.

- [ ] **Step 2: Re-run the three-cover live comparison from the deep-debug review**

Using the Chrome tab already on `https://trivia-jukebox.vercel.app` — the code changes are LOCAL and not yet deployed, so this step is checking the code's logic offline (via the same in-browser calibration harness used earlier this session), not the live endpoint, until Ben deploys. Confirm: for "1990something," the new server-side scoring (Task 1) ranks the salmon/pink background competitively with yellow, and the new client picker (Task 2) no longer drops it. For "Dance with Me," confirm the accent's new weight (~0.15 via `buildWeights`) is small relative to the two real gold colors' combined weight.

- [ ] **Step 3: Report to Ben**

Summarize what changed, what the simulation numbers showed, and that none of this is live until he runs `git push` (no push access from this sandbox, same as every other commit today).

---

## Execution note

Given today's session has already accumulated a lot of context on this exact codebase (many prior fixes, many documented false starts, several live-verified edge cases in `api/palette.js`'s comments that must not regress), Tasks 1 and 2 are best executed by whoever already holds that context rather than a fresh subagent re-deriving it. Task 3 is more self-contained once hand ed the finalized `weights` contract from Tasks 1-2, and its own verification step (Step 2, the numeric simulation) is exactly the kind of independently-checkable unit of work `subagent-driven-development` is for.
