import sharp from 'sharp';
import { resolvePaletteConfig } from '../src/lib/paletteDefaults.js';

// Simplified 2026-08-04 (owner request, live) — the previous version of
// this file (see git history for the full thing, ~1150 lines) accumulated
// a lot of cover-specific-tuned complexity over several sessions: a
// "muddy-warm hue pocket" recoloring model, OKLab-based accent-hue
// placement math for single-hue-family covers, a MIN_COLORS padding/
// round-robin system, hue-sibling merging. All of it existed to make the
// AUTO-suggested two colors look good on every cover with zero manual
// intervention. But every song's two colors are picked/adjustable by hand
// in SongDetailModal's popup — those ARE the master colors for that song,
// not a preview of an algorithm's best guess — so automatically nailing
// every cover stopped being worth the weight. This version finds two real,
// sufficiently distinct, non-near-black colors from the cover and hands
// them over; anything that reads wrong gets fixed by hand in the popup,
// same as any other song. `index 2+` of a returned colors array was
// already dead code downstream (LiveScreen's pickGradientColors
// unconditionally slices to 2), so this only ever needs to find 2.

// Owner spec (2026-08-04): "for black albums, take the neon purple or pink
// as a primary color, i dont want black in the background anywhere." 300
// (magenta-purple) and 330 (hot pink) are 30deg apart -- close enough to
// read as one family, far enough to still have visible gradient motion.
export function pickMonochromeAccentHues() {
  return [300, 330];
}

// Matches LiveScreen.jsx's safeGradientColor threshold (luma < 60 -> hot-pink
// fallback) — 2026-08-06, Ben: shuffled and got a pure-pink background. This
// floor used to sit at 30, letting the server hand back real dark colors
// that the client's safety net then silently swapped for neon pink on
// render, since it never accepted anything below 60. Raised to match so a
// server-picked color always survives the client's own check.
const LUMA_THRESHOLD = 60;
const CHROMA_FLOOR = 0.12;   // below this, a candidate is too washed-out to read as a real color

export default async function handler(req, res) {
  const { url } = req.query;
  const { cfg, overridden } = resolvePaletteConfig(req.query);

  if (!url) return res.status(400).json({ error: 'Missing url param' });

  // Only allow Spotify CDN images — check the actual hostname, not a
  // substring match (which a query string like ?x=i.scdn.co could spoof).
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return res.status(400).json({ error: 'Invalid image source' });
  }
  if (hostname !== 'i.scdn.co' && hostname !== 'mosaic.scdn.co') {
    return res.status(400).json({ error: 'Invalid image source' });
  }

  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Resize to 150×150, drop alpha, get raw RGB bytes
    const { data, info } = await sharp(buffer)
      .resize(150, 150)
      .removeAlpha()
      .toColorspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Sample every 3rd pixel so median-cut runs on ~7 500 points
    const ch = info.channels; // 3 after removeAlpha
    const pixels = [];
    for (let i = 0; i < data.length; i += ch * 3) {
      pixels.push([data[i], data[i + 1], data[i + 2]]);
    }

    // 8 buckets is plenty when only the top 2 distinct-enough candidates
    // ever get used — the old 12-bucket ask existed to feed a 5-8 color
    // output that nothing downstream actually read past index 1.
    const candidates = medianCut(pixels, 8);
    const ranked = candidates
      .map(({ hex, population }) => ({
        hex,
        population,
        chroma: hexToChroma(hex),
        hue: hexToHue(hex),
        luma: hexToLuma(hex),
      }))
      .filter(c => c.luma >= LUMA_THRESHOLD && c.chroma > CHROMA_FLOOR)
      // Population-weighted (sqrt-dampened so a merely-bigger bucket can't
      // bury a much more vivid, smaller one) so the cover's actual dominant
      // color competes fairly against a small vivid accent, without letting
      // size alone win.
      .sort((a, b) => (b.chroma * Math.sqrt(b.population)) - (a.chroma * Math.sqrt(a.population)));

    const HUE_GAP_DEG = cfg.HUE_GAP_DEG;
    const picked = [];
    for (const c of ranked) {
      if (picked.some(p => hueDelta(p.hue, c.hue) < HUE_GAP_DEG)) continue;
      picked.push(c);
      if (picked.length >= 2) break;
    }
    // Only one real distinct hue in the cover — fill the second slot with
    // the next-best real candidate regardless of hue gap (a lighter/darker
    // shade of the same family), rather than inventing a hue that isn't
    // actually in the art.
    if (picked.length < 2) {
      for (const c of ranked) {
        if (picked.includes(c)) continue;
        picked.push(c);
        if (picked.length >= 2) break;
      }
    }

    let colors, weights;
    if (picked.length === 0) {
      // Genuinely no real color anywhere in the cover (true grayscale) —
      // fixed neon accent pair, lightness-matched to the art's own average
      // brightness so a dark B&W cover still gets a dark accent, not a
      // jarring bright patch.
      const avgLuma = pixels.reduce((sum, [r, g, b]) => sum + (0.299 * r + 0.587 * g + 0.114 * b), 0) / pixels.length / 255;
      const [hue] = pickMonochromeAccentHues();
      const accent = hslToHex(hue, 0.65, Math.min(0.75, Math.max(0.38, avgLuma)));
      const offwhite = hslToHex(hue, 0.10, 0.94);
      colors = [accent, offwhite];
      weights = [0.5, 0.5];
    } else if (picked.length === 1) {
      // Exactly one usable candidate and nothing in `ranked` to pair it with.
      // Duplicating the hex gave both anchors the identical color, so the
      // two-color collision had nothing to blend between and the background
      // sat motionless. Derive the second anchor as a lightness-shifted
      // variant of the same hue instead — same trick the grayscale branch
      // above uses when there's no second real color.
      const { hue, luma: luma255 } = picked[0];
      const luma = luma255 / 255; // hexToLuma returns 0-255; hslToHex wants 0-1 (see avgLuma above)
      // Floor 0.28, not 0.15 (2026-08-07, Opus review): a luma255 128-149
      // candidate shifted down to 0.15-0.23 lightness comes back under this
      // file's own LUMA_THRESHOLD (60/255 = 0.235) once converted to RGB, so
      // LiveScreen's client-side safeGradientColor check was substituting a
      // hot-pink fallback for the very color this branch just picked. 0.28
      // keeps the shifted anchor's luma safely above 60 with margin.
      const shiftedLuma = luma > 0.5 ? Math.max(0.28, luma - 0.35) : Math.min(0.85, luma + 0.35);
      const shifted = hslToHex(hue, 0.55, shiftedLuma);
      colors = [picked[0].hex, shifted];
      weights = [0.6, 0.4];
    } else {
      colors = picked.map(c => c.hex);
      const totalPop = picked.reduce((s, c) => s + c.population, 0);
      weights = totalPop > 0 ? picked.map(c => c.population / totalPop) : [0.5, 0.5];
    }

    // Album art URLs are stable — cache aggressively, UNLESS the tuning
    // board is live-testing a VARIETY value, in which case caching would
    // serve a stale palette back to the board mid-tune.
    res.setHeader('Cache-Control', overridden ? 'no-store' : 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json({ colors, weights });
  } catch (err) {
    console.error('[palette]', err.message);
    return res.status(500).json({ error: 'Extraction failed' });
  }
}

