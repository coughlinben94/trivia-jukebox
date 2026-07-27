import { useState, useEffect } from 'react'
import LiveScreen from './LiveScreen'
import TuningBoard from './TuningBoard'
import { TUNING_EVENT, ENGINE_KEY } from '../lib/gradientTuning.js'

// Mirrors LiveScreen.getMeshGradientFlag() exactly — the ?gradient= URL param
// beats localStorage there, so the board has to report the same winner or the
// switch would show a state the renderer isn't in.
function readEngine() {
  if (typeof window === 'undefined') return { engine: 'mesh', locked: false }
  const q = new URLSearchParams(window.location.search).get('gradient')
  if (q === 'circles' || q === 'circle') return { engine: 'circles', locked: true }
  if (q === 'mesh') return { engine: 'mesh', locked: true }
  const stored = localStorage.getItem(ENGINE_KEY)
  return { engine: (stored === 'circles' || stored === 'circle') ? 'circles' : 'mesh', locked: false }
}

// The tuning screen. Deliberately a SECOND, separate mount of the real
// LiveScreen — not a preview, not a static picker.
//
// Why the real thing: the whole point is judging the gradient against what
// actually happens during a show — the entrance blend, the song-to-song
// crossfade, the blob drift behind a spinning record. A still preview of one
// album's palette tells you nothing about any of that. So the TUNE button in
// Jukebox.jsx calls the same startShuffle() the Space bar calls, real audio
// plays, and this screen mounts the real LiveScreen with the board bolted on.
//
// Why it's still separate from the Live flow: Jukebox.jsx routes the "track
// confirmed" moment to showTest instead of showLive while this is open, so
// `showLive` never flips true and the real Live path — Space bar, the Live
// header toggle, the `b` handoff — is untouched. Closing stops playback and
// hands everything back exactly as handleStop() would from the library view.
export default function TestScreen({ currentTrack, isPaused, shuffleKey, onUpcomingTrack, onClose }) {
  const [{ engine, locked }, setEngineState] = useState(readEngine)
  // Bumped to remount LiveScreen. Necessary — not belt-and-braces:
  //  · the engine flag is read once per LiveScreen mount (getMeshGradientFlag)
  //  · MOTION and SIZE are baked into useMemo(makeCircleParams, []) inside both
  //    renderers, so a re-render alone would keep the old blob speed/size
  //  · VARIETY changes the /api/palette query string, and usePalette only
  //    refetches when its effect re-runs
  // BRIGHTNESS/BLEND/CROSSFADE are read per draw frame and per blend tick, so
  // they deliberately do NOT remount — they apply mid-drag, no snap.
  const [liveKey, setLiveKey] = useState(0)

  useEffect(() => {
    const onTuningChange = (e) => {
      const d = e.detail ?? {}
      if (d.id === '__engine' || d.id === '__all') setEngineState(readEngine())
      // committed only: 'release' dials fire uncommitted events on every drag
      // pixel, and remounting the turntable 60x/second would be unusable.
      if (d.committed && (d.remount || d.server)) setLiveKey(k => k + 1)
    }
    window.addEventListener(TUNING_EVENT, onTuningChange)
    return () => window.removeEventListener(TUNING_EVENT, onTuningChange)
  }, [])

  return (
    <>
      {/* Real LiveScreen — same props the real {showLive && ...} block passes,
          minus `ending`: this screen has no fly-out exit sequence, it just
          closes (and Jukebox's handleStop leaves liveEnding alone because
          showLive was never true). LiveScreen's own ✕ and Escape both call
          onClose, so there's no second close affordance to build here. */}
      <LiveScreen
        key={liveKey}
        currentTrack={currentTrack}
        isPaused={isPaused}
        ending={false}
        onClose={onClose}
        shuffleKey={shuffleKey}
        onUpcomingTrack={onUpcomingTrack}
      />

      <div className="fixed top-6 left-6 z-[60] pointer-events-none">
        <span className="text-[10px] font-semibold tracking-[0.15em] text-white/50">
          TEST SCREEN — GRADIENT TUNING
        </span>
      </div>

      <TuningBoard engine={engine} engineLocked={locked} />
    </>
  )
}
