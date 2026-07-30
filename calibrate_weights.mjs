import sharp from 'sharp';

// ── copied verbatim from api/palette.js (color helpers) ────────────────────
function toHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0')).join('');
}
function pixelChroma([r, g, b]) { return (Math.max(r, g, b) - Math.min(r, g, b)) / 255; }
function hexToChroma(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return pixelChroma([r, g, b]);
}
function hexToLuma(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
function hexToLightness(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
}
function hexToHue(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  h *= 60; return h < 0 ? h + 360 : h;
}
function hueDelta(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
function smoothstep(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
function uglyWeight(hue, chroma, lightness) {
  const HUE_LO = 40, HUE_HI = 100, HUE_RAMP = 10;
  let hw; if (hue < HUE_LO) hw = smoothstep(HUE_LO - HUE_RAMP, HUE_LO, hue);
  else if (hue > HUE_HI) hw = 1 - smoothstep(HUE_HI, HUE_HI + HUE_RAMP, hue); else hw = 1;
  if (hw <= 0) return 0;
  const cw = 1 - smoothstep(0.26, 0.33, chroma); if (cw <= 0) return 0;
  const LIGHT_LO = 0.18, LIGHT_HI = 0.55, LIGHT_RAMP = 0.05;
  let lw; if (lightness < LIGHT_LO) lw = smoothstep(LIGHT_LO - LIGHT_RAMP, LIGHT_LO, lightness);
  else if (lightness > LIGHT_HI) lw = 1 - smoothstep(LIGHT_HI, LIGHT_HI + LIGHT_RAMP, lightness); else lw = 1;
  if (lw <= 0) return 0;
  return hw * cw * lw;
}
function uglyPenalty(hue, chroma, lightness) { return 1 - uglyWeight(hue, chroma, lightness) * 0.65; }
function deuglify(hue, chroma, lightness, originalHex) {
  const weight = uglyWeight(hue, chroma, lightness);
  if (weight <= 0) return { hue, chroma, lightness, hex: originalHex };
  const TARGET_HUE = hue >= 60 ? 105 : 34, MAX_ROT = 35;
  const rot = Math.max(-MAX_ROT, Math.min(MAX_ROT, weight * (TARGET_HUE - hue)));
  const newHue = (hue + rot + 360) % 360;
  const newChroma = Math.min(chroma + weight * 0.18, 0.42);
  const newLightness = lightness + weight * (0.46 - lightness) * 0.7;
  return { hue: newHue, chroma: newChroma, lightness: newLightness, hex: chromaHueLightnessToHex(newHue, newChroma, newLightness) };
}
function chromaHueLightnessToHex(hue, chroma, lightness) {
  const denom = 1 - Math.abs(2 * lightness - 1);
  const s = denom > 0 ? Math.min(1, chroma / denom) : 0;
  return hslToHex(hue, s, lightness);
}
function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return toHex(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255));
}
function channelRange(bucket, c) {
  let min = 255, max = 0;
  for (const p of bucket) { if (p[c] < min) min = p[c]; if (p[c] > max) max = p[c]; }
  return max - min;
}
// medianCut MODIFIED to also return population (pixel count per bucket)
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
    if (maxRange === 0) break;
    const bucket = buckets[splitIdx];
    bucket.sort((a, b) => a[splitChannel] - b[splitChannel]);
    const mid = Math.floor(bucket.length / 2);
    buckets.splice(splitIdx, 1, bucket.slice(0, mid), bucket.slice(mid));
  }
  return buckets.map(bucket => {
    let best = bucket[0], bestChroma = -1;
    for (const p of bucket) { const c = pixelChroma(p); if (c > bestChroma) { bestChroma = c; best = p; } }
    return { hex: toHex(best[0], best[1], best[2]), population: bucket.length };
  });
}

async function extractCandidates(url) {
  const response = await fetch(url);
  const buffer = Buffer.from(await response.arrayBuffer());
  const { data, info } = await sharp(buffer).resize(150, 150).removeAlpha().toColorspace('srgb').raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const pixels = [];
  for (let i = 0; i < data.length; i += ch * 3) pixels.push([data[i], data[i + 1], data[i + 2]]);
  const LUMA_THRESHOLD = 30;
  const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
  const totalSampled = pixels.length;
  const candidates = medianCut(pixels, 12);
  const maxPopulation = Math.max(...candidates.map(c => c.population));
  const ranked = candidates
    .map(({ hex, population }) => {
      const rawChroma = hexToChroma(hex), rawHue = hexToHue(hex), rawLightness = hexToLightness(hex);
      const { hue, chroma, lightness, hex: displayHex } = deuglify(rawHue, rawChroma, rawLightness, hex);
      return {
        hex: displayHex, chroma, hue, lightness, rawChroma, luma: hexToLuma(hex),
        population, populationShare: population / totalSampled, populationRel: population / maxPopulation,
        oldScore: chroma * uglyPenalty(hue, chroma, lightness),
      };
    })
    .filter(c => c.luma >= LUMA_THRESHOLD);
  return ranked;
}

const covers = {
  miles_on_it: 'https://i.scdn.co/image/ab67616d0000b27360d9e6851312e529730690d5',
  dance_with_me: 'https://i.scdn.co/image/ab67616d0000b2737e6acc29c6632ded821d2acf',
  '1990something': 'https://i.scdn.co/image/ab67616d0000b2739eb121cb48161b9c21ba397a',
};

for (const [name, url] of Object.entries(covers)) {
  const ranked = await extractCandidates(url);
  console.log(`\n=== ${name} ===`);
  const sorted = [...ranked].sort((a, b) => b.oldScore - a.oldScore).slice(0, 8);
  for (const c of sorted) {
    console.log(
      c.hex,
      'oldScore=' + c.oldScore.toFixed(3),
      'chroma=' + c.chroma.toFixed(3),
      'pop=' + c.population,
      'popShare=' + (c.populationShare * 100).toFixed(1) + '%',
      'popRel=' + c.populationRel.toFixed(3),
    );
  }
}
