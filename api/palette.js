import Vibrant from 'node-vibrant';

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
    const palette = await Vibrant.from(buffer).getPalette();

    const colors = [
      palette.Vibrant?.hex,
      palette.LightVibrant?.hex,
      palette.DarkVibrant?.hex,
      palette.Muted?.hex,
      palette.LightMuted?.hex,
      palette.DarkMuted?.hex,
    ].filter(Boolean);

    // Album art URLs are stable — cache aggressively
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json({ colors });
  } catch (err) {
    console.error('[palette]', err.message);
    return res.status(500).json({ error: 'Extraction failed' });
  }
}
