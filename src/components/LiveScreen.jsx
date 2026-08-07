import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, memo } from 'react'
import { motion, useAnimation } from 'framer-motion'
// 2026-08-04, owner request: after looking at the pre-mesh circle-blobs
// engine live (AlbumGradient.jsx, temp-revert earlier this session), the
// 'screen' composite blob centers read as washed-out/white -- switched to
// AlbumGradientMesh.jsx instead, revived from an early mesh commit and
// adapted for the app's current 2-color-max picker-driven model (see that
// file's header for the full history and what was fixed vs. the original).
import GradientBackground from './AlbumGradientMesh'
import { usePalette } from '../hooks/usePalette'
import { displayName } from '../lib/track'

// One palette-driven two-pool Canvas renderer owns the live background.

const sleep = ms => new Promise(r => setTimeout(r, ms))

const ARM_ON  = { rotate: 8,  y: 0 }   // needle resting on record
const ARM_OFF = { rotate: -30, y: -8 } // lifted and rotated back (y -5 -> -8, 2026-08-04: Ben wanted a hair more lift)

// Exit sequence timing (2026-08-04, fable review) — named and exported so
// Jukebox.jsx's trivia-os handoff (the 'b'-hold handler) can await the same
// duration instead of a second hardcoded 2250, which previously had nothing
// keeping it in sync with a retune of the ending effect below.
export const EXIT_LEAD_IN_MS   = 400   // delay before the exit sequence starts
export const EXIT_CLOSE_DELAY_MS = 1850 // from lead-in to onClose
export const EXIT_TOTAL_MS = EXIT_LEAD_IN_MS + EXIT_CLOSE_DELAY_MS

// Boogaloo (display) + DM Sans (body) — same pairing Trivia OS ships across all
// 21 themes (see trivia-os/themes/index.js), loaded via Google Fonts link in
// index.html. Matches the jukebox's live screen to the rest of the trivia-night
// visual identity instead of falling back to system-ui.
const FONT_DISPLAY = "'Boogaloo', system-ui, sans-serif"
const FONT_BODY    = "'DM Sans', system-ui, sans-serif"

// Soft dark halo hugging the glyphs — not a filled panel, not black text.
// White title/artist text was disappearing against pale/light-hue stretches
// of the gradient (yellow-green, cream). Three stacked no-offset blur radii
// read as a scrim just outside the letterforms rather than a drop shadow or
// a background box, and hold up against any hue the gradient lands on.
const TEXT_SCRIM = '0 0 4px rgba(0,0,0,0.55), 0 0 10px rgba(0,0,0,0.45), 0 0 20px rgba(0,0,0,0.35)'

const LOADING_SENTINEL = '#080808'
const VALID_HEX = /^#[0-9a-f]{6}$/i

