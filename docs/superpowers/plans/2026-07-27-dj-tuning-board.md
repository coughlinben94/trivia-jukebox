# DJ Gradient Tuning Board Implementation Plan (v2 — 6 dials)

> **Supersedes the v1 draft in this same file (2026-07-27, 40 raw knobs).** Ben's call after seeing v1: "40 knobs?!?!?! that's crazy... i was thinking 5 or 6?? i am no color engineer." This version replaces the raw-constant-per-knob design with 6 macro dials, each a plain-English concept mapped to a handful of underlying constants via a lerp curve, plus one A/B switch. The file/architecture ideas that still hold up (hotkey, localStorage override pattern, remount-on-commit for baked-in values, server-side override via query params, paste-back export) carry over from v1; the knob registry does not.

> **For agentic workers:** Execute task-by-task inline. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT run `npm run dev` or `npm run test` for verification — both are broken in this sandbox (rolldown native-binding issue, confirmed 2026-07-27); use the esbuild static syntax checks in Task 9 plus the manual live checklist.

**Goal:** A DJ-mixer-styled live-tuning panel on a dedicated test screen — opened by a visible **Tune** button that starts a real shuffled session — with exactly 6 rotary dials — BRIGHTNESS, MOTION, SIZE, BLEND, VARIETY, CROSSFADE — plus a CIRCLES/MESH engine switch, so Ben can shape the ambient gradient against whatever's actually playing with no redeploy round-trip, no color-theory required.

**Architecture:**
- Each dial is a 0–100 "feel" value with no unit of its own. Turning it maps, via a `lerp()` curve, to one or more of the real underlying constants in `AlbumGradient.jsx` / `AlbumGradientMesh.jsx` / `api/palette.js`. Every dial's curve is built so **50 (the default) reproduces the exact value already live today** — turning nothing on the board changes nothing on screen.
- `src/lib/gradientTuning.js` — the 6-dial registry, a localStorage override store (same shape/pattern as the existing `trivia_gradient_engine` flag this app already uses), and the derived-value functions (`chromaScale()`, `orbitSpeed()`, etc.) that both renderers call instead of reading a bare module constant.
- `src/lib/paletteDefaults.js` — the one dial that reaches the server (VARIETY) needs a small shared resolver, because `api/palette.js` runs on Vercel's infra and can't read the browser's localStorage. The client sends `t_VARIETY=<0-100>` as a query param on its own `/api/palette` calls only when that dial is actually moved from 50; the server resolves it through the same lerp curve and answers those requests `no-store` so tuning experiments don't pollute the CDN cache. Default-dial requests are byte-identical to today's URLs, so the existing 24h cache stays warm.
- `src/components/TuningBoard.jsx` — the mixer UI. One reusable `Knob` component (drag-to-rotate, scroll-to-nudge, double-click-to-reset), 6 of them plus the engine toggle switch and COPY/RESET buttons, styled to sit next to the app's existing turntable/tonearm hardware look.
- Reached by a visible **Tune** button in `Jukebox.jsx`'s header — no hotkey at all (see Task 8, twice revised). Clicking it starts a real shuffled session and opens `TestScreen.jsx`, a second mount of the real `LiveScreen` with the board always on screen.

**Tech Stack:** React 19, Vite, Tailwind, Vercel serverless (`api/palette.js`). No new dependencies.

---

## The 6 dials

| Dial | Default (50) reproduces | What turning it up does | Underlying knobs it drives |
|---|---|---|---|
| **BRIGHTNESS** | today's alpha/saturation | Background pops more — brighter, more saturated blobs | `MESH_CHROMA_SCALE`, `CIRCLE_ALPHA_MUTED`, `CIRCLE_ALPHA_SAT` |
| **MOTION** | `ORBIT_SPEED = 1.1` | Blobs drift faster | `ORBIT_SPEED` (shared orbit formula, both renderers) |
| **SIZE** | `BLOB_RADIUS = 0.50` | Each color blob covers more of the screen | `BLOB_RADIUS` (shared, both renderers) |
| **BLEND** | `IDW_POWER = 3` / `CIRCLE_FALLOFF_POW = 1.5` | Colors separate into distinct bodies instead of a creamy average | `MESH_IDW_POWER` (mesh) or `CIRCLE_FALLOFF_POW` (circles) — whichever engine is active |
| **VARIETY** | `HUE_GAP_DEG = 25`, `MIN_COLORS = 5` | Pulls more distinct hues from the album art instead of letting one dominate | `api/palette.js`'s hue-diversity dedup gap + color floor — server-side |
| **CROSSFADE** | `BLEND_DURATION_MS = 7500` | Song-to-song background transitions happen faster | `BLEND_DURATION_MS` (shared, both renderers) |

Plus: **CIRC/MESH** engine switch (writes the existing `trivia_gradient_engine` key), **COPY VALUES**, **RESET ALL**.

