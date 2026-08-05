import { useState, useEffect, useRef } from 'react';
import { paletteQuery } from '../lib/gradientTuning.js';

const cache = new Map();

// Fallback while a palette is loading/fails — near-black, all gradient
// components cycle through whatever-length array is given so this doesn't
// need to match either gradient's exact color count. Equal weights since
// there's no real data to weight by.
const FALLBACK_COLORS = ['#080808', '#080808', '#080808', '#080808', '#080808'];
const FALLBACK = { colors: FALLBACK_COLORS, weights: FALLBACK_COLORS.map(() => 0.2) };

// Palette response version — BUMP THIS whenever api/palette.js changes what
// it returns (new fields, different color/weight semantics). It rides in the
// fetch URL, so a bump rotates the CDN cache key and kills every stale edge
// entry the moment the deploy lands. Why it exists: /api/palette caches with
// s-maxage=86400, and a deploy does NOT purge those entries — on 2026-07-30
// the weights/hue-merge/accent fixes were live in code while the CDN kept
// serving pre-fix payloads (5 colors, no `weights`) for up to 24h per cover.
// normalize() below then fell back to EQUAL weights, which is exactly the
// equal-share condition the day's fixes existed to remove — random covers
// kept rendering as "lava lamp" out of the renderer's control. Verified live:
// the same production endpoint returned weighted output for one cover and
// pre-weights output for three others in the same minute.
// v3 (2026-07-30 late): accent saturation became chroma-ratio-derived in
// api/palette.js's single-real-hue branch — server output changed, so the
// version rotates every CDN key at deploy (owner: "when you push, lets
// clear the cache").
// v4 (same night): medianCut bucket representative changed from single
// most-vivid pixel to top-chroma-cohort average (de-neon/de-spike).
// v5 (2026-08-03): true-monochrome covers now receive a neon purple/pink
// fallback pair instead of the previous blue/orange API output.
// v6 (same day): single-real-hue branch's synthetic accent moved from
// index 2 (dead -- pickGradientColors never reads past index 1) to index
// 1, and ACCENT_WEIGHT 0.15 -> 0.30 -- both change this branch's server
// output, and s-maxage=86400 means an unbumped version can serve the old
// accent placement/weight for up to 24h post-deploy.
// v7 (same day): ACCENT_WEIGHT 0.30 -> 0.40 (60/40, owner spec).
export const PALETTE_VERSION = 7;
const versionQuery = `&pv=${PALETTE_VERSION}`;

// Cache key includes the version + tuning query so a VARIETY-overridden fetch
// never collides with (or overwrites) the default-palette entry for the same
// art, and a version bump never reuses a pre-bump entry.
const cacheKey = (url) => url + versionQuery + paletteQuery();

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
  fetch(`/api/palette?url=${encodeURIComponent(albumArtUrl)}${versionQuery}${paletteQuery()}`)
    .then(r => r.json())
    .then(data => {
      if (data.colors?.length >= 2) cache.set(key, normalize(data));
    })
    .catch(() => {});
}

export function usePalette(albumArtUrl) {
  const [palette, setPalette] = useState(FALLBACK);
  const abortRef = useRef(null);
  // abort() only preempts a fetch/.json() promise that hasn't settled yet —
  // once it resolves, the queued .then() below runs regardless. A fast
  // skip streak (song A -> B -> C) can have B's response land after C's
  // effect has already moved on, so the state write also needs its own
  // "is this still the current request" check, not just the AbortController.
  const latestKeyRef = useRef(null);
  // Re-added (2026-08-04) — pulled during a blanket revert of the audit
  // session's changes when a DIFFERENT file's change (a bail-checkpoint in
  // LiveScreen.jsx's runTransition) caused a real bug on the entrance. This
  // file's change is independent and was never implicated — live evidence
  // (screenshot: every auto-picked swatch in SongDetailModal pinned at
  // near-black #080808 for a song whose art clearly isn't black) confirms
  // the exact failure mode this retry exists to catch: one failed fetch
  // (cold serverless start, dropped request) previously left a song's
  // background wrong for its entire playback with nothing to ever re-fire
  // it. One retry after a short delay covers the common transient case.
  const retryTimerRef = useRef(null);

  useEffect(() => {
    if (!albumArtUrl) return;
    const key = cacheKey(albumArtUrl)
    latestKeyRef.current = key;

    if (cache.has(key)) {
      setPalette(cache.get(key));
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    clearTimeout(retryTimerRef.current);
    const controller = new AbortController();
    abortRef.current = controller;
    setPalette(FALLBACK);

    const url = `/api/palette?url=${encodeURIComponent(albumArtUrl)}${versionQuery}${paletteQuery()}`;

    const attempt = (isRetry) => {
      fetch(url, { signal: controller.signal })
        .then(r => r.json())
        .then(data => {
          if (data.colors?.length >= 2) {
            const p = normalize(data);
            cache.set(key, p);
            if (latestKeyRef.current === key) setPalette(p);
          }
        })
        .catch(err => {
          if (err.name === 'AbortError') return;
          if (!isRetry) {
            retryTimerRef.current = setTimeout(() => {
              if (latestKeyRef.current === key) attempt(true);
            }, 1200);
          } else {
            console.warn('[usePalette] falling back to defaults:', err.message);
          }
        });
    };
    attempt(false);

    return () => {
      controller.abort();
      clearTimeout(retryTimerRef.current);
    };
  }, [albumArtUrl, paletteQuery()]);

  return palette;
}
