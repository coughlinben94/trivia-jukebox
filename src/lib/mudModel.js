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

// ── Displayed-pixel rescue (renderer output stage) ──────────────────────────
// DESATURATE toward neutral — v2, 2026-07-30 ~20:00. v1 (same evening,
// briefly live) lifted in-pocket pixels to a clean-amber saturation (0.62)
// on the theory "saturated warm is well-rated." Correct for an ISOLATED
// muddy pixel; catastrophic for the case that actually dominates on screen:
// a CONTINUOUS blend corridor between two clean hues (red↔teal on David
// Guetta's "Nothing But The Beat", blue↔orange on Valley's "There's Still A
// Light In The House") sweeps every intermediate hue through the pocket,
// and lifting each of those pixels to uniform high saturation renders the
// full spectrum as a vivid RAINBOW BAND drifting across the field —
// observed live within minutes of deploy (three frames captured: a
// prism-smear arc sweeping the whole background; also the standing "seams"
// and "fishes" reports on blue/orange covers, which are the same corridor
// with fewer hues). The guard was converting quiet mud into loud rainbow.
//
// v2 pushes the OTHER way: in-pocket pixels desaturate toward near-neutral
// (NEUTRAL_S). A desaturated warm corridor reads as a soft shadow between
// two color bodies — quiet, not dirty, not rainbow. This is deliberately
// the treatment the model's own research supports: the Palmer & Schloss
// dislike trough is mid-saturation warm (mud); NEAR-NEUTRAL warm is plain
// gray/taupe shading and never scanned as ugly (the neutrality guard
// exists precisely because warm-tinted gray is not mud). Full-strength
// rescue lands below the neutrality guard's floor (chroma < 0.05·denom at
// mid lightness), so post-rescue uglyWeight collapses to ~0 through the
// neutrality ramp rather than the saturation edge.
//
// MUD_RESCUE_KNEE 0.15: strength = min(1, w/0.15) saturates FAST so any
// meaningfully-in-pocket pixel goes essentially all the way to neutral.
// HONEST SCOPE (critic review, 2026-07-30): any continuous map that is
// the identity at rel-sat 0.55 and near-neutral below 0.42 must pass
// through the intermediate (muddy) saturations SOMEWHERE — here that
// transient lives on a ~0.014-wide sliver of input s just under the
// clean edge, where partial desaturation lands mid-pocket (post-weight
// can touch 1.0 on that sliver; a 0.05-step grid aliases right over it,
// which is how v2's first test "proved" a false 0.35 bound). The knee
// keeps the sliver thin in INPUT measure (~1-2 tiny-canvas px at seam
// gradients); the blur upscale absorbs it spatially. The guarantees that
// ARE true and tested (src/test/mudModel.test.js): full quench for any
// pixel with pre-weight ≥ KNEE at chroma ≥ 0.16 (post-weight ≤
// MUD_RESCUE_BOUND, via the neutrality ramp), a bounded ≤0.02-wide
// transient shell, and — the anti-rainbow lock — the rescue can never
// increase saturation. These are tiny-canvas (pre-blur) invariants; the
// upscale blur can remix rescued and unrescued warm pixels back into
// mid-saturation at band edges, so screen-stage mud is measured by the
// render sim, not asserted from this grid.
// Chroma gate smoothstep(0.10, 0.16): near-neutrals pass through — they're
// already the destination. The 0.10-0.16 band is deliberately partially
// treated (never worsened — desat only reduces the neutrality factor
// there); "bounds displayed color" claims exclude it.
export const MUD_RESCUE_NEUTRAL_S = 0.06;
export const MUD_RESCUE_KNEE = 0.15;
export const MUD_RESCUE_BOUND = 0.06; // full-quench ceiling: smoothstep(0.05,0.12,0.06)=0.0554

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
  return s + k * (MUD_RESCUE_NEUTRAL_S - s);
}