Deliberately left off the board (fixed at today's values, not exposed): mesh wobble amount/speed/texture, mesh blur/grain/internal-resolution, blob count, per-blob period/margin variety, palette candidate-bucket count, B&W-cover accent hues/saturation, circle sweep-offset and base-luma. These are real constants but they're second-order — nobody without a color-engineering background is going to reach for "wobble texture frequency" on a Tuesday night. If Ben wants any of these promoted to a 7th/8th dial later, `docs/superpowers/plans/2026-07-27-dj-tuning-board.md`'s git history (this file, v1) still has the full 40-constant census with exact file/line locations to pull from.

---

## File Structure

- Create: `src/lib/paletteDefaults.js` — VARIETY→`{HUE_GAP_DEG, MIN_COLORS}` curve + `resolvePaletteConfig()`, shared by server and client.
- Create: `src/lib/gradientTuning.js` — `DIALS` registry, localStorage override store (`T()`, `setDial`, `resetDial`, `clearDials`, `setEngine`), `TUNING_EVENT`, derived-value functions, `paletteQuery()`, `exportSnippet()`.
- Create: `src/components/TuningBoard.jsx` — `Knob` rotary widget + 6 dials + engine switch + copy/reset.
- Create: `src/components/TestScreen.jsx` — real `LiveScreen` + always-visible board, remount-on-commit `key`.
- Modify: `api/palette.js` — resolve `t_VARIETY` via `resolvePaletteConfig`; `no-store` when overridden.
- Modify: `src/hooks/usePalette.js` — append `paletteQuery()` to fetch URLs when VARIETY is overridden; cache key includes it.
- Modify: `src/components/AlbumGradient.jsx` — `buildBlobGradient` and `makeCircleParams` read derived values instead of bare constants.
- Modify: `src/components/AlbumGradientMesh.jsx` — same treatment for `CHROMA_SCALE`, `IDW_POWER`, orbit formula, `BLEND_DURATION_MS`.
- Modify: `src/components/Jukebox.jsx` — `Tune` header button, `showTest` state, `tuningRef` routing, mount point. `LiveScreen.jsx` is **not** modified — `TestScreen` mounts it as-is.

---

### Task 1: Shared VARIETY resolver (`src/lib/paletteDefaults.js`)

**Files:**
- Create: `src/lib/paletteDefaults.js`

- [ ] **Step 1: Create the file**

```js
// Shared between api/palette.js (runs on Vercel's infra) and the client
// tuning board (src/lib/gradientTuning.js). Pure data + one pure function —
// no browser or Node APIs — so both bundles can import it (Vercel's nft
// tracing follows the ../src import when bundling the serverless function).
//
// Only the VARIETY dial reaches the server (see the plan doc's dial table).
// It's a single 0-100 "feel" value; this file is the one place that curve
// is defined, so the client and server can never compute it differently.

export function varietyToConfig(variety) {
  // Number(undefined)/Number('abc') is NaN, and `NaN ?? 50` is still NaN (??
  // only catches null/undefined) — an earlier version of this line let a bad
  // input fall all the way through to HUE_GAP_DEG: NaN. Guard on isFinite.
  const n = Number(variety)
  const v = (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50) / 100
  return {
    HUE_GAP_DEG: Math.round(5 + (45 - 5) * v),   // 50 → 25, matches today's hardcoded value
    MIN_COLORS: Math.round(3 + (7 - 3) * v),      // 50 → 5, matches today's hardcoded value
  }
}

// Reads t_VARIETY off the request (0-100). Absent/invalid → 50 (today's
// behavior, byte-identical query string, keeps the CDN cache warm).
// Returns { cfg, overridden } — overridden tells the handler to answer
// no-store instead of using the normal 24h cache.
export function resolvePaletteConfig(query = {}) {
  const raw = query.t_VARIETY
  if (raw === undefined) return { cfg: varietyToConfig(50), overridden: false }
  const n = Number(raw)
  if (!Number.isFinite(n)) return { cfg: varietyToConfig(50), overridden: false }
  return { cfg: varietyToConfig(n), overridden: true }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/paletteDefaults.js
git commit -m "tuning: VARIETY dial curve + query-override resolver (server/client)"
```

---

### Task 2: Dial registry + override store (`src/lib/gradientTuning.js`)

**Files:**
- Create: `src/lib/gradientTuning.js`

- [ ] **Step 1: Create the file**

```js
// Single source of truth for the 6-dial DJ tuning board (TuningBoard.jsx)
// and the derived values the renderers actually read.
//
// Every dial is a plain 0-100 "feel" value, no units. T(id) returns a live
// board override when present (persisted in localStorage under STORAGE_KEY),
// 50 (the default — reproduces today's live behavior exactly) otherwise.
// Renderers never read T() directly — they call the derived-value functions
// below (chromaScale(), orbitSpeed(), etc.), which do the lerp and, for the
// engine-specific BLEND dial, pick the right curve for whichever renderer
// is asking.
//
// The board is a tuning aid, not the long-term source of truth: COPY VALUES
// (exportSnippet) emits a paste-ready block of the real constants each dial
// currently resolves to, for pasting back over the hardcoded values in
// AlbumGradient.jsx / AlbumGradientMesh.jsx / api/palette.js. Paste, commit,
// then RESET ALL.

import { varietyToConfig } from './paletteDefaults.js'

export const STORAGE_KEY  = 'trivia_gradient_tuning'
export const ENGINE_KEY   = 'trivia_gradient_engine' // pre-existing key — LiveScreen.getMeshGradientFlag() reads it
export const TUNING_EVENT = 'trivia-tuning-change'

export const lerp = (a, b, t) => a + (b - a) * t

// commit: 'live' dials apply every drag frame. 'release' dials take effect
// on pointer-up — they're baked into a useMemo'd blob-params object or (for
// VARIETY) trigger a serverless refetch, both too heavy to do per drag pixel.
export const DIALS = [
  { id: 'BRIGHTNESS', label: 'BRIGHTNESS', commit: 'live' },
  { id: 'MOTION',     label: 'MOTION',     commit: 'release', remount: true },
  { id: 'SIZE',       label: 'SIZE',       commit: 'release', remount: true },
  { id: 'BLEND',      label: 'BLEND',      commit: 'live' },
  { id: 'VARIETY',    label: 'VARIETY',    commit: 'release', server: true },
  { id: 'CROSSFADE',  label: 'CROSSFADE',  commit: 'live' },
]
const DIAL_BY_ID = Object.fromEntries(DIALS.map(d => [d.id, d]))
const DEFAULT_VALUE = 50

// ── Runtime store ─────────────────────────────────────────────────────────────

let overrides = {}
if (typeof window !== 'undefined') {
  try { overrides = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {} }
  catch { overrides = {} }
}
let version = 1

// Monotonic counter — AlbumGradient.jsx compares it against its cached
// CanvasGradient objects so BRIGHTNESS/BLEND turns invalidate the cache
// without an event subscription in the draw loop.
export function tuningVersion() { return version }

// The one call the board and renderers make for a dial's raw 0-100 value.
export function T(id) { return overrides[id] ?? DEFAULT_VALUE }

export function isOverridden(id) { return overrides[id] !== undefined && overrides[id] !== DEFAULT_VALUE }
export function hasOverrides() { return Object.keys(overrides).some(isOverridden) }

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)) }
  catch { /* storage full/blocked — overrides still apply in-memory this session */ }
}

function dispatch(id, committed) {
  const d = DIAL_BY_ID[id]
  window.dispatchEvent(new CustomEvent(TUNING_EVENT, {
    detail: { id, committed, remount: !!d?.remount, server: !!d?.server },
  }))
}

// committed=false during a drag on a 'release' dial: the store + version
// still update (so the knob's own readout tracks the drag) but listeners
// that do heavy work (palette refetch, remount) wait for committed=true on
// pointer-up.
export function setDial(id, value, committed = true) {
  if (!DIAL_BY_ID[id]) return
  const clamped = Math.min(100, Math.max(0, Math.round(value)))
  overrides = { ...overrides, [id]: clamped }
  version++
  if (committed) persist()
  dispatch(id, committed)
}

export function resetDial(id) {
  if (!(id in overrides)) return
  const next = { ...overrides }
  delete next[id]
  overrides = next
  version++
  persist()
  dispatch(id, true)
}

export function clearDials() {
  overrides = {}
  version++
  persist()
  window.dispatchEvent(new CustomEvent(TUNING_EVENT, {
    detail: { id: '__all', committed: true, remount: true, server: true },
  }))
}

// Engine A/B — reuses the EXISTING trivia_gradient_engine mechanism rather
// than inventing a second one. The ?gradient= URL param still wins inside
// getMeshGradientFlag(); the board should show a small warning when one is
// present in the URL (see Task 8).
export function setEngine(engine) {
  try { localStorage.setItem(ENGINE_KEY, engine) } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(TUNING_EVENT, {
    detail: { id: '__engine', committed: true, remount: true, server: false },
  }))
}

// ── Derived values — what the renderers actually call ──────────────────────
// Every curve is built so T(id)===50 reproduces today's exact hardcoded
// value. `engine` is 'circles' | 'mesh', only needed for BLEND (the two
// renderers express "distinct vs. creamy" through different constants).

// BRIGHTNESS ranges are centered on the values that were hardcoded before the
// board existed, so a dial sitting at 50 draws exactly what shipped yesterday.
// (They were off by a hair — 0.85/0.625/0.40 vs 0.82/0.62/0.38 — which broke
// the board's core promise that "touch nothing, change nothing".)
export function chromaScale()      { return lerp(0.50, 1.14, T('BRIGHTNESS') / 100) }       // 50 → 0.82 (was 0.82, exact)
export function circleAlphaMuted() { return lerp(0.45, 0.79, T('BRIGHTNESS') / 100) }       // 50 → 0.62 (was 0.62, exact)
export function circleAlphaSat()   { return lerp(0.21, 0.55, T('BRIGHTNESS') / 100) }       // 50 → 0.38 (was 0.38, exact)

export function orbitSpeed()       { return lerp(0.3, 1.9, T('MOTION') / 100) }             // 50 → 1.1 (was 1.1, exact)

export function blobRadius()       { return lerp(0.30, 0.70, T('SIZE') / 100) }             // 50 → 0.50 (was 0.50, exact)

export function meshIdwPower()     { return lerp(1, 5, T('BLEND') / 100) }                  // 50 → 3 (was 3, exact)
export function circleFalloffPow() { return lerp(0.2, 2.8, T('BLEND') / 100) }              // 50 → 1.5 (was 1.5, exact)

export function blendDurationMs()  { return lerp(12000, 3000, T('CROSSFADE') / 100) }       // 50 → 7500 (was 7500, exact)

// VARIETY resolves through the SAME curve as the server (paletteDefaults.js)
// — used client-side only for the board's own readout; the actual palette
// extraction always happens server-side.
export function varietyConfig()    { return varietyToConfig(T('VARIETY')) }

// Query-string fragment for /api/palette calls — empty string when VARIETY
// is untouched, so default sessions keep byte-identical URLs (and therefore
// their warm CDN cache entries).
export function paletteQuery() {
  return isOverridden('VARIETY') ? `&t_VARIETY=${T('VARIETY')}` : ''
}

// Paste-ready export — the board is a tuning aid; proven values go back into
// source and get committed. Emits the real constant each touched dial
// currently resolves to, annotated with which file/line it replaces.
export function exportSnippet() {
  const fmt = v => String(+(+v).toFixed(4))
  const lines = [`// trivia-jukebox gradient tuning — exported ${new Date().toISOString()}`]
  const touched = DIALS.filter(d => isOverridden(d.id))
  if (!touched.length) { lines.push('// (no dials moved from default)'); return lines.join('\n') }
  if (isOverridden('BRIGHTNESS')) {
    lines.push('', '// AlbumGradientMesh.jsx — replace CHROMA_SCALE:', `const CHROMA_SCALE = ${fmt(chromaScale())}`)
    lines.push('// AlbumGradient.jsx — inside buildBlobGradient, replace the peakAlpha lerp:', `const peakAlpha = lerp(${fmt(circleAlphaMuted())}, ${fmt(circleAlphaSat())}, chroma)`)
  }
  if (isOverridden('MOTION')) {
    lines.push('', '// AlbumGradient.jsx makeCircleParams / AlbumGradientMesh.jsx makeBlobParams —', '// replace the "1.1 /" numerator in xFreq/yFreq:', `const ORBIT_SPEED = ${fmt(orbitSpeed())}`)
  }
  if (isOverridden('SIZE')) {
    lines.push('', '// Both makeCircleParams/makeBlobParams — replace "radius: 0.50 + rng(i, 6) * 0.13":', `radius: ${fmt(blobRadius())} + rng(i, 6) * 0.13`)
  }
  if (isOverridden('BLEND')) {
    lines.push('', '// AlbumGradientMesh.jsx — replace IDW_POWER:', `const IDW_POWER = ${fmt(meshIdwPower())}`)
    lines.push('// AlbumGradient.jsx buildBlobGradient — replace Math.pow(1 - t, 1.5):', `Math.pow(1 - t, ${fmt(circleFalloffPow())})`)
  }
  if (isOverridden('VARIETY')) {
    const cfg = varietyConfig()
    lines.push('', '// api/palette.js — replace the MIN_COLORS/HUE_GAP_DEG in the const line:', `MIN_COLORS = ${cfg.MIN_COLORS}, HUE_GAP_DEG = ${cfg.HUE_GAP_DEG}`)
  }
  if (isOverridden('CROSSFADE')) {
    lines.push('', '// Both files — replace BLEND_DURATION_MS:', `const BLEND_DURATION_MS = ${Math.round(blendDurationMs())}`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/gradientTuning.js
git commit -m "tuning: 6-dial registry, localStorage override store, derived-value curves"
```

---

### Task 3: `api/palette.js` — VARIETY override

**Files:**
- Modify: `api/palette.js:1-6` (import + resolve)
- Modify: `api/palette.js:84` (const line)
- Modify: `api/palette.js:123-125` (cache header)

- [ ] **Step 1: Import and resolve config**

Replace `api/palette.js:1-6`:

```js
import sharp from 'sharp';

export default async function handler(req, res) {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: 'Missing url param' });
```

with:

```js
import sharp from 'sharp';
import { resolvePaletteConfig } from '../src/lib/paletteDefaults.js';

export default async function handler(req, res) {
  const { url } = req.query;
  const { cfg, overridden } = resolvePaletteConfig(req.query);

  if (!url) return res.status(400).json({ error: 'Missing url param' });
```

- [ ] **Step 2: Wire the const line to the resolved config**

Replace `api/palette.js:84`:

```js
    const MIN_COLORS = 5, MAX_COLORS = 8, CHROMA_FLOOR = 0.18, HUE_GAP_DEG = 25;
```

with:

```js
    const MIN_COLORS = cfg.MIN_COLORS, MAX_COLORS = 8, CHROMA_FLOOR = 0.18, HUE_GAP_DEG = cfg.HUE_GAP_DEG;
```

- [ ] **Step 3: Skip the CDN cache when the board has overridden VARIETY**

Replace `api/palette.js:123-125`:

```js
    // Album art URLs are stable — cache aggressively
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json({ colors });
```

with:

```js
    // Album art URLs are stable — cache aggressively, UNLESS the tuning
    // board is live-testing a VARIETY value, in which case caching would
    // serve a stale palette back to the board mid-tune.
    res.setHeader('Cache-Control', overridden ? 'no-store' : 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json({ colors });
```

- [ ] **Step 4: Commit**

```bash
git add api/palette.js
git commit -m "tuning: wire VARIETY dial into palette extraction via query override"
```

---

### Task 4: `usePalette.js` — send the override, cache by full URL

**Files:**
- Modify: `src/hooks/usePalette.js`

- [ ] **Step 1: Import `paletteQuery` and append it to both fetch call sites**

Replace `src/hooks/usePalette.js:1-21`:

```js
import { useState, useEffect, useRef } from 'react';

const cache = new Map();

// Fallback while a palette is loading/fails — near-black, all gradient
// components cycle through whatever-length array is given so this doesn't
// need to match either gradient's exact color count.
const FALLBACK = ['#080808', '#080808', '#080808', '#080808', '#080808'];

// Warm the cache ahead of need (e.g. the upcoming song's art the moment the
// current song starts) so the fade-out blend gets a cache hit and the full
// encroachment window, instead of losing it to a cold serverless fetch.
export function prefetchPalette(albumArtUrl) {
  if (!albumArtUrl || cache.has(albumArtUrl)) return;
  fetch(`/api/palette?url=${encodeURIComponent(albumArtUrl)}`)
    .then(r => r.json())
    .then(data => {
      if (data.colors?.length >= 2) cache.set(albumArtUrl, data.colors);
    })
    .catch(() => {});
}
```

with:

```js
import { useState, useEffect, useRef } from 'react';
import { paletteQuery } from '../lib/gradientTuning.js';

const cache = new Map();

// Fallback while a palette is loading/fails — near-black, all gradient
// components cycle through whatever-length array is given so this doesn't
// need to match either gradient's exact color count.
const FALLBACK = ['#080808', '#080808', '#080808', '#080808', '#080808'];

// Cache key includes the tuning query so a VARIETY-overridden fetch never
// collides with (or overwrites) the default-palette entry for the same art.
const cacheKey = (url) => url + paletteQuery();

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
      if (data.colors?.length >= 2) cache.set(key, data.colors);
    })
    .catch(() => {});
}
```

- [ ] **Step 2: Update the hook body to use `cacheKey`/the query param, and re-fetch on a committed VARIETY change**

Replace `src/hooks/usePalette.js:23-60` (the rest of the file, `usePalette`):

```js
export function usePalette(albumArtUrl) {
  const [colors, setColors] = useState(FALLBACK);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!albumArtUrl) return;
    const key = cacheKey(albumArtUrl)

    if (cache.has(key)) {
      setColors(cache.get(key));
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setColors(FALLBACK);

    fetch(`/api/palette?url=${encodeURIComponent(albumArtUrl)}${paletteQuery()}`, {
      signal: controller.signal,
    })
      .then(r => r.json())
      .then(data => {
        if (data.colors?.length >= 2) {
          cache.set(key, data.colors);
          setColors(data.colors);
        }
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          console.warn('[usePalette] falling back to defaults:', err.message);
        }
      });

    return () => controller.abort();
  }, [albumArtUrl, paletteQuery()]);

  return colors;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/hooks/usePalette.js
