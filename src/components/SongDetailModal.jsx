import { useState, useEffect, useRef } from 'react'
import { fmt, TimeField, SetMarkerButton } from './ScrubberControls'

const MIN_CLIP_MS = 1000

export default function SongDetailModal({ track, player, onUpdateTimes, onClose, moveOrCopySong, sets, activeId, onToast, isLiveShuffling, onStopLiveShuffle }) {
  const { position, duration, seek, playTrack, pause, currentTrack, isPaused } = player

  const isActive = currentTrack?.uri === track.uri
  const isPlaying = isActive && !isPaused

  const displayDuration = isActive && duration > 0 ? duration : (track.duration_ms || 0)
  const [localPos, setLocalPos] = useState(track.startMs ?? 0)
  const [dragMs, setDragMs]         = useState(null)
  const draggingRef                 = useRef(false)
  const [moveCopyOpen, setMoveCopyOpen] = useState(false)
  const [selectedMode, setSelectedMode] = useState('move')
  const [confirmMsg, setConfirmMsg]     = useState(null)
  const otherSets = Object.entries(sets?.items ?? {}).filter(([id]) => id !== activeId)
  const displayPosition = draggingRef.current || dragMs !== null
    ? dragMs
    : (isActive ? position : localPos)

  const [startMs, setStartMs] = useState(track.startMs ?? 0)
  const [stopMs, setStopMs]   = useState(track.stopMs  ?? track.duration_ms ?? 0)

  // Keep refs so handleClose always has current values even inside closures
  const startMsRef     = useRef(startMs)
  const stopMsRef      = useRef(stopMs)
  const handleCloseRef = useRef(null)  // always points to latest handleClose
  useEffect(() => { startMsRef.current = startMs }, [startMs])
  useEffect(() => { stopMsRef.current  = stopMs  }, [stopMs])

  const img     = track.album?.images?.[0]
  const artists = track.artists?.map(a => a.name).join(', ')

  const pct    = displayDuration > 0 ? (displayPosition / displayDuration) * 100 : 0
  const inPct  = displayDuration > 0 ? (startMs          / displayDuration) * 100 : 0
  const outPct = displayDuration > 0 ? (stopMs           / displayDuration) * 100 : 0

  // Preview: plays from In to Out, does NOT auto-advance to next song.
  // The modal shares the single Spotify player/connection with live shuffle
  // playback, so previewing ANY song — including the one currently live —
  // would otherwise silently hijack it (no fade, and Jukebox's isPlaying/
  // playingId/Live-overlay state would go stale since it never learns
  // playback moved on). Always stop the live session cleanly first so state
  // stays consistent; this is also true when isActive, since the modal's own
  // transport can't tell "still live" apart from "live but paused via us".
  const handlePlay = async () => {
    // Wait for the live fade-out to finish before starting the preview —
    // starting immediately would bump the player generation and cut the
    // fade short (onStopLiveShuffle returns fadeAndPause's promise).
    if (isLiveShuffling) await onStopLiveShuffle?.()
    playTrack(track.uri, startMs, stopMs, true)
  }
  // Route through onStopLiveShuffle (Jukebox.handleStop) when this song is
  // the live one — a bare player.pause() bypasses Jukebox's isPlaying/
  // showLive/playingId state, leaving the main UI stuck showing "playing"
  // with no song actually advancing.
  const handleStop = () => (isActive && isLiveShuffling) ? onStopLiveShuffle?.() : pause()

  // Set In/Out: capture current scrubber position AND immediately save to library.
  // Clamped against the other bound (with a minimum gap) so a saved clip can
  // never have startMs >= stopMs — that combination silently disables the
  // stop-point trigger during live playback (the song just plays through untrimmed).
  const handleSetIn = () => {
    const ms = Math.min(displayPosition, Math.max(0, stopMsRef.current - MIN_CLIP_MS))
    setStartMs(ms)
    startMsRef.current = ms
    onUpdateTimes(track.id, ms, stopMsRef.current)
  }
  const handleSetOut = () => {
    const ms = Math.max(displayPosition, Math.min(displayDuration, startMsRef.current + MIN_CLIP_MS))
    setStopMs(ms)
    stopMsRef.current = ms
    onUpdateTimes(track.id, startMsRef.current, ms)
  }

  const handleMoveOrCopy = (destSetId, destSetName) => {
    moveOrCopySong(track.id, destSetId, selectedMode)
    const msg = `${selectedMode === 'move' ? 'Moved' : 'Copied'} to ${destSetName}`
    setConfirmMsg(msg)
    onToast?.(msg)
    if (selectedMode === 'move') {
      setTimeout(() => { setMoveCopyOpen(false); handleCloseRef.current() }, 900)
    } else {
      setTimeout(() => { setMoveCopyOpen(false); setConfirmMsg(null) }, 900)
    }
  }

  // Reset: clear clip and immediately save
  const handleReset = () => {
    const dur = track.duration_ms ?? 0
    setStartMs(0)
    setStopMs(dur)
    setLocalPos(0)
    startMsRef.current = 0
    stopMsRef.current  = dur
    onUpdateTimes(track.id, 0, dur)
  }

  // Close: always save current times (catches TimeField edits), then stop preview if active
  const handleClose = () => {
    onUpdateTimes(track.id, startMsRef.current, stopMsRef.current)
    if (isPlaying) pause()
    onClose()
  }
  handleCloseRef.current = handleClose  // keep ref fresh so Escape handler always calls latest

  useEffect(() => {
    const h = (e) => {
      if (e.repeat) return
      if (e.key === 'Escape') handleCloseRef.current()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])  // stable: h always calls handleCloseRef.current which is always current

  return (
    <div
      className="fixed inset-0 z-40 flex items-end sm:items-center justify-center p-0 sm:p-6 bg-black/75 backdrop-blur-sm animate-fade-in"
      onClick={handleClose}
    >
      <div
        className="bg-surface-raised border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-md shadow-2xl animate-fade-up overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Album art strip */}
        <div className="relative h-48 bg-black overflow-hidden">
          {img && (
            <img
              src={img.url}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-30"
              style={{ filter: 'blur(24px) saturate(1.4)', transform: 'scale(1.1)' }}
            />
          )}
          {img && (
            <img
              src={img.url}
              alt=""
              className="relative mx-auto h-full object-contain drop-shadow-2xl"
            />
          )}
          <button
            onClick={handleClose}
            className="absolute top-3 right-3 w-7 h-7 rounded-full bg-black/60 text-white hover:text-white flex items-center justify-center transition-[transform,color] duration-150 active:scale-[0.97] cursor-pointer"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        <div className="p-5">
          {/* Track info */}
          <div className="mb-4 text-center">
            <p className="text-base font-semibold text-white leading-tight truncate">{track.name}</p>
            <p className="text-xs text-white mt-1 truncate">{artists}</p>
          </div>

          {/* Scrubber with green clip range */}
          <div className="mb-1.5 relative">
            <div
              className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[3px] rounded-full pointer-events-none"
              style={{
                background: `linear-gradient(to right,
                  rgba(255,255,255,0.07) 0%,
                  rgba(255,255,255,0.07) ${inPct}%,
                  var(--color-accent) ${inPct}%,
                  var(--color-accent) ${outPct}%,
                  rgba(255,255,255,0.07) ${outPct}%,
                  rgba(255,255,255,0.07) 100%)`,
              }}
            />
            <input
              type="range"
              className="player-scrubber w-full relative"
              min={0}
              max={displayDuration || 1}
              value={displayPosition}
              style={{ '--progress': `${pct}%` }}
              onPointerDown={() => {
                draggingRef.current = true
                setDragMs(isActive ? position : localPos)
              }}
              onChange={e => {
                if (draggingRef.current) setDragMs(Number(e.target.value))
              }}
              onPointerUp={e => {
                const final = Number(e.target.value)
                if (isActive) seek(final)
                else setLocalPos(final)
                draggingRef.current = false
                setDragMs(null)
              }}
            />
          </div>
          <div className="flex justify-between mb-4">
            <span className="text-[10px] text-ink-muted tabular-nums">{fmt(displayPosition)}</span>
            <span className="text-[10px] text-ink-muted tabular-nums">{fmt(displayDuration)}</span>
          </div>

          {/* Set In / Play / Set Out */}
          <div className="grid grid-cols-3 gap-2 mb-4">
            <SetMarkerButton label="Set In"  position={displayPosition} savedMs={startMs} onClick={handleSetIn}  />

            <button
              onClick={isPlaying ? handleStop : handlePlay}
              style={{ transition: 'transform 160ms cubic-bezier(0.23,1,0.32,1)' }}
              className={`py-3 rounded-xl font-semibold text-sm cursor-pointer active:scale-[0.97] ${
                isPlaying
                  ? 'bg-white/10 text-white'
                  : 'bg-white text-black hover:bg-white/90'
              }`}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>

            <SetMarkerButton label="Set Out" position={displayPosition} savedMs={stopMs}  onClick={handleSetOut} />
          </div>

          {/* Typed In/Out fields + reset */}
          <div className="flex items-center justify-between px-1 mb-5">
            <TimeField label="In"  value={startMs} maxMs={Math.max(0, stopMs - MIN_CLIP_MS)} onChange={v => { setStartMs(v); startMsRef.current = v; onUpdateTimes(track.id, v, stopMsRef.current) }} />
            <div className="flex flex-col items-center gap-1">
              <div className="w-24 h-[1px] bg-accent/20" />
              <button
                onClick={handleReset}
                className="text-[10px] text-white hover:text-white cursor-pointer transition-colors duration-150"
              >
                ↺ reset
              </button>
            </div>
            <TimeField label="Out" value={stopMs}  minMs={Math.min(displayDuration, startMs + MIN_CLIP_MS)} maxMs={displayDuration} onChange={v => { setStopMs(v);  stopMsRef.current  = v; onUpdateTimes(track.id, startMsRef.current, v) }} />
          </div>

          {/* Move / Copy to another library */}
          <button
            onClick={() => { setMoveCopyOpen(v => !v); setConfirmMsg(null) }}
            style={{ transition: 'transform 160ms cubic-bezier(0.23,1,0.32,1)' }}
            className="w-full py-2.5 mb-3 bg-white/[0.05] hover:bg-white/[0.09] text-white text-xs font-semibold rounded-xl cursor-pointer active:scale-[0.97]"
          >
            {moveCopyOpen ? 'Cancel' : 'Move / Copy to library…'}
          </button>

          {moveCopyOpen && (
            <div className="mb-3 rounded-xl bg-white/[0.04] border border-white/[0.07] overflow-hidden">
              <div className="flex border-b border-white/[0.07]">
                {['move', 'copy'].map(m => (
                  <button
                    key={m}
                    onClick={() => setSelectedMode(m)}
                    className={`flex-1 py-2 text-xs font-semibold transition-colors duration-150 cursor-pointer ${
                      selectedMode === m ? 'bg-accent/15 text-accent' : 'text-white hover:bg-white/[0.05]'
                    }`}
                  >
                    {m === 'move' ? 'Move' : 'Copy'}
                  </button>
                ))}
              </div>
              {confirmMsg ? (
                <p className="text-xs text-accent text-center py-4 font-medium">{confirmMsg}</p>
              ) : otherSets.length === 0 ? (
                <p className="text-xs text-white text-center py-4">No other libraries — create one first</p>
              ) : (
                <div>
                  {otherSets.map(([id, set]) => (
                    <button
                      key={id}
                      onClick={() => handleMoveOrCopy(id, set.name)}
                      className="w-full text-left px-4 py-2.5 text-xs font-medium text-white hover:bg-white/[0.06] transition-colors duration-150 cursor-pointer border-b border-white/[0.04] last:border-0"
                    >
                      {set.name}
                      <span className="ml-2 text-[11px] text-ink-muted">{set.songs?.length ?? 0} songs</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <button
            onClick={handleClose}
            style={{ transition: 'transform 160ms cubic-bezier(0.23,1,0.32,1)' }}
            className="w-full py-3 bg-accent text-black text-sm font-bold rounded-xl hover:bg-accent-hover active:scale-[0.97] cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
