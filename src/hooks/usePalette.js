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