// ── Median-cut color quantisation ─────────────────────────────────────────

function channelRange(bucket, c) {
  let min = 255, max = 0;
  for (const p of bucket) {
    if (p[c] < min) min = p[c];
    if (p[c] > max) max = p[c];
  }
  return max - min;
}

function medianCut(pixels, numColors) {
  let buckets = [pixels];

  while (buckets.length < numColors) {
    let maxRange = 0, splitIdx = 0, splitChannel = 0;
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].length <= 1) continue;
      for (let c = 0; c < 3; c++) {
        const range = channelRange(buckets[i], c);
        if (range > maxRange) { maxRange = range; splitIdx = i; splitChannel = c; }
      }
    }
    if (maxRange === 0) break; // no bucket can be split further

    const bucket = buckets[splitIdx];
    bucket.sort((a, b) => a[splitChannel] - b[splitChannel]);
    const mid = Math.floor(bucket.length / 2);
    buckets.splice(splitIdx, 1, bucket.slice(0, mid), bucket.slice(mid));
  }

  // Represent each bucket by the average of its top-chroma pixel cohort
  // (chroma >= 0.85 x the bucket's own max), not a flat average of the
  // whole bucket — a flat average blends a small vivid region (a logo, an
  // accent patch) away to nothing against a much larger neutral one. The
  // 0.85 cohort also avoids the opposite failure of picking a single
  // compression-spike pixel as the "representative" color.
  return buckets.map(bucket => {
    let bestChroma = -1;
    for (const p of bucket) {
      const c = pixelChroma(p);
      if (c > bestChroma) bestChroma = c;
    }
    const thr = bestChroma * 0.85;
    let n = 0, r = 0, g = 0, b = 0;
    for (const p of bucket) {
      if (pixelChroma(p) >= thr) { n++; r += p[0]; g += p[1]; b += p[2]; }
    }
    return { hex: toHex(Math.round(r / n), Math.round(g / n), Math.round(b / n)), population: bucket.length };
  });
}

function pixelChroma([r, g, b]) {
  return (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
}

function toHex(r, g, b) {
  return '#' + [r, g, b]
    .map(v => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0'))
    .join('');
}

// ── Color helpers ──────────────────────────────────────────────────────────

function hexToChroma(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return pixelChroma([r, g, b]);
}

function hexToLuma(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function hexToHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

// Shortest angular distance between two hues, 0-180.
function hueDelta(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60)       [r, g, b] = [c, x, 0];
  else if (h < 120)  [r, g, b] = [x, c, 0];
  else if (h < 180)  [r, g, b] = [0, c, x];
  else if (h < 240)  [r, g, b] = [0, x, c];
  else if (h < 300)  [r, g, b] = [x, 0, c];
  else               [r, g, b] = [c, 0, x];
  return toHex(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255));
}
