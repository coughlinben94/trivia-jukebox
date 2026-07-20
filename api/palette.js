import sharp from 'sharp';

export default async function handler(req, res) {
  const { url } = req.query;

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

    // Drop near-black pixels before quantising — a black border, letterboxing,
    // or a mostly-black cover shouldn't win a median-cut bucket and end up
    // driving a blob. Keep anything with real luminance so the gradient
    // favors the other colors on the cover. If the art really is all black
    // (filtering leaves too few points to be meaningful), fall back to the
    // unfiltered set rather than starving medianCut of input.
    const LUMA_THRESHOLD = 30;
    const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
    const litPixels = pixels.filter(p => luma(p) >= LUMA_THRESHOLD);
    const source = litPixels.length >= pixels.length * 0.05 ? litPixels : pixels;

    // Ask median-cut for more buckets than we'll actually use (12, not the
    // 5-8 we keep) — it splits by widest channel RANGE, not by vividness, so
    // a bucket can easily end up holding a small vivid region (a logo, an
    // accent patch) mixed in with a much larger neutral one (skin tone, a
    // gray wall). Pulling extra candidates and ranking by vividness finds
    // the colorful parts of the cover that a straight small-bucket cut
    // would miss.
    const candidates = medianCut(source, 12);
    const ranked = candidates
      .map(hex => ({ hex, chroma: hexToChroma(hex) }))
      .sort((a, b) => b.chroma - a.chroma);

    // Take every candidate with real color (chroma > 0.18), up to 8 — covers
    // with lots of distinct hues get more of them instead of being
    // truncated to a fixed 5. Always keep at least 5 (padding from the
    // ranked list even below the threshold) so the background never starves
    // for colors on a muted-but-not-quite-grayscale cover.
    const MIN_COLORS = 5, MAX_COLORS = 8, CHROMA_FLOOR = 0.18;
    const vivid = ranked.filter(c => c.chroma > CHROMA_FLOOR).slice(0, MAX_COLORS);
    let colors = (vivid.length >= MIN_COLORS ? vivid : ranked.slice(0, MIN_COLORS)).map(c => c.hex);

    // Genuinely grayscale/near-monochrome art (even the most vivid bucket
    // is barely colored) — nothing to rank can invent hues that aren't
    // there. Blend in two fixed accent hues so the background still has
    // real color to animate, lightness-matched to the art's own average
    // brightness so a dark B&W cover still gets a dark accent, not a jarring
    // bright patch.
    const mostVivid = ranked[0]?.chroma ?? 0;
    if (mostVivid < 0.15) {
      const avgLuma = source.reduce((sum, p) => sum + luma(p), 0) / source.length / 255;
      const accentHues = [24, 265]; // warm amber, cool violet — house accents
      const accents = accentHues.map(h => hslToHex(h, 0.55, Math.min(0.75, Math.max(0.25, avgLuma))));
      // Replace the two least-saturated picks — the ones contributing least
      // to actual color anyway — rather than the most-saturated real ones.
      colors = [...colors.slice(0, 3), ...accents];
    }

    // Album art URLs are stable — cache aggressively
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
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
