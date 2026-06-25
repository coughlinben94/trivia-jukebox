import { useState, useEffect, useRef } from 'react'

function fmt(ms) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function parseMmSs(str) {
  const parts = str.split(':').map(Number)
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]))
    return (parts[0] * 60 + parts[1]) * 1000
  const sec = Number(str)
  return isNaN(sec) ? null : sec * 1000
}

function TimeField({ label, value, maxMs, onChange }) {
  const [editing, setEditing] = useState(false)
  const [raw, setRaw] = useState('')
  const ref = useRef(null)

  const start = () => {
    setRaw(fmt(value))
    setEditing(true)
    setTimeout(() => ref.current?.select(), 0)
  }
  const commit = () => {
    const ms = parseMmSs(raw)
    if (ms !== null) onChange(Math.max(0, Math.min(maxMs, ms)))
    setEditing(false)
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[9px] font-bold uppercase tracking-widest text-white">{label}</span>
      {editing ? (
        <input
          ref={ref}
          type="text"
          value={raw}
          onChange={e => setRaw(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false) }}
          className="w-16 text-center text-sm font-mono font-bold bg-white/[0.08] text-white rounded-lg px-2 py-1.5 outline-none border border-[#1DB954]/50"
        />
      ) : (
        <button
          onClick={start}
          className="text-sm font-mono font-bold text-[#1DB954] hover:text-white transition-colors duration-150 cursor-pointer px-2 py-1 rounded-lg hover:bg-white/[0.05]"
          title="Click to type a time"
        >
          {fmt(value)}
        </button>
      )}
    </div>
  )
}

function SetMarkerButton({ label, position, savedMs, onClick }) {
  const [wasJustSet, setWasJustSet] = useState(false)

  const handleClick = () => {
    onClick()
    setWasJustSet(true)
  }

  useEffect(() => {
    if (wasJustSet && Math.abs(position - savedMs) > 500) {
      setWasJustSet(false)
    }
  }, [position, savedMs, wasJustSet])

  const isConfirmed = wasJustSet || Math.abs(position - savedMs) < 500

  return (
    <button
      onClick={handleClick}
      style={{ transition: 'transform 160ms cubic-bezier(0.23,1,0.32,1), background 200ms cubic-bezier(0.23,1,0.32,1)' }}
      className={`py-3 rounded-xl flex flex-col items-center gap-0.5 cursor-pointer active:scale-[0.97]
        ${isConfirmed
          ? 'bg-[#1DB954]/15 ring-1 ring-[#1DB954]/25'
          : 'bg-white/[0.05] hover:bg-white/[0.09]'
        }`}
    >
      <span
        className="text-[10px] font-bold uppercase tracking-wider"
        style={{ transition: 'color 200ms cubic-bezier(0.23,1,0.32,1)' }}
      >
        {isConfirmed
          ? <span className="text-[#1DB954]">✓ {label}</span>
          : <span className="text-white">{label}</span>
        }
      </span>
      <span className="text-[10px] tabular-nums" style={{ transition: 'color 200ms', color: isConfirmed ? 'rgba(29,185,84,0.6)' : 'rgba(255,255,255,0.3)' }}>
        {fmt(savedMs)}
      </span>
    </button>
  )
}

export default function SongDetailModal({ track, player, onUpdateTimes, onClose }) {
  const { position, duration, seek, playTrack, fadeAndPause, currentTrack, isPaused } = player

  const isActive = currentTrack?.uri === track.uri
  const isPlaying = isActive && !isPaused

  const displayDuration = isActive && duration > 0 ? duration : (track.duration_ms || 0)
  const [localPos, setLocalPos] = useState(track.startMs ?? 0)
  const [dragMs, setDragMs]     = useState(null)
  const draggingRef             = useRef(false)
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

  // Preview: plays from In to Out, does NOT auto-advance to next song
  const handlePlay = () => playTrack(track.uri, startMs, stopMs, true)
  const handleStop = () => fadeAndPause()

  // Set In/Out: capture current scrubber position AND immediately save to library
  const handleSetIn = () => {
    const ms = displayPosition
    setStartMs(ms)
    startMsRef.current = ms
    onUpdateTimes(track.id, ms, stopMsRef.current)
  }
  const handleSetOut = () => {
    const ms = displayPosition
    setStopMs(ms)
    stopMsRef.current = ms
    onUpdateTimes(track.id, startMsRef.current, ms)
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
    if (isPlaying) fadeAndPause()
    onClose()
  }
  handleCloseRef.current = handleClose  // keep ref fresh so Escape handler always calls latest

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') handleCloseRef.current() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])  // stable: h always calls handleCloseRef.current which is always current

  return (
    <div
      className="fixed inset-0 z-40 flex items-end sm:items-center justify-center p-0 sm:p-6 bg-black/75 backdrop-blur-sm animate-fade-in"
      onClick={handleClose}
    >
      <div
        className="bg-[#303032] border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-md shadow-2xl animate-fade-up overflow-hidden"
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
                  #1DB954 ${inPct}%,
                  #1DB954 ${outPct}%,
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
            <span className="text-[10px] text-white tabular-nums">{fmt(displayPosition)}</span>
            <span className="text-[10px] text-white tabular-nums">{fmt(displayDuration)}</span>
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
            <TimeField label="In"  value={startMs} maxMs={stopMs}          onChange={v => { setStartMs(v); startMsRef.current = v }} />
            <div className="flex flex-col items-center gap-1">
              <div className="w-24 h-[1px] bg-[#1DB954]/20" />
              <button
                onClick={handleReset}
                className="text-[10px] text-white hover:text-white cursor-pointer transition-colors duration-150"
              >
                ↺ reset
              </button>
            </div>
            <TimeField label="Out" value={stopMs}  maxMs={displayDuration} onChange={v => { setStopMs(v);  stopMsRef.current  = v }} />
          </div>

          <button
            onClick={handleClose}
            style={{ transition: 'transform 160ms cubic-bezier(0.23,1,0.32,1)' }}
            className="w-full py-3 bg-[#1DB954] text-black text-sm font-bold rounded-xl hover:bg-[#1ed760] active:scale-[0.97] cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