git commit -m "tuning: usePalette sends VARIETY override, caches by full URL"
```

---

### Task 5: `AlbumGradient.jsx` — read BRIGHTNESS/MOTION/SIZE/BLEND/CROSSFADE

**Files:**
- Modify: `src/components/AlbumGradient.jsx:1-5` (import + remove hardcoded `BLEND_DURATION_MS`)
- Modify: `src/components/AlbumGradient.jsx:48-58` (`buildBlobGradient`)
- Modify: `src/components/AlbumGradient.jsx:62-82` (`makeCircleParams`)
- Modify: `src/components/AlbumGradient.jsx` — every reference to `BLEND_DURATION_MS` inside the component

- [ ] **Step 1: Import derived values, drop the hardcoded constant**

Replace `src/components/AlbumGradient.jsx:1-5`:

```js
import { useEffect, useRef, useMemo } from 'react'

const BLEND_DURATION_MS = 7500
const NUM_CIRCLES  = 6
const DIRECTIONS   = ['left', 'right', 'up', 'down']
```

with:

```js
import { useEffect, useRef, useMemo } from 'react'
import {
  circleAlphaMuted, circleAlphaSat, circleFalloffPow,
  orbitSpeed, blobRadius, blendDurationMs, tuningVersion,
} from '../lib/gradientTuning.js'

