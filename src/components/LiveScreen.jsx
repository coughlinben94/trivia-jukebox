import { useState, useEffect, useRef } from 'react'
import { AnimatePresence, motion, useAnimation } from 'framer-motion'
import AlbumGradient from './AlbumGradient'
import { usePalette } from '../hooks/usePalette'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const ARM_ON  = { rotate: 8,  y: 0 }   // needle resting on record
const ARM_OFF = { rotate: -30, y: -5 } // lifted and rotated back

function preloadImage(url) {
  return new Promise(resolve => {
    const img = new Image()
    img.onload = resolve
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
      style={{ top: -8, right: -24, width: 92, height: 154,
               transformOrigin: '78px 18px', zIndex: 20, willChange: 'transform' }}
      initial={ARM_OFF}
      animate={controls}
    >
      <svg width="92" height="154" viewBox="0 0 92 154" fill="none">
        <circle cx="78" cy="18" r="12" fill="#e8e4dc" stroke="#ccc9c0" strokeWidth="1.5"/>
        <circle cx="78" cy="18" r="5"  fill="#b0aca4"/>
        <rect x="72" y="16" width="7" height="108" rx="3.5" fill="#f0ece4"/>
        <rect x="53" y="116" width="24" height="6" rx="3" fill="#e8e4dc"/>
        <rect x="41" y="116" width="20" height="14" rx="3"
              fill="#ece8e0" stroke="#d4d0c8" strokeWidth="1"/>
        <line x1="51" y1="130" x2="48" y2="144"
              stroke="#a0a0a0" strokeWidth="1.5" strokeLinecap="round"/>
        <circle cx="48" cy="145" r="2" fill="#c8c4bc"/>
      </svg>
    </motion.div>
  )
}

// ── LiveScreen ─────────────────────────────────────────────────────────────────
export default function LiveScreen({ currentTrack, isPaused, ending, onClose, nextArtUrl, shuffleKey, onUpcomingTrack }) {
  const [shown, setShown]                 = useState(currentTrack)
  const [prev,  setPrev]                  = useState(null)
  const [transitioning, setTransitioning] = useState(false)
  const [showBlank, setShowBlank]         = useState(false)
  const [artOpacity, setArtOpacity]       = useState(1)
  const [artUrl, setArtUrl]               = useState(currentTrack?.album?.images?.[0]?.url)
  const [textVisible, setTextVisible]     = useState(false)
  const [spinPaused, setSpinPaused]       = useState(false)
  const [upcomingArtUrl, setUpcomingArtUrl] = useState(null)
  const [textInstant, setTextInstant]     = useState(false)

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
      busyRef.current = true
      setTextVisible(false)

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
      setTextVisible(true)
      busyRef.current = false

      // Bug 3: re-sync arm now that busyRef is clear, in case isPaused changed mid-entrance
      tonearmCtrl.start({
        ...(isPausedRef.current ? ARM_OFF : ARM_ON),
        transition: { type: 'spring', stiffness: 180, damping: 26 },
      })
    }

    runEntrance()
  }, [shown])

  // Play/pause tonearm nudge when not mid-transition or entrance
  useEffect(() => {
    if (busyRef.current) return

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
    tonearmCtrl.start({ ...ARM_OFF, transition: { type: 'spring', stiffness: 220, damping: 22 } })
    flyCtrl.start({ y: -500, transition: { type: 'spring', stiffness: 220, damping: 22 } })
    setArtOpacity(0)
    const t = setTimeout(onClose, 520)
    return () => clearTimeout(t)
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
        setTransitioning(true)

        // Step 1 — arm lifts alone; record stays put until arm is fully up
        tonearmCtrl.start({ ...ARM_OFF, transition: { type: 'spring', stiffness: 220, damping: 22 } })
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

        // Re-sync arm in case isPaused changed while busy
        tonearmCtrl.start({
          ...(isPausedRef.current ? ARM_OFF : ARM_ON),
          transition: { type: 'spring', stiffness: 180, damping: 26 },
        })

        // Let the re-sync animation start before any recursive call fires ARM_OFF
        await new Promise(r => setTimeout(r, 50))

        // Clear upcoming palette — prevents stale colors bleeding through between songs
        setUpcomingArtUrl(null)

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
    const h = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div className="fixed inset-0 bg-black z-50 overflow-hidden flex flex-col items-center justify-start">

      <AlbumGradient colors={paletteColors} nextColors={upcomingPaletteColors} active={!isPaused || transitioning} shuffleKey={shuffleKey} />

      <div className="relative z-10 flex flex-col items-center gap-8 px-10 text-center max-w-lg w-full" style={{ paddingTop: '20vh' }}>
        {shown ? (
          <>
            {/* Record + tonearm scene */}
            <div className="relative w-72 h-72 sm:w-80 sm:h-80">

              {/* Layer 0 – turntable platter: static, never flies or spins */}
              <div
                className="absolute rounded-full"
                style={{
                  inset: '-8px',
                  background: 'radial-gradient(circle at 40% 35%, #2a2a2a, #111)',
                  zIndex: 0,
                }}
              />

              {/* Layer 1 – blank white record (drops in during transition).
                   zIndex 1 keeps it below the fly wrapper (zIndex 2),
                   so new art fades in on top of it. */}
              <AnimatePresence>
                {showBlank && (
                  <motion.div
                    key="blank"
                    className="absolute inset-0 rounded-full"
                    style={{
                      background: 'rgba(238,238,238,0.96)',
                      boxShadow: '0 32px 80px rgba(0,0,0,0.7)',
                      zIndex: 1,
                    }}
                    initial={{ y: -300, rotate: -20, scale: 0.85 }}
                    animate={{ y: 0, rotate: 0, scale: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.18 } }}
                    transition={{ type: 'spring', stiffness: 250, damping: 26 }}
                  />
                )}
              </AnimatePresence>

              {/* Layer 2 – fly wrapper: drops in on entrance, flies straight up on exit.
                   Never rotated — fly-up is always vertical regardless of spin angle. */}
              <motion.div
                className="absolute inset-0"
                style={{ zIndex: 2, willChange: 'transform' }}
                initial={{ opacity: 0, y: -400, scale: 0.85 }}
                animate={flyCtrl}
              >
                {/* Content wrapper: art + groove rings + shadow all fade together via artOpacity.
                     transition-delay 0.25s on exit keeps art opaque while record is ~60% of the way up. */}
                <div
                  className={`absolute inset-0 ${artOpacity === 0 ? 'art-fade-out' : 'art-fade-in'}`}
                  style={{ opacity: artOpacity }}
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
                    <img src={artUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
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
                </div>
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
              animate={{ opacity: transitioning ? 0 : (textVisible ? 1 : 0), y: transitioning ? -6 : 0 }}
              transition={textInstant ? { duration: 0 } : { duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
            >
              <h1 className="text-3xl sm:text-4xl font-bold text-white tracking-tight leading-tight mb-2">
                {shown.name}
              </h1>
              <p className="text-lg text-white font-medium">
                {shown.artists?.map(a => a.name).join(', ')}
              </p>
            </motion.div>
          </>
        ) : (
          /* Waiting state — track hasn't arrived from SDK yet. Show an empty turntable
             so the screen isn't black. Once shown populates, the entrance animation plays. */
          <div className="relative w-72 h-72 sm:w-80 sm:h-80">
            {/* Platter */}
            <div
              className="absolute rounded-full"
              style={{
                inset: '-8px',
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
