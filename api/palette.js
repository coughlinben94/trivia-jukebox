import sharp from 'sharp';

export default async function handler(req, res) {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: 'Missing url param' });

  // Only allow Spotify CDN images
  if (!url.includes('i.scdn.co') && !url.includes('mosaic.scdn.co')) {
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

    const colors = medianCut(pixels, 6);

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