const NUM_CIRCLES  = 6
const DIRECTIONS   = ['left', 'right', 'up', 'down']
```

- [ ] **Step 2: Replace every `BLEND_DURATION_MS` reference in the component with `blendDurationMs()`**

There are 3 call sites (the `blendStart >= 0 && (now - s.blendStart) < BLEND_DURATION_MS` guard in `startBlendTo`, the same guard in `draw`, and the `t = easeInOut(Math.min((ts - s.blendStart) / BLEND_DURATION_MS, 1))` line in `draw`). Replace each `BLEND_DURATION_MS` identifier with `blendDurationMs()` — a function call, not a constant, since CROSSFADE can move mid-transition.

- [ ] **Step 3: `buildBlobGradient` reads BRIGHTNESS and BLEND instead of hardcoded lerps**

Replace `src/components/AlbumGradient.jsx:48-58`:

```js
function buildBlobGradient(ctx, r, g, b, baseRadiusPx) {
  const chroma     = chromaOf(r, g, b)
  const peakAlpha  = lerp(0.62, 0.38, chroma)
  const radiusPx   = baseRadiusPx * lerp(1.05, 0.85, chroma)
  const grad       = ctx.createRadialGradient(0, 0, 0, 0, 0, radiusPx)
  for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const a = peakAlpha * Math.pow(1 - t, 1.5)
    grad.addColorStop(t, `rgba(${r},${g},${b},${a.toFixed(3)})`)
  }
  return { grad, r: radiusPx }
}
```

with:

```js
function buildBlobGradient(ctx, r, g, b, baseRadiusPx) {
  const chroma     = chromaOf(r, g, b)
  const peakAlpha  = lerp(circleAlphaMuted(), circleAlphaSat(), chroma)
  const radiusPx   = baseRadiusPx * lerp(1.05, 0.85, chroma)
  const grad       = ctx.createRadialGradient(0, 0, 0, 0, 0, radiusPx)
  const falloffPow = circleFalloffPow()
  for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const a = peakAlpha * Math.pow(1 - t, falloffPow)
    grad.addColorStop(t, `rgba(${r},${g},${b},${a.toFixed(3)})`)
  }
  return { grad, r: radiusPx }
}
```

- [ ] **Step 4: `makeCircleParams` reads MOTION and SIZE**

Replace `src/components/AlbumGradient.jsx:62-82`:

```js
function makeCircleParams() {
  function rng(i, slot) {
    const x = Math.sin((i * 7 + slot) * 9301 + 49297) * 233280
    return x - Math.floor(x)
  }
  return Array.from({ length: NUM_CIRCLES }, (_, i) => ({
    baseX:  0.10 + rng(i, 0) * 0.80,
    baseY:  0.10 + rng(i, 1) * 0.80,
    // Amp up + radius down ~10% vs the ca8fb4d tuning: smaller blobs overlap
    // less, so the screen-blend washes to a single hue less often and distinct
    // palette colors stay co-visible. Periods 10–17s (was 12–20s) for a bit
    // more background motion. Frequency +10% again for faster flow.
    xAmp:   0.33,
    yAmp:   0.33,
    xFreq:  1.1 / (10 + rng(i, 2) * 7),
    yFreq:  1.1 / (10 + rng(i, 3) * 7),
    xPhase: rng(i, 4) * Math.PI * 2,
    yPhase: rng(i, 5) * Math.PI * 2,
    radius: 0.50 + rng(i, 6) * 0.13,
  }))
}
```

with:

```js
function makeCircleParams() {
  function rng(i, slot) {
    const x = Math.sin((i * 7 + slot) * 9301 + 49297) * 233280
    return x - Math.floor(x)
  }
  const speed = orbitSpeed()
  const size  = blobRadius()
  return Array.from({ length: NUM_CIRCLES }, (_, i) => ({
    baseX:  0.10 + rng(i, 0) * 0.80,
    baseY:  0.10 + rng(i, 1) * 0.80,
    xAmp:   0.33,
    yAmp:   0.33,
    xFreq:  speed / (10 + rng(i, 2) * 7),
    yFreq:  speed / (10 + rng(i, 3) * 7),
    xPhase: rng(i, 4) * Math.PI * 2,
    yPhase: rng(i, 5) * Math.PI * 2,
    radius: size + rng(i, 6) * 0.13,
  }))
}
```

Note `makeCircleParams()` is called once via `useMemo(makeCircleParams, [])` — MOTION/SIZE changes need the MOTION/SIZE dials' `remount: true` behavior (Task 8) to actually take effect, which is why those two dials are `commit: 'release'` with a component remount, not `'live'`.

- [ ] **Step 5: Commit**

```bash
git add src/components/AlbumGradient.jsx
git commit -m "tuning: AlbumGradient.jsx reads BRIGHTNESS/MOTION/SIZE/BLEND/CROSSFADE dials"
```

---

### Task 6: `AlbumGradientMesh.jsx` — same treatment

**Files:**
- Modify: `src/components/AlbumGradientMesh.jsx:1-2` (import)
- Modify: `src/components/AlbumGradientMesh.jsx:33` (remove hardcoded `BLEND_DURATION_MS`)
- Modify: `src/components/AlbumGradientMesh.jsx:43-59` (`makeBlobParams`)
- Modify: `src/components/AlbumGradientMesh.jsx:68,76` (`IDW_POWER`, `CHROMA_SCALE`)
- Modify: `src/components/AlbumGradientMesh.jsx` — `BLEND_DURATION_MS` references in `draw`/`startBlendTo`

- [ ] **Step 1: Import, drop hardcoded constants**

Replace `src/components/AlbumGradientMesh.jsx:1-2`:

```js
import { useEffect, useRef, useMemo } from 'react'
```

with:

```js
import { useEffect, useRef, useMemo } from 'react'
import { orbitSpeed, blobRadius, meshIdwPower, chromaScale, blendDurationMs } from '../lib/gradientTuning.js'
```

Replace `src/components/AlbumGradientMesh.jsx:33`:

```js
const BLEND_DURATION_MS = 7500
```

with nothing (delete the line — `blendDurationMs()` is called instead, same as Task 5 Step 2).

- [ ] **Step 2: Replace every `BLEND_DURATION_MS` identifier in the component body with `blendDurationMs()`** (2 call sites: `startBlendTo`'s guard, `draw`'s `t = easeInOut(...)` line).

- [ ] **Step 3: `IDW_POWER`/`CHROMA_SCALE` → function calls**

Replace `src/components/AlbumGradientMesh.jsx:68`:

```js
const IDW_POWER = 3
```

with nothing (delete — `meshIdwPower()` is called at each use site instead). Same for line 76 (`CHROMA_SCALE = 0.82`) — delete, use `chromaScale()`.

In `draw()`, where the per-pixel loop reads `IDW_POWER` and where `CHROMA_SCALE` is applied to `a`/`b`, hoist one local each at the top of `draw()` (not inside the pixel loop — matches this file's existing performance pattern of computing per-frame values once, see `oklabColors`/`blobs` above the loop):

```js
    const oklabColors = liveColors.map(rgbToOklab)
    const idwPower = meshIdwPower()
    const chromaScl = chromaScale()
