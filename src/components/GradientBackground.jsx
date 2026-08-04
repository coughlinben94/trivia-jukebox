/* eslint-disable react-refresh/only-export-components -- pure renderer helpers are exported for focused state/math tests */
import { useEffect, useRef } from 'react'
import {
  blendDurationMs, brightnessAdjustment, motionSpeed,
  anchorAmplitude, wobbleAmount, seamWidth, shadeAmount,
} from '../lib/gradientTuning.js'
import { prepareTwoPoolField } from '../lib/twoLightBlend.js'
import { makeFlowNoise2D } from '../lib/flowNoise.js'

// Opus-consultant-verified bug (2026-08-04): every `wobble.fbm(...) * amount`
// call site in this file assumed fbm's 2-octave output spans roughly
// [-1, 1] -- measured (20 seeds x 5000 samples each, see PR discussion) it
// actually peaks around 0.53. So wobbleAmount/shadeAmount/drift/speedMod
// were ALL under-delivering their stated amount by ~1.9x, not just the
// speed one the owner happened to notice ("the speed should go up and down
// by 15% either way" measured at ~3% before this fix). FBM_PEAK divides
// that back out so a caller's "amount" means what it says. Calibrated for
// octaves=2 specifically (every call site here uses 2) -- would need
// re-measuring if any call site's octave count changes.
const FBM_PEAK = 0.53
const TINY_SIZE = 48
// Blur-upscale already hides resolution loss (the 48x48 tile is what
// carries the actual gradient) — capping the destination canvases' backing
// store keeps 3 full-res RGBA buffers (2 visible + 1 snapshot) cheap
// regardless of viewport/DPR. Uncapped, a plain 1080p screen at DPR2 alone
// runs ~95MB across the 3; 4K/DPR1 hits ~100MB, 4K/DPR2 ~400MB.
const MAX_BACKING_DIMENSION = 800
const SENTINEL = '#080808'
const FALLBACK = ['#702070', '#d83a88']
const VALID_HEX = /^#[0-9a-f]{6}$/i

function hashString(value) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

