import { useState, useEffect, useRef, memo } from 'react'
import { motion, useAnimation } from 'framer-motion'
import AlbumGradient from './AlbumGradient'
import { usePalette } from '../hooks/usePalette'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const ARM_ON  = { rotate: 8,  y: 0 }   // needle resting on record
const ARM_OFF = { rotate: -30, y: -5 } // lifted and rotated back

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
          runTransitionRef.current?.(pending)
        }

        // Let the record + tonearm springs fully settle before entranceActive
        // flips — that flip releases the gradient's deferred first blend, which
        // doubles canvas layer work at onset and was landing exactly as the
        // record lays onto the platter (the reported settle-moment chop).
        await sleep(600)
      } finally {
        setEntranceActive(false)
        busyRef.current = false
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
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); clearTimeout(t4) }
  }, [ending])

  // Hide text immediately when a new track arrives — instant (no fade) before runTransition fires
  useEffect(() => {
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
        flyCtrl.start({ y: 0, opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 120, damping: 28 } })
        await sleep(500)   // record flies down

        await sleep(500)
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

  return (
    <div className={`fixed inset-0 bg-black z-50 overflow-hidden flex flex-col items-center justify-start transition-opacity duration-200 ${closing ? 'opacity-0' : 'opacity-100'}`}>

      <AlbumGradient colors={paletteColors} nextColors={upcomingPaletteColors} active={!isPaused || transitioning} shuffleKey={shuffleKey} entranceActive={entranceActive} />

      <div className="relative z-10 flex flex-col items-center gap-8 px-10 text-center max-w-lg w-full" style={{ paddingTop: '15vh' }}>
        {shown ? (
          <>
            {/* Record + tonearm scene */}
            <div className="relative w-[330px] h-[330px] sm:w-[368px] sm:h-[368px]">

              {/* Layer 0 – turntable platter: static, never flies or spins */}
              <div
                className="absolute rounded-full"
                style={{
                  inset: '-9px',
                  background: 'radial-gradient(circle at 40% 35%, #2a2a2a, #111)',
                  zIndex: 0,
                }}
              />

              {/* Layer 2 – fly wrapper: drops in on entrance, flies straight up on exit.
                   Never rotated — fly-up is always vertical regardless of spin angle. */}
              <motion.div
                className="absolute inset-0"
                style={{ zIndex: 2, willChange: 'transform, opacity' }}
                initial={{ opacity: 0, y: -400, scale: 0.85 }}
                animate={flyCtrl}
              >
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
              </motion.div>

              {/* Layer 3 – center hole/spindle: static, outside fly wrapper — never moves */}
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
                style={{ zIndex: 15 }}
              >
                <div className="w-4 h-4 rounded-full bg-black ring-1 ring-white/10" />
              </div>

              {/* Layer 4 – tonearm */}
              <Tonearm controls={tonearmCtrl} />
            </div>

            {/* Track info — hidden during transitions and before entrance completes */}
            <motion.div
              initial={{ opacity: 0, y: 0 }}
              animate={{ opacity: transitioning ? 0 : (textVisible ? 1 : 0), y: transitioning ? -6 : 0 }}
              transition={textInstant ? { duration: 0 } : { duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
            >
              <h1
                ref={titleRef}
                className="text-4xl sm:text-5xl font-bold text-white tracking-tight leading-tight mb-2"
                style={titleScale < 1 ? { fontSize: `${(titleBasePxRef.current ?? 48) * titleScale}px` } : undefined}
              >
                {shown.name}
              </h1>
              <p className="text-xl text-white font-medium">
                {shown.artists?.map(a => a.name).join(', ')}
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
            {/* Blank record */}
            <div
              className="absolute inset-0 rounded-full"
              style={{
                background: 'rgba(238,238,238,0.96)',
                boxShadow: '0 32px 80px rgba(0,0,0,0.7)',
                zIndex: 1,
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

      <button
        onClick={onClose}
        className="absolute top-6 right-6 text-white/50 hover:text-white transition-colors transition-transform duration-150 active:scale-[0.97] cursor-pointer text-lg leading-none"
        aria-label="Close live screen"
      >
        ✕
      </button>
    </div>
  )
}

export default memo(LiveScreen)
