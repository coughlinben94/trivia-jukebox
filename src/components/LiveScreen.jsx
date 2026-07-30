import { useState, useEffect, useLayoutEffect, useRef, memo } from 'react'
import { motion, useAnimation } from 'framer-motion'
import AlbumGradient from './AlbumGradient'
import AlbumGradientMesh from './AlbumGradientMesh'
import { usePalette } from '../hooks/usePalette'
import { displayName } from '../lib/track'

// AlbumGradientMesh (soft mesh, OKLab mixing, tiny-canvas blur, "two colors
// colliding") is the default background as of 2026-07-26. The original
// AlbumGradient (radial-gradient circle blobs) draws 6 solid-colored circles
// and screen-blends them — no matter how the falloff curve is tuned, wherever
// two differently-colored circles meet (or a circle's own bright center meets
// its softer edge) there's a visible boundary, reported repeatedly as "circles
// in the middle of blobs." Mesh doesn't have that failure mode by
// construction: it paints at a tiny ~48px resolution and blurs the result way
// up onto the real canvas, so a hard edge is physically impossible.
// Mesh's tuning constants (ANCHOR_SWING, ACCENT_BOOST, etc., see
// AlbumGradientMesh.jsx) were dialed up on 2026-07-19 specifically to fight
// api/palette.js's old washed-out bucket-averaging bug — that bug is long
// fixed and palette.js has since also gained hue-diversity dedup (2026-07-26),
// so those boosts are working with much more vivid input than when they were
// tuned. Watch for oversaturation; dial the "+25% intensity pass" values back
// down first if so.
// Circle-blobs is kept as an opt-out: ?gradient=circles or
// localStorage.setItem('trivia_gradient_engine', 'circles') in devtools —
// either way it's instant, no redeploy needed.
// Not a real hook (no React state/effects) — plain function, just named to
// signal it's read at render time rather than cached once at module load.
function getMeshGradientFlag() {
  if (typeof window === 'undefined') return true
  const q = new URLSearchParams(window.location.search).get('gradient')
  if (q === 'circles' || q === 'circle') return false
  if (q === 'mesh') return true
  const stored = localStorage.getItem('trivia_gradient_engine')
  if (stored === 'circles' || stored === 'circle') return false
  return true
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const ARM_ON  = { rotate: 8,  y: 0 }   // needle resting on record
const ARM_OFF = { rotate: -30, y: -5 } // lifted and rotated back

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
function LiveScreen({ currentTrack, isPaused, ending, onClose, shuffleKey, onUpcomingTrack }) {
  // Read once per mount, not per render — avoids re-checking localStorage/URL
  // on every position-tick re-render this component already gets a lot of.
  const [useMeshGradient] = useState(getMeshGradientFlag)
  const GradientBg = useMeshGradient ? AlbumGradientMesh : AlbumGradient
  const [shown, setShown]                 = useState(currentTrack)
  const [prev,  setPrev]                  = useState(null)
  const [transitioning, setTransitioning] = useState(false)
  const [artOpacity, setArtOpacity]       = useState(1)
  const [artUrl, setArtUrl]               = useState(currentTrack?.album?.images?.[0]?.url)
  const [textVisible, setTextVisible]     = useState(false)
  const [spinPaused, setSpinPaused]       = useState(false)
  const [upcomingArtUrl, setUpcomingArtUrl] = useState(null)
  const [textInstant, setTextInstant]     = useState(false)
  const [closing, setClosing]             = useState(false)
  const [entranceActive, setEntranceActive] = useState(true)

  const titleRef                          = useRef(null)
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

  const paletteColors          = usePalette(artUrl)
  const upcomingPaletteColors  = usePalette(upcomingArtUrl)

  const tonearmCtrl = useAnimation()
  const flyCtrl     = useAnimation()
  const busyRef      = useRef(false)
  const mountedRef   = useRef(false)
  const pendingRef   = useRef(null)
  const pauseSeqRef  = useRef([])
  // Always-current isPaused so async functions don't read a stale closure value
  const isPausedRef = useRef(isPaused)
  const runTransitionRef = useRef(null)
  useEffect(() => { isPausedRef.current = isPaused }, [isPaused])

  // Register palette-prefetch handler with Jukebox so advanceToNext can notify us
  useEffect(() => {
    onUpcomingTrack?.((song) => setUpcomingArtUrl(song?.album?.images?.[0]?.url ?? null))
    return () => onUpcomingTrack?.(null)
  }, [onUpcomingTrack])

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
        if (entranceArt) await preloadImage(entranceArt)

        flyCtrl.start({
          y: 0, opacity: 1, scale: 1,
          transition: { type: 'spring', stiffness: 120, damping: 28 },
        })

        await sleep(1200)
        tonearmCtrl.start({
          ...(isPausedRef.current ? ARM_OFF : ARM_ON),
          transition: { type: 'spring', stiffness: 180, damping: 22 },
        })

        await sleep(200)
        setTextInstant(false)
        setTextVisible(true)
        busyRef.current = false

        // Bug 3: re-sync arm now that busyRef is clear, in case isPaused changed mid-entrance.
        // Settle instantly if the tab is hidden — same rationale as the isPaused
        // effect above: this spring is rAF-driven and stalls while backgrounded,
        // then visibly snaps/catches up on refocus if left animating.
        if (document.hidden) {
          tonearmCtrl.set(isPausedRef.current ? ARM_OFF : ARM_ON)
        } else {
          tonearmCtrl.start({
            ...(isPausedRef.current ? ARM_OFF : ARM_ON),
            transition: { type: 'spring', stiffness: 180, damping: 26 },
          })
        }

        if (pendingRef.current && pendingRef.current.uri !== shown?.uri) {
          const pending = pendingRef.current
          pendingRef.current = null
          handedOffToTransition = true
          runTransitionRef.current?.(pending)
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

    // Pause: 3000ms delay (500ms after 2500ms fade) → arm lifts with shuffle spring → spin stops
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
      t4 = setTimeout(onClose, 1850)
    }, 400)
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

  // Song change → coordinated transition.
  // Guard: !shown skips the very first track (handled by entrance above).
  useEffect(() => {
    if (!currentTrack || !shown || currentTrack.uri === shown.uri) return

    async function runTransition(target, prevTrack = shown) {
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
        setPrev(prevTrack)
        await sleep(400)   // arm fully lifted

        // Step 2 — record flies up once arm is clear
        flyCtrl.start({ y: -500, transition: { type: 'spring', stiffness: 220, damping: 22 } })
        setArtOpacity(0)
        await Promise.all([preloadPromise, sleep(1200)])   // fly-up completes; preload runs concurrently
        // Old record is gone — swap track identity
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
        // Await the fly-down spring's OWN completion (controls.start()'s
        // promise resolves when the animation actually finishes) instead of
        // a guessed sleep(500) — this spring's damping ratio (28 vs a
        // critically-damped ~2*sqrt(120)≈21.9) is overdamped, so its real
        // settle time isn't a fixed number and can run past 500ms on a
        // loaded frame. The old fixed-sleep version fired ARM_ON on a timer
        // that assumed the record had landed by then; when it hadn't, the
        // arm visibly dropped to engaged while the record was still
        // descending (live-observed 2026-07-30). Tying the arm cue to the
        // record's actual landing removes that whole class of race — it
        // can't drop early relative to a record that isn't there yet, or
        // relative to one still mid-flight, because it now waits on the
        // same promise that resolves when the flight is over.
        await flyCtrl.start({ y: 0, opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 120, damping: 28 } })

        await sleep(500)   // brief settle after landing, same grace period as before
        tonearmCtrl.start({ ...ARM_ON, transition: { type: 'spring', stiffness: 180, damping: 22 } })
        await sleep(200)
        setTextInstant(false)
        setTransitioning(false)
        busyRef.current = false
        setTextVisible(true)

        // Re-sync arm in case isPaused changed while busy. Settle instantly if
        // the tab is hidden — see the identical guard in runEntrance above.
        if (document.hidden) {
          tonearmCtrl.set(isPausedRef.current ? ARM_OFF : ARM_ON)
        } else {
          tonearmCtrl.start({
            ...(isPausedRef.current ? ARM_OFF : ARM_ON),
            transition: { type: 'spring', stiffness: 180, damping: 26 },
          })
        }

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
    }

    runTransitionRef.current = runTransition
    runTransition(currentTrack)
  }, [currentTrack?.uri])

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
      <GradientBg colors={paletteColors} nextColors={upcomingPaletteColors} active={true} shuffleKey={shuffleKey} entranceActive={entranceActive} />

      {/* Light vignette — kept subtle on purpose. This screen's whole job is
          showing off the album-gradient colors, so this only pulls focus
          toward center without visibly darkening/muting the palette itself. */}
      <div
        className="absolute inset-0 z-[1] pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.32) 100%)' }}
      />

      <div className="relative z-10 flex flex-col items-center gap-8 px-10 text-center max-w-lg w-full" style={{ paddingTop: '15vh' }}>
        {shown ? (
          <>
            {/* Record + tonearm scene */}
            <div className="relative w-[330px] h-[330px] sm:w-[368px] sm:h-[368px]">

              {/* Layer 2 – fly wrapper: drops in on entrance, flies straight up on exit.
                   Never rotated — fly-up is always vertical regardless of spin angle.
                   Now also carries the platter and spindle, so the record "is here or it isn't"
                   as one unit — only the tonearm is left behind as permanent furniture. */}
              <motion.div
                className="absolute inset-0"
                style={{ zIndex: 2, willChange: 'transform, opacity' }}
                initial={{ opacity: 0, y: -400, scale: 0.85 }}
                animate={flyCtrl}
              >
                {/* Layer 0 – turntable platter: travels with the record now.
                     z-index 0 + first in tree order keeps it painted behind the
                     content wrapper below (which is z-index:auto, i.e. effectively 0 —
                     same-level positioned siblings paint in document order). */}
                <div
                  className="absolute rounded-full"
                  style={{
                    inset: '-9px',
                    background: 'radial-gradient(circle at 40% 35%, #2a2a2a, #111)',
                    zIndex: 0,
                  }}
                />

                {/* Content wrapper: art + groove rings + shadow all fade together via artOpacity.
                     Transition delay on exit (0.25s) keeps art opaque while record is ~60% of the way up. */}
                <motion.div
                  className="absolute inset-0"
                  style={{ willChange: 'opacity' }}
                  animate={{ opacity: artOpacity }}
                  transition={artOpacity === 1
                    ? { duration: 0.35, ease: [0.23, 1, 0.32, 1] }
                    : { duration: 0.2, delay: 0.25, ease: [0.23, 1, 0.32, 1] }}
                >
                  {/* Spin layer: art img + groove rings rotate together */}
                  <div
                    className="absolute inset-0 rounded-full overflow-hidden"
                    style={{
                      animation: 'live-spin 12s linear infinite',
                      animationPlayState: spinPaused ? 'paused' : 'running',
                      willChange: 'transform',
                      transform: 'translateZ(0)',
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
                </motion.div>

                {/* Layer 3 – center hole/spindle: travels with the record now.
                     Explicit positive z-index forms its own stacking context, which
                     always paints above z-index:0/auto siblings (platter, content
                     wrapper) regardless of tree order — so it stays a dot on top of
                     the art, same visual result as the old zIndex:15 had outside. */}
                <div
                  className="absolute inset-0 flex items-center justify-center pointer-events-none"
                  style={{ zIndex: 1 }}
                >
                  <div className="w-4 h-4 rounded-full bg-black ring-1 ring-white/10" />
                </div>
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
              <h1
                ref={titleRef}
                className="text-5xl sm:text-6xl text-white tracking-tight leading-tight mb-2"
                style={{
                  fontFamily: FONT_DISPLAY,
                  textShadow: TEXT_SCRIM,
                  ...(titleScale < 1 ? { fontSize: `${(titleBasePxRef.current ?? 48) * titleScale}px` } : {}),
                }}
              >
                {displayName(shown.name)}
              </h1>
              <p
                className="text-2xl sm:text-3xl text-white font-medium italic"
                style={{ fontFamily: FONT_BODY, textShadow: TEXT_SCRIM }}
              >
                {/* Cap the collaborator list at 2 names — a song with a
                    handful of featured artists (5, in the reported case) was
                    wrapping to 3 italic lines on this audience-facing screen,
                    which read as clutter rather than information. Just the
                    two main artists, no "& others" suffix — simplest read. */}
                {shown.artists?.slice(0, 2).map(a => a.name).join(', ')}
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