// Two pool anchors (was two point-lights, pre-2026-08-04). Each anchor
// wanders around its own base position; prepareTwoPoolField assigns every
// pixel to whichever anchor is spatially nearer (unweighted), so these
// positions are what actually shapes and moves the two pools' boundary.
//
// driftPhase* (2026-08-04): owner, live, after the flat-pool/wobble version
// landed: "the motions of the two colors interacting with each other needs
// to feel more random." Pure sine motion is a Lissajous curve -- exactly
// periodic, and over a 3-4 minute song a repeating path reads as
// mechanical however organic any single loop looks. drawScene blends this
// sine path with a slow noise-driven wander (same per-scene noise generator
// used for the boundary wobble, sampled along time at a distinct offset per
// anchor/axis via these phases) -- noise never repeats, so the two anchors'
// relative motion stops being a fixed dance and reads as actually drifting.
// Owner, live (2026-08-04, follow-up to the crossing/dancing ask): the
// crossing fix above barely changed anything on measurement -- pinned-at-
// MIN_ANCHOR_SEPARATION time stayed ~60% regardless of drift amplitude
// (swept 0.9x-1.7x, all landed 58-63%). Root cause traced to base position
// generation, not motion: each anchor's baseX/baseY was independently
// uniform over the same 0.25-0.75 box, so two random points in a 0.5x0.5
// square land under the 0.35 floor ~half the time from BIRTH, before any
// sine/drift runs -- the clamp was pinning the pair into a fixed-radius
// orbit (only the rate-limited angle free to move) for the majority of a
// typical song, which reads as mechanical no matter how large the wander
// amplitude is. Fix at the source: anchor B's base is now placed at a
// guaranteed 0.45-0.70 separation from anchor A, random angle -- the clamp
// goes back to being the rare safety net it was designed as, so real
// noise-driven wandering (and the crossing/retreat it produces) actually
// gets to run instead of being swallowed by the collision guard almost
// all the time.
export function makeLightParams({ shuffleKey = 0, artUrl = '', colors = [] }) {
  let seed = hashString(`${shuffleKey}|${artUrl}|${colors.join('|')}`)
  const rng = () => {
    seed += 0x6d2b79f5
    let value = seed
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
  const amp = anchorAmplitude()
  const baseAX = 0.25 + rng() * 0.5
  const baseAY = 0.25 + rng() * 0.5
  const baseSep = 0.45 + rng() * 0.25
  const baseAngle = rng() * Math.PI * 2
  const bases = [
    { baseX: baseAX, baseY: baseAY },
    { baseX: baseAX + Math.cos(baseAngle) * baseSep, baseY: baseAY + Math.sin(baseAngle) * baseSep },
  ]
  return bases.map(base => ({
    ...base,
    ampX: amp + (rng() - 0.5) * amp * 0.4,
    ampY: amp + (rng() - 0.5) * amp * 0.4,
    freqX: (0.35 + rng() * 0.2) * motionSpeed(),
    freqY: (0.3 + rng() * 0.2) * motionSpeed(),
    phaseX: rng() * Math.PI * 2,
    phaseY: rng() * Math.PI * 2,
    driftPhaseX: rng() * 1000,
    driftPhaseY: rng() * 1000,
    driftFreqMult: 0.7 + rng() * 0.6,
  }))
}

// Opus-consultant-verified bug (2026-08-04): nothing stopped the two anchors
// from drifting into each other -- base separation is only ~0.29 with each
// anchor independently wandering +-anchorAmplitude() (~0.15) on top, and
// about a fifth of songs are "born" with base positions under 0.15 apart.
// Simulated against real makeLightParams seeding across 300 songs: 85% hit
// a degraded stretch, 72% a full collision, averaging ~16.5s/song (worst
// case 66.5s -- over a third of the song). When separation collapses, the
// unweighted nearest-anchor split's base signedField magnitude collapses
// with it, so the boundary-wobble noise term (which isn't scaled by
// separation) can dominate and swing the WHOLE frame's field sign at once --
// which independently reproduced all three previously-rejected looks in one
// sequence: full-frame haze ("blended everywhere"), one color vanishing
// entirely (0% pool purity), and the isolated "circle" blob reforming as
// separation recovered.
//
// A minimum-separation clamp (first cut) fixed all of that but two
// independent adversarial reviews caught the SAME follow-on bug in it: the
// clamp rescales the DISTANCE between the anchors but inherits the RAW
// direction between them unchanged. As raw separation approaches zero, that
// direction is numerically unstable -- it can reverse ~180 degrees in a
// single frame when the anchors' true (unclamped) positions cross each
// other. Pre-clamp, that reversal was invisible because the field itself
// had also collapsed to near-uniform mush at the same moment. Post-clamp,
// the field is held at FULL contrast the entire time (separation is pinned
// at the floor), so that same instantaneous reversal renders as a hard,
// whole-screen color swap -- measured up to ~92% of the frame flipping pool
// membership in a single 60fps frame, in roughly a third of simulated
// songs. A rescued distance with an unrescued direction just moved the bug
// from "mushy" to "flashing."
//
// FIRST ATTEMPT at fixing the direction (2026-08-04, reverted same day): a
// hysteresis flip -- keep the raw axis, but negate it whenever it points
// >90 degrees from last frame's chosen axis, so the push axis tracks
// whichever orientation is closer to continuous. This had a real bug: the
// incremental push formula (`a -= u*push; b += u*push`) assumes u always
// points from A toward B. Negating u for continuity, without separately
// correcting the push's sign, pushes the anchors TOGETHER instead of apart
// whenever the flip is active -- caught by re-running the separation
// invariant after implementing it (min separation collapsed to ~0.00001,
// should never go below 0.35). Worse, once the sign is corrected
// algebraically, the result reduces to being mathematically identical to
// always using the raw direction directly -- a fixed-separation "mid +-
// axis*half" reconstruction has no continuous solution that also tracks
// the true instantaneous relative position, because the anchors' actual
// crossing IS the discontinuity; hysteresis-on-a-linear-push cannot smooth
// over a singularity in what it's built from.
//
// SECOND ATTEMPT (also reverted same day): blend the push angle toward a
// slow, independent noise-driven reference angle, weighted by sep/minSep so
// the reference fully takes over as separation approaches zero. Fully
// stateless, no sign ambiguity -- but re-running the frame-to-frame angle
// test against it still found jumps up to ~180 degrees, EVEN on frames
// where the clamp was active on both sides. Root cause: raw angular
// velocity isn't only high right at sep=0 -- two anchors can swing past
// each other at high angular speed while staying at a small-but-nonzero
// separation the whole time (an orbit, not a crossing), and at that
// separation the blend weight (sep/minSep) is still large enough (~0.4-0.5)
// to let most of that raw angular velocity through. A weight tied to
// distance-from-collision doesn't bound angular VELOCITY at all.
//
// ACTUAL FIX: rate-limit the OUTPUT angle directly, in angle-space, capped
// at MAX_ANGLE_STEP_DEG_PER_SEC of real elapsed time regardless of how fast
// the raw relative position is spinning. This is a genuine low-pass filter
// on a scalar (with correct shortest-arc wraparound), not a sign-selection
// heuristic -- it has no equivalent-to-raw reduction the way the hysteresis
// attempt did, because it bounds a RATE, not a binary choice. Time-based
// (not a fixed step per call) so the cap is consistent regardless of the
// display's actual refresh rate -- everything else in this function is
// already a pure function of `t`, this is the one piece that would
// otherwise be frame-count-dependent. Requires persisting the filtered
// angle AND the timestamp it was computed at across frames (drawScene
// threads both via scene.prevAngle/scene.prevAngleT, same memoization
// pattern as scene.field/wobbleNoise); on the very first frame (no prior
// state) there's nothing to rate-limit against yet, so it snaps directly
// to the raw angle once.
const MIN_ANCHOR_SEPARATION = 0.35
const MAX_ANGLE_STEP_DEG_PER_SEC = 240

// Pure and exported so this is a regression test, not unverified inline
// math baked into drawScene -- see GradientBackground.test.js. `wobbleAmt`
// (current wobbleAmount(), or 0), `prevAngle`/`prevT` (last call's returned
// `angle` and the `t` it was computed at, or null on the first call) are
// threaded in explicitly rather than read from module/React state, so the
// function stays a pure, independently-testable function of its arguments.
export function computeAnchorPositions(lights, t, wobbleNoise, { wobbleAmt = 0, prevAngle = null, prevT = null } = {}) {
  const [a, b] = lights
  // Both noise-space axes move with time (not one fixed, one time-varying)
  // -- a 1D slice through a 2D field only explores a straight line, which
  // can sit in a low-magnitude region for a long stretch by chance (measured:
  // a fixed-second-axis sample stayed within +-0.05 of center for a full
  // 600s/10min window on one real seed). Moving both axes traces a diagonal
  // through the field instead, covering far more terrain per unit time, so
  // the achievable range is reached reliably rather than seed-dependently.
  // "the motions ... need to feel like they're battling or dancing with each
  // other, truly random" (owner, live, 2026-08-04 follow-up) -- the sine term
  // above is a fixed Lissajous path no matter how it's phase-offset, so it's
  // the noise term that has to carry "truly random" and "cross into the
  // other's territory, then retreat." First attempt bumped reach 0.8x ->
  // 1.7x but measurement showed the real ceiling wasn't drift strength at
  // all -- it was the base-position generator putting anchors within the
  // MIN_ANCHOR_SEPARATION floor from birth ~60% of the time (fixed in
  // makeLightParams above). With that headroom actually available, 2.8x
  // was the sweet spot from re-measuring the sweep (1.7/2.2/2.8/3.5x):
  // clamp-pinned time stays low (~10%, an occasional close-pass/hand-off
  // moment, not a chronic lock) while crossing depth reaches materially
  // further (~0.40 past the midline) without the excursions reading as a
  // full takeover. Each anchor's noise also runs at its own per-instance
  // frequency (driftFreqMult, 0.7-1.3x) instead of a shared rate, so the
  // two anchors' excursions decorrelate in timing as well as phase -- no
  // fixed cycle length, which is what "truly random" rules out.
  const driftFor = light => {
    const freqMult = light.driftFreqMult ?? 1
    return {
      dx: wobbleNoise.fbm(t * 0.025 * freqMult + light.driftPhaseX, t * 0.017 * freqMult + 0.31, 2) / FBM_PEAK * light.ampX * 2.8,
      dy: wobbleNoise.fbm(t * 0.021 * freqMult + light.driftPhaseY, t * 0.014 * freqMult + 0.77, 2) / FBM_PEAK * light.ampY * 2.8,
    }
  }
  const driftA = driftFor(a), driftB = driftFor(b)
  // "the speed should go up and down from its baseline by 15% either way at
  // any given time" (owner, live) -- a single shared multiplier, sourced
  // from the same slow noise generator as the drift above (far-apart offset
  // so it doesn't visibly lock to any one drift term), oscillating the
  // anchors' angular rate. +-0.15 is the DESIGNED CEILING now that FBM_PEAK
  // normalizes the noise correctly (it was previously an unreachable ~0.925-
  // 1.070 due to the same bug -- see FBM_PEAK's comment); because this is
  // organic noise, not a sine wave, and the owner separately asked for the
  // motion to feel "more random" rather than perfectly periodic, any single
  // song won't hit exactly +-15% on a schedule -- verified against real
  // makeLightParams seeding across 300 simulated songs, the realized global
  // range reaches ~0.855-1.154 and the median per-song peak-to-peak span is
  // ~14.7% (was ~5.6% pre-fix) -- close to a 3x improvement, measured, not
  // the pure 1.887x FBM_PEAK's own normalization alone would predict,
  // because moving both noise axes with time (above) independently widens
  // per-song coverage too. Applied as t*freq*speedMod rather than
  // integrating a warped-time accumulator -- speedMod changes far slower
  // than one anchor orbit (its own period is on the order of minutes vs.
  // ~10-15s per orbit), so the phase error this approximation introduces
  // stays visually negligible; exact frequency modulation would need
  // per-frame state this stateless function doesn't otherwise keep.
  const speedMod = 1 + (wobbleNoise.fbm(t * 0.016 + 271.3, t * 0.012 + 613.7, 2) / FBM_PEAK) * 0.15
  let ax = a.baseX + Math.sin(t * a.freqX * speedMod + a.phaseX) * a.ampX + driftA.dx
  let ay = a.baseY + Math.sin(t * a.freqY * speedMod + a.phaseY) * a.ampY + driftA.dy
  let bx = b.baseX + Math.sin(t * b.freqX * speedMod + b.phaseX) * b.ampX + driftB.dx
  let by = b.baseY + Math.sin(t * b.freqY * speedMod + b.phaseY) * b.ampY + driftB.dy

  // Recenter the PAIR (2026-08-04, residual from the collision-fix review):
  // even with the two anchors always kept apart from EACH OTHER, their
  // shared midpoint can still wander toward a screen corner -- and since
  // the split is an unweighted perpendicular bisector, a midpoint near a
  // corner can put almost the entire visible frame on one side of it,
  // dropping the minority pool under 5% of screen (measured in ~2.3% of
  // simulated songs). Fixed as a smooth compression of the midpoint toward
  // canvas center, not a hard clamp -- tanh saturates gracefully (behaves
  // as identity for small offsets, only compresses large ones), no
  // discontinuity. Both anchors are translated by the same delta (their
  // separation/direction to each other is exactly preserved), so this
  // can't interact with the angle-blended clamp below at all -- it only
  // ever moves the pair as a whole, before the clamp even runs.
  const rawMidX = (ax + bx) / 2, rawMidY = (ay + by) / 2
  const squashToward = (v, center, limit) => center + limit * Math.tanh((v - center) / limit)
  const midX = squashToward(rawMidX, 0.5, 0.30)
  const midY = squashToward(rawMidY, 0.5, 0.30)
  const shiftX = midX - rawMidX, shiftY = midY - rawMidY
  ax += shiftX; bx += shiftX; ay += shiftY; by += shiftY

  // Minimum-separation clamp, angle-blended (2026-08-04, see the long
  // comment above computeAnchorPositions for why this replaced a hysteresis
  // attempt that turned out to be either buggy or a no-op). Dynamic floor,
  // not just the base constant: at DEPTH=100 the boundary-wobble amount
  // (already correctly normalized above) could otherwise approach or
  // exceed a FIXED separation floor, reopening the exact "noise dominates
  // the base field" failure this clamp exists to prevent -- a second
  // adversarial review caught this margin wasn't structurally guaranteed.
  // Keeping the floor at least 2x the current wobble amount (in addition
  // to the 0.35 base) means a future dial/constant change can't silently
  // reintroduce the original bug.
  const dx = bx - ax, dy = by - ay
  const sep = Math.hypot(dx, dy)
  const minSeparation = Math.max(MIN_ANCHOR_SEPARATION, wobbleAmt * 2)

  // Rate-limited angle, computed every call (not just while clamped) so the
  // filter state stays continuous across the clamped/unclamped boundary
  // too. Harmless when unclamped: at comfortably large separation the raw
  // angular velocity is already naturally small (angular rate ~ tangential
  // speed / separation), so the cap rarely binds there -- instability only
  // concentrates where separation is small, which is exactly the regime
  // this feeds into the clamp below.
  const rawAngle = sep > 1e-6 ? Math.atan2(dy, dx) : (prevAngle ?? 0)
  let angle
  if (prevAngle === null || prevT === null) {
    angle = rawAngle
  } else {
    const dt = Math.max(0, t - prevT)
    // Cap the elapsed-time window itself -- a long pause (backgrounded tab,
    // etc.) shouldn't force a correspondingly huge allowed step; beyond
    // ~0.5s there's no motion continuity worth preserving anyway, so just
    // let it catch up fully rather than crawl back over many frames.
    const maxStep = MAX_ANGLE_STEP_DEG_PER_SEC * Math.min(dt, 0.5) * (Math.PI / 180)
    let diff = rawAngle - prevAngle
    diff -= Math.round(diff / (2 * Math.PI)) * 2 * Math.PI // shortest arc, (-PI, PI]
    const step = Math.max(-maxStep, Math.min(maxStep, diff))
    angle = prevAngle + step
  }

  if (sep < minSeparation) {
    const ux = Math.cos(angle), uy = Math.sin(angle)
    const mx = (ax + bx) / 2, my = (ay + by) / 2
    const half = minSeparation / 2
    ax = mx - ux * half; ay = my - uy * half
    bx = mx + ux * half; by = my + uy * half
  }

  return { ax, ay, bx, by, speedMod, angle }
}

// "the 10% either way gradients need to be more apparent" (owner, live) --
// each pool's own internal lightness variation, from the original design
// spec, shipped flat first (so the SEAM would read as the only gradient)
// and needed to come back once that landed. A soft, low-frequency field --
// not per-pixel texture -- so it reads as tonal depth within a pool, not
// noise/grain. Amount now comes from gradientTuning.js's shadeAmount()
// (the DEPTH dial, shared with wobbleAmount()) instead of a fixed constant
// -- see that file for why DEPTH drives both.
const SHADE_SPATIAL_FREQ = 1.3

function isNearBlack(hex) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b < 32
}

