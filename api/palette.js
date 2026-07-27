import sharp from 'sharp';
import { resolvePaletteConfig } from '../src/lib/paletteDefaults.js';

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

    // Do NOT pre-filter dark pixels here. Tried on 2026-07-26 (a699d8d) to
    // keep a black border/letterboxing from winning a bucket, but on a
    // genuinely dark cover it can strip out most of the image, leaving only
    // a small warm-highlight fraction as medianCut's input — every bucket
    // then represents variations of that one highlight, which is why two
    // completely different covers (a golden outdoor photo and a dark indoor
    // photo) both extracted near-identical gold palettes on 2026-07-27.
    // The near-black filter on the RANKED CANDIDATES below (LUMA_THRESHOLD)
    // already keeps black from becoming an output color, without corrupting
    // what medianCut sees.
    const LUMA_THRESHOLD = 30;
    const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
    const source = pixels;

    // Ask median-cut for more buckets than we'll actually use (12, not the
    // 5-8 we keep) — it splits by widest channel RANGE, not by vividness, so
    // a bucket can easily end up holding a small vivid region (a logo, an
    // accent patch) mixed in with a much larger neutral one (skin tone, a
    // gray wall). Pulling extra candidates and ranking by vividness finds
    // the colorful parts of the cover that a straight small-bucket cut
    // would miss.
    const candidates = medianCut(source, 12);
    const ranked = candidates
      .map(hex => ({ hex, chroma: hexToChroma(hex), luma: hexToLuma(hex) }))
      // A near-black bucket (e.g. a two-tone black-and-one-color cover, where
      // black is the dominant channel) shouldn't ever surface as a "color" —
      // against the canvas's own near-black base it reads as a hole, not a
      // hue. Drop it here so it can't win a padding slot below even when
      // there aren't enough vivid candidates to fill MIN_COLORS.
      .filter(c => c.luma >= LUMA_THRESHOLD)
      .sort((a, b) => b.chroma - a.chroma);

    // Take every candidate with real color (chroma > 0.18), up to 8 — covers
    // with lots of distinct hues get more of them instead of being
    // truncated to a fixed 5.
    //
    // Verified against a live cover (a yellow record background with small
    // red/blue/green accent regions — "All The Pretty Girls"): a plain
    // top-8-by-chroma cut returned 8 near-identical shades of yellow and
    // NONE of the accents. Yellow's own chroma (~0.65-0.73) simply outranks
    // the accents' (blue ~0.56, red ~0.53, green ~0.42), and median-cut had
    // split the dominant yellow region into that many near-duplicate
    // sub-buckets — so ranking by raw chroma alone just picks 8 flavors of
    // the same hue instead of the cover's actual distinct colors. Walking
    // the ranked list and skipping anything within HUE_GAP_DEG of an
    // already-picked hue forces genuine hue diversity — confirmed this
    // returns yellow+blue+red+green for that cover instead of all-yellow.
    const MIN_COLORS = cfg.MIN_COLORS, MAX_COLORS = 8, CHROMA_FLOOR = 0.18, HUE_GAP_DEG = cfg.HUE_GAP_DEG;
    const vivid = [];
    for (const c of ranked) {
      if (c.chroma <= CHROMA_FLOOR) continue;
      const hue = hexToHue(c.hex);
      if (vivid.some(v => hueDelta(v.hue, hue) < HUE_GAP_DEG)) continue;
      vivid.push({ ...c, hue });
      if (vivid.length >= MAX_COLORS) break;
    }
    // Pad up to MIN_COLORS from the remaining ranked list if the diverse set
    // came up short — but pad AROUND the diverse picks, don't replace them.
    // (An earlier version fell back to `ranked.slice(0, MIN_COLORS)` whenever
    // the diverse set was under MIN_COLORS, which silently threw the
    // diversity work away and put all-yellow right back for any cover with
    // fewer than 5 sufficiently-distinct hues.)
    let colors = vivid.map(c => c.hex);
    if (colors.length < MIN_COLORS) {
      // Pad with the same hue-gap rule as the main pass first — a cover that
      // only had 2 genuinely distinct hues shouldn't get those 2 diluted
      // back down to 5-near-duplicates just to hit MIN_COLORS. Only if that
      // still comes up short (the cover truly has no more distinct hues to
      // offer) fall back to filling with whatever's left, duplicates and all.
      for (const c of ranked) {
        if (colors.length >= MIN_COLORS) break;
        if (colors.includes(c.hex)) continue;
        const hue = hexToHue(c.hex);
        if (colors.some(hex => hueDelta(hexToHue(hex), hue) < HUE_GAP_DEG)) continue;
        colors.push(c.hex);
      }
      for (const c of ranked) {
        if (colors.length >= MIN_COLORS) break;
        if (!colors.includes(c.hex)) colors.push(c.hex);
      }
    }

    // Genuinely grayscale/near-monochrome art (even the most vivid bucket
    // is barely colored) — nothing to rank can invent hues that aren't
    // there. Blend in two fixed accent hues so the background still has
    // real color to animate, lightness-matched to the art's own average
    // brightness so a dark B&W cover still gets a dark accent, not a jarring
    // bright patch.
    const mostVivid = ranked[0]?.chroma ?? 0;
    if (mostVivid < 0.15) {
      const avgLuma = source.reduce((sum, p) => sum + luma(p), 0) / source.length / 255;
      const accentHues = [320, 280]; // neon pink, neon purple — B&W covers get punchy contrast instead of fading to gray
      const accents = accentHues.map(h => hslToHex(h, 0.85, Math.min(0.75, Math.max(0.25, avgLuma))));
      // Replace the two least-saturated picks — the ones contributing least
      // to actual color anyway — rather than the most-saturated real ones.
      colors = [...colors.slice(0, 3), ...accents];
    }

    // Album art URLs are stable — cache aggressively, UNLESS the tuning
    // board is live-testing a VARIETY value, in which case caching would
    // serve a stale palette back to the board mid-tune.
    res.setHeader('Cache-Control', overridden ? 'no-store' : 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json({ colors });
  } catch (err) {
    console.error('[palette]', err.message);
    return res.status(500).json({ error: 'Extraction failed' });
  }
}

// ── Median-cut color quantisation ─────────────────────────────────────────────

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
    // Pick the bucket + channel with the widest value range
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
  return buckets.map(bucket => {
    let best = bucket[0], bestChroma = -1;
    for (const p of bucket) {
      const c = pixelChroma(p);
      if (c > bestChroma) { bestChroma = c; best = p; }
    }
    return toHex(best[0], best[1], best[2]);
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
// hexToChroma ranks candidates for vividness. Chroma (max-min channel, 0-1)
// is used instead of HSL saturation because HSL saturation blows up near
// pure white/black — a near-white pixel like #fffaf7 (barely any real color)
// reports s≈1.0 since saturation's denominator shrinks toward zero at
// lightness extremes, which would falsely outrank genuinely vivid colors.
// Chroma doesn't have that instability: #fffaf7 correctly scores ~0.03.

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
