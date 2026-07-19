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

export function usePalette(albumArtUrl) {
  const [colors, setColors] = useState(FALLBACK);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!albumArtUrl) return;

    if (cache.has(albumArtUrl)) {
      setColors(cache.get(albumArtUrl));
      return;
    }

    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setColors(FALLBACK);

    fetch(`/api/palette?url=${encodeURIComponent(albumArtUrl)}`, {
      signal: controller.signal,
    })
      .then(r => r.json())
      .then(data => {
        if (data.colors?.length >= 2) {
          cache.set(albumArtUrl, data.colors);
          setColors(data.colors);
        }
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          console.warn('[usePalette] falling back to defaults:', err.message);
        }
      });

    return () => controller.abort();
  }, [albumArtUrl]);

  return colors;
}