export function normalizeScene({ colors = [], weights = [], artUrl = '', shuffleKey = 0 } = {}) {
  const valid = colors.map((color, index) => ({ color, weight: weights[index] }))
    .filter(({ color }) => typeof color === 'string' && VALID_HEX.test(color))
  const allSentinel = valid.length > 0 && valid.length === colors.length &&
    valid.every(({ color }) => color.toLowerCase() === SENTINEL)
  const usable = valid.map(({ color, weight }) => ({ color: color.toLowerCase(), weight }))
    .filter(({ color }) => color !== SENTINEL && !isNearBlack(color))
  const selected = usable.length >= 2 ? usable.slice(0, 2)
    : usable.length === 1 ? [usable[0], usable[0]]
      : FALLBACK.map(color => ({ color, weight: undefined }))
  const normalized = selected.map(({ color }) => color)
  const rawWeights = selected.map(({ weight }) => weight)
  const validWeights = rawWeights.every(weight => Number.isFinite(weight) && weight >= 0)
  const totalWeight = validWeights ? rawWeights[0] + rawWeights[1] : 0
  const normalizedWeights = totalWeight > 0
    ? rawWeights.map(weight => weight / totalWeight)
    : [0.5, 0.5]
  const identity = `${shuffleKey}|${artUrl}|${normalized.join('|')}|${normalizedWeights.join('|')}`
  return {
    artUrl,
    colors: normalized,
    weights: normalizedWeights,
    identity,
    ready: usable.length > 0 && !allSentinel,
    shuffleKey,
    lights: makeLightParams({ shuffleKey, artUrl, colors: normalized }),
  }
}

