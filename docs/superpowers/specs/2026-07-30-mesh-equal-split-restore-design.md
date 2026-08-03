# Mesh equal-split restore + displayed-mud guard — design

2026-07-30, late evening. Owner: Ben. Consultant review ("think tank"): three-lens design pass (color science / renderer math / regression risk), full findings folded in below.

## Problem

The 07-28..30 weighted-blob work made a color's screen area proportional to its cover pixel population, quantized into 6 blob slots. A ~15%-weight color got exactly 1 blob — which is either **invisible** (loses the chroma-weighted hue vote everywhere but its own core; live reports: "one color on screen," Secret Garden, Down) or a **lone orbiting disc** (a compact pool circling one fixed orbit all song; live reports: "lava lamp," "blue blob going round and round," Dead Beat City). 30-cover live audit, exact renderer math, 20 frames each: **22/30 broken** (14 LONE_DISC, 7 ONE_COLOR, 1 MONO). Equal alternating split — the math live on 2026-07-27, which the owner remembers as right — scored **27/30 clean** on the same covers.

Separately, the owner's standing requirement "no ugly colors, push them to a prettier shade" was only enforced for *extracted* palette entries (api/palette.js deuglify). The mesh's polar blend displays every hue along the short OKLab arc between co-present colors — spatially at seams, temporally across the 7.5s crossfade — so the screen can show muddy warm shades that exist in no palette entry. No layer guarded those.

## Decision

1. **Renderer**: restore equal alternating split (`src[(i+rot) % len]`, up to 6 hues). Delete `allocateBlobCounts`/`assignColorsToPairs`/`BLOB_PAIRS`. Keep antipodal orbit pairing (pins each color's frame share to ~0.43–0.59; fixes the measured 07-27 defect of 0.29→0.72 mid-song share flips without changing the look). `weights`/`nextWeights` props stay accepted-and-unused. Dial defaults restored: `chromaScale` 50 → 0.82, `meshIdwPower` 50 → 3 (lerp endpoints re-centered: 0.64–1.00, 2–4).
2. **Displayed-mud guard** (new, output stage of `draw()`): every pixel, after chroma scaling, is checked in the same HSL space the mud bands were calibrated in (651-color scan; bands live in new shared module `src/lib/mudModel.js`, re-exported by api/palette.js so its tests keep passing). In-pocket pixels get a chroma-lift at fixed hue/lightness toward `MUD_RESCUE_SAT = 0.62` with strength `min(1, w/0.35)` gated by `smoothstep(0.10, 0.16, chroma)`. Hue rotation and near-neutral enrichment rejected (fixed-point stranding / mud manufacture — see mudModel.js comments). Self-quench guarantee (post-rescue weight ≤ 0.35 for chroma ≥ 0.16) verified exhaustively in `src/test/mudModel.test.js`.
3. **Accent chroma ratio** (api/palette.js single-real-hue branch): accent saturation solved per cover so accent OKLab chroma = 0.55 × base chroma (clamp sat 0.25–0.65, two-pass with `pickAccentHue`), replacing fixed 0.40. Without it, a vivid base sets a ~71% hue-vote threshold and the accent reads only in its blob cores.
4. **Cache**: `PALETTE_VERSION` 2 → 3 (server output changed; owner asked for a cache clear on push).

## Acceptance results (run 2026-07-30 in-browser, sandbox shell was down; committed re-runnable version: `scripts/simulate-mesh-restore.mjs`)

- **Mud**: 6 of 30 covers had displayed mud pre-guard (worst: Why Can't I Touch It 84.5% of frame pixels, Good Old Days 65.5%, Young 60.7%) → **0 post-guard on every frame of every cover**. Grid unit test proves the bound analytically.
- **Presence**: every palette color ≥ 5% mean frame share on 27/30; residuals below.
- **Seams**: the ΔE>0.12-anywhere gate was **invalidated by its own calibration references** (accepted-good true-B&W duel: 58/60 "sharp"; accepted Rocketship: 59/60; actual Fast Car standing-ring bug: 7/60). It measures long soft battle lines — the *liked* look — and misses small rings. Demoted to informational in the sim. Binding judgment was visual: side-by-side renders of the four seam-heaviest covers at IDW 3 vs 2 — IDW 3 reads as distinct flowing bodies (the remembered 07-27 look), IDW 2 goes milky; no rings or hard edges either way. **IDW 3 ships.**

## Addendum — mud guard v2 (same night, ~20:15)

Guard v1 above (chroma-LIFT to 0.62) was wrong for the dominant case: a swept blend corridor through the pocket got every intermediate hue lifted to uniform high saturation = a vivid moving rainbow band (observed live on "Nothing But The Beat" within minutes; same mechanism as the fish/seam reports). v2 inverts to DESATURATION toward near-neutral (`MUD_RESCUE_NEUTRAL_S`), reviewed by three independent critics (perception / math / systems — unanimous ship-with-amendment) whose amendments are in: rescue decided in palette space pre-chromaScale and applied as a ratio (fixes BRIGHTNESS-dial band shift that grayed deuglify's own terracotta), luma preserved through the desat (corridor is chroma-only modulation), grid test replaced (old one aliased over a ~0.014-wide transient sliver where post-weight reaches 1.0 — real, thin, blur-absorbed, now honestly documented and shell-width-tested), plus an anti-rainbow lock test (rescue can never increase saturation). Known accepted trades: field-wide brief gray dip on muted cross-warm crossfades (replaces the olive wash; observe live before touching `MUD_RESCUE_KNEE`), and the 0.10-0.16 chroma gate band is partially treated by design. No server change; no pv bump needed.

## Addendum 2 — Cartesian blend revert (2026-08-03)

Watched frame-by-frame from a live recording (Kyrie / Mr. Mister): the 07-28 polar spatial blend (hue from vector sum, chroma from scalar mean) displays every intermediate hue at FULL chroma between hue-distant blobs — a 3-color green/blue/red palette rendered vivid magenta/cyan/orange/yellow that exist on no cover. This one mechanism is upstream of the week's whole corridor-artifact family (rainbow, fish, seams). Reverted the spatial blend to Cartesian a/b mixing: distant hues cancel toward neutral at seams (paint behavior), no un-palette hue can appear; the warm-olive neutral case that originally motivated polar is now owned by mud guard v2. Verified side-by-side with the real Kyrie palette, 4 timestamps, guard on: same bodies/motion, corridors neutral. Temporal crossfade (blendPairRgb) keeps LCh. No server change, no pv bump.

## Residuals / follow-ups

- **Strawberry Wine** returned a 1-color palette from production (`colors.length === 1`) — some path skips both the accent branch and MIN_COLORS padding. Renderer handles it (single-color field), but trace the server path.
- **Why Can't I Touch It? / A Thousand Miles**: a *real* second color with very low chroma still loses the hue vote despite equal area (mean share < 5%). Candidate: extend the accent chroma-ratio idea to real-but-dull secondaries (lift toward a floor ratio of the primary's chroma — same "prettier shade" discipline). Not attempted tonight.
- Seam classifier that actually separates standing rings from battle lines (topology/persistence of closed contours, post-blur) — research-grade; only worth it if ring-class bugs ever return.
