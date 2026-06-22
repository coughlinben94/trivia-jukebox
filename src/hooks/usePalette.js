import { useState, useEffect, useRef } from 'react';

const cache = new Map();

// Fallback: deep blue/purple — looks good if palette fails
const FALLBACK = ['#1a1a2e', '#16213e', '#533483', '#e94560', '#0f3460', '#f5a623'];

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