```

then use `idwPower`/`chromaScl` in place of `IDW_POWER`/`CHROMA_SCALE` inside the pixel loop (`Math.pow(dn, idwPower)` and `a *= chromaScl; b *= chromaScl`).

- [ ] **Step 4: `makeBlobParams` reads MOTION and SIZE**

Replace `src/components/AlbumGradientMesh.jsx:43-59`:

```js
function makeBlobParams() {
  function rng(i, slot) {
    const x = Math.sin((i * 7 + slot) * 9301 + 49297) * 233280
    return x - Math.floor(x)
  }
  return Array.from({ length: NUM_BLOBS }, (_, i) => ({
    baseX:  0.10 + rng(i, 0) * 0.80,
    baseY:  0.10 + rng(i, 1) * 0.80,
    xAmp:   0.33,
    yAmp:   0.33,
    xFreq:  1.1 / (10 + rng(i, 2) * 7),
    yFreq:  1.1 / (10 + rng(i, 3) * 7),
    xPhase: rng(i, 4) * Math.PI * 2,
    yPhase: rng(i, 5) * Math.PI * 2,
    radius: 0.50 + rng(i, 6) * 0.13,
  }))
}
```

with:

```js
function makeBlobParams() {
  function rng(i, slot) {
    const x = Math.sin((i * 7 + slot) * 9301 + 49297) * 233280
    return x - Math.floor(x)
  }
  const speed = orbitSpeed()
  const size  = blobRadius()
  return Array.from({ length: NUM_BLOBS }, (_, i) => ({
    baseX:  0.10 + rng(i, 0) * 0.80,
    baseY:  0.10 + rng(i, 1) * 0.80,
    xAmp:   0.33,
    yAmp:   0.33,
    xFreq:  speed / (10 + rng(i, 2) * 7),
    yFreq:  speed / (10 + rng(i, 3) * 7),
    xPhase: rng(i, 4) * Math.PI * 2,
    yPhase: rng(i, 5) * Math.PI * 2,
    radius: size + rng(i, 6) * 0.13,
  }))
}
```

- [ ] **Step 5: Commit**

```bash
git add src/components/AlbumGradientMesh.jsx
git commit -m "tuning: AlbumGradientMesh.jsx reads BRIGHTNESS/MOTION/SIZE/BLEND/CROSSFADE dials"
```

---

### Task 7: `TuningBoard.jsx` — the mixer UI

**Files:**
- Create: `src/components/TuningBoard.jsx`

- [ ] **Step 1: Create the file**

```jsx
import { useRef, useState, useCallback } from 'react'
import {
  DIALS, T, setDial, resetDial, clearDials, setEngine,
  hasOverrides, exportSnippet,
} from '../lib/gradientTuning.js'

