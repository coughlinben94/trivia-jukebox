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
      .map(hex => {
        const rawChroma = hexToChroma(hex);
        const rawHue = hexToHue(hex);
        const rawLightness = hexToLightness(hex);
        // Recolor (not just discount) anything in the "ugly olive/khaki"
        // pocket — see deuglify() below. Everything downstream (score,
        // hue-gap dedup, the final output hex) operates on the RECOLORED
        // values; only `rawChroma` survives separately, because the
        // monochrome-fallback check further down must judge the art's real
        // vividness, not a color this function invented.
        const { hue, chroma, lightness, hex: displayHex } =
          deuglify(rawHue, rawChroma, rawLightness, hex);
        // `score` (not `chroma`) drives sort order below — see uglyPenalty().
        return {
          hex: displayHex,
          chroma,
          hue,
          lightness,
          rawChroma,
          luma: hexToLuma(hex),
          score: chroma * uglyPenalty(hue, chroma, lightness),
        };
      })
      // A near-black bucket (e.g. a two-tone black-and-one-color cover, where
      // black is the dominant channel) shouldn't ever surface as a "color" —
      // against the canvas's own near-black base it reads as a hole, not a
      // hue. Drop it here so it can't win a padding slot below even when
      // there aren't enough vivid candidates to fill MIN_COLORS. Luma is
      // read from the ORIGINAL pixel — deuglify only ever lifts lightness
      // for pocket colors, never darkens, so judging near-blackness pre
      // recolor is equivalent and simpler.
      .filter(c => c.luma >= LUMA_THRESHOLD)
      // Sort by the ugliness-discounted score, not raw chroma — see
      // uglyPenalty() below. mostVivid further down reads each candidate's
      // real, pre-recolor .rawChroma (not .chroma), so this only affects
      // PICK ORDER, never "is there real color in the source art at all."
      .sort((a, b) => b.score - a.score);

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
    // Gate on `.score` (chroma discounted by uglyPenalty), not raw `.chroma`
    // — this is the piece the first version of the ugly-hue fix was missing.
    // A discounted score only changes SORT ORDER; if a muddy hue (like the
    // olive on The Mowgli's "I Feel Good About This") is the only candidate
    // anywhere near its hue neighborhood, nothing else competes for that
    // slot, so it still got picked here regardless of rank position — the
    // live re-check after deploy confirmed #5b6732 came through unchanged.
    // Gating the floor on `.score` is actually an absolute exclusion, not
    // just a raised bar: uglyPenalty only ever discounts when chroma < 0.45,
    // so the highest possible discounted score is 0.45*0.35 = 0.1575 — always
    // below CHROMA_FLOOR (0.18). Every penalized candidate fails this check,
    // full stop, and gets deferred to the last-resort padding loop below
    // instead of an automatic pick here.
    const vivid = [];
    for (const c of ranked) {
      if (c.score <= CHROMA_FLOOR) continue;
      if (vivid.some(v => hueDelta(v.hue, c.hue) < HUE_GAP_DEG)) continue;
      vivid.push(c);
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
      // Same `.score` gate as the vivid pass above — a muddy hue shouldn't
      // get a free pass into padding just because it dodged the first loop's
      // hue-gap dedup. It's still eligible for the true last-resort
      // round-robin pad below if nothing clean is left.
      for (const c of ranked) {
        if (colors.length >= MIN_COLORS) break;
        if (colors.includes(c.hex)) continue;
        if (c.score <= CHROMA_FLOOR) continue;
        if (colors.some(hex => hueDelta(hexToHue(hex), c.hue) < HUE_GAP_DEG)) continue;
        colors.push(c.hex);
      }
      // Still short — the cover only has as many genuinely distinct hues as
      // are already in `colors`. Round-robin the remaining padding budget
      // ACROSS those existing hue families instead of bulk-grabbing
      // whatever's next by raw chroma. Bulk order systematically
      // overrepresents whichever hue family happens to rank highest by
      // chroma: verified live on Abraham Alexander's "Stay" (a sepia/brown
      // illustration) — real /api/palette output was
      // #2a6899/#806d3e/#6d8eaf/#0e324f/#937957. Three of those five
      // (#2a6899, #6d8eaf, #0e324f) are the SAME ~207° blue at different
      // lightness levels, vs only two browns, purely because blue's
      // candidate buckets all had higher chroma (~0.26-0.44) than the
      // browns' (~0.24-0.26) and the old loop just took the next-highest-
      // chroma candidate regardless of hue — so blue, having already won
      // the "most vivid" pick, ALSO ate most of the padding slots, even
      // though the sepia/brown tone is what actually covers most of the
      // image. Cycling the target hue each pick spends the padding budget
      // on more shades of EVERY real hue family found, not just the top one.
      if (colors.length < MIN_COLORS) {
        // Same CHROMA_FLOOR gate every other pick point in this function
        // obeys — this loop was the one place that didn't, so a gray
        // candidate (chroma≈0, score exactly 0, well under the floor) could
        // still win a padding slot just for having the closest hue-angle
        // match to an existing anchor. Hue is meaningless noise at near-zero
        // chroma; "closest hue" was never a valid reason to let one through.
        // If nothing clears the floor, colors simply stays short of
        // MIN_COLORS — downstream (parseColors) already wraps a short array
        // via modulo, and the monochrome fallback below still catches a
        // genuinely colorless cover separately.
        const remaining = ranked.filter(c => !colors.includes(c.hex) && c.score > CHROMA_FLOOR);
        const anchors = [];
        for (const hex of colors) {
          const h = hexToHue(hex);
          if (!anchors.some(a => hueDelta(a, h) < HUE_GAP_DEG)) anchors.push(h);
        }
        // A SINGLE anchor means the cover only has one real hue family left
        // to draw padding from (no competing family that could dominate) —
        // exactly the "just take the next-best remaining candidate" case the
        // zero-anchor branch already handles, so route it there too instead
        // of running the hue-closest tiebreak. Verified live on Classified's
        // "Higher" (a white cover, vivid red art only — one hue family,
        // hueSpread 7.1° across candidates, correctly a single anchor at hue
        // 3.1°): the hue-closest tiebreak picked #971b15, #ad3c30, #6f0909,
        // #60090b — four PROGRESSIVELY DARKER reds (lightness 0.34→0.21) —
        // and never picked #c4734e (lightness 0.54, chroma 0.463), the one
        // candidate bright enough to actually read as "vivid red." That's
        // not a fluke: as a saturated color lightens toward a white
        // background, anti-aliased/JPEG-compressed pixels drift a few
        // degrees warmer in hue (here 3.1°→18.8°), so "closest hue to the
        // anchor" systematically re-picks near-duplicates of the DARKEST
        // member of the family and starves out the lighter, more vivid ones
        // — the opposite of what a single-hue-family cover needs. `remaining`
        // is already sorted by score (chroma discounted by uglyPenalty, see
        // `ranked` above), so falling through to score order here picks
        // #971b15, #ad3c30, #c4734e, #6f0909 instead — the actual four
        // brightest members, including the one the old tiebreak dropped.
        // Multi-anchor covers (2+ real hue families, e.g. the "Stay"
        // sepia/blue case documented above) are untouched — this only
        // changes behavior when there's nothing left to race against.
        let cycle = 0;
        while (colors.length < MIN_COLORS && remaining.length) {
          if (anchors.length <= 1) { colors.push(remaining.shift().hex); continue; }
          const targetHue = anchors[cycle % anchors.length];
          let bestIdx = 0, bestDelta = Infinity;
          for (let i = 0; i < remaining.length; i++) {
            const d = hueDelta(hexToHue(remaining[i].hex), targetHue);
            if (d < bestDelta) { bestDelta = d; bestIdx = i; }
          }
          colors.push(remaining[bestIdx].hex);
          remaining.splice(bestIdx, 1);
          cycle++;
        }
      }
    }

    // Genuinely grayscale/near-monochrome art (even the most vivid bucket
    // is barely colored) — nothing to rank can invent hues that aren't
    // there. Blend in two fixed accent hues so the background still has
    // real color to animate, lightness-matched to the art's own average
    // brightness so a dark B&W cover still gets a dark accent, not a jarring
    // bright patch.
    // NOTE: `ranked` is now sorted by uglyPenalty-discounted `score`, not raw
    // chroma, so ranked[0] is no longer guaranteed to be the highest-chroma
    // candidate — this must ask "how vivid is the single most vivid REAL
    // color" regardless of pick order, so it reads true chroma across all
    // candidates directly rather than trusting sort position. Reads
    // `.rawChroma` specifically (the pre-deuglify value) — `.chroma` on each
    // candidate may have been lifted by deuglify's recolor, and a cover this
    // function had to invent vividness for is exactly the genuinely-gray
    // case the monochrome fallback below exists to catch. Judging on the
    // recolored value would let a faintly-khaki-tinted grayscale cover dodge
    // the fallback it actually needs.
    const mostVivid = ranked.length ? Math.max(...ranked.map(c => c.rawChroma)) : 0;

    // A SECOND, different failure mode: a cover can have plenty of raw
    // chroma (yellow/gold is a vivid hue) while still being a single hue
    // family throughout — a solid gold record cover (gold label + black
    // text) has no gray/near-black-only problem, but every candidate that
    // survives the chroma/luma filters is some shade of the same gold, so
    // the "distinct moving bodies" gradient reads as one flat wash anyway.
    // Reported live on "Before You Go" (Common Kings). mostVivid alone can't
    // catch this — it only measures how colorful the single best bucket is,
    // not how much the picked SET disagrees on hue. Measure the actual hue
    // spread across what we ended up with and route it through the same
    // accent treatment as B&W whenever that spread is too narrow to read as
    // more than one color.
    const paletteHues = colors.map(hexToHue);
    const hueSpread = paletteHues.length > 1
      ? Math.max(...paletteHues.flatMap((h, i) => paletteHues.slice(i + 1).map(h2 => hueDelta(h, h2))))
      : 0;
    // Was a hardcoded 40deg, independent of HUE_GAP_DEG (the vivid-pick
    // loop's own diversity bar, default 25deg) — contradicted it. Verified
    // live 2026-07-30 on "Check Yes, Juliet" (We The Kings): a rust-red base
    // + gold filigree, 29deg apart, cleared the vivid pick's 25deg gap as
    // two genuinely distinct colors, then got told by THIS check "not
    // diverse enough" and had one swapped for a neon pink accent instead —
    // that accent blending with the red is what read as purple on screen.
    // If the picker already accepted two colors as different at
    // HUE_GAP_DEG apart, this check demanding MORE separation than that to
    // believe the palette is genuinely multi-hue was never coherent — tying
    // it to the same constant means "we couldn't even find two colors as
    // far apart as our own diversity bar requires" is the only way to
    // trigger this fallback now, not an independent, stricter bar.
    const MONOCHROME_HUE_SPREAD_DEG = HUE_GAP_DEG;

    if (mostVivid < 0.15 || hueSpread < MONOCHROME_HUE_SPREAD_DEG) {
      const avgLuma = source.reduce((sum, p) => sum + luma(p), 0) / source.length / 255;

      if (mostVivid < 0.15) {
        // Genuinely nothing real to lean on (true B&W/grayscale) — no real
        // hue to derive a color-wheel relationship FROM (unlike the
        // single-real-hue branch below), so this triad has to be a
        // deliberately-chosen fixed palette rather than something derived
        // per cover. Evenly spaced 120° apart (true triadic — the standard
        // relationship for exactly three accent hues, same logic as this
        // file's true-complementary fix for the single-accent case) and
        // chosen to sit clear of the documented ugly olive/khaki pocket
        // (hue 40-100°, see uglyWeight/deuglify above) at full saturation —
        // 140/260/20 lands at teal-green/blue-violet/red-orange, none of
        // them anywhere near that band. Saturation eased from the old 0.85
        // (matches the tone-down on the single-accent branch, 0.85 -> 0.55)
        // to 0.65 — still needs to carry the WHOLE gradient alone here since
        // there's no real color backing it up, so a bit more than the
        // single-accent case, but the old 0.85 read as the same "neon slap"
        // this whole pass is fixing.
        const accentHues = [140, 260, 20];
        const accents = accentHues.map(h => hslToHex(h, 0.65, Math.min(0.75, Math.max(0.25, avgLuma))));
        // Accents FIRST, leftover near-gray candidates after: LiveScreen's
        // client-side pick takes the top 2-3 entries in array order, and the
        // three accents here are the only entries with any real hue
        // separation — two near-identical grays (colors.slice(0,2), all
        // that's left in a genuinely colorless cover) would otherwise sit
        // first and waste a pick slot on a near-duplicate of each other.
        colors = [...accents, ...colors.slice(0, 2)];
      } else {
        // There IS a real color here, just one hue family (a rich solid-gold
        // cover, or a warm skin-tone photo like Edgar Winter's "Free Ride") —
        // that color should stay the star. The old fixed 2-real+3-neon ratio
        // buried it under pink/purple/cyan regardless of how much real color
        // existed (reported live on "Free Ride" — a mostly warm-skin-tone
        // photo that came out reading as a neon wash instead of its own
        // tone). Keep more of the real picks and add just ONE accent for
        // motion/contrast instead of overpowering the album's actual color.
        //
        // Accent hue used to be a FIXED 320° (neon pink) regardless of what
        // the real color actually was — reported live 2026-07-30 on Black
        // Match's "June" (a near-grayscale beach photo, one real muted tan
        // #a57d61 survived): paired with hardcoded hot pink, it read as "a
        // shit color," because a fixed neon accent has no relationship to
        // whatever real hue it's forced next to — sometimes it'll clash,
        // sometimes (as here) it always will against a warm muted tone.
        // Deriving the accent from the real color's own hue, true
        // complementary (+180°) — the standard, legible color-wheel
        // relationship for pairing exactly one accent against one base hue.
        // An earlier version of this fix hedged to +150° instead, worried
        // exact opposites would cancel toward gray when blended — that
        // concern doesn't actually apply here: both blend paths this mesh
        // uses (the per-frame multi-blob spatial blend AND the song-to-song
        // crossfade) already work in polar (hue, chroma) space specifically
        // to avoid vector cancellation — chroma is a scalar mean/lerp, hue
        // takes the shortest arc, neither can collapse toward zero the way
        // averaging raw a/b vectors can (see AlbumGradientMesh.jsx's own
        // comments on both fixes). True complementary is safe and gives more
        // contrast than the hedge. Saturation toned down from 0.85 to 0.55
        // either way (still reads as a distinct second color, not a neon
        // slap) so the accent always has SOME relationship to the actual
        // cover instead of being an unrelated fixed color bolted on.
        const realHue = colors.length ? hexToHue(colors[0]) : 320;
        const accentHue = (realHue + 180) % 360;
        const accent = hslToHex(accentHue, 0.55, Math.min(0.75, Math.max(0.25, avgLuma)));
        colors = [...colors.slice(0, 4), accent];
      }
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

// HSL lightness (0-1) — separate from luma. hexToLuma weights channels for
// perceived brightness (used for the near-black filter); this is the plain
// (max+min)/2 HSL definition, needed because uglyPenalty's "muddy" pocket is
// specifically a MID-lightness band, not a dark/bright one.
function hexToLightness(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255;
}

// Discounts a candidate's chroma for the SORT score only (never the real
// .chroma value other checks read) when it falls in a hue+chroma+lightness
// pocket that reads as bile/decay almost regardless of the rest of a cover's
// palette — drab olive/khaki through mustard-brown, hue 40°-100° combined,
// gated to moderate-or-lower chroma (<0.45) and mid lightness (18%-55%).
// This is the same territory as Pantone 448C ("the world's ugliest color,"
// researched for Australia's 2012 plain-cigarette-packaging law) — a flat
// murky brown-green that tested as least-liked across age/gender groups;
// color-preference research (Palmer & Schloss, "An ecological valence theory
// of human color preference," PNAS 2010) ties that reaction to the hue
// calling up decay/mold/bile, largely independent of how saturated it is.
//
// Deliberately narrow so it does NOT touch true greens (~100°-160°,
// forest/spring green), teals/blues (~160°-250°), dusty rose/mauve, or
// terracotta/rust (~10°-30°) — all sit outside this hue band — and does NOT
// touch a vivid, bright version of the SAME hue (a saturated chartreuse or
// golden Dijon-yellow reads as fresh, not sick, which is why chroma/
// lightness gate it as much as hue does). Verified against a real offender:
// "I Feel Good About This" (The Mowgli's) extracted #5b6732 — hue 73.5°,
// chroma 0.21, lightness 30% — squarely inside this pocket, and it read as
// "pukey" blended live against that cover's rust-reds.
//
// Each of the three gates (hue/chroma/lightness) ramps in over a buffer
// zone via smoothstep rather than snapping at a hard line, so a color a
// hair on either side of an edge — chroma 0.449 vs 0.451, hue 99° vs 101° —
// gets nearly the same treatment instead of one being fully caught and the
// other fully waved through. The three ramps multiply together into one
// combined `weight` (0 = clean, 1 = dead center of the pocket), which then
// interpolates the penalty between 1 (no discount) and 0.35 (full discount).
// A color deep in the pocket on all three axes still lands at exactly 0.35,
// same as the original hard-gated version — this only softens the edges.
//
// CHROMA_FLOOR note: a color deep in the pocket (weight≈1) tops out at
// chroma 0.26 (the chroma ramp's own lower edge, narrowed 2026-07-29 from
// 0.40) × 0.35 ≈ 0.09, still under CHROMA_FLOOR (0.18) — so the core pocket
// is still an absolute exclusion from the vivid pick, exactly as before
// (and still catches the documented #5b6732 offender at chroma 0.21). Only
// a real photographed green now needs chroma above ~0.33, not ~0.45, to
// clear the ramp entirely. Only colors near an
// edge (partial weight) can land a discounted score above the floor, and
// that's intentional: they're only partly in ugly territory to begin with.
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// 0 (clean) to 1 (dead centre of the ugly pocket). Factored out of
// uglyPenalty (2026-07-29) so the score discount and deuglify's recolor
// below share one definition of "in the pocket" and can never disagree.
function uglyWeight(hue, chroma, lightness) {
  const HUE_LO = 40, HUE_HI = 100, HUE_RAMP = 10;
  let hueWeight;
  if (hue < HUE_LO) hueWeight = smoothstep(HUE_LO - HUE_RAMP, HUE_LO, hue);
  else if (hue > HUE_HI) hueWeight = 1 - smoothstep(HUE_HI, HUE_HI + HUE_RAMP, hue);
  else hueWeight = 1;
  if (hueWeight <= 0) return 0;

  // Ramps down from full weight at chroma 0.26 to none at 0.33 (narrowed
  // 2026-07-29, was 0.40-0.45) — the wider ramp still caught real
  // photographed grass/foliage green, which lands in the SAME 40-100deg hue
  // band as the documented olive/khaki offender and can't be separated by
  // hue alone. The offender (#5b6732) sits at chroma 0.21, well under this
  // ramp's lower edge, so it's still fully discounted.
  const chromaWeight = 1 - smoothstep(0.26, 0.33, chroma);
  if (chromaWeight <= 0) return 0;

  // Ramps in/out over a 5%-lightness buffer on both sides of the 18%-55%
  // muddy band. Pantone 448C itself sits at 22.7%L, comfortably inside.
  const LIGHT_LO = 0.18, LIGHT_HI = 0.55, LIGHT_RAMP = 0.05;
  let lightnessWeight;
  if (lightness < LIGHT_LO) lightnessWeight = smoothstep(LIGHT_LO - LIGHT_RAMP, LIGHT_LO, lightness);
  else if (lightness > LIGHT_HI) lightnessWeight = 1 - smoothstep(LIGHT_HI, LIGHT_HI + LIGHT_RAMP, lightness);
  else lightnessWeight = 1;
  if (lightnessWeight <= 0) return 0;

  return hueWeight * chromaWeight * lightnessWeight;
}

function uglyPenalty(hue, chroma, lightness) {
  const weight = uglyWeight(hue, chroma, lightness);
  return 1 - weight * 0.65; // weight 1 → 0.35 (full discount), weight 0 → 1 (none)
}

// Recolors a candidate deep in the ugly olive/khaki pocket instead of just
// discounting it out of the palette (2026-07-29) — nudges it toward a
// nicer neighbor so the live background still derives its color from that
// region of the album art, rather than losing the slot to an unrelated
// color or (in the worst case) tripping the monochrome fallback below.
// Scaled by uglyWeight so a color barely inside the pocket moves
// imperceptibly, a color dead-center moves the full amount, and anything
// outside the pocket (weight 0) passes through completely unchanged — same
// continuity discipline as uglyPenalty's own ramps. This happens entirely
// in the palette layer; the renderer still only draws what it's handed.
//
// Splits at hue 60°, not the pocket's own 40-100° midpoint (70°) — a muddy
// hue already reads as green rather than brown/mustard by around 60°.
// Rotates toward leaf green (105°, just past the pocket's own HUE_HI) or
// bronze/amber (34°, just under HUE_LO) accordingly, and lifts chroma/
// lightness together with the hue shift — Pantone 448C reads ugly because
// it's desaturated AND mid-dark, not because of its hue angle alone;
// rotating hue with no chroma/lightness change just gives a muddy green
// instead of a muddy olive.
function deuglify(hue, chroma, lightness, originalHex) {
  const weight = uglyWeight(hue, chroma, lightness);
  if (weight <= 0) return { hue, chroma, lightness, hex: originalHex };

  const TARGET_HUE = hue >= 60 ? 105 : 34;
  const MAX_ROT = 35; // stays recognizably the same underlying color
  const rot = Math.max(-MAX_ROT, Math.min(MAX_ROT, weight * (TARGET_HUE - hue)));

  const newHue = (hue + rot + 360) % 360;
  const newChroma = Math.min(chroma + weight * 0.18, 0.42);
  const newLightness = lightness + weight * (0.46 - lightness) * 0.7;

  return {
    hue: newHue,
    chroma: newChroma,
    lightness: newLightness,
    hex: chromaHueLightnessToHex(newHue, newChroma, newLightness),
  };
}

// Rebuilds a hex color from hue/chroma/lightness in the same cylindrical
// model hexToChroma/hexToLightness read them from — chroma here is the HSL
// cylinder's c = (1 - |2L-1|) * s — so deuglify's shifted values round-trip
// back into a real, displayable color instead of an approximation.
function chromaHueLightnessToHex(hue, chroma, lightness) {
  const denom = 1 - Math.abs(2 * lightness - 1);
  const s = denom > 0 ? Math.min(1, chroma / denom) : 0;
  return hslToHex(hue, s, lightness);
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