// colors[] arrives in the server's prettiness order. Use the first two
// exactly, preserving their relative population weights. Near-black and
// malformed colors are replaced before rendering.
const safeGradientColor = hex => {
  if (typeof hex !== 'string' || !VALID_HEX.test(hex)) return '#ff2fb0'
  const normalized = hex.toLowerCase()
  const r = parseInt(normalized.slice(1, 3), 16)
  const g = parseInt(normalized.slice(3, 5), 16)
  const b = parseInt(normalized.slice(5, 7), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b < 60 ? '#ff2fb0' : normalized
}

const normalizeGradientWeights = weights => {
  const safe = [0, 1].map(i => Number.isFinite(weights?.[i]) && weights[i] >= 0 ? weights[i] : 0)
  const total = safe[0] + safe[1]
  return Number.isFinite(total) && total > 0 ? safe.map(weight => weight / total) : [0.5, 0.5]
}

export function pickGradientColors(colors, weights) {
  if (!colors.length) return { colors: [], weights: [] }
  const allLoadingSentinel = colors.every(
    color => typeof color === 'string' && color.toLowerCase() === LOADING_SENTINEL,
  )

  if (colors.length === 1) {
    const color = allLoadingSentinel ? LOADING_SENTINEL : safeGradientColor(colors[0])
    return { colors: [color, color], weights: [0.5, 0.5] }
  }

  // #080808 is loading control state, not a render color. Preserve an
  // all-sentinel palette so the current renderer can ignore upcoming loading
  // data. Task 4's renderer will ignore it when upcoming and use an internal
  // purple/pink fallback when it is the current palette.
  if (allLoadingSentinel) {
    return { colors: [LOADING_SENTINEL, LOADING_SENTINEL], weights: normalizeGradientWeights(weights) }
  }

  return { colors: colors.slice(0, 2).map(safeGradientColor), weights: normalizeGradientWeights(weights) }
}

// Manual gradient-color override (2026-08-03, thinktank round 3; extended
// 2026-08-04 to cover color 1 too): if the owner has picked a color for this
// song in SongDetailModal, it REPLACES pickGradientColors' auto-picked
// color at that slot. overrideHex1 replaces colors[0] (field name
// `gradientOverride1`), overrideHex2 replaces colors[1] (field name
// `gradientOverride`, kept as-is for backward compat with songs saved
// before color 1 was overridable). Either, both, or neither may be set.
export function applyGradientOverride(autoPicked, rawColors, overrideHex1, overrideHex2) {
  if ((!overrideHex1 && !overrideHex2) || !rawColors.length) return autoPicked
  if (autoPicked.colors.length && autoPicked.colors.every(color => color === LOADING_SENTINEL)) return autoPicked
  const color1 = overrideHex1 ? safeGradientColor(overrideHex1) : autoPicked.colors[0]
  const color2 = overrideHex2 ? safeGradientColor(overrideHex2) : autoPicked.colors[1]
  return { colors: [color1, color2], weights: [0.5, 0.5] }
}

// Waits for the page's webfonts (Boogaloo/DM Sans, loaded via a Google Fonts
// <link> in index.html with font-display: swap) to finish loading, so the
// entrance's title/artist reveal doesn't show the fallback system font for
// a beat before swapping to the real one (2026-08-04, Ben: "the font went
// from wrong to right" on the first song of a session — only ever visible
// once, since every subsequent song's text renders after the fonts are
// already cached). Same 800ms safety-timeout pattern as preloadImage below,
// so a slow/failed font load can't hang the entrance.
function preloadFonts() {
  if (!document.fonts?.ready) return Promise.resolve()
  return Promise.race([
    document.fonts.ready,
    new Promise(resolve => setTimeout(resolve, 800)),
  ])
}

function preloadImage(url) {
  return new Promise(resolve => {
    const img = new Image()
    // decode() pushes the JPEG decode off the paint path — without it the
    // decode lands on the first painted frame, i.e. mid-spring.
    img.onload = () => {
      if (img.decode) img.decode().catch(() => {}).then(resolve)
      else resolve()
    }
    img.onerror = resolve
    img.src = url
    setTimeout(resolve, 800)
  })
}

// ── Tonearm ───────────────────────────────────────────────────────────────────
function Tonearm({ controls }) {
  return (
    <motion.div
      className="absolute pointer-events-none select-none"
      style={{ top: -9, right: -28, width: 106, height: 177,
               transformOrigin: '90px 21px', zIndex: 20, willChange: 'transform' }}
      initial={ARM_OFF}
      animate={controls}
    >
      <svg width="106" height="177" viewBox="0 0 106 177" fill="none">
        <circle cx="90" cy="21" r="14" fill="#e8e4dc" stroke="#ccc9c0" strokeWidth="1.5"/>
        <circle cx="90" cy="21" r="6"  fill="#b0aca4"/>
        <rect x="83" y="18" width="8" height="124" rx="4" fill="#f0ece4"/>
        <rect x="61" y="133" width="28" height="7" rx="3" fill="#e8e4dc"/>
        <rect x="47" y="133" width="23" height="16" rx="3"
              fill="#ece8e0" stroke="#d4d0c8" strokeWidth="1"/>
        <line x1="59" y1="150" x2="55" y2="166"
              stroke="#a0a0a0" strokeWidth="1.5" strokeLinecap="round"/>
        <circle cx="55" cy="167" r="2" fill="#c8c4bc"/>
      </svg>
    </motion.div>
  )
}

// ── LiveScreen ─────────────────────────────────────────────────────────────────
// Position updates every 300ms during playback via the Jukebox-owned player hook,
// forcing a re-render of everything under Jukebox. None of this component's props
// change on that cadence, so memo() keeps it from redoing its render work — title-fit
// measurement, palette lookups, the whole record/tonearm JSX tree — 3.3x/second for nothing.
function LiveScreen({ currentTrack, isPaused, ending, onClose, shuffleKey, onUpcomingTrack, entranceSong, onEntranceStart, onRegisterTransition, onTransitionAudioStart }) {
  // entranceSong (2026-08-04): the chosen first song, handed down BEFORE
  // Spotify is asked to play it (see Jukebox.jsx's startShuffle) — falls
  // back to currentTrack for the tuning screen and any other caller that
  // doesn't pass it, so this stays backward compatible. Once the real
  // currentTrack does arrive, the uri-equality guards in runTransition below
  // treat it as the same song (no-op), so `shown` just keeps the richer
  // library object — which, as a side effect, is also what actually lets a
  // song's manual gradient-color overrides apply to the FIRST song, not just
  // the next one (the SDK object never carried those fields to begin with).
  const [shown, setShown]                 = useState(entranceSong ?? currentTrack)
  const [prev,  setPrev]                  = useState(null)
  const [transitioning, setTransitioning] = useState(false)
  const [artOpacity, setArtOpacity]       = useState(1)
  const [artUrl, setArtUrl]               = useState((entranceSong ?? currentTrack)?.album?.images?.[0]?.url)
  const [textVisible, setTextVisible]     = useState(false)
  const [spinPaused, setSpinPaused]       = useState(false)
  const [upcomingArtUrl, setUpcomingArtUrl] = useState(null)
  // Upcoming song's manual gradient override (see palette useMemo below) —
  // onUpcomingTrack only ever handed the art URL through before; the full
  // song object it receives already carries gradientOverride, this just
  // also captures that instead of discarding the rest of the object.
  const [upcomingGradientOverride, setUpcomingGradientOverride]   = useState(null)
  const [upcomingGradientOverride1, setUpcomingGradientOverride1] = useState(null)
  const [textInstant, setTextInstant]     = useState(false)
  const [closing, setClosing]             = useState(false)
  const [entranceActive, setEntranceActive] = useState(true)
  // Ref mirror of entranceActive (2026-08-04 — "flew down, went back up,
  // another one came down" bug) for the reconciliation-backstop effect
  // further below, which needs to read it inside a setTimeout without
  // re-subscribing on every entranceActive change.
  const entranceActiveGuardRef = useRef(true)
  useEffect(() => { entranceActiveGuardRef.current = entranceActive }, [entranceActive])

  const titleRef                          = useRef(null)
  const titleBoxRef                       = useRef(null)
  const titleBasePxRef                    = useRef(null)
  const [titleScale, setTitleScale]       = useState(1)

  // Shrink long titles to fit within two lines. Title is opacity-0 during the
  // entire entrance, so post-paint measurement (useEffect) is invisible to the user
  // and avoids blocking the record-drop spring with synchronous layout reflows.
  useEffect(() => {
    const el = titleRef.current
    if (!el) return

    function measure() {
      // Reset any previous override so Tailwind classes determine the base size.
      el.style.fontSize = ''

      const cs     = getComputedStyle(el)
      const basePx = parseFloat(cs.fontSize)
      // lineHeight can be 'normal' in some browsers; fall back to leading-tight ratio.
      const lhPx   = parseFloat(cs.lineHeight) || basePx * 1.25
      const maxH   = lhPx * 2 + 4  // two lines + 4px sub-pixel buffer

      // Reserve the full two-line height regardless of how many lines this
      // title actually uses (2026-08-07, Ben: lock the artist name to one
      // fixed spot below, let short titles center in the middle of the
      // title's own slot rather than sitting high with an empty second
      // line). The wrapper below is flex+justify-center, so a one-line
      // title centers vertically in this box and a two-line title just
      // fills it edge to edge like before — either way the artist paragraph
      // that follows sits at the same y every time, since the box height
      // no longer depends on the title's own content height.
      if (titleBoxRef.current) titleBoxRef.current.style.height = `${maxH}px`

      titleBasePxRef.current = basePx

      if (el.scrollHeight <= maxH) {
        setTitleScale(1)
        return
      }

      let scale = 1 - 0.08
      while (scale >= 0.55) {
        el.style.fontSize = `${basePx * scale}px`
        if (el.scrollHeight <= maxH) break
        scale -= 0.08
      }
      setTitleScale(Math.max(0.55, scale))
    }

    measure()

    // Title now renders in Boogaloo (a webfont, added for the Trivia OS font
    // match) instead of always-available system-ui. On first paint the font
    // may still be downloading, so the measurement above can run against
    // fallback metrics — Boogaloo's glyph widths/line-height differ enough
    // that the two-line shrink computed pre-load can be wrong once the real
    // font swaps in, and this effect (keyed on shown?.name) won't naturally
    // re-run to correct it. Re-measure once the real font is actually active.
    // Same gotcha Trivia OS's own autoFitText guards against for this reason.
    let cancelled = false
    document.fonts?.ready?.then(() => { if (!cancelled) measure() })
    return () => { cancelled = true }
  }, [shown?.name])

  const { colors: paletteColorsFull, weights: paletteWeightsFull } = usePalette(artUrl)
  const { colors: upcomingPaletteColorsFull, weights: upcomingPaletteWeightsFull } = usePalette(upcomingArtUrl)
  // Cap what the gradient actually draws from — see pickGradientColors above
  // for the weight-based selection logic (2026-07-30, replaced the old
  // 2-normally/3-when-needed hue-distance cap once a root-cause review
  // traced it as the actual bug on busy multi-hue covers).
  //
  // useMemo, not a plain .slice()/pick every render: GradientBackground's
  // blend-trigger effects key off [colors]/[nextColors] BY REFERENCE
  // (usePalette's own return value is stable across re-renders unless a
  // real fetch resolves, which is what those effects rely on to fire once
  // per actual color change, not once per render). A bare .slice() here
  // hands GradientBg a NEW array every single LiveScreen re-render — and
  // LiveScreen re-renders often (position ticks, spin/pause state, etc.) —
  // so the mesh's crossfade kept restarting from t=0 continuously and never
  // actually progressed until the render churn settled down well after the
  // real track change, reading as "new song's colors don't show up until
  // it's already playing" (live-reported 2026-07-30) instead of blending in
  // during the fade-out like the onFadeStart/onUpcomingTrack plumbing
  // already intends. useMemo restores the same stable-unless-really-changed
  // reference usePalette itself provides.
  const palette = useMemo(() => {
    const result = applyGradientOverride(pickGradientColors(paletteColorsFull, paletteWeightsFull), paletteColorsFull, shown?.gradientOverride1, shown?.gradientOverride)
    // TEMP DIAGNOSTIC (2026-08-04) — see matching log in runTransition.
    // Remove once the color-change report is nailed down or ruled out.
    console.log('[jukebox:palette]', { shownName: shown?.name, shownUri: shown?.uri, paletteColorsFull, resultColors: result.colors })
    return result
  }, [paletteColorsFull, paletteWeightsFull, shown?.gradientOverride1, shown?.gradientOverride])
  const upcomingPalette = useMemo(
    () => applyGradientOverride(pickGradientColors(upcomingPaletteColorsFull, upcomingPaletteWeightsFull), upcomingPaletteColorsFull, upcomingGradientOverride1, upcomingGradientOverride),
    [upcomingPaletteColorsFull, upcomingPaletteWeightsFull, upcomingGradientOverride1, upcomingGradientOverride]
  )

  const tonearmCtrl = useAnimation()
  const flyCtrl     = useAnimation()
  const busyRef      = useRef(false)
  const mountedRef   = useRef(false)
  const pendingRef   = useRef(null)
  const pauseSeqRef  = useRef([])
  // Always-current isPaused so async functions don't read a stale closure value
  const isPausedRef = useRef(isPaused)
  const trackChangeDebounceRef = useRef(null)
  useEffect(() => { isPausedRef.current = isPaused }, [isPaused])
  // Always-current `shown`, read by the hoisted runTransition below instead
  // of a `prevTrack = shown` default param (2026-08-04, Opus review) — a
  // default param would re-capture a fresh `shown` closure every render,
  // which fights runTransition being a single stable function now instead
  // of being redefined inside an effect on every currentTrack change.
  const shownRef = useRef(shown)
  useEffect(() => { shownRef.current = shown }, [shown])
  // True for a short window right after Step 3 fires the real Spotify play
  // call for the incoming song (2026-08-04, Opus review) — guards the arm/
  // spin re-sync just after Step 3 from trusting isPausedRef, which can
  // still be reporting the PREVIOUS song's paused/ended state for a couple
  // hundred ms after the new song's play request goes out (the SDK's own
  // player_state_changed confirmation lags the request). Without this, the
  // record could stop spinning and the arm lift right as the new song
  // starts, essentially a coin flip every transition. The entrance never hit
  // this because its equivalent gap is ~1200ms, comfortably past the SDK's
  // usual 200-500ms confirm window.
  const audioJustFiredRef = useRef(false)
  // Timer id for the clear-timeout below, shared between the entrance and
  // transition call sites (2026-08-04, fable review) — previously each site
  // fired its own uncancelled setTimeout, so if the entrance set the flag and
  // a queued skip handed off into runTransition before the entrance's own
  // 1800ms timer fired, that STALE timer would still clear the flag out from
  // under the transition's fresh window, silently reopening the exact wobble
  // bug just fixed. Always clear the previous timer before starting a new one.
  const audioJustFiredClearTimerRef = useRef(null)

  // Register palette-prefetch handler with Jukebox so advanceToNext can notify us.
  // Token-guarded (2026-08-04) — see registerUpcomingTrackHandler in
  // Jukebox.jsx: on unmount we pass back the same token we registered with,
  // so a stale cleanup can't null out a newer screen's handler.
  useEffect(() => {
    const token = {}
    onUpcomingTrack?.({
      token,
      fn: (song) => {
        setUpcomingArtUrl(song?.album?.images?.[0]?.url ?? null)
        setUpcomingGradientOverride(song?.gradientOverride ?? null)
        setUpcomingGradientOverride1(song?.gradientOverride1 ?? null)
      },
    })
    return () => onUpcomingTrack?.({ token, fn: null })
  }, [onUpcomingTrack])

  // Register the transition trigger with Jukebox (2026-08-04) — same
  // imperative-handler pattern as onUpcomingTrack just above, not a prop,
  // so Jukebox can call straight into runTransition without any prop-
  // identity or effect-ordering hazard. This is what lets advanceToNext
  // start the visual transition (arm lift, fly-up, fly-down) using the
  // library song's own art/name BEFORE Spotify is ever asked to play it —
  // audio now fires from inside runTransition itself, at Step 3, instead of
  // on an independent timer (see Jukebox.jsx's advanceToNext for the other
  // half; mirrors the same fix already shipped for the entrance/first song).
  // Token-guarded (2026-08-04) — same race as onUpcomingTrack above.
  useEffect(() => {
    const token = {}
    onRegisterTransition?.({ token, fn: (song) => runTransition(song) })
    return () => onRegisterTransition?.({ token, fn: null })
  }, [onRegisterTransition])

  // Arm starts lifted; this runs once on mount before anything else renders
  useEffect(() => {
    tonearmCtrl.set(ARM_OFF)
  }, [])

  // Entrance: fires once, the first time `shown` becomes non-null.
  // By depending on [shown] we guarantee the fly wrapper is mounted before flyCtrl fires.
  useEffect(() => {
    if (!shown) return           // track not ready yet
    if (mountedRef.current) return  // entrance already ran
    mountedRef.current = true

    async function runEntrance() {
      // Set when a pending skip is handed off to runTransition below — from
      // that point runTransition owns busyRef exclusively (it clears it at
      // its own exit points ~2.8s later). Without this flag the unconditional
      // reset in `finally` fires after this function's own 600ms sleep and
      // clobbers busyRef mid-transition, letting a second skip race the
      // still-running fly/arm sequence.
      let handedOffToTransition = false
      try {
        setTextInstant(true)
        busyRef.current = true
        setTextVisible(false)

        // First-song art may not be in browser cache yet — decode it before the
        // record drops, or the JPEG decode lands mid-spring and drops frames.
        // runTransition already does this for every subsequent song; the
        // entrance was the gap (2bd5194 only covered the gradient, not the art).
        const entranceArt = shown?.album?.images?.[0]?.url
        await Promise.all([
          entranceArt ? preloadImage(entranceArt) : Promise.resolve(),
          preloadFonts(),
        ])

        // Record fly-in — audio no longer gated on this step (2026-08-04,
        // see below), so back to a plain await of the real tuned spring, no
        // race-against-a-cap needed here anymore. 120/22 is the same
        // 2026-07-30 live-tuned value used for every other fly/drop in this
        // file — do not bump this for speed, see runTransition's identical
        // spring for why that goes wrong.
        // Explicit .set() to the same start pose runTransition's Step 3 uses
        // (y:-500, scale:1) instead of relying on the JSX initial={{y:-400,
        // scale:0.85}} below (2026-08-06, Ben: fly-down felt jumpy/different
        // between shuffle-entrance and song-to-song). Same spring constants
        // but a shorter travel distance AND an extra scale-up baked into the
        // entrance meant the two never actually matched despite the shared
        // 120/22 tuning — this makes the starting state identical so the two
        // drops are the same motion, not just the same spring.
        flyCtrl.set({ opacity: 0, y: -500, scale: 1 })
        await flyCtrl.start({
          y: 0, opacity: 1, scale: 1,
          transition: { type: 'spring', stiffness: 120, damping: 22 },
        })

        await sleep(0)   // 1200 -> 900 -> 1000 -> 500 -> 250 -> 100 -> 0, 2026-08-04: Ben — arm needs to come down sooner still. Arm now drops the instant the record lands (spring above is already awaited, so this is just the last bit of slack removed, not a race).

        // Audio fires when the ARM actually lands, not off the record's
        // fly-in (2026-08-04, Ben live: "the first song is when the arm
        // lands, the ones after are on the flydown" — flows better this
        // way). This is deliberately DIFFERENT from runTransition, where
        // audio fires at the start of the fly-down instead — that's correct
        // there too, per the same live feedback. Await the arm spring's own
        // promise so this stays tied to the real animation, not a guessed
        // delay (same principle as the old record-landing gate this replaces).
        // damping 22 -> 26 (2026-08-04, fable review) — this was the one
        // ARM_ON spring in the entrance that never got matched to 180/26
        // when runTransition's identical spring was fixed; underdamped
        // (critical = 2*sqrt(180)≈26.8) so it overshot, which also delayed
        // this await (and therefore audio) resolving.
        await tonearmCtrl.start({
          ...(isPausedRef.current ? ARM_OFF : ARM_ON),
          transition: { type: 'spring', stiffness: 180, damping: 26 },
        })
        onEntranceStart?.()
        // Reuse the same stale-pause guard runTransition uses (2026-08-04,
        // Opus review flag): the "Bug 3" re-sync just below reads
        // isPausedRef.current only 50ms after audio just fired, well inside
        // the SDK's normal confirm lag — without this it could read stale
        // `true` and flip the arm OFF then back ON a moment later, the same
        // wobble already fixed on the transition path.
        clearTimeout(audioJustFiredClearTimerRef.current)
        audioJustFiredRef.current = true
        audioJustFiredClearTimerRef.current = setTimeout(() => { audioJustFiredRef.current = false }, 1800)

        await sleep(50)   // 200 -> 100 -> 50, 2026-08-04: same halving
        setTextInstant(false)
        setTextVisible(true)
        busyRef.current = false

        // Bug 3: re-sync arm now that busyRef is clear, in case isPaused changed mid-entrance.
        // Settle instantly if the tab is hidden — same rationale as the isPaused
        // effect above: this spring is rAF-driven and stalls while backgrounded,
        // then visibly snaps/catches up on refocus if left animating.
        const armPaused = audioJustFiredRef.current ? false : isPausedRef.current
        if (document.hidden) {
          tonearmCtrl.set(armPaused ? ARM_OFF : ARM_ON)
        } else {
          tonearmCtrl.start({
            ...(armPaused ? ARM_OFF : ARM_ON),
            transition: { type: 'spring', stiffness: 180, damping: 26 },
          })
        }
        // Sweep finding (2026-08-04): the isPaused effect below bails out
        // unconditionally while busyRef.current is true and never re-fires on
        // its own once busy clears (its deps are just [isPaused], which
        // didn't necessarily change again) — so a pause/resume that happened
        // mid-entrance could leave the record's CSS spin animation not
        // matching actual playback state indefinitely, even though the arm
        // above already correctly re-syncs. Reconcile it here too. Uses the
        // same guarded armPaused as the arm re-sync just above, not a raw
        // isPausedRef read, so the two can't disagree.
        setSpinPaused(armPaused)

        if (pendingRef.current && pendingRef.current.uri !== shown?.uri) {
          const pending = pendingRef.current
          pendingRef.current = null
          handedOffToTransition = true
          // Was runTransitionRef.current?.(pending) — that ref was only ever
          // assigned inside the OLD per-effect runTransition definition,
          // which didn't exist yet the very first time this could fire (the
          // effect that assigned it hadn't run yet), silently swallowing
          // this hand-off via the `?.`. runTransition is a stable, always-
          // defined function now (2026-08-04, Opus review) — call it
          // directly, no ref indirection needed.
          runTransition(pending)
        }

        // REVERTED (2026-07-28): the 350ms trim did reproduce the chop live —
        // Ben saw a stutter right as the record lands on the turntable, on
        // the entrance (first song of a session), a couple of times. Back to
        // 600ms per the watch-item's own planned rollback. Let the record +
        // tonearm springs settle before entranceActive flips — that flip
        // releases the gradient's deferred first blend, which doubles canvas
        // layer work at onset; the extra buffer here is what keeps that
        // doubled work from landing exactly as the record settles onto the
        // platter.
        await sleep(600)
      } finally {
        setEntranceActive(false)
        if (!handedOffToTransition) busyRef.current = false
      }
    }

    runEntrance()
  }, [shown])

  // Play/pause tonearm nudge when not mid-transition or entrance
  useEffect(() => {
    if (busyRef.current) return

    // Tab is backgrounded — settle instantly instead of animating. rAF-driven
    // springs stall while hidden and visibly catch up on refocus, and a
    // backgrounded tab can also get a transient isPaused blip as playback
    // re-syncs; either way we don't want it playing out once the user looks back.
    if (document.hidden) {
      pauseSeqRef.current.forEach(clearTimeout)
      pauseSeqRef.current = []
      setSpinPaused(isPaused)
      tonearmCtrl.set(isPaused ? ARM_OFF : ARM_ON)
      return
    }

    if (!isPaused) {
      // Resume: cancel any pending pause sequence, spin immediately, arm down (unchanged)
      pauseSeqRef.current.forEach(clearTimeout)
      pauseSeqRef.current = []
      setSpinPaused(false)
      tonearmCtrl.start({
        ...ARM_ON,
        transition: { type: 'spring', stiffness: 160, damping: 22 },
      })
      return
    }

    // Pause: 2600ms delay (just after 2500ms fade) → arm lifts with shuffle spring → spin stops
    // (comment previously said "3000ms (500ms after...)" — that edit never
    // actually landed in the setTimeout below, which has stayed 2600ms the
    // whole time; comment restored to match the real, live-tuned value.)
    const t1 = setTimeout(() => {
      tonearmCtrl.start({
        ...ARM_OFF,
        transition: { type: 'spring', stiffness: 35, damping: 18 },
      })
      const t2 = setTimeout(() => setSpinPaused(true), 1600)
      pauseSeqRef.current.push(t2)
    }, 2600)
    pauseSeqRef.current = [t1]

    return () => {
      pauseSeqRef.current.forEach(clearTimeout)
      pauseSeqRef.current = []
    }
  }, [isPaused])

  // If the tab is backgrounded while a pause-sequence timer is already queued
  // (paused just before switching away), cancel it and settle instantly rather
  // than let the arm-lift/spin-stop play out once the user comes back.
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden || busyRef.current) return
      pauseSeqRef.current.forEach(clearTimeout)
      pauseSeqRef.current = []
      setSpinPaused(isPausedRef.current)
      tonearmCtrl.set(isPausedRef.current ? ARM_OFF : ARM_ON)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // Populate shown/artUrl when currentTrack first arrives (SDK delivers it async after mount)
  useEffect(() => {
    if (currentTrack && !shown) {
      setShown(currentTrack)
      setArtUrl(currentTrack.album?.images?.[0]?.url)
    }
  }, [currentTrack, shown])

  // Ending animation: arm lifts + record flies up, then close
  useEffect(() => {
    if (!ending) return
    busyRef.current = true
    setTransitioning(true)
    let t2, t3, t4
    const t1 = setTimeout(() => {
      tonearmCtrl.start({ ...ARM_OFF, transition: { type: 'spring', stiffness: 80, damping: 20 } })
      t2 = setTimeout(() => {
        flyCtrl.start({ y: -500, transition: { type: 'spring', stiffness: 220, damping: 22 } })
        setArtOpacity(0)
      }, 750)
      t3 = setTimeout(() => setClosing(true), 1650)
      t4 = setTimeout(onClose, EXIT_CLOSE_DELAY_MS)
    }, EXIT_LEAD_IN_MS)
    // Fires either when `ending` flips back to false (Jukebox supersedes an
    // in-flight exit — e.g. song restarted within the close window) or on
    // unmount. Either way, reset the flags this effect set so a superseded
    // exit doesn't leave busyRef stuck true — which would silently swallow
    // every subsequent track change into pendingRef forever with the record
    // stranded mid fly-off.
    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4)
      busyRef.current = false
      setTransitioning(false)
    }
  }, [ending])

  // Hide text immediately when a new track arrives — instant (no fade) before runTransition fires.
  // useLayoutEffect, not useEffect: a plain useEffect runs AFTER the browser
  // paints, so on the render where currentTrack.uri first changes, the OLD
  // textVisible/transitioning values (from the just-finished previous reveal)
  // are what actually gets painted — the hide would only land on the NEXT
  // frame, which is how the new title was observed sitting at full opacity
  // over an empty turntable for a beat before cutting out. useLayoutEffect
  // fires synchronously before paint, so the hide is guaranteed to land in
  // the SAME frame as the uri change — no stale frame is ever painted.
  useLayoutEffect(() => {
    if (!currentTrack || !shown || currentTrack.uri === shown.uri) return
    setTextInstant(true)
    setTextVisible(false)
  }, [currentTrack?.uri])

  // Hoisted to component scope, always defined (2026-08-04, Opus review) —
  // used to be redefined fresh inside the currentTrack effect below on every
  // song change, which meant it also didn't exist at all until the first
  // real SDK-confirmed track landed (see the entrance's dead-ref hand-off
  // fix above). Now it's the single stable entry point both the entrance
  // hand-off AND Jukebox.jsx's advanceToNext (via onRegisterTransition, see
  // the registration effect above) can call directly with a library song
  // object, BEFORE Spotify has been asked to play anything — the visual
  // sequence (arm lift, fly-up) starts immediately off that; the real
  // Spotify play call now fires from INSIDE Step 3 below via
  // onTransitionAudioStart, not from an independent timer in Jukebox.jsx.
  const runTransition = useCallback(async (target, prevTrack) => {
    const from = prevTrack ?? shownRef.current
    try {
      if (busyRef.current) {
        pendingRef.current = target
        // Belt-and-suspenders with the useLayoutEffect above: that effect
        // already forces textVisible=false/textInstant=true unconditionally
        // on every uri change (including this queued-while-busy case), so
        // this is redundant today — but writing it here too means THIS
        // function no longer depends on the other effect's existence/order
        // to stay hidden while a skip sits in pendingRef. One less place a
        // future edit to either effect could silently reopen the gap.
        setTextVisible(false)
        setTextInstant(true)
        return
      }
      pendingRef.current = null
      busyRef.current = true
      setTextVisible(false)
      setTextInstant(true)
      setTransitioning(true)

      // Step 1 — arm lifts alone; record stays put until arm is fully up
      tonearmCtrl.start({ ...ARM_OFF, transition: { type: 'spring', stiffness: 220, damping: 30 } })
      // Kick off preload during the arm lift so it has more time
      const newArtUrl = target?.album?.images?.[0]?.url
      const preloadPromise = newArtUrl ? preloadImage(newArtUrl) : Promise.resolve()
      setPrev(from)
      await sleep(450)   // arm fully lifted (400 -> 200 -> 50 -> 450, 2026-08-04: 50ms had the record flying before the arm's spring (~350ms settle) even finished lifting — no stall, just clipping. Ben confirmed live: arm off, a real stall, then fly off. 450ms clears the spring's settle with a bit of pause on top.)

      // Step 2 — record flies up once arm is clear. stiffness 220 -> 120
      // (2026-08-04, Ben — "the two should be the same speed"): matches the
      // fly-down spring in Step 3 below, so the record leaves and arrives at
      // the same speed instead of leaving faster than it lands.
      flyCtrl.start({ y: -500, transition: { type: 'spring', stiffness: 120, damping: 22 } })
      setArtOpacity(0)
      await Promise.all([preloadPromise, sleep(900)])   // fly-up completes; preload runs concurrently (700 -> 1700 -> 900 -> 650 -> 900, 2026-08-04: the 650 cut made the A->B fly-down itself read as too fast/rushed — reverted back to the tuned 900. The earlier-audio ask stands as a real request, just needs a different lever than compressing this gap — don't re-cut this number for it.)
      // Old record is gone — swap track identity. This also carries the
      // library song's own gradientOverride/gradientOverride1 fields when
      // target is a library object rather than the SDK's currentTrack (the
      // Spotify object never had those fields — see the palette useMemo
      // above; manual color overrides silently didn't apply on any but the
      // NEXT-preview song before this) — 2026-08-04, Opus review.
      // TEMP DIAGNOSTIC (2026-08-04) — Ben reported a color-change bug on a
      // NORMAL song1->song2 transition, symptom unclear/not caught live.
      // Rather than guess at another fix on top of tonight's changes, log
      // what runTransition actually hands the palette pipeline so the next
      // occurrence gives real data instead of speculation. Safe to remove
      // once this is nailed down or ruled out.
      console.log('[jukebox:transition]', {
        name: target?.name,
        uri: target?.uri,
        gradientOverride: target?.gradientOverride,
        gradientOverride1: target?.gradientOverride1,
        newArtUrl,
      })
      setShown(target)

      // If another skip arrived during this window, bail before flying the new record in
      if (pendingRef.current && pendingRef.current.uri !== target.uri) {
        const pending = pendingRef.current
        pendingRef.current = null
        setTransitioning(false)
        busyRef.current = false
        runTransition(pending, target)
        return
      }

      // Step 3 — load art onto record off-screen, then fly it down with art already visible
      flyCtrl.set({ opacity: 0 })
      flyCtrl.set({ y: -500, scale: 1 })
      if (newArtUrl) setArtUrl(newArtUrl)
      setArtOpacity(1)

      // Fire the real Spotify play call right here (2026-08-04, Ben live:
      // "song b is playing almost immediately after song a is done" on the
      // old independent-timer design — see Jukebox.jsx's advanceToNext for
      // the other half of this). This sits downstream of setShown(target)
      // above, so by the time Spotify confirms and currentTrack updates,
      // the reconciliation effect further below sees shown.uri already
      // matching and no-ops instead of scheduling a second transition
      // (Opus review — confirmed this ordering specifically, firing any
      // earlier would race that guard).
      clearTimeout(audioJustFiredClearTimerRef.current)
      audioJustFiredRef.current = true
      // 700 -> 1800 (2026-08-04, Opus review of the "fishy" wobble report):
      // this flag is read at the isPausedRef check below, ~820-870ms after
      // it's set (Promise.race cap up to 550ms + sleep(120) + sleep(200)) —
      // longer than the 700ms window, so the flag was always already false
      // by the time it mattered and never actually guarded anything. When
      // the SDK was slow to confirm playback, isPausedRef read stale
      // `true`, so the re-sync below started ARM_OFF, then the real
      // isPaused effect fired ARM_ON moments later and interrupted it
      // mid-swing with leftover velocity — the overshoot/wobble Ben saw.
      // 1800ms comfortably covers the read below plus normal SDK confirm lag.
      // Timer id stored and cleared on each (re-)set (2026-08-04, fable
      // review) — previously an uncancelled entrance timer could clear this
      // transition's flag early if a skip queued during the entrance handed
      // off here, reopening the wobble bug on that specific path.
      audioJustFiredClearTimerRef.current = setTimeout(() => { audioJustFiredRef.current = false }, 1800)
      onTransitionAudioStart?.(target)

      // Await the fly-down spring's OWN completion (controls.start()'s
      // promise resolves when the animation actually finishes) instead of
      // a guessed sleep(500) — ties the arm cue to the record's actual
      // landing so it can't drop early over an empty or still-descending
      // turntable (live-observed 2026-07-30). This was ORIGINALLY damping
      // 28, meaningfully overdamped for stiffness 120 (critical damping
      // here is 2*sqrt(120)≈21.9) — meaning the awaited promise itself
      // took a while to resolve, and the arm swing read as sluggish even
      // after trimming the grace period below (also 2026-07-30). Retuned
      // to damping 22 (right at critical, same change as the entrance
      // sequence's identical spring above) — lands just as cleanly, no
      // bounce, but the await resolves noticeably faster.
      // Capped at 550ms (2026-08-04, Opus review): the spring visually
      // settles well before Framer's own "at rest" promise threshold
      // resolves — the raw await was stacking invisible extra wait on top
      // of a motion that had already finished playing. Race it against a
      // cap instead; the arm cue below fires at whichever comes first.
      await Promise.race([
        flyCtrl.start({ y: 0, opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 120, damping: 22 } }),
        new Promise(r => setTimeout(r, 550)),
      ])

      // The 500ms grace here used to run concurrently with an un-awaited
      // fly-down (the actual landing happened somewhere during it, timing
      // unverified) — now that we AWAIT the real landing above, this delay
      // is pure extra wait stacked on top of it, and it read as sluggish
      // (2026-07-30). Trimmed to a beat, not a pause.
      await sleep(120)
      // damping 22 -> 26 (2026-08-04, Opus review): 180/22 is underdamped
      // (critical = 2*sqrt(180)≈26.8, ζ≈0.82) and overshoots. 200ms later the
      // re-sync below starts a SECOND spring to the same ARM_ON target at
      // 180/26, interrupting this one mid-overshoot with leftover velocity —
      // a visible double-settle even in the happy path, amplifying the
      // 700ms-guard bug fixed just above. Matching 180/26 here so both
      // springs to ARM_ON agree.
      tonearmCtrl.start({ ...ARM_ON, transition: { type: 'spring', stiffness: 180, damping: 26 } })
      await sleep(200)
      setTextInstant(false)
      setTransitioning(false)
      busyRef.current = false
      setTextVisible(true)

      // Re-sync arm in case isPaused changed while busy. Settle instantly if
      // the tab is hidden — see the identical guard in runEntrance above.
      // audioJustFiredRef guards against isPausedRef still reporting the
      // PREVIOUS song's state in the narrow window right after Step 3 fired
      // the new song's play request (see that ref's own comment above).
      const paused = audioJustFiredRef.current ? false : isPausedRef.current
      if (document.hidden) {
        tonearmCtrl.set(paused ? ARM_OFF : ARM_ON)
      } else {
        tonearmCtrl.start({
          ...(paused ? ARM_OFF : ARM_ON),
          transition: { type: 'spring', stiffness: 180, damping: 26 },
        })
      }
      // Sweep finding (2026-08-04) — same gap as runEntrance's identical
      // re-sync above: the isPaused effect bails out while busyRef.current
      // is true and won't naturally re-fire once busy clears, so a
      // pause/resume during a song-to-song transition could leave the
      // record's spin animation state stale even after the arm re-syncs.
      setSpinPaused(paused)

      // Let the re-sync animation start before any recursive call fires ARM_OFF
      await new Promise(r => setTimeout(r, 50))

      // Drain any skip that arrived mid-transition
      if (pendingRef.current && pendingRef.current.uri !== target.uri) {
        const pending = pendingRef.current
        pendingRef.current = null
        runTransition(pending, target)
      }
    } catch (err) {
      console.error('[runTransition]', err)
      busyRef.current = false
      setTransitioning(false)
      tonearmCtrl.start({ ...ARM_ON, transition: { type: 'spring', stiffness: 180, damping: 26 } })
    }
  }, [onTransitionAudioStart])

  // Song change → reconciliation backstop, not the primary trigger anymore
  // (2026-08-04) — the real trigger is Jukebox.jsx's advanceToNext calling
  // straight into runTransition via onRegisterTransition, above. This effect
  // stays as a safety net for anything that changes currentTrack WITHOUT
  // going through that path (a stray SDK event, another client transferring
  // the device, etc.) and, in the normal case, is a no-op: by the time
  // Spotify confirms and currentTrack updates, setShown(target) inside
  // runTransition already ran, so shown.uri === currentTrack.uri and the
  // guard below returns immediately.
  // Guard: !shown skips the very first track (handled by entrance above).
  // Guard: entranceActiveGuardRef — real root cause of "hit shuffle, song
  // flew down, went back up, another one came down, but the FIRST song is
  // what actually played" (2026-08-04). player.currentTrack (Jukebox.jsx)
  // doesn't get cleared on stop, so on a fresh shuffle it can still hold the
  // PREVIOUS session's song right as this component mounts — shown is
  // correctly seeded from entranceSong (fixed earlier tonight), but this
  // effect compares raw currentTrack against shown with no awareness that
  // currentTrack is stale leftover, not a real change. It fired a transition
  // AWAY from the real new song back toward the stale old one, then fired a
  // SECOND transition back once Spotify actually confirmed the real song —
  // two full unrequested fly animations with the audio never actually
  // leaving the first song the whole time. The entrance already owns
  // reconciling its own song via its pendingRef hand-off; this backstop
  // exists for STEADY-STATE anomalies (tab-focus SDK reconnect blips) that
  // by definition can't happen until well after the entrance settles, so
  // skip it entirely while the entrance is still active.
  // Guard: busyRef — 2026-08-06, Ben mid-session: "a song flew down, jumped
  // up, then flew back down" a few songs into a shuffle (not at the
  // entrance, so entranceActiveGuardRef above didn't apply). Root cause is
  // the same shape as that entrance bug, just for the steady-state case:
  // runTransition's Step 3 calls setShown(target) BEFORE the real Spotify
  // play call even fires, so for the whole rest of that transition (~2s of
  // arm-land/re-sync awaits) currentTrack (still reporting the OLD track
  // until Spotify confirms the new one) and shown (already the new track)
  // legitimately disagree — that's expected and self-resolves the moment
  // Spotify confirms. But this effect had no awareness a transition owned
  // the record: it scheduled its 220ms debounced correction anyway,
  // runTransition's own busyRef check (called 220ms later) just queued it
  // into pendingRef since busy was still true, and runTransition's own
  // end-of-function pendingRef drain (a few lines above, `if
  // (pendingRef.current...)`) then fired a real SECOND transition — arm up,
  // the record that had just landed flying back up, then back down to
  // whatever stale currentTrack snapshot the debounce timer had closed over.
  // Skipping entirely while busyRef is true removes the false trigger at its
  // source: any mismatch during an active transition is either about to
  // self-resolve (the common case) or, if truly a competing SDK event,
  // belongs to whichever check runs once busy clears — not a queued
  // correction fired against an already-outdated snapshot.
  useEffect(() => {
    if (!currentTrack || !shown || currentTrack.uri === shown.uri) return
    if (entranceActiveGuardRef.current) return
    if (busyRef.current) return

    // Debounced, not immediate (2026-08-04, Ben live: switching windows away
    // and back mid-song was replaying the fly-down even though the arm ended
    // up back in the right place). The Spotify Web Playback SDK is known to
    // re-emit a stale player_state_changed on reconnect after a tab regains
    // focus, briefly reporting a different current_track before catching up
    // to the real one a moment later (useSpotifyPlayer.js's player_state_changed
    // listener has no defense against this — it only dedupes IDENTICAL uris,
    // not a uri that changes and reverts). This effect fires on every
    // currentTrack.uri change with no debounce, so a flicker-and-revert ran
    // two full real transitions back to back: one out to the momentarily-
    // reported track, one back — net correct arm position, but a fly
    // animation the user never asked for. Delaying the actual call lets the
    // effect's own cleanup (React re-running this effect on the very next uri
    // change) cancel the stale timeout before it fires, so a revert within
    // the window never starts a transition at all. 220ms comfortably covers
    // the SDK's own reconnect-and-correct gap without adding a perceptible
    // delay to a real song change.
    trackChangeDebounceRef.current = setTimeout(() => {
      runTransition(currentTrack)
    }, 220)
    return () => clearTimeout(trackChangeDebounceRef.current)
  }, [currentTrack?.uri, runTransition])

  // Cleanup prev background after crossfade
  useEffect(() => {
    if (!prev) return
    const t = setTimeout(() => setPrev(null), 900)
    return () => clearTimeout(t)
  }, [prev?.uri])

  // Escape key
  useEffect(() => {
    const h = e => {
      if (e.repeat) return
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  // Close button is a host control, not an audience-facing element — it stays
  // hidden on this audience-facing screen unless the mouse is actively moving
  // (host reaching for the trackpad), then fades out again after a couple
  // seconds of no movement.
  const [showClose, setShowClose] = useState(false)
  const closeHideTimerRef = useRef(null)
  useEffect(() => {
    function reveal() {
      setShowClose(true)
      clearTimeout(closeHideTimerRef.current)
      closeHideTimerRef.current = setTimeout(() => setShowClose(false), 2200)
    }
    window.addEventListener('mousemove', reveal)
    return () => {
      window.removeEventListener('mousemove', reveal)
      clearTimeout(closeHideTimerRef.current)
    }
  }, [])

  return (
    <div className={`fixed inset-0 bg-black z-50 overflow-hidden flex flex-col items-center justify-start transition-opacity duration-200 ${closing ? 'opacity-0' : 'opacity-100'}`}>

      {/* active is always true — grading breaks are exactly when the screen
          sits paused for minutes, and that's precisely when the ambient
          motion matters most. Previously active={!isPaused || transitioning}
          froze the canvas RAF loop on pause, so the one moment the room stares
          at this screen the longest showed a dead frame. */}
      <GradientBackground colors={palette.colors} weights={palette.weights} nextColors={upcomingPalette.colors} nextWeights={upcomingPalette.weights} active={true} shuffleKey={shuffleKey} entranceActive={entranceActive} artUrl={artUrl} nextArtUrl={upcomingArtUrl} />

      {/* Entrance black cover (2026-08-04, owner spec), scoped ONLY to
          entranceActive (true exactly once, the very first song of a
          shuffle session — see the runEntrance effect above).
          2026-08-03 revision: this used to BE the entrance animation (a
          900ms, then 2400ms, opacity fade over an already-fully-bright
          GradientBackground underneath) — but alpha-compositing a static
          black layer over a fixed-brightness scene reads as a wipe/reveal
          no matter the duration, which is exactly what the owner kept
          calling "not fluid enough... supposed to be two living colors
          floating in, not instant" even at 2400ms. The actual "floating
          in" animation now lives in GradientBackground itself (a CSS
          brightness() filter on its own canvases, ramping the colors'
          real intensity up instead of uncovering a static image) — see
          GradientBackground.jsx. This div now only needs to cover the
          very first paint frame before that mounts, so it snaps instantly
          instead of animating; animating two things at once just to reach
          the same "revealed" endpoint would double-count the reveal. */}
      {/* #080808, not pure #000 (2026-08-07, Ben live: "black shifts from
          one black to another, right before the gradients flow in") — this
          div snaps instantly (no transition, see comment above) the moment
          entranceActive flips, exposing whatever GradientBackground's canvas
          is currently showing. Its resting/initial color before any real
          palette lands is #080808 (usePalette's FALLBACK_COLORS, baked into
          AlbumGradientMesh's own hexToRgb fallback too) — GradientBackground's
          own entranceActive effect that starts the real color blend fires a
          beat AFTER this cover disappears (separate component, separate
          effect pass), so a pure-#000 cover was revealing a visibly
          different near-black for that gap before any hue appeared. Matching
          the two removes the value jump; the canvas's own blend still owns
          the entire "floating in" motion from there. */}
      <div
        className="absolute inset-0 z-[1] pointer-events-none"
        style={{ background: '#080808', opacity: entranceActive ? 1 : 0 }}
      />

      {/* Light vignette — kept subtle on purpose. This screen's whole job is
          showing off the album-gradient colors, so this only pulls focus
          toward center without visibly darkening/muting the palette itself. */}
      <div
        className="absolute inset-0 z-[1] pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.32) 100%)' }}
      />

      <div className="relative z-10 flex flex-col items-center gap-8 px-10 text-center max-w-lg w-full" style={{ paddingTop: '10vh' }}>
        {shown ? (
          <>
            {/* Record + tonearm scene */}
            <div className="relative w-[370px] h-[370px] sm:w-[412px] sm:h-[412px]">

              {/* Layer 2 – fly wrapper: drops in on entrance, flies straight up on exit.
                   Never rotated — fly-up is always vertical regardless of spin angle.
                   Now also carries the platter and spindle, so the record "is here or it isn't"
                   as one unit — only the tonearm is left behind as permanent furniture. */}
              <motion.div
                className="absolute inset-0"
                style={{ zIndex: 2, willChange: 'transform, opacity' }}
                initial={{ opacity: 0, y: -500, scale: 1 }}
                animate={flyCtrl}
              >
                {/* Content wrapper: platter + art + groove rings + shadow + spindle
                     ALL fade together via artOpacity.
                     Transition delay on exit (0.25s) keeps art opaque while record is ~60% of the way up.

                     2026-08-07: the platter and spindle used to sit OUTSIDE this
                     wrapper as siblings, so they never faded — and the fly-off's
                     y:-500 does not actually clear the top of the viewport. The
                     leftover on screen after a fly-off is
                     (paddingTop + recordHeight - 500)px of the record's bottom
                     edge: at the then-current 15vh anchor that was ~3px at the
                     old 368px record (invisible) but ~47px on a 900px-tall
                     viewport at today's 412px size — i.e. the "bottom 10% of the
                     album stuck near the top of the screen" Ben reported, as a
                     dark platter chord that then sat there until the whole
                     overlay faded ~1.2s later. Same defect on runTransition's
                     Step 2 fly-up, since both paths animate this one shared
                     flyCtrl wrapper. Folding the platter and spindle into the
                     existing fade fixes both paths at once and is
                     viewport/size/position independent — no spring, distance, or
                     delay retuned. Paint order is unchanged: platter zIndex:0
                     first in tree, spin layer + shadow z-auto next, spindle
                     zIndex:1 on top.

                     The anchor is 10vh as of the same day (see the container
                     above); that only shrinks the leftover — 90+412-500 = ~2px at
                     900px tall, ~20px at 1080 — and this fade covers it either
                     way, which is exactly why the fix was written as a fade and
                     not as a bigger travel constant. */}
                <motion.div
                  className="absolute inset-0"
                  style={{ willChange: 'opacity' }}
                  animate={{ opacity: artOpacity }}
                  transition={artOpacity === 1
                    ? { duration: 0.35, ease: [0.23, 1, 0.32, 1] }
                    : { duration: 0.2, delay: 0.25, ease: [0.23, 1, 0.32, 1] }}
                >
                  {/* Layer 0 – turntable platter: travels with the record now.
                       z-index 0 + first in tree order keeps it painted behind the
                       spin layer below (which is z-index:auto, i.e. effectively 0 —
                       same-level positioned siblings paint in document order). */}
                  <div
                    className="absolute rounded-full"
                    style={{
                      inset: '-9px',
                      background: 'radial-gradient(circle at 40% 35%, #2a2a2a, #111)',
                      zIndex: 0,
                    }}
                  />

                  {/* Spin layer: art img + groove rings rotate together.
                       clipPath alongside overflow-hidden+rounded-full (2026-08-06,
                       live-observed): the square art's corners briefly showed past
                       the circular rim on entrance for at least one track — this
                       div is will-change:transform + a running CSS animation, so
                       it's promoted to its own compositing layer, and overflow+
                       border-radius clipping on a freshly (re)created layer can
                       paint a frame before the clip is established. clip-path is
                       enforced independently of that layer-promotion path, so it
                       holds even if the overflow clip's first frame doesn't. */}
                  <div
                    className="absolute inset-0 rounded-full overflow-hidden"
                    style={{
                      animation: 'live-spin 12s linear infinite',
                      animationPlayState: spinPaused ? 'paused' : 'running',
                      willChange: 'transform',
                      transform: 'translateZ(0)',
                      clipPath: 'circle(50%)',
                    }}
                  >
                    <img src={artUrl} alt="" decoding="async" className="absolute inset-0 w-full h-full object-cover" />
                    <div
                      className="absolute inset-0 rounded-full pointer-events-none"
                      style={{
                        background: 'repeating-radial-gradient(circle at center, transparent 0px, transparent 6px, rgba(0,0,0,0.12) 7px, transparent 8px)',
                      }}
                    />
                  </div>
                  {/* Drop shadow — outside spin layer so it doesn't rotate */}
                  <div
                    className="absolute inset-0 rounded-full pointer-events-none"
                    style={{ boxShadow: '0 32px 80px rgba(0,0,0,0.7)' }}
                  />

                  {/* Layer 3 – center hole/spindle: travels with the record now.
                       Explicit positive z-index forms its own stacking context, which
                       always paints above z-index:0/auto siblings (platter, spin
                       layer, shadow) regardless of tree order — so it stays a dot on
                       top of the art, same visual result as the old zIndex:15 had. */}
                  <div
                    className="absolute inset-0 flex items-center justify-center pointer-events-none"
                    style={{ zIndex: 1 }}
                  >
                    <div className="w-4 h-4 rounded-full bg-black ring-1 ring-white/10" />
                  </div>
                </motion.div>
              </motion.div>

              {/* Layer 4 – tonearm */}
              <Tonearm controls={tonearmCtrl} />
            </div>

            {/* Track info — hidden during transitions and before entrance completes.
                (2026-07-30: tried gating this on a 3s-in/3s-out buffer keyed off
                playback position, reverted — added a class of timing bugs, e.g.
                the name hiding for a whole song if position ever stalled, that
                weren't worth the polish.) */}
            <motion.div
              initial={{ opacity: 0, y: 0 }}
              animate={{ opacity: transitioning ? 0 : (textVisible ? 1 : 0), y: transitioning ? -6 : 0 }}
              transition={textInstant ? { duration: 0 } : { duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
            >
              <div ref={titleBoxRef} className="flex flex-col justify-center mb-2">
                <h1
                  ref={titleRef}
                  className="text-5xl sm:text-6xl text-white tracking-tight leading-tight"
                  style={{
                    fontFamily: FONT_DISPLAY,
                    textShadow: TEXT_SCRIM,
                    ...(titleScale < 1 ? { fontSize: `${(titleBasePxRef.current ?? 48) * titleScale}px` } : {}),
                  }}
                >
                  {displayName(shown.name)}
                </h1>
              </div>
              <p
                className="text-2xl sm:text-3xl text-white font-medium italic"
                style={{ fontFamily: FONT_BODY, textShadow: TEXT_SCRIM }}
              >
                {/* Cap the collaborator list at 2 names — a song with a
                    handful of featured artists (5, in the reported case) was
                    wrapping to 3 italic lines on this audience-facing screen,
                    which read as clutter rather than information. Just the
                    two main artists, no "& others" suffix — simplest read. */}
                {shown.artists?.slice(0, 2).map(a => a.name).join(' & ')}
              </p>
            </motion.div>
          </>
        ) : (
          /* Waiting state — track hasn't arrived from SDK yet. Show an empty turntable
             so the screen isn't black. Once shown populates, the entrance animation plays. */
          <div className="relative w-[330px] h-[330px] sm:w-[368px] sm:h-[368px]">
            {/* Platter */}
            <div
              className="absolute rounded-full"
              style={{
                inset: '-9px',
                background: 'radial-gradient(circle at 40% 35%, #2a2a2a, #111)',
                zIndex: 0,
              }}
            />
            {/* Blank record — slow shimmer signals "loading," not "stuck" */}
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background: 'rgba(238,238,238,0.96)',
                boxShadow: '0 32px 80px rgba(0,0,0,0.7)',
                zIndex: 1,
                animation: 'platter-shimmer 2.4s ease-in-out infinite',
              }}
            />
            {/* Center hole */}
            <div
              className="absolute inset-0 flex items-center justify-center pointer-events-none"
              style={{ zIndex: 15 }}
            >
              <div className="w-4 h-4 rounded-full bg-black ring-1 ring-white/10" />
            </div>
            {/* Tonearm in lifted/OFF position */}
            <Tonearm controls={tonearmCtrl} />
          </div>
        )}
      </div>

      {/* Wrapper owns the fade (opacity/pointer-events); the button keeps its
          own color/press transitions so the two don't fight over
          transition-property. */}
      <div className={`absolute top-6 right-6 transition-opacity duration-300 ${showClose ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <button
          onClick={onClose}
          className="text-white/50 hover:text-white transition-colors transition-transform duration-150 active:scale-[0.97] cursor-pointer text-lg leading-none"
          aria-label="Close live screen"
        >
          ✕
        </button>
      </div>
    </div>
  )
}

export default memo(LiveScreen)