// A single DJ-style rotary knob. Drag vertically to turn (standard pro-audio
// knob convention — up increases, matches a physical knob's "pull toward
// you to raise" feel better than a circular drag gesture would on a
// trackpad). Scroll to nudge by 1. Double-click resets to 50 (the default —
// see gradientTuning.js's derived-value comments for why 50 always
// reproduces today's live-tuned sound).
function Knob({ id, label, engine }) {
  const value = T(id)
  const dragRef = useRef(null)
  const isOverridden = value !== 50

  const onPointerDown = useCallback((e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, startValue: value }
  }, [value])

  const onPointerMove = useCallback((e) => {
    if (!dragRef.current) return
    const dy = dragRef.current.startY - e.clientY // up = positive = increase
    const next = dragRef.current.startValue + dy * 0.6
    setDial(id, next, false)
  }, [id])

  const onPointerUp = useCallback((e) => {
    if (!dragRef.current) return
    dragRef.current = null
    setDial(id, T(id), true) // commit at current dragged value
  }, [id])

  const onWheel = useCallback((e) => {
    e.preventDefault()
    setDial(id, T(id) + (e.deltaY < 0 ? 1 : -1), true)
  }, [id])

  const onDoubleClick = useCallback(() => resetDial(id), [id])

  // 270° sweep, -135deg (min) to +135deg (max), matching a physical mixer knob.
  const rotation = -135 + (value / 100) * 270

  return (
    <div className="flex flex-col items-center gap-1.5 select-none">
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        className="relative w-12 h-12 rounded-full cursor-ns-resize touch-none"
        style={{
          background: 'radial-gradient(circle at 35% 30%, #3a3a3a, #161616 70%)',
          boxShadow: isOverridden
            ? '0 0 0 2px rgba(167,139,250,0.6), 0 2px 6px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.15)'
            : '0 2px 6px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.1)',
        }}
        title={`${label}: ${Math.round(value)} — drag to turn, scroll to nudge, double-click to reset`}
      >
        <div
          className="absolute left-1/2 top-1/2 w-[3px] h-4 rounded-full bg-white/80"
          style={{ transform: `translate(-50%, -100%) rotate(${rotation}deg)`, transformOrigin: '50% 100%' }}
        />
      </div>
      <span className="text-[9px] font-semibold tracking-wide text-white/70">{label}</span>
      <span className="text-[9px] tabular-nums text-white/40">{Math.round(value)}</span>
    </div>
  )
}

