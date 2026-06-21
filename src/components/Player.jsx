function fmt(ms) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function Player({ player }) {
  const { isPaused, currentTrack, position, duration, togglePlay, seek, skipNext, skipPrev } = player

  if (!currentTrack) return null

  const art = currentTrack.album?.images?.[1] ?? currentTrack.album?.images?.[0]

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-[#111]/95 backdrop-blur-xl border-t border-white/[0.06] z-20">
      {/* Scrubber */}
      <div className="px-4 pt-3 pb-1">
        <div className="flex items-center gap-2.5">
          <span className="text-[10px] text-white/25 tabular-nums w-7 text-right">{fmt(position)}</span>
          <input
            type="range"
            className="player-scrubber flex-1"
            min={0}
            max={duration || 1}
            value={position}
            style={{ '--progress': `${progress}%` }}
            onChange={e => seek(Number(e.target.value))}
          />
          <span className="text-[10px] text-white/25 tabular-nums w-7">{fmt(duration)}</span>
        </div>
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-4 px-5 pb-5 pt-1">
        {/* Track info */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {art && (
            <img src={art.url} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white truncate leading-tight">{currentTrack.name}</p>
            <p className="text-xs text-white/40 truncate mt-0.5">
              {currentTrack.artists?.map(a => a.name).join(', ')}
            </p>
          </div>
        </div>

        {/* Buttons */}
        <div className="flex items-center gap-5 flex-shrink-0">
          <button
            onClick={skipPrev}
            className="text-white/35 hover:text-white transition-colors duration-150 cursor-pointer active:scale-[0.92]"
            aria-label="Previous"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>
            </svg>
          </button>

          <button
            onClick={togglePlay}
            className="w-11 h-11 rounded-full bg-white flex items-center justify-center hover:scale-[1.04] active:scale-[0.95] transition-transform duration-150 cursor-pointer flex-shrink-0"
            aria-label={isPaused ? 'Play' : 'Pause'}
          >
            {isPaused
              ? <svg width="17" height="17" viewBox="0 0 24 24" fill="#0a0a0a" style={{ marginLeft: 2 }}><path d="M8 5v14l11-7z"/></svg>
              : <svg width="17" height="17" viewBox="0 0 24 24" fill="#0a0a0a"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            }
          </button>

          <button
            onClick={skipNext}
            className="text-white/35 hover:text-white transition-colors duration-150 cursor-pointer active:scale-[0.92]"
            aria-label="Next"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 18l8.5-6L6 6v12zm2.5-8.14 5.5 3.89-5.5 3.89V9.86zM16 6h2v12h-2z"/>
            </svg>
          </button>
        </div>

        <div className="flex-1" />
      </div>
    </div>
  )
}
