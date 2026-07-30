// Shared "muddy warm pocket" model — ONE definition of ugly, used by BOTH
// layers that can produce a displayed color:
//   · api/palette.js — gates/recolors EXTRACTED palette candidates (deuglify)
//   · AlbumGradientMesh.jsx — rescues DISPLAYED per-pixel blends (mudRescue)
// The renderer needs its own guard because the mesh's polar blend displays
// every hue along the short OKLab arc between simultaneously-present colors
// (spatially at seams, temporally across the 7.5s crossfade) — colors that
// exist in no palette entry and so can never be caught server-side. This
// module is pure data + pure functions (no browser/Node APIs) so both
// bundles can import it — same precedent as paletteDefaults.js; Vercel's
// nft tracing follows the ../src import when bundling the serverless fn.
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

// ── Displayed-pixel rescue (renderer output stage) ──────────────────────────
// Chroma-lift at FIXED hue and lightness: mustard becomes amber/ochre of the
// same hue — "push it to a prettier shade," never a different color. Hue
// rotation was rejected for the per-pixel case: any continuous hue rescue
// strands a fixed-point hue mid-pocket and piles swept hues into two-tone
// bands at the pocket edges. Saturated warm is well-rated (Palmer & Schloss;
// the scan's clean ambers sit at rel-sat 0.70+); the dislike trough is
// specifically LOW-saturation warm.
//
// MUD_RESCUE_SAT 0.62: just past uglyWeight's own 0.55 clean edge — the
// nearest empirically-clean saturation. Full-strength rescue lands exactly
// there, so post-rescue dullWeight is 0 by construction.
// MUD_RESCUE_KNEE 0.35: strength = min(1, w/0.35) reaches FULL while w is
// still mid-ramp, so every deep-pocket pixel exits the pocket completely
// instead of stranding at a partially-lifted (still muddy) saturation —
// the fixed-point trap that sinks gentler easings like sqrt(w) or w.
// Chroma gate smoothstep(0.10, 0.16): near-neutrals are deliberately
// untouched — partial enrichment of a warm gray MANUFACTURES mud (chroma
// 0.07 lifted halfway lands at ~0.3 dull khaki). Warm-tinted gray is gray,
// not mud, per the model's own neutrality-guard rationale; all 44
// scan-confirmed muddy colors had chroma ≥ 0.24.
//
// Self-quench guarantee (verified exhaustively in src/test/mudModel.test.js
// over the full HSL grid at chroma ≥ 0.16): post-rescue uglyWeight ≤ KNEE.
export const MUD_RESCUE_SAT = 0.62;
export const MUD_RESCUE_KNEE = 0.35;

// Returns the corrected HSL saturation s' for a displayed pixel already
// measured at (hslHue, hslChroma, hslLightness). Identity when outside the
// pocket (w=0) or below the chroma gate. Continuous everywhere (composition
// of smoothsteps and lerps) — no banding; blur(24px) sits downstream anyway.
export function mudRescue(hue, chroma, lightness) {
  const w = uglyWeight(hue, chroma, lightness);
  const denom = 1 - Math.abs(2 * lightness - 1);
  const s = denom > 0 ? Math.min(1, chroma / denom) : 0;
  if (w <= 0) return s;
  const gate = smoothstep(0.10, 0.16, chroma);
  if (gate <= 0) return s;
  const k = gate * Math.min(1, w / MUD_RESCUE_KNEE);
  return s + k * (MUD_RESCUE_SAT - s);
}
