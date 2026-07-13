import { useRef, useState } from 'react'

function fmt(ms) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function Player({ player, isPlaying, onPlay, onStop, onSkip, library, runtime }) {
  const { currentTrack, position, duration, seek, volume, setVolume } = player
  // Only commit a seek on release, not per drag pixel — the native range input's
  // onChange fires continuously during a mouse drag, and firing an uncoalesced,
  // uncancelled seek() fetch per pixel let network reordering land playback at a
  // stale intermediate point. Track the drag locally and seek once on pointer up.
  const [dragMs, setDragMs] = useState(null)
  const draggingRef = useRef(false)

  if (library.length === 0) return null

  const art = currentTrack?.album?.images?.[1] ?? currentTrack?.album?.images?.[0]
  const displayPosition = dragMs !== null ? dragMs : position
  const progress = duration > 0 ? (displayPosition / duration) * 100 : 0
  const volPct = (volume ?? 0.8) * 100

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-surface/95 backdrop-blur-xl border-t border-white/[0.06] z-20">
      {/* Scrubber */}
      <div className="px-5 pt-3 pb-1">
        <div className="flex items-center gap-2.5">
          <span className="text-[10px] text-ink-muted tabular-nums w-7 text-right">{fmt(displayPosition)}</span>
          <input
            type="range"
            className="player-scrubber flex-1"
            min={0}
            max={duration || 1}
            value={displayPosition}
            style={{ '--progress': `${progress}%` }}
            onPointerDown={() => { draggingRef.current = true; setDragMs(position) }}
            onChange={e => { if (draggingRef.current) setDragMs(Number(e.target.value)) }}
            onPointerUp={e => {
              seek(Number(e.target.value))
              draggingRef.current = false
              setDragMs(null)
            }}
          />
          <span className="text-[10px] text-ink-muted tabular-nums w-7">{fmt(duration)}</span>
        </div>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 px-5 pb-6 pt-1.5">
        {/* Track info */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {art
            ? <img src={art.url} alt="" className="w-9 h-9 rounded-lg object-cover flex-shrink-0" />
            : <div className="w-9 h-9 rounded-lg bg-white/[0.06] flex-shrink-0" />
          }
          <div className="min-w-0">
            {currentTrack ? (
              <>
                <p className="text-sm font-semibold text-white truncate leading-tight">{currentTrack.name}</p>
                <p className="text-xs text-white truncate mt-0.5">
                  {currentTrack.artists?.map(a => a.name).join(', ')}
                </p>
              </>
            ) : (
              <p className="text-xs text-white">{library.length} songs ready · <span className="text-ink-muted">{runtime}</span> · shuffle play</p>
            )}
          </div>
        </div>

        {/* Center: skip + play */}
        <div className="flex items-center gap-4 flex-shrink-0">
          {isPlaying && (
            <button
              onClick={onSkip}
              className="text-white hover:text-white transition-transform duration-150 cursor-pointer active:scale-[0.97]"
              aria-label="Skip"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 18l8.5-6L6 6v12zm2.5-8.14 5.5 3.89-5.5 3.89V9.86zM16 6h2v12h-2z"/>
              </svg>
            </button>
          )}

          <button
            onClick={isPlaying ? onStop : onPlay}
            className="w-10 h-10 rounded-full bg-white flex items-center justify-center hover:scale-[1.05] active:scale-[0.95] transition-transform duration-150 cursor-pointer flex-shrink-0"
            aria-label={isPlaying ? 'Fade out' : 'Shuffle play'}
          >
            {isPlaying
              ? <svg width="14" height="14" viewBox="0 0 24 24" className="fill-base"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" className="fill-base">
                  <path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
                </svg>
            }
          </button>
        </div>

        {/* Right: volume */}
        <div className="flex-1 flex items-center justify-end gap-2">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" className="text-white flex-shrink-0">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
          </svg>
          <input
            type="range"
            className="player-scrubber w-20"
            min={0}
            max={100}
            value={volPct}
            style={{ '--progress': `${volPct}%` }}
            onChange={e => setVolume(Number(e.target.value) / 100)}
          />
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" className="text-white flex-shrink-0">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
          </svg>
        </div>
      </div>
    </div>
  )
}