export default function TuningBoard({ engine, onClose }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exportSnippet())
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard blocked — snippet is still in exportSnippet() if needed via console */ }
  }

  return (
    <div
      className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 flex items-end gap-5 px-5 py-4 rounded-2xl"
      style={{
        background: 'linear-gradient(180deg, rgba(20,20,20,0.92), rgba(10,10,10,0.96))',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
        backdropFilter: 'blur(12px)',
      }}
    >
      {DIALS.map(d => <Knob key={d.id} id={d.id} label={d.label} engine={engine} />)}

      <div className="w-px self-stretch bg-white/10 mx-1" />

      {/* Engine A/B — a toggle switch, not a knob, next to the dials like a mixer's routing switch */}
      <div className="flex flex-col items-center gap-1.5">
        <button
          onClick={() => setEngine(engine === 'mesh' ? 'circles' : 'mesh')}
          className="w-12 h-6 rounded-full relative transition-colors duration-150 cursor-pointer"
          style={{ background: engine === 'mesh' ? 'rgba(167,139,250,0.5)' : 'rgba(255,255,255,0.15)' }}
          title="Switch gradient engine (mesh / circles)"
        >
          <div
            className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-150"
            style={{ transform: engine === 'mesh' ? 'translateX(26px)' : 'translateX(2px)' }}
          />
        </button>
        <span className="text-[9px] font-semibold tracking-wide text-white/70">{engine === 'mesh' ? 'MESH' : 'CIRCLES'}</span>
      </div>

      <div className="w-px self-stretch bg-white/10 mx-1" />

      <div className="flex flex-col items-center gap-2">
        <button
          onClick={copy}
          className="text-[10px] font-semibold tracking-wide text-white bg-white/10 hover:bg-white/20 transition-colors duration-150 cursor-pointer px-3 py-1.5 rounded-lg"
        >
          {copied ? 'COPIED ✓' : 'COPY VALUES'}
        </button>
        <button
          onClick={clearDials}
          disabled={!hasOverrides()}
          className="text-[10px] font-medium tracking-wide text-white/50 hover:text-white/80 disabled:opacity-30 disabled:cursor-default transition-colors duration-150 cursor-pointer"
        >
          RESET ALL
        </button>
      </div>
    </div>
  )
}
```

**Four corrections made to that draft when it was actually built (the shipped file is the source of truth):**

1. **The draft never re-rendered.** `Knob` reads `T(id)` at render time, but the dial store lives outside React — nothing in the draft subscribes to `TUNING_EVENT`, so turning a knob would move the store (and the gradient) while the knob itself sat frozen at 50 and RESET ALL stayed permanently disabled. The shipped board holds one `TUNING_EVENT` subscription and force-renders the whole board; the `Knob`s aren't memoized, so they follow.
2. **`onWheel` + `preventDefault()` don't mix in React.** React binds `wheel` at the root as a *passive* listener, where `preventDefault()` is a no-op plus a console warning. Wheel is now attached per-knob via `addEventListener('wheel', h, { passive: false })`.
3. **Positioning:** the board is `fixed ... z-[60]`, not `absolute ... z-30` — it has to clear `LiveScreen`'s own `z-50` full-screen container.
4. **`engineLocked` prop:** when `?gradient=` is in the URL it beats localStorage inside `getMeshGradientFlag()`, so the switch is disabled and labeled rather than lying about which renderer is on screen.

- [ ] **Step 2: Commit**

```bash
git add src/components/TuningBoard.jsx
git commit -m "tuning: DJ-mixer TuningBoard UI — 6 rotary knobs + engine switch"
```

---

### Task 8 (REVISED TWICE — this is what was built): visible Tune button → real shuffled session + test screen

Revision 1 (after Tasks 1-7 landed): "the dials should live on a 'test screen', ie not the live screen" — a `g` hotkey over the real Live screen is a live-show risk. That produced a draft with a `t` hotkey and a static `<select>` song picker.

Revision 2 (Ben, correcting that draft): *"the space bar still plays hte live screen. you have to manually click the test screen and then it shuffles, and thats where i can play with the dials."*

So the shipped design is:

- **No hotkey anywhere.** The `t` hotkey from the previous draft is dropped — a second hidden hotkey was exactly the live-show risk revision 1 was avoiding. Entry is a **visible `Tune` button** in `Jukebox.jsx`'s header, sibling to the existing `Live` toggle, always shown.
- **Clicking it shuffles for real.** `openTuning()` calls the same `startShuffle()` the Space bar calls — real audio, real palette fetches, real crossfades. The static song picker is deleted: tuning a background against a still frame tells you nothing about the entrance blend, the song-to-song sweep, or blob drift behind a spinning record, which is the whole thing being judged.
- **The board bolts onto the real `LiveScreen`.** `TestScreen.jsx` mounts `<LiveScreen>` (unmodified — same props the real `{showLive && ...}` block passes, minus `ending`, which is always `false` here) with `<TuningBoard>` as a sibling overlay, always visible.
- **Separate code path from the real Live flow.** `Jukebox.jsx` keeps a `tuningRef`; while it's set, the confirmed-track watcher opens `showTest` **instead of** `showLive`. `showLive` therefore never flips true during a tuning session, so the Space bar, the `Live` header toggle and the `b` handoff behave exactly as before. `openTuning` also clears `showLive`/`liveEnding` so the two screens can never stack.
- **Closing stops playback cleanly.** `LiveScreen`'s own ✕ and its `Escape` handler both call `closeTuning`, which clears `tuningRef` + the pending-open refs, unmounts the screen, then calls the existing `handleStop()`. Because `showLive` was false the whole time, `handleStop` takes its `else` branch — no `liveEnding` is ever set, so nothing is left half-open for Space or `b` to trip over.

**Files:**
- Create: `src/components/TestScreen.jsx`
- Modify: `src/components/Jukebox.jsx` — import, `showTest` state + `tuningRef`, watcher routing, `openTuning`/`closeTuning`, header button, mount point.
- `src/components/LiveScreen.jsx` — **untouched.**

- [ ] **Step 1: `TestScreen.jsx`**

Renders `<LiveScreen key={liveKey} …/>` plus `<TuningBoard engine … engineLocked …/>`, and owns two pieces of state:

- `engine` / `locked`, read through a `readEngine()` that mirrors `LiveScreen.getMeshGradientFlag()` exactly (`?gradient=` beats localStorage) so the switch can't display a renderer that isn't on screen.
- `liveKey`, bumped on `TUNING_EVENT` when `detail.committed && (detail.remount || detail.server)`.

The remount is necessary, not defensive — three separate reasons, verified in the code:
- `getMeshGradientFlag()` is read once per `LiveScreen` mount (`useState(getMeshGradientFlag)`), so the engine switch needs one.
- MOTION and SIZE are baked into `useMemo(makeCircleParams, [])` / `useMemo(makeBlobParams, [])` inside the renderers — a plain re-render keeps the old blob speed and size.
- VARIETY changes the `/api/palette` query string, and `usePalette` only refetches when its effect re-runs.

BRIGHTNESS, BLEND and CROSSFADE are read per draw frame (and per blend tick), so they deliberately do **not** remount — they apply mid-drag with no snap. The `committed` guard is what keeps a `release` dial from remounting the turntable on every drag pixel.

- [ ] **Step 2: `Jukebox.jsx` wiring**

```js
const [showTest, setShowTest] = useState(false)
const tuningRef = useRef(false)
```

In the confirmed-track watcher (`useEffect` on `player.currentTrack?.uri`):

```js
if (tuningRef.current) setShowTest(true)
else setShowLive(true)
```

`openTuning` (header button) sets `tuningRef`, clears `showLive`/`liveEnding`, mounts `TestScreen` immediately — `LiveScreen`'s empty-platter waiting state covers the gap until the SDK confirms the first track — then calls `startShuffle()`. `closeTuning` clears `tuningRef` and `pendingLiveOpenRef`/`pendingUriRef` (otherwise a track confirming a beat after close would pop the real Live screen open over the library), unmounts, and calls `handleStop()`.

- [ ] **Step 3: Commit**

```bash
git add src/components/TestScreen.jsx src/components/Jukebox.jsx
git commit -m "tuning: visible Tune button opens a real shuffled tuning session with the board"
```

---

### Task 8 (ORIGINAL, SUPERSEDED — kept for reference only, do not execute): `LiveScreen.jsx` — hotkey, mount, remount-on-bake

**Files:**
- Modify: `src/components/LiveScreen.jsx:1-5` (imports)
- Modify: `src/components/LiveScreen.jsx` — add board state + `g` hotkey effect
- Modify: `src/components/LiveScreen.jsx:462` (`GradientBg` render — add remount `key`)
- Modify: `src/components/LiveScreen.jsx` — render `TuningBoard` when open

- [ ] **Step 1: Imports**

Replace `src/components/LiveScreen.jsx:1-6`:

```js
import { useState, useEffect, useRef, memo } from 'react'
import { motion, useAnimation } from 'framer-motion'
import AlbumGradient from './AlbumGradient'
import AlbumGradientMesh from './AlbumGradientMesh'
import { usePalette } from '../hooks/usePalette'
import { displayName } from '../lib/track'
```

with:

```js
import { useState, useEffect, useRef, memo } from 'react'
import { motion, useAnimation } from 'framer-motion'
import AlbumGradient from './AlbumGradient'
import AlbumGradientMesh from './AlbumGradientMesh'
import TuningBoard from './TuningBoard'
import { usePalette } from '../hooks/usePalette'
import { displayName } from '../lib/track'
import { TUNING_EVENT } from '../lib/gradientTuning.js'
```

- [ ] **Step 2: Board-open state, `g` hotkey, remount key, live engine re-read**

Add inside the `LiveScreen` function body, right after the existing `const [useMeshGradient] = useState(getMeshGradientFlag)` line (~line 92):

```js
  // Tuning board — hidden behind `g`. Distinct from `useMeshGradient` above
  // (that one's read once at mount): `engine` here is live-updated so the
  // board's engine A/B switch swaps the renderer without a full remount of
  // LiveScreen itself, just of GradientBg via gradientKey below.
  const [engine, setEngineState] = useState(useMeshGradient ? 'mesh' : 'circles')
  const [boardOpen, setBoardOpen] = useState(false)
  const [gradientKey, setGradientKey] = useState(0) // bumped to remount GradientBg for 'remount: true' dials

  useEffect(() => {
    const onTuningChange = (e) => {
      if (e.detail?.id === '__engine') {
        setEngineState(localStorage.getItem('trivia_gradient_engine') === 'circles' ? 'circles' : 'mesh')
      }
      if (e.detail?.remount) setGradientKey(k => k + 1)
    }
    window.addEventListener(TUNING_EVENT, onTuningChange)
    return () => window.removeEventListener(TUNING_EVENT, onTuningChange)
  }, [])

  useEffect(() => {
    const onKey = (e) => {
      if (e.repeat) return
      if (e.key === 'g' || e.key === 'G') setBoardOpen(v => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
```

- [ ] **Step 3: `Escape` closes the board before it closes the Live screen**

Find the existing Escape handler (`src/components/LiveScreen.jsx:450-457`):

```js
  useEffect(() => {
    const h = e => {
      if (e.repeat) return
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
```

replace with:

```js
  useEffect(() => {
    const h = e => {
      if (e.repeat) return
      if (e.key !== 'Escape') return
      if (boardOpen) { setBoardOpen(false); return }
      onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, boardOpen])
```

- [ ] **Step 4: `GradientBg` — remount key, use live `engine` instead of the mount-once flag**

Replace `src/components/LiveScreen.jsx:462`:

```js
      <GradientBg colors={paletteColors} nextColors={upcomingPaletteColors} active={!isPaused || transitioning} shuffleKey={shuffleKey} entranceActive={entranceActive} />
```

with:

```js
      {(() => {
        const GradientBgLive = engine === 'mesh' ? AlbumGradientMesh : AlbumGradient
        return (
          <GradientBgLive
            key={gradientKey}
            colors={paletteColors} nextColors={upcomingPaletteColors}
            active={!isPaused || transitioning} shuffleKey={shuffleKey} entranceActive={entranceActive}
          />
        )
      })()}
      {boardOpen && <TuningBoard engine={engine} onClose={() => setBoardOpen(false)} />}
```

Note: the `key={gradientKey}` remount is intentional and necessary — MOTION and SIZE are baked into `useMemo(makeCircleParams/makeBlobParams, [])`'s one-time result (Task 5/6), so a plain re-render wouldn't pick up a committed change; remounting the component re-runs that `useMemo`. This trades a one-frame snap on those two dials specifically for keeping `makeCircleParams`'s per-frame draw loop simple — acceptable while actively tuning, and those two dials only remount on pointer-release (`commit: 'release'` in the registry), never mid-drag.

- [ ] **Step 5: Commit**

```bash
git add src/components/LiveScreen.jsx
git commit -m "tuning: g hotkey mounts TuningBoard; live engine switch + remount-on-bake"
```

---

### Task 9: Verification

**Files:** none (verification only)

- [ ] **Step 1: Static syntax check every touched/new file**

`npm run dev` and `vitest run` are both broken in this sandbox (rolldown native-binding issue) — this is the substitute. One flag set works for every file:

```bash
cd ~/Projects/baynes-trivia/trivia-jukebox
for f in src/lib/paletteDefaults.js src/lib/gradientTuning.js \
         src/components/TuningBoard.jsx src/components/TestScreen.jsx \
         src/components/AlbumGradient.jsx src/components/AlbumGradientMesh.jsx \
         src/components/LiveScreen.jsx src/components/Jukebox.jsx api/palette.js; do
  echo "=== $f"
  npx esbuild "$f" --loader:.jsx=jsx --bundle --format=esm --platform=node \
    --external:react --external:framer-motion --external:sharp \
    --external:./* --external:../lib/* --external:../hooks/* --external:../src/lib/* \
    --outfile=/tmp/check.js
done
```

Expected: every command exits 0 with a `⚡ Done` line. Verified 2026-07-27 — all 9 pass.

- [ ] **Step 2: Manual live checklist on `trivia-jukebox.vercel.app`**

Nothing here is automatable: Playwright can't get through Spotify's OAuth, so playback and the gradient have to be eyeballed.

1. **Real Live path is untouched.** Press `Space` from the library view — normal shuffled playback, the real Live screen, no board anywhere on it. `Escape`, then `Space` again — still clean.
2. Click **Tune** in the header — a shuffled song starts and the test screen opens: real turntable, real entrance, board along the bottom.
3. Drag **BRIGHTNESS** up — the background pops brighter *while dragging* (live dial, no snap, no remount).
4. Drag **BLEND** — colors separate into distinct bodies vs. one creamy average, again live.
5. Drag **MOTION** or **SIZE**, then release — the blobs' speed/size changes on release (the documented one-frame remount, which restarts the record entrance), not during the drag.
6. Drag **VARIETY**, release — remount + palette refetch; the background should shift toward more/fewer distinct hues.
7. Drag **CROSSFADE** low, then skip a song — the song-to-song background sweep is visibly quicker.
8. Flip the **engine switch** — mesh ↔ circles swap, label follows, board stays put.
9. **COPY VALUES** → paste into a scratch file: real numbers (`const CHROMA_SCALE = 1.02`), no `NaN`/`undefined`. Clipboard blocked? It's also `console.log`ged.
10. **RESET ALL** → every knob back to center and the background back to exactly today's look.
11. Reload, hit **Tune** again — knob positions survived (localStorage).
12. **Close and re-check isolation:** ✕ or `Escape` — audio fades, the library view returns, no Live screen pops open a beat later. Then `Space` → normal Live playback, and hold `b` → the Trivia OS handoff still runs its stop-and-animate exit.

- [ ] **Step 3: Final commit (plan doc)**

```bash
git add docs/superpowers/plans/2026-07-27-dj-tuning-board.md
git commit -m "docs: DJ tuning board plan matches shipped Tune-button/test-screen flow"
```

---

## Self-Review

**Spec coverage:** all 6 dials from the table are implemented end to end (registry → derived value → renderer read → board control); the engine switch reuses the existing `trivia_gradient_engine` mechanism, localStorage persistence and copy-to-clipboard export are per the original constraints. Two design calls moved during the build, both from Ben: scope (6 dials, not 40), and entry point (a visible **Tune** button that starts a real shuffled session — not the `g` hotkey over the Live screen this plan opened with, and not the `t` hotkey + static song picker of the first revision).

**Corrections made at build time (2026-07-27), all folded into the task text above:**
- `paletteDefaults.js` — `Number(x) ?? 50` doesn't catch `NaN`; a bad `t_VARIETY` reached `HUE_GAP_DEG: NaN`. Now guarded with `Number.isFinite`.
- `gradientTuning.js` — the three BRIGHTNESS curves resolved to 0.85/0.625/0.40 at dial 50 instead of the shipped 0.82/0.62/0.38, so opening the board would have nudged the background before Ben touched anything. Ranges re-centered; all six dials now reproduce today's exact values at 50 (checked by hand, not by comment).
- `TuningBoard.jsx` — the Task 7 draft had no `TUNING_EVENT` subscription, so knobs would never have visually turned; and its `onWheel` + `preventDefault()` is a no-op under React's passive root listener. Both fixed (see the four notes under Task 7).
- `AlbumGradient.jsx`'s two gradient caches (`blendCacheRef`, `gradCacheRef`) were traced against a BRIGHTNESS/BLEND turn: each carries its own `tv` field compared to `tuningVersion()`, so both rebuild. Correct as written.

**Placeholder scan:** no TBD/"add appropriate handling" in any step; every code block is the literal diff or full new file.

**Type/name consistency:** `T`, `setDial`, `resetDial`, `clearDials`, `DIALS`, `TUNING_EVENT` used identically across Tasks 2, 4, 5, 6, 7, 8. `varietyToConfig`/`resolvePaletteConfig` (Task 1) match their usage in Task 2 (client) and Task 3 (server) exactly — same function names, same shape (`{ cfg, overridden }` / `{ HUE_GAP_DEG, MIN_COLORS }`).
