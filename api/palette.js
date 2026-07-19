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

    // Ask median-cut for more buckets than we'll actually use (8, not 5) —
    // it splits by widest channel RANGE, not by vividness, so the raw bucket
    // averages skew toward whatever's most common (skin tones, black keys,
    // gray walls). Pulling extra candidates and ranking by saturation finds
    // the vivid parts of the cover that a straight 5-bucket cut would miss.
    const candidates = medianCut(source, 8);
    const ranked = candidates
      .map(hex => ({ hex, ...hexToHsl(hex) }))
      .sort((a, b) => b.s - a.s);

    let colors = ranked.slice(0, 5).map(c => c.hex);

    // Genuinely grayscale/near-monochrome art (even the most saturated bucket
    // is barely colored) — a saturation ranking can't invent hues that
    // aren't there. Blend in two fixed accent hues so the background still
    // has real color to animate, lightness-matched to the art's own average
    // brightness so a dark B&W cover still gets a dark accent, not a jarring
    // bright patch.
    const mostSaturated = ranked[0]?.s ?? 0;
    if (mostSaturated < 0.15) {
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

  // Average each bucket → representative hex color
  return buckets.map(bucket => {
    let r = 0, g = 0, b = 0;
    for (const p of bucket) { r += p[0]; g += p[1]; b += p[2]; }
    const n = bucket.length;
    return toHex(Math.round(r / n), Math.round(g / n), Math.round(b / n));
  });
}

function toHex(r, g, b) {
  return '#' + [r, g, b]
    .map(v => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0'))
    .join('');
}

// ── HSL helpers — used to rank median-cut buckets by vividness and to build
// lightness-matched fallback accents for near-grayscale art ────────────────

function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
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
