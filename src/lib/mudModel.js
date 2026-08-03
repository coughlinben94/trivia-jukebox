// Shared muddy-warm-pocket model used by api/palette.js to gate and recolor
// extracted candidates. This module stays pure (no browser/Node APIs) so the
// Vercel serverless bundle can import it through ../src.
//
// Bands were calibrated in HSL hue / relative-saturation / lightness space
// against a 651-color live-library scan (2026-07-30, see api/palette.js
// uglyWeight comment for the full calibration story). Consumers must
// evaluate in that space — do NOT refit these bands in OKLab; two mud
// definitions will drift.

export function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// HSL-cylinder saturation: chroma as a fraction of the maximum chroma the
// cylinder can hold at that lightness (1 - |2L - 1|). The hue-agnostic
// "dullness" axis uglyWeight ranks on.
export function relativeSaturation(chroma, lightness) {
  const denom = 1 - Math.abs(2 * lightness - 1);
  if (denom <= 0) return 0;
  return Math.min(1, chroma / denom);
}

// Warm-valence hue band — WHERE muddiness applies on the wheel. Full weight
// 28°-88°, ramping in over 16°-28° and out over 88°-102°. Terracotta below
// ~16° reads as clay, true greens above ~102° read as foliage.
export function warmPocketHueWeight(hue) {
  const HUE_IN_LO = 16, HUE_IN_HI = 28, HUE_OUT_LO = 88, HUE_OUT_HI = 102;
  if (hue < HUE_IN_HI) return smoothstep(HUE_IN_LO, HUE_IN_HI, hue);
  if (hue > HUE_OUT_LO) return 1 - smoothstep(HUE_OUT_LO, HUE_OUT_HI, hue);
  return 1;
}

// 0 (clean) to 1 (dead centre of the muddy-warm pocket). Product of three
// continuous ramps: warm hue band × dullness (rel-sat < 0.42 full, out by
// 0.55, with a neutrality guard so warm-tinted grays don't count) ×
// mid-lightness band (0.18-0.55). Calibration: 44/651 scan colors caught,
// zero false positives on muted teals/slates/plums; #5b6732 → 1.0.
export function uglyWeight(hue, chroma, lightness) {
  const hueWeight = warmPocketHueWeight(hue);
  if (hueWeight <= 0) return 0;

  const REL_SAT_LO = 0.42, REL_SAT_HI = 0.55;
  const NEUTRAL_LO = 0.05, NEUTRAL_HI = 0.12;
  const dullWeight = (1 - smoothstep(REL_SAT_LO, REL_SAT_HI, relativeSaturation(chroma, lightness)))
    * smoothstep(NEUTRAL_LO, NEUTRAL_HI, chroma);
  if (dullWeight <= 0) return 0;

  const LIGHT_LO = 0.18, LIGHT_HI = 0.55, LIGHT_RAMP_LO = 0.05, LIGHT_RAMP_HI = 0.10;
  let lightnessWeight;
  if (lightness < LIGHT_LO) lightnessWeight = smoothstep(LIGHT_LO - LIGHT_RAMP_LO, LIGHT_LO, lightness);
  else if (lightness > LIGHT_HI) lightnessWeight = 1 - smoothstep(LIGHT_HI, LIGHT_HI + LIGHT_RAMP_HI, lightness);
  else lightnessWeight = 1;
  if (lightnessWeight <= 0) return 0;

  return hueWeight * dullWeight * lightnessWeight;
}
