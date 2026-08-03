import sharp from 'sharp';
import { resolvePaletteConfig } from '../src/lib/paletteDefaults.js';
import { smoothstep, relativeSaturation, warmPocketHueWeight, uglyWeight } from '../src/lib/mudModel.js';

// Mud-pocket model lives in src/lib/mudModel.js so palette candidate gating
// and recoloring share one definition of ugly. Re-exported here so existing imports
// (src/test/palette.test.js) keep working. Full calibration history stays
// in the comments below, where the model was built.
export { smoothstep, relativeSaturation, warmPocketHueWeight, uglyWeight };

// Owner spec (2026-08-04): "for black albums, take the neon purple or pink
// as a primary color, i dont want black in the background anywhere." The
// old fixed pair here (200/20, blue/orange) predates that spec and never
// matched it -- this is the one true-grayscale-cover fallback in the whole
// file, so it's the only place a hardcoded hue choice like this makes
// sense. 300 (magenta-purple) and 330 (hot pink) are 30deg apart -- close
// enough to read as one family (matches the "neon purple OR pink" framing,
// not "pick one arbitrarily and hope"), far enough to still have visible
// gradient motion between them.
export function pickMonochromeAccentHues() {
  return [300, 330];
}

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
    const maxPopulation = Math.max(...candidates.map(c => c.population));
    const ranked = candidates
      .map(({ hex, population }) => {
        const rawChroma = hexToChroma(hex);
        const rawHue = hexToHue(hex);
        const rawLightness = hexToLightness(hex);
        // Recolor (not just discount) anything in the muddy-warm
        // (brown/mustard/khaki/olive) pocket — see deuglify() below.
        // Everything downstream (score,
        // hue-gap dedup, the final output hex) operates on the RECOLORED
        // values; only `rawChroma` survives separately, because the
        // monochrome-fallback check further down must judge the art's real
        // vividness, not a color this function invented.
        const { hue, chroma, lightness, hex: displayHex } =
          deuglify(rawHue, rawChroma, rawLightness, hex);
        const popRel = maxPopulation > 0 ? population / maxPopulation : 0;
        // `score` (not `chroma`) drives sort order below — see uglyPenalty()
        // and populationFactor().
        return {
          hex: displayHex,
          chroma,
          hue,
          lightness,
          rawChroma,
          luma: hexToLuma(hex),
          population,
          popRel,
          score: chroma * uglyPenalty(hue, chroma, lightness) * populationFactor(popRel),
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
    // Gating the floor on `.score` is an absolute exclusion for the deep
    // pocket, not just a raised bar: full uglyWeight requires relative
    // saturation <= 0.42, which caps chroma at 0.42 (the rel-sat
    // denominator never exceeds 1), so a fully-penalized score tops out at
    // 0.42*0.35 ≈ 0.147 — below CHROMA_FLOOR (0.18). Anything the recolor
    // leaves fully in the pocket fails this check and gets deferred to the
    // last-resort padding loop below instead of an automatic pick here.
    // (In practice deuglify recolors a deep-pocket candidate OUT of the
    // pocket before this score is computed — that's the designed path:
    // the region keeps its slot, wearing a fixed color.)
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

    // `colors` at this point is real (vivid picks + padding), so every
    // entry has a real population from `ranked` — look each one up by hex
    // to carry it through. (The monochrome/single-hue branches below build
    // their own `weights` directly, since they mix in synthetic colors that
    // were never in `ranked` to begin with.)
    const byHex = new Map(ranked.map(c => [c.hex, c]));

    // Merge hue-sibling entries BEFORE computing weights — found live
    // 2026-07-30 on Llunr's "Rocketship" (hard blue/orange split, reported
    // as "lava lamp" even after the weighted-palette fix above landed).
    // Real output was #e89c00/#1169b6/#cc0000/#f2a61b/#005096 — only 3
    // genuine hue families (orange ~40°, blue ~208°, a trace of red), but
    // the round-robin padding loop above (see its own comment, "Stay"/
    // Abraham Alexander) deliberately cycles back through EVERY anchor
    // family to hit MIN_COLORS when a cover doesn't have 5 genuinely
    // distinct hues — so orange and blue each got a second near-duplicate
    // entry (#e89c00/#f2a61b 1.5° apart, #1169b6/#005096 0° apart) purely to
    // pad the count. That was harmless under the old equal-weight blob
    // split (adjacent near-identical hues just blended into each other) but
    // became a real bug when visual allocation was weight-driven: splitting
    // one real hue family's population across two separate array entries
    // handed each one its OWN independent visual-allocation slot,
    // antipodally mirrored against a DIFFERENT partner — traced by hand
    // against Rocketship's real weights, dark blue (#005096, 2 blobs) and
    // #1169b6 (1 blob) never land in the same arena, so blue's presence
    // gets reinforced against orange twice instead of settling into one
    // stable, self-consistent pool. Same HUE_GAP_DEG bar the rest of this
    // file already uses for "is this actually a different color" — if it's
    // not diverse enough to count as a separate PICK, it shouldn't count as
    // a separate WEIGHT/blob-allocation unit either. Keeps the
    // higher-population member as the representative hex and folds every
    // sibling's population into it, so the family's full weight backs ONE
    // entry. Runs only here (not in the B&W/single-hue-accent branches
    // below) — those already construct their hues 180° apart by design, so
    // there's nothing for this to merge.
    colors = mergeHueSiblings(colors, byHex, HUE_GAP_DEG);

    let weights = buildWeights(colors.map(hex => ({ population: byHex.get(hex)?.population ?? null })));

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
        // single-real-hue branch below), so this pair has to be a
        // deliberately-chosen fixed palette rather than something derived
        // per cover. Keep both accents in the purple-to-pink band so true
        // monochrome art avoids the muddy warm pocket. Saturation eased
        // from the old 0.85
        // (same tone-down as the single-accent branch, 0.85 -> 0.55) to
        // 0.65 — still needs to carry the WHOLE gradient alone here since
        // there's no real color backing it up, so a bit richer than the
        // single-accent case, but 0.85 read as the same "neon slap" this
        // whole pass is fixing.
        //
        // Originally shipped as a 3-hue "triadic" (140/260/20) with the
        // leftover near-gray candidates kept after it, on the theory that
        // LiveScreen's client-side picker (pickGradientColors) would use up
        // to 3 of these 5 entries. A second-opinion review actually traced
        // that picker's logic against this exact array: it takes the top 2
        // entries, then adds a 3rd ONLY if those top 2 are hue-close
        // (originally <50° hue delta, since replaced by an OKLab ΔE test —
        // see LiveScreen.jsx) — and since these hues are fixed and always
        // 180° apart by construction, the picker NEVER reaches past the
        // first 2. The 3rd accent and both grays were dead weight on every
        // single true-B&W cover, unconditionally. Simplified to exactly the
        // 2 hues that were actually ever displayed, so what's in the code
        // matches what's on screen.
        //
        // Lightness floor raised 0.25 -> 0.38 (2026-07-30, second-opinion
        // review): at low avgLuma the old 0.25 floor combined with this
        // branch's own 0.65 saturation produces OKLab chroma ~0.07-0.09 —
        // a muted dark slate vs. dark brown, not the "richer, carries the
        // whole gradient" color this branch's own reasoning calls for.
        // Raising the floor keeps dark true-B&W covers (verified live:
        // "Shot At The Night," "Always Be My Baby," "DEVOTION," "Dreams" —
        // all 4 land in this exact branch and, since it's a fixed pair, all
        // 4 shared one identical near-mud background under the old floor)
        // legible without pushing the light end past what 0.75 already caps.
        const accentHues = pickMonochromeAccentHues();
        colors = accentHues.map(h => hslToHex(h, 0.65, Math.min(0.75, Math.max(0.38, avgLuma))));
        // Nothing real behind either hue here — both synthetic, so
        // buildWeights' zero-real-entries branch splits them evenly.
        weights = buildWeights(colors.map(() => ({ population: null })));
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
        // Deriving from the real color's own hue fixed that and stays.
        //
        // The OFFSET, however, moved twice. First derivation used true
        // complementary (+180°). An earlier pass already documented the
        // danger: the former per-pixel spatial blend derived hue
        // via `Math.atan2(bSum, aSum)` on the CARTESIAN SUM of each blob's
        // a/b — near 180° apart the sum vector cancels toward zero and hue
        // SNAPS instead of sweeping — and kept 180° anyway on the theory
        // that the 24px screen blur averages the unstable seam into a calm
        // boundary ("Watch item: ... if it ever reads as visible shimmer
        // rather than a static soft boundary, back off toward ~165°").
        // That watch item came due 2026-07-30 on Black Pumas' "Fast Car"
        // (live palette ["#d72a1b","#397f85"], weights [0.85,0.15]):
        // an isolated, sharply-bounded teal disc drifting across a flat red
        // field, "never blending into the red." Reproduced offline by
        // rendering the mesh's exact per-pixel math (simulate-accent-blob.mjs)
        // — the measured mechanism is worth keeping on record because it
        // rules out every other knob:
        //   - The chroma-preserving blend (chroma = scalar weighted MEAN,
        //     hue = atan2 of the vector sum) means a pixel only ever
        //     DISPLAYS the accent's hue side once the accent's
        //     chroma-weighted vector outweighs the base's:
        //     share > C_base/(C_base+C_accent). Fast Car's red is OKLab
        //     C=0.209 vs the sat-0.40 teal's C=0.070 — threshold 75%. So
        //     the accent was invisible below 75% local dominance: only
        //     2.9-5.5% of the frame showed any teal at all (vs its 19.8%
        //     IDW weight share), everything else stayed pure red, and the
        //     whole red-to-teal transition compressed into ~2 tiny-canvas
        //     pixels (max neighbor ΔE_OK 0.13-0.14 — a hard edge the blur
        //     can only round, not feather), ringed by a mustard halo where
        //     the near-cancelled hue snaps through the yellow direction.
        //   - Every previously-guessed lever was tested against that rig
        //     and DISPROVEN: raising accent saturation to chroma-match the
        //     base made the edge HARDER (max ΔE 0.196); halving the accent
        //     blob's radius shrank the disc (1.2% area) but left the edge
        //     identical (ΔE 0.143); blob count was already at the minimum
        //     1 of 6. The earlier note here ("the real fix is giving the
        //     accent fewer/smaller blobs, not less saturation") was a
        //     reasonable guess and is simply wrong — no size/count/
        //     saturation combination can feather a ~180° pair in this
        //     renderer, because the sharpness comes from the blend math's
        //     hue snap, not from the blob's footprint.
        //   - Backing off to 165° (the watch item's own suggestion) still
        //     measured 8 hard-seam pixels (max ΔE 0.088) — OKLab
        //     separation was still ~150°, deep in cancellation territory.
        //     At offsets ≤ ~120-135° the seam vanishes entirely (0 pixels
        //     over ΔE 0.06/px, max 0.057): the sum vector never cancels,
        //     so atan2 sweeps CONTINUOUSLY through intermediate hues and
        //     the accent finally feathers into the base — visible accent
        //     area rises toward its actual weight instead of pooling.
        // So: triadic (120° away) — still a standard, legible color-wheel
        // relationship derived from the cover's own hue, and the largest
        // offset the mesh's blend can actually render as a gradient. Both
        // the SIDE of the wheel and the exact hue are chosen per cover by
        // pickAccentHue() below, and the 120° is measured in OKLAB hue
        // (the space the cancellation actually happens in), not HSL:
        // verification caught HSL-±120° spanning ~107°-149° OKLab
        // depending on the base — a green base at HSL 152° landed at
        // 149.3° OKLab and measured 14-15 hard-seam pixels, the same
        // failure class, so the offset is pinned at 120° OKLab for every
        // base instead. The sign matters because the swept arc between
        // base and accent becomes visible intermediate color on screen,
        // so the side whose arc stays clear of the muddy-warm pocket wins
        // (rendered proof: red base, green side = accent wearing a wide
        // baby-poop-mustard halo; same base, blue-violet side = melting
        // through clean magenta — same geometry, night and day).
        // The true-B&W branch above deliberately KEEPS its 200°/20°
        // complementary pair: with two equal-weight colors at 3 blobs each,
        // hard-ish seams read as the intended "two bodies dueling," and
        // there is no isolated low-weight disc to feather — the failure
        // mode is specific to a minority accent, not to opposition itself.
        //
        // Saturation history, for the record: 0.85 -> 0.55 ("neon slap"),
        // then 0.55 -> 0.40 (2026-07-30, Orleans' "Dance with Me" pooling
        // report, whose real structural cause — equal blob shares for a
        // minority accent — was since fixed by buildWeights/
        // allocateBlobCounts). 0.40 stands: the Fast Car rig confirmed
        // saturation was never the isolation lever, and at a feathering
        // offset 0.40 reads as a soft wash, which is the accent's whole job.
        // Accent saturation is no longer fixed (was 0.40, 2026-07-30 evening
        // revision): under the restored equal 3/3 blob split the accent owns
        // area by orbit, but the mesh's chroma-weighted hue vote still
        // decides what a pixel DISPLAYS — a pixel only leans past the
        // angular midpoint toward the accent when the accent's chroma-
        // weighted share beats the base's: share > C_base/(C_base+C_accent).
        // Measured live (Secret Garden): base C 0.192 vs fixed-0.40-sat
        // accent C 0.078 -> threshold 71% -> the accent's true hue showed
        // only in its blob cores and the field read ONE color. Pinning the
        // RATIO instead (C_accent = 0.55 x C_base -> threshold ~64.5%) keeps
        // accent presence proportional to how vivid the base actually is.
        // Solved by scanning HSL sat at the accent's own hue/lightness
        // against real OKLab chroma; clamped [0.25, 0.65] — floor keeps
        // presence on very muted bases, cap is the B&W branch's own
        // "carries the gradient alone" sat so it can never cross into neon.
        // Two passes because pickAccentHue's arc test depends on sat: pick
        // hue at the old provisional 0.40, solve sat at that hue, re-pick.
        const ACCENT_PROVISIONAL_SAT = 0.40;
        const ACCENT_CHROMA_RATIO = 0.55;
        const ACCENT_SAT_MIN = 0.25, ACCENT_SAT_MAX = 0.65;
        const accentLight = Math.min(0.75, Math.max(0.25, avgLuma));
        // no real candidates survived at all — rare, arbitrary last resort
        // (the old code anchored this case at hue 320; same color, as hex,
        // since pickAccentHue derives both HSL and OKLab hue from a hex)
        const baseHex = colors.length ? colors[0] : hslToHex(320, 0.55, 0.45);
        const provisionalHue = pickAccentHue(baseHex, ACCENT_PROVISIONAL_SAT, accentLight);
        const targetC = ACCENT_CHROMA_RATIO * hexToOklabChroma(baseHex);
        let accentSat = ACCENT_SAT_MIN, bestD = Infinity;
        for (let s = ACCENT_SAT_MIN; s <= ACCENT_SAT_MAX + 1e-9; s += 0.05) {
          const d = Math.abs(hexToOklabChroma(hslToHex(provisionalHue, s, accentLight)) - targetC);
          if (d < bestD) { bestD = d; accentSat = s; }
        }
        const accentHue = pickAccentHue(baseHex, accentSat, accentLight);
        const accent = hslToHex(accentHue, accentSat, accentLight);
        // Accent placed at index 2, not appended at the end — LiveScreen's
        // client-side picker (pickGradientColors) only ever looks at indices
        // 0-2 (top 2, plus a 3rd from index 2 specifically when the top 2
        // are hue-close). This branch's top 2 real picks ARE hue-close by
        // definition (that's what routed us into this fallback in the first
        // place), so appending the accent at the end (old: index 4 of 5)
        // put it past where the picker ever looks — confirmed via a
        // second-opinion library scan: the accent displayed on 0 of 26
        // real single-hue-family covers, including the exact covers ("Free
        // Ride," "Before You Go") whose live complaints motivated adding it.
        // At index 2 the picker's top-2/3rd-if-close logic reaches it on
        // every one of them.
        colors = [colors[0], colors[1], accent, ...colors.slice(2, 4)].filter(Boolean);
        // colors[0]/colors[1] (and any padding past index 2) are real, so
        // they keep their bucket population; `accent` is synthetic and gets
        // buildWeights' fixed ACCENT_WEIGHT share instead of competing for
        // an equal split — this is the actual structural fix for the
        // accent reading as a fully competing pooling color instead of a
        // minor one. Renderer contracts still consume this population weight.
        weights = buildWeights(colors.map(hex =>
          hex === accent ? { population: null } : { population: byHex.get(hex)?.population ?? null }
        ));
      }
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
  // Also returns `population` (bucket.length, i.e. how many of the ~7500
  // sampled pixels landed in this bucket) alongside the hex. This was
  // previously discarded entirely once medianCut returned — the single
  // biggest architectural gap found in the 2026-07-30 root-cause review:
  // every candidate was ranked by vividness alone with zero sense of how
  // much of the cover it actually represents, which is why a small vivid
  // accent could out-rank a large muted background that a viewer would
  // call "the cover's real color." See populationFactor()/buildWeights()
  // below for what consumes this.
  // De-spike (2026-07-30, late): the representative is no longer the single
  // most-vivid PIXEL but the average of the bucket's top-chroma cohort
  // (chroma >= 0.85 x the bucket max; always contains at least the max
  // pixel itself). The single-pixel pick was the right fix for muted covers
  // (see above) but on busy ALREADY-vivid art it rides lone compression-
  // spike pixels — measured live on Texas Hill's "Easy on the Eyes":
  // the cyan bucket's vivid pick was #00f8e2 at chroma 0.97 while its
  // 453-pixel top cohort averages #06cdd9 (the cover's actual sky-cyan),
  // and the magenta bucket's neon rep came from literally 2 pixels. Those
  // spike palettes are what read as "neon" on screen (live complaint:
  // "usually with the neon colors"). A 0.85 threshold keeps the cohort
  // tight enough that dark-red buckets don't broaden toward brown (0.70
  // measured #882c20 -> #83512e on "Vacation Eyes"; 0.85 stays in family),
  // while still averaging away single-pixel outliers. Muted covers are
  // unaffected in spirit: their cohort is small and close to the max pixel.
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

// Dampens population's effect on sort order so a large boring bucket can't
// win purely on size — CHROMA_FLOOR (below) still gates real color first;
// this only re-orders candidates that already cleared it. sqrt compresses
// the dynamic range (a bucket 4x bigger than another gets only 2x the
// factor, not 4x) so a modestly-larger muted region can't bury a smaller
// genuinely vivid one. Range 0.5 (smallest bucket) to 1.0 (largest) means
// population can at most halve a candidate's score, never zero it out or
// let it alone create a top pick from nothing -- chroma still has to be
// real to begin with. Calibrated 2026-07-30 against live extraction data
// from Sub-Radio's "1990something": the cover's actual dominant salmon-pink
// background (two buckets, each 12.5% of sampled pixels, popRel 0.5) was
// ranked 7th-8th by chroma alone, behind a 6.3%-of-image yellow patch
// (popRel 0.25, chroma 0.902) — this factor promotes the dominant color
// enough to compete for the top ranking slot without letting population
// override a real vividness gap (see src/test/palette.test.js).
export function populationFactor(popRel) {
  return 0.5 + 0.5 * Math.sqrt(Math.max(0, Math.min(1, popRel)));
}

// Builds a normalized (sum=1) weight per final output color, for the
// renderer to allocate blob count/size proportionally instead of an equal
// split. `entries` is an array of { population } -- population is the real
// bucket pixel-count for a color that came from `ranked`, or `null` for a
// synthetic color (the monochrome/single-hue-accent fallbacks below, which
// have no real bucket to measure). Synthetic entries each get a fixed
// ACCENT_WEIGHT share; the real entries split what's left, proportional to
// their own population. If EVERY entry is synthetic (the true-B&W fallback,
// exactly 2 fixed hues, nothing real behind either), there's nothing to be
// proportional to -- split evenly instead of collapsing to a divide-by-zero.
const ACCENT_WEIGHT = 0.15;
export function buildWeights(entries) {
  const real = entries.filter(e => e.population != null);
  const synthetic = entries.filter(e => e.population == null);
  if (!real.length) {
    const even = 1 / entries.length;
    return entries.map(() => even);
  }
  const totalReal = real.reduce((s, e) => s + e.population, 0);
  const realBudget = synthetic.length ? 1 - ACCENT_WEIGHT * synthetic.length : 1;
  return entries.map(e =>
    e.population == null ? ACCENT_WEIGHT : realBudget * (e.population / totalReal)
  );
}

// Merges near-duplicate-hue entries (same real hue family, different exact
// shade) into one before weights are computed — found live 2026-07-30 on
// Llunr's "Rocketship" (hard blue/orange split reported as "lava lamp"
// even after the weighted-palette fix above landed). Real output was
// #e89c00/#1169b6/#cc0000/#f2a61b/#005096 — only 3 genuine hue families
// (orange ~40°, blue ~208°, a trace of red), but the round-robin padding
// loop above (see its own comment, "Stay"/Abraham Alexander) deliberately
// cycles back through EVERY anchor family to hit MIN_COLORS when a cover
// doesn't have 5 genuinely distinct hues — so orange and blue each got a
// second near-duplicate entry (#e89c00/#f2a61b 1.5° apart, #1169b6/#005096
// 0° apart) purely to pad the count. That was harmless under the old
// equal-weight blob split (adjacent near-identical hues just blended into
// each other) but became a real bug when visual allocation was weight-driven:
// splitting one real hue family's population across two separate array
// entries handed each one its OWN independent visual-allocation slot,
// antipodally mirrored against a DIFFERENT
// partner — traced by hand against Rocketship's real weights, dark blue
// (#005096, 2 blobs) and #1169b6 (1 blob) never land in the same arena, so
// blue's presence gets reinforced against orange twice instead of settling
// into one stable, self-consistent pool. Same HUE_GAP_DEG bar the rest of
// this file already uses for "is this actually a different color" — if
// it's not diverse enough to count as a separate PICK, it shouldn't count
// as a separate WEIGHT/blob-allocation unit either. Keeps the
// higher-population member as the representative hex and folds every
// sibling's population into it (mutating `byHex` in place so buildWeights'
// lookup sees the combined total), so the family's full weight backs ONE
// entry. Only ever called on the normal vivid+padding path — the B&W/
// single-hue-accent branches below construct their hues 180° apart by
// design, so there's nothing for this to merge.
export function mergeHueSiblings(colors, byHex, hueGapDeg) {
  const groups = [];
  for (const hex of colors) {
    const hue = byHex.get(hex)?.hue ?? hexToHue(hex);
    const group = groups.find(g => hueDelta(g.hue, hue) < hueGapDeg);
    if (group) group.members.push(hex);
    else groups.push({ hue, members: [hex] });
  }
  return groups.map(g => {
    if (g.members.length === 1) return g.members[0];
    let best = g.members[0], bestPop = byHex.get(best)?.population ?? 0, totalPop = bestPop;
    for (const hex of g.members.slice(1)) {
      const pop = byHex.get(hex)?.population ?? 0;
      totalPop += pop;
      if (pop > bestPop) { bestPop = pop; best = hex; }
    }
    byHex.set(best, { ...byHex.get(best), population: totalPop });
    return best;
  });
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
// .chroma value other checks read) when it falls in the "muddy warm" pocket
// that reads as dirt/bile/decay almost regardless of the rest of a cover's
// palette. Originally (2026-07-29) this was a hardcoded hue 40°-100° box
// gated on ABSOLUTE chroma (full weight under 0.26, gone by 0.33), tuned
// against exactly one live complaint (#5b6732, The Mowgli's "I Feel Good
// About This"). A 2026-07-30 scan of the full live library — all 140
// covers, 651 output colors fetched from the production /api/palette,
// swatch-rendered and visually judged — showed that box missed almost
// everything in the same perceptual category: 44 output colors read as
// genuinely muddy, and the old box gave 41 of them weight 0. The misses
// fell in two groups the box could never catch:
//   1. Browns/tans BELOW hue 40 — #8b6b4d (Kyrie, hue 29), #906940
//      (Sweet Annie, hue 31), #a88a6e (Mary Was The Marrying Kind, hue
//      29): the literal "poopy brown" complaint, entirely outside a
//      40-100 hue gate.
//   2. Mustards/khakis whose ABSOLUTE chroma clears 0.33 while still
//      reading flat — #b18e55 (I Could Drive You Crazy, chroma 0.361),
//      #a17336 (White Walls, 0.420), #a69652 (Love Like That, 0.329):
//      max-min chroma says "vivid enough," the eye says baby-poop
//      mustard, because what matters is chroma relative to what that
//      LIGHTNESS can carry, not chroma in the absolute.
//
// The same scan also disproved the tempting fully-hue-agnostic theory
// ("muddy = low relative saturation at mid lightness, on any hue"): muted
// teals (#3c7f7e Umbrella, #5e9a9e), slate blues (#516891 Nine in the
// Afternoon), and dusty plums (#8146b8 1990something) sit at the SAME low
// relative saturation and mid lightness as the browns and read as
// perfectly good moody/dusty colors, not dirt. That matches the
// color-preference literature this pocket was built on: Palmer & Schloss
// ("An ecological valence theory of human color preference," PNAS 2010)
// found dark orange (brown) and dark yellow (olive) rated FAR below other
// colors of the same hues, while dark red, green, and blue took no such
// hit — the dislike trough is hue-specific (rot/waste associations), even
// though "muted" itself is hue-agnostic. Pantone 448C ("the world's
// ugliest color," Australia's plain-cigarette-packaging research) sits in
// the same warm band. So the model is: a hue-AGNOSTIC dullness measure
// (relativeSaturation below) deciding HOW muddy a color can be, gated by
// a warm-hue valence band deciding WHERE muddiness applies at all.
// Muddiness = the product of three continuous ramps:
//
//   hue — warm-valence band, full weight 28°-88°, ramping in over 16°-28°
//     and out over 88°-102°. Terracotta/rust below ~16° reads as clay,
//     not dirt (the scan's hue 3-20 low-saturation brick/clay colors all
//     passed visual inspection), and true greens above ~102° read as
//     foliage (#5da23d at hue 101, #6caf55 at 105 both read clean).
//   dullness — relativeSaturation (chroma / max chroma the HSL cylinder
//     holds at that lightness; the lightness-relative measure, same idea
//     as a color-appearance model's saturation correlate, colorfulness
//     judged against brightness) at full weight below 0.42, ramping out
//     by 0.55. Calibrated on the scan: every visually-muddy survivor sat
//     at 0.25-0.50; the clean warm controls (#b37a1f amber, rel-sat 0.70;
//     #cbb622 gold, 0.71; #eeb435, 0.84) all cleared 0.55. This replaces
//     the old absolute-chroma gate and is what catches group 2 above.
//     Multiplied by a neutrality guard (ramps in over chroma 0.05-0.12):
//     a warm-TINTED near-gray isn't muddy, it's gray — recoloring it
//     would invent a hue the art doesn't have, and CHROMA_FLOOR plus the
//     monochrome fallback already own the gray case.
//   lightness — mid band 18%-55% as before (Pantone 448C sits at 22.7%L),
//     but the top ramp widened 0.05 → 0.10: the scan's dirty-cardboard
//     tans (#ba9675, lightness 0.59, on Morning Light) were escaping
//     through the old 0.55-0.60 ramp, while genuinely-fine sand/parchment
//     (#ccb28e, lightness 0.68) stays outside the wider one too.
//
// Verified against the full 651-color scan before shipping: 44 colors
// caught at weight > 0.3 (all visually muddy on inspection), ZERO colors
// with relative saturation >= 0.55 caught, every cool-hue color untouched,
// and the original offender #5b6732 (hue 73.6°, rel-sat 0.35, lightness
// 30%) still lands at weight 1.0.
//
// Each ramp uses smoothstep over a buffer zone rather than snapping at a
// hard line, so a color a hair on either side of an edge gets nearly the
// same treatment instead of one being fully caught and the other fully
// waved through. The ramps multiply into one combined `weight` (0 =
// clean, 1 = dead center of the pocket), which interpolates the penalty
// between 1 (no discount) and 0.35 (full discount), same as always.
// smoothstep: see src/lib/mudModel.js

// HSL-cylinder saturation: chroma as a fraction of the maximum chroma the
// cylinder can hold at that lightness (1 - |2L - 1|). This is the
// hue-agnostic "dullness" axis uglyWeight ranks on — absolute chroma 0.36
// is most of what lightness 0.20 can carry (rich), but barely a third of
// what 0.50 can (flat). Same quantity chromaHueLightnessToHex already
// inverts to rebuild a hex. This is deliberately NOT hexToChroma's
// near-white-instability problem coming back (see that comment): here the
// value only ever gates a PENALTY, it never ranks a color upward, and the
// lightness band in uglyWeight keeps the unstable near-white/near-black
// ends out of play anyway.
// relativeSaturation: see src/lib/mudModel.js

// The warm-valence hue band from uglyWeight's three-ramp model, factored
// out (2026-07-30) so pickAccentHue below can integrate the SAME "where
// does muddiness live on the wheel" band over a swept hue arc — one
// definition, shared, so accent placement and mud detection can never
// drift apart (same discipline as uglyPenalty/deuglify sharing
// uglyWeight). Full weight 28°-88°, ramping in over 16°-28° and out over
// 88°-102° — calibration notes in the uglyWeight comment below.
// warmPocketHueWeight: see src/lib/mudModel.js

// 0 (clean) to 1 (dead centre of the muddy-warm pocket). Factored out of
// uglyPenalty (2026-07-29) so the score discount and deuglify's recolor
// below share one definition of "in the pocket" and can never disagree.
// Generalized 2026-07-30 from the original 40-100° absolute-chroma box to
// the three-ramp model documented above.
// uglyWeight: see src/lib/mudModel.js (calibration documented above)

function uglyPenalty(hue, chroma, lightness) {
  const weight = uglyWeight(hue, chroma, lightness);
  return 1 - weight * 0.65; // weight 1 → 0.35 (full discount), weight 0 → 1 (none)
}

// OKLab hue (degrees, 0-360) of a hex color — standard Björn Ottosson
// sRGB→OKLab, reduced to just the hue angle. Kept local to the serverless
// palette module, like the client picker and simulation rigs — api/ is
// serverless and this file's rule is no cross-layer
// refactors without a bug to justify them. Needed by pickAccentHue below
// because the former blend's cancellation problem lived in OKLab's a/b plane, so
// only OKLab hue distance predicts it — HSL hue distance does not (the
// 2026-07-30 verification sweep measured HSL-±120° spanning anywhere from
// ~107° to ~149° in OKLab depending on the base hue).
// OKLab chroma (a/b magnitude) of a hex color — sibling of hexToOklabHueDeg
// below, same matrix. Needed by the accent-saturation solve above because
// the historical hue-vote visibility threshold was a ratio of OKLab chromas, so
// the accent's sat must be chosen against real OKLab chroma, not HSL sat.
export function hexToOklabChroma(hex) {
  const lin = v => { v = parseInt(v, 16) / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const r = lin(hex.slice(1, 3)), g = lin(hex.slice(3, 5)), b = lin(hex.slice(5, 7));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return Math.hypot(a, bb);
}

export function hexToOklabHueDeg(hex) {
  const lin = v => { v = parseInt(v, 16) / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const r = lin(hex.slice(1, 3)), g = lin(hex.slice(3, 5)), b = lin(hex.slice(5, 7));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360;
}

// Places the single-real-hue branch's synthetic accent: 120° from the
// base — measured in OKLAB hue, not HSL hue — and this function picks the
// SIGN. Why 120° at all (not the original 180° complementary) is
// documented at the call site above: the mesh's per-pixel blend derives
// hue from the a/b vector SUM, which cancels toward zero near opposition,
// so the hue SNAPS instead of sweeping and the accent pools as an
// isolated hard-edged disc (the Fast Car bug); ~120° is the largest
// separation the blend renders as a continuous feathered gradient
// (simulate-accent-blob.mjs: 0 hard-seam pixels vs 14-24 at 180°).
//
// Why the offset is applied in OKLab: the cancellation is a geometric
// fact about the a/b plane, so the safety margin is an OKLab hue
// distance. HSL-hue ±120° only lands near OKLab 120° for some bases —
// the verification sweep caught HSL-±120° on a green base (HSL 152°)
// mapping to 149.3° OKLab, back in cancellation territory. The metric
// that separates "bug" from "renderer baseline" here is seam
// PERSISTENCE, not any single frame: two differently-colored blob
// centers crossing always spikes a transient seam (the ACCEPTED-good
// references measure far worse single frames — the true-B&W duel pair
// and the fixed Rocketship palette both show seam pixels in 61/61
// sampled frames over 30s, worst 80/65 px — and the 24px screen blur is
// what absorbs those on screen), but a near-cancellation pair wears its
// seam as a STANDING ring around the accent: the HSL-±120° green case
// measured seams in 48 of 61 frames — the exact persistence signature
// of the original 180° Fast Car bug (also 48/61) — vs 17/61
// (crossing-driven only) for the same base once the separation is
// pinned at 120° OKLab, and 6/61 for Fast Car itself. The target OKLab
// hue is inverted back to an HSL hue by scanning all 360 integer HSL
// hues at the accent's own fixed saturation/lightness (the mapping is
// monotonic; ~720 cheap conversions, once per cover, single-hue branch
// only).
//
// The SIGN matters because the IDW blend actually DISPLAYS the
// intermediate hues along the short arc between base and accent — that
// arc becomes real on-screen color, so a side whose arc crosses the
// muddy-warm pocket paints the mud as a halo around the accent. Rendered
// proof in the rig: Fast Car's red base with the green-side accent wears
// a wide mustard halo (3.1% of frame pixels in the pocket); the
// blue-violet side melts through clean magenta (0.0%). Integrate
// warmPocketHueWeight (the pocket's own hue band — shared definition,
// see above) along each candidate's swept HSL arc at 1° steps and take
// the cleaner side. Ties — both arcs fully clean, which happens for cool
// bases whose OPPOSITE wedge is where the pocket lives — prefer the +
// side: a warm pink/red accent against a cool base. A side effect worth
// noting: an arc that ENDS deep in the pocket necessarily swept into it
// (big penalty), so the chosen accent itself always lands clear of the
// pocket — verified across all 360 integer base hues in
// verify_accent_tmp.mjs (max warmPocketHueWeight of the chosen accent: 0).
export function pickAccentHue(baseHex, accentSat, accentLight) {
  const baseHslHue = hexToHue(baseHex);
  const baseOkHue = hexToOklabHueDeg(baseHex);
  // Invert "OKLab hue = target" to the HSL hue whose rendered accent (at
  // the accent's own sat/lightness) lands closest to it.
  const candidateFor = (sign) => {
    const target = ((baseOkHue + sign * 120) % 360 + 360) % 360;
    let bestH = 0, bestD = Infinity;
    for (let h = 0; h < 360; h++) {
      const d = hueDelta(hexToOklabHueDeg(hslToHex(h, accentSat, accentLight)), target);
      if (d < bestD) { bestD = d; bestH = h; }
    }
    return bestH;
  };
  const arcPenalty = (accentHslHue) => {
    let delta = ((accentHslHue - baseHslHue) % 360 + 360) % 360;
    if (delta > 180) delta -= 360; // signed short arc, matches the on-screen sweep
    const steps = Math.max(1, Math.round(Math.abs(delta)));
    let sum = 0;
    for (let k = 1; k <= steps; k++) {
      sum += warmPocketHueWeight(((baseHslHue + delta * (k / steps)) % 360 + 360) % 360);
    }
    return sum;
  };
  const plusH = candidateFor(1), minusH = candidateFor(-1);
  return arcPenalty(plusH) <= arcPenalty(minusH) ? plusH : minusH;
}

// Recolors a candidate deep in the muddy-warm pocket instead of just
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
// Recoloring (not dropping) is a deliberate choice re-examined during the
// 2026-07-30 generalization, against the alternative of skipping a muddy
// pick and promoting the next-ranked candidate: on the covers that
// actually produce mud (sepia photos, wood, skin tones — see Abraham
// Alexander's "Stay" in the padding comments above) the muddy color IS
// the dominant region, often most of the image. Skipping it either hands
// the background to a tiny unrelated accent, or leaves so few distinct
// hue families that the hue-gap diversity pass and the monochrome
// fallback both degrade — and buildWeights would then hand the surviving
// colors that region's population share, overstating THEIR area instead.
// Recoloring keeps the region's slot, its population weight, and its hue
// family; it only fixes the color. (The score penalty below still demotes
// anything the recolor leaves partially muddy, so "try the next color
// first" already happens implicitly through sort order.)
//
// Splits at hue 60° — a muddy hue already reads as green rather than
// brown/mustard by around 60°. At/above 60 it rotates toward leaf green
// (108°, just past the pocket's upper ramp). Below 60 — the browns/tans/
// mustards the 2026-07-30 generalization added — it rotates toward
// terracotta (18°, just inside the lower ramp): the same live scan that
// calibrated uglyWeight showed low-saturation hue-3-to-20 brick/clay
// reading fine while the identical treatment a step yellower reads as
// dirt, so terracotta is the nearest hue where "muted warm" stops being
// "muddy." (The old target was 34° bronze — meaningless once the pocket
// reaches down past 20°: most browns ARE ~30°, and rotating them to 34
// was a near-no-op that left the chroma lift to do all the work.) Chroma
// and lightness lift together with the hue shift, as before — Pantone
// 448C reads ugly because it's desaturated AND mid-dark, not because of
// its hue angle alone. The lift cap moved from a flat 0.42 to
// max(chroma, 0.45): the scan's mustards arrive at chroma 0.39-0.42
// already, so the old hard ceiling would have zeroed the lift for exactly
// the colors that need it most, and Math.min against a value below the
// input would have REDUCED chroma — max() keeps the rule "lift, never
// reduce."
export function deuglify(hue, chroma, lightness, originalHex) {
  const weight = uglyWeight(hue, chroma, lightness);
  if (weight <= 0) return { hue, chroma, lightness, hex: originalHex };

  const TARGET_HUE = hue >= 60 ? 108 : 18;
  const MAX_ROT = 35; // stays recognizably the same underlying color
  const rot = Math.max(-MAX_ROT, Math.min(MAX_ROT, weight * (TARGET_HUE - hue)));

  const newHue = (hue + rot + 360) % 360;
  const newChroma = Math.min(chroma + weight * 0.18, Math.max(chroma, 0.45));
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