export function createTransitionState(currentInput) {
  return {
    current: normalizeScene(currentInput),
    outgoing: null,
    incoming: null,
    pending: null,
    blendStart: null,
    snapshotRequest: null,
  }
}

function startTransition(state, scene, now) {
  const visible = state.incoming || state.current
  if (visible.identity === scene.identity) return state
  const interrupted = state.blendStart !== null && state.outgoing && state.incoming
  const snapshotRequest = interrupted ? {
    outgoing: state.outgoing,
    incoming: state.incoming,
    progress: Math.max(0, Math.min(1, (now - state.blendStart) / blendDurationMs())),
  } : null
  return {
    current: state.current,
    outgoing: interrupted ? { snapshot: true } : visible,
    incoming: scene,
    pending: null,
    blendStart: now,
    snapshotRequest,
  }
}

export function updateTransitionState(state, { current, next, entranceActive, now }) {
  const currentScene = normalizeScene(current)
  const nextScene = normalizeScene(next)

  // Promotion of an already-preloaded scene updates metadata only; fade clock
  // and seeded incoming motion remain untouched.
  if (state.incoming?.identity === currentScene.identity) {
    state = { ...state, current: state.incoming }
  } else if (state.current.identity !== currentScene.identity && currentScene.ready) {
    // Owner, live, second pass on the entrance: "it's basically what each
    // song-to-song animation should be, but the first one just takes over
    // a black screen." Used to special-case this (silently swap `current`
    // with no blend while entranceActive and not-yet-ready) and fake the
    // reveal separately with CSS (brightness filter + clip-path circle) --
    // rejected live as looking like "blowing up like a circle in a random
    // place," not like color arriving and taking over. Removing that
    // special case means the very first REAL palette (once it's ready,
    // replacing GradientBackground's hand-seeded all-black initial `current`
    // -- see the component below) goes through the exact same
    // startTransition path as every other song change: a real two-canvas
    // crossfade, same organic per-pixel pool motion, from black to color.
    // The `currentScene.ready` guard still skips transitioning INTO a
    // not-yet-resolved (sentinel/loading) scene -- unchanged from before,
    // just no longer only enforced during entrance.
    state = startTransition(state, currentScene, now)
  }

  if (entranceActive) {
    return nextScene.ready ? { ...state, pending: nextScene } : state
  }
  // Flush a previously-ready pending scene before considering a now-empty
  // next palette; entrance release must not lose the last useful preload.
  if (state.pending) return startTransition({ ...state, pending: null }, state.pending, now)
  if (!nextScene.ready) return state
  return startTransition(state, nextScene, now)
}

