import { useEffect, useRef, useMemo } from 'react';

const NUM_BLOBS = 8;

// Seeded pseudo-random — deterministic per blob index so layout is stable on re-render
function sr(seed) {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function makeBlobParams(i) {
  return {
    size:    180 + sr(i * 7 + 0) * 220,   // 180–400px
    xCenter: 15  + sr(i * 7 + 1) * 70,    // 15–85% base X
    yCenter: 15  + sr(i * 7 + 2) * 70,    // 15–85% base Y
    xAmp:    18  + sr(i * 7 + 3) * 18,    // drift amplitude %
    yAmp:    15  + sr(i * 7 + 4) * 18,
    xFreq:   0.05 + sr(i * 7 + 5) * 0.08, // cycles/sec — very slow
    yFreq:   0.04 + sr(i * 7 + 6) * 0.07,
    xPhase:  sr(i * 7 + 7) * Math.PI * 2, // start offset so blobs are spread at t=0
    yPhase:  sr(i * 7 + 8) * Math.PI * 2,
  };
}

// Darken a hex color to use as the container background
// The gooey filter (blur+contrast) needs a near-black bg to work
function darken(hex, factor = 0.12) {
  if (!hex || hex.length < 7) return '#080808';
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * factor);
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * factor);
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * factor);
  return `rgb(${r},${g},${b})`;
}

export default function LavaLamp({ colors = [], active = true }) {
  const blobRefs = useRef([]);
  const rafRef   = useRef(null);

  const params = useMemo(() => Array.from({ length: NUM_BLOBS }, (_, i) => makeBlobParams(i)), []);

  // Distribute palette colors across blobs — cycle if fewer colors than blobs
  const blobColors = useMemo(
    () => Array.from({ length: NUM_BLOBS }, (_, i) => colors[i % colors.length] ?? '#1a1a2e'),
    [colors]
  );

  // Background: heavily darkened version of the muted anchor color
  const bgColor = darken(colors[3] ?? colors[0] ?? '#111111');

  // RAF animation loop — direct DOM mutation for perf (no React re-renders per frame)
  useEffect(() => {
    if (!active) return;
    const animate = () => {
      const t = performance.now() / 1000;
      blobRefs.current.forEach((el, i) => {
        if (!el) return;
        const p = params[i];
        const x = p.xCenter + p.xAmp * Math.sin(t * p.xFreq + p.xPhase);
        const y = p.yCenter + p.yAmp * Math.sin(t * p.yFreq + p.yPhase);
        el.style.left = `${x}%`;
        el.style.top  = `${y}%`;
      });
      rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, params]);

  // Smooth color transitions between tracks — CSS transition handles the fade
  useEffect(() => {
    blobRefs.current.forEach((el, i) => {
      if (el) el.style.backgroundColor = blobColors[i];
    });
  }, [blobColors]);

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      overflow: 'hidden',
      backgroundColor: bgColor,
      transition: 'background-color 3s ease',
      zIndex: 0,
    }}>
      {/* The gooey trick: blur makes blobs soft, contrast snaps edges back —
          but where two blobs overlap, their blurred edges merge before the
          contrast threshold, creating the liquid merging effect */}
      <div style={{
        position: 'absolute',
        inset: 0,
        filter: 'blur(35px) contrast(10)',
      }}>
        {params.map((p, i) => {
          // Compute initial position at t=0 so there's no flash on first paint
          const initX = p.xCenter + p.xAmp * Math.sin(p.xPhase);
          const initY = p.yCenter + p.yAmp * Math.sin(p.yPhase);
          return (
            <div
              key={i}
              ref={el => (blobRefs.current[i] = el)}
              style={{
                position: 'absolute',
                width:  p.size,
                height: p.size,
                borderRadius: '50%',
                backgroundColor: blobColors[i],
                transform: 'translate(-50%, -50%)',
                left: `${initX}%`,
                top:  `${initY}%`,
                transition: 'background-color 2.5s ease',
                willChange: 'left, top',
              }}
            />
          );
        })}
      </div>

      {/* Subtle dark veil — keeps the turntable and text readable without killing the color */}
      <div style={{
        position: 'absolute',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.30)',
        zIndex: 1,
      }} />
    </div>
  );
}