function drawScene(ctx, smallCtx, scene, timestamp, width, height) {
  const t = timestamp / 1000
  const [a, b] = scene.lights
  const field = scene.field || (scene.field = prepareTwoPoolField(...scene.colors, {
    brightnessAdjustment: brightnessAdjustment(),
    seamWidth: seamWidth(),
    weightA: scene.weights[0],
    weightB: scene.weights[1],
  }))
  // Seeded once per scene (memoized alongside `field`/`imageData` below) so
  // motion/wobble/shade are stable frame-to-frame and vary song-to-song,
  // same "seeded per identity" property makeLightParams already has.
  // Two independent generators (distinct seeds) so the boundary's wobble
  // and each pool's internal shade don't visibly lock together.
  const wobble = scene.wobbleNoise || (scene.wobbleNoise = makeFlowNoise2D(hashString(`wobble|${scene.identity}`)))
  const shadeNoise = scene.shadeNoise || (scene.shadeNoise = makeFlowNoise2D(hashString(`shade|${scene.identity}`)))
  const image = scene.imageData || (scene.imageData = smallCtx.createImageData(TINY_SIZE, TINY_SIZE))
  const wobbleAmt = wobbleAmount()
  const shadeAmt = shadeAmount()

  // Anchor position: deterministic sine path + slow noise drift + speed
  // breathing + midpoint recentering + the rate-limited-angle minimum-
  // separation clamp, all in one pure, independently-tested function -- see
  // computeAnchorPositions above. `angle`/`t` are memoized onto the scene
  // (same pattern as scene.field/wobbleNoise) so next frame's rate limiter
  // has real elapsed time and a prior angle to filter against -- without
  // this persisting across frames, the whole point of the fix is lost.
  const { ax, ay, bx, by, angle } = computeAnchorPositions(
    [a, b], t, wobble, { wobbleAmt, prevAngle: scene.prevAngle, prevT: scene.prevAngleT },
  )
  scene.prevAngle = angle
  scene.prevAngleT = t

  for (let y = 0; y < TINY_SIZE; y += 1) {
    for (let x = 0; x < TINY_SIZE; x += 1) {
      const nx = x / (TINY_SIZE - 1)
      const ny = y / (TINY_SIZE - 1)
      const index = (y * TINY_SIZE + x) * 4
      const distA = Math.hypot(nx - ax, ny - ay)
      const distB = Math.hypot(nx - bx, ny - by)
      // Low-octave on purpose (2 octaves) -- a finer field breaks the
      // boundary into many small islands instead of one flowing line.
      // /FBM_PEAK -- see the constant's comment; without it wobbleAmt/
      // shadeAmt were only ever delivering ~53% of their stated amount.
      const w = wobble.fbm(nx * 2.4 + t * 0.05, ny * 2.4 - t * 0.04, 2) / FBM_PEAK * wobbleAmt
      const shade = shadeNoise.fbm(nx * SHADE_SPATIAL_FREQ + t * 0.03, ny * SHADE_SPATIAL_FREQ - t * 0.025, 2) / FBM_PEAK * shadeAmt
      field.sampleInto(distA - distB + w, shade, image.data, index)
    }
  }
  smallCtx.putImageData(image, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.imageSmoothingEnabled = true
  // Blur raised to width/15 (30px+) the same day as the radius widen above,
  // on the theory both were needed for an aurora-style wash -- but blur
  // (unlike a uniform radius change) genuinely averages neighboring hue
  // regions together at a FIXED pixel scale, and at that strength it was
  // the actual cause of "the two colors aren't two distinct beings" -- it
  // smeared the two hues into each other across most of the frame rather
  // than just softening each one's own edge. Pulled back to roughly
  // half -- still meaningfully softer than the pre-session width/70
  // sliver (enough that no small-scale artifact reads as a hard edge),
  // without homogenizing the two colors into one blended mush.
  ctx.filter = `blur(${Math.max(16, width / 40)}px)`
  ctx.drawImage(smallCtx.canvas, -width * 0.04, -height * 0.04, width * 1.08, height * 1.08)
  ctx.filter = 'none'
}

export function crossfadeOpacities(progress) {
  const clamped = Math.max(0, Math.min(1, progress))
  return { outgoing: 1, incoming: clamped }
}

export function compositeSnapshot(context, outgoing, incoming, progress, width, height) {
  const { outgoing: outgoingAlpha, incoming: incomingAlpha } = crossfadeOpacities(progress)
  context.clearRect(0, 0, width, height)
  context.globalAlpha = outgoingAlpha
  context.drawImage(outgoing, 0, 0)
  context.globalAlpha = incomingAlpha
  context.drawImage(incoming, 0, 0)
  context.globalAlpha = 1
}

export function resizeCanvasesPreservingSnapshot(
  canvases,
  snapshotCanvas,
  snapshotContext,
  dpr,
  makeCanvas = () => document.createElement('canvas'),
) {
  const saved = makeCanvas()
  saved.width = Math.max(1, snapshotCanvas.width)
  saved.height = Math.max(1, snapshotCanvas.height)
  const savedContext = saved.getContext('2d')
  if (savedContext) savedContext.drawImage(snapshotCanvas, 0, 0)

  canvases.forEach(canvas => {
    const longest = Math.max(canvas.clientWidth, canvas.clientHeight) * dpr
    const scale = longest > MAX_BACKING_DIMENSION ? MAX_BACKING_DIMENSION / longest : 1
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr * scale))
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr * scale))
  })
  snapshotCanvas.width = canvases[0].width
  snapshotCanvas.height = canvases[0].height
  if (savedContext) {
    snapshotContext.drawImage(saved, 0, 0, snapshotCanvas.width, snapshotCanvas.height)
  }
}

export default function GradientBackground({
  colors = [], nextColors = [], active = true, shuffleKey = 0,
  entranceActive = false, artUrl = '', nextArtUrl = '',
  weights = [], nextWeights = [],
}) {
  const canvasesRef = useRef([])
  // Hand-built black scene, not createTransitionState({colors, ...}) off the
  // real (probably-not-ready-yet) props -- normalizeScene's near-black
  // filter would strip literal black and substitute the FALLBACK pink/
  // purple pair, which is the wrong seed for an entrance meant to start
  // from black (see updateTransitionState's entrance comment above for why
  // this is the seed the real palette then crossfades FROM, same as any
  // other song-to-song transition).
  const transitionRef = useRef({
    current: {
      artUrl: '', colors: ['#000000', '#000000'], weights: [0.5, 0.5],
      identity: '__entrance-black__', ready: true, shuffleKey: -1,
      lights: makeLightParams({ shuffleKey: -1, artUrl: '', colors: ['#000000', '#000000'] }),
    },
    outgoing: null, incoming: null, pending: null, blendStart: null, snapshotRequest: null,
  })
  const rafRef = useRef(null)

  useEffect(() => {
    transitionRef.current = updateTransitionState(transitionRef.current, {
      current: { colors, weights, artUrl, shuffleKey },
      next: { colors: nextColors, weights: nextWeights, artUrl: nextArtUrl, shuffleKey },
      entranceActive,
      now: performance.now(),
    })
  }, [artUrl, colors, entranceActive, nextArtUrl, nextColors, nextWeights, shuffleKey, weights])

  useEffect(() => {
    if (!active) return undefined
    const canvases = canvasesRef.current
    if (canvases.length !== 2 || canvases.some(canvas => !canvas)) return undefined
    const contexts = canvases.map(canvas => canvas.getContext('2d'))
    if (contexts.some(context => !context)) return undefined
    const small = contexts.map(() => {
      const canvas = document.createElement('canvas')
      canvas.width = TINY_SIZE
      canvas.height = TINY_SIZE
      return canvas.getContext('2d')
    })
    const snapshotCanvas = document.createElement('canvas')
    const snapshotContext = snapshotCanvas.getContext('2d')
    if (!snapshotContext) return undefined

    const resize = () => {
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
      resizeCanvasesPreservingSnapshot(canvases, snapshotCanvas, snapshotContext, dpr)
    }
    resize()
    window.addEventListener('resize', resize)

    // Frozen-outgoing-frame cache (2026-08-04, simplify pass): `back` is a
    // stable object reference for a whole blend (see startTransition), and
    // with `state.blendStart` now fixed (below) drawScene's output for it
    // is identical on every one of the ~450 frames in a blend. Skip the
    // redraw once it's already on canvas 0 -- the canvas keeps whatever was
    // last painted into it, so simply not calling drawScene again leaves
    // the frozen frame in place for free.
    let frozenBack = null

    const draw = timestamp => {
      let state = transitionRef.current
      if (state.snapshotRequest) {
        const request = state.snapshotRequest
        // Visible canvases still contain the last displayed A/B frame. Merge
        // those exact pixels (rather than re-rendering either scene) so an
        // interruption starts from what the audience actually saw. This also
        // supports repeated interruptions when canvas 0 already holds an
        // earlier snapshot.
        compositeSnapshot(
          snapshotContext,
          canvases[0],
          canvases[1],
          request.progress,
          snapshotCanvas.width,
          snapshotCanvas.height,
        )
        state = { ...state, snapshotRequest: null }
        transitionRef.current = state
      }
      if (state.blendStart !== null && timestamp - state.blendStart >= blendDurationMs()) {
        state = {
          current: state.incoming,
          outgoing: null,
          incoming: null,
          pending: state.pending,
          blendStart: null,
          snapshotRequest: null,
        }
        transitionRef.current = state
      }
      const progress = state.blendStart === null ? 1 : Math.min(1, (timestamp - state.blendStart) / blendDurationMs())
      const front = state.incoming || state.current
      const back = state.outgoing
      if (back?.snapshot) {
        contexts[0].clearRect(0, 0, canvases[0].width, canvases[0].height)
        contexts[0].drawImage(snapshotCanvas, 0, 0, canvases[0].width, canvases[0].height)
      } else if (back) {
        // Owner, live: "the transitions from song to song are really not
        // smooth." Both layers were drawScene'd with the live, growing
        // `timestamp` for the full ~7.5s blend -- two independently-seeded
        // fields each doing their own full-strength wander/crossing (more so
        // now that the drift fix above lets them actually roam), alpha-
        // composited on top of each other, reads as a busy double-exposure
        // rather than a clean dissolve. Freezing the OUTGOING scene's time at
        // the moment its fade started turns it into a static frame that
        // just fades out in place -- only the incoming scene is still alive
        // during the blend, same as a standard crossfade over a still frame.
        // No pixel snapshot needed for this (unlike the interruption path
        // above): drawScene's output is a pure function of `t` given the
        // scene's already-memoized field/noise, so a fixed t reproduces the
        // exact same frame every call for free -- so it only needs painting
        // once per (scene, canvas size), not every rAF tick; frozenBack
        // caches that identity and the redraw is skipped once it matches.
        if (frozenBack?.scene !== back || frozenBack.width !== canvases[0].width || frozenBack.height !== canvases[0].height) {
          drawScene(contexts[0], small[0], back, state.blendStart, canvases[0].width, canvases[0].height)
          frozenBack = { scene: back, width: canvases[0].width, height: canvases[0].height }
        }
      } else {
        frozenBack = null
      }
      drawScene(contexts[1], small[1], front, timestamp, canvases[1].width, canvases[1].height)
      const opacity = crossfadeOpacities(progress)
      canvases[0].style.opacity = back ? String(opacity.outgoing) : '0'
      canvases[1].style.opacity = back ? String(opacity.incoming) : '1'
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)

    return () => {
      window.removeEventListener('resize', resize)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [active])

  // Entrance (2026-08-04, third pass): two prior attempts here were CSS
  // tricks layered on top of an already-fully-formed scene -- a brightness()
  // ramp (2026-08-03), then a clip-path circle grown from a random point
  // (same day, second pass) -- and both got rejected live for the same
  // underlying reason: they're revealing/lighting a static image that's
  // already fully composed underneath, which reads as a wipe or a
  // "circle blowing up in a random place," not color arriving. Owner, live:
  // "it's basically what each song-to-song animation should be, but the
  // first one just takes over a black screen." So: no CSS animation here at
  // all anymore -- the entrance IS a real transition now, through the exact
  // same updateTransitionState/startTransition path every song change uses,
  // crossfading from the hand-seeded all-black `current` scene above to the
  // first real palette once it's ready (see that function's comment). Same
  // organic per-pixel two-pool motion animates it as any other transition,
  // because it's the same code, not a parallel mechanism to keep in sync.
  const canvasStyle = { position: 'absolute', inset: 0, width: '100%', height: '100%' }
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 0, overflow: 'hidden', background: '#000' }}>
      <canvas ref={node => { canvasesRef.current[0] = node }} style={canvasStyle} />
      <canvas ref={node => { canvasesRef.current[1] = node }} style={canvasStyle} />
    </div>
  )
}
