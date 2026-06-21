import { useState, useEffect, useRef, useCallback } from 'react'
import { searchTracks, logout } from '../lib/spotify'
import { useSpotifyPlayer } from '../hooks/useSpotifyPlayer'
import Player from './Player'
import LiveScreen from './LiveScreen'

// ─── Time helpers ─────────────────────────────────────────────────
function msToTime(ms) {
  if (!ms && ms !== 0) return ''
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function timeToMs(str) {
  const parts = str.trim().split(':')
  if (parts.length === 2) {
    const m = parseInt(parts[0], 10)
    const s = parseInt(parts[1], 10)
    if (!isNaN(m) && !isNaN(s)) return (m * 60 + s) * 1000
  }
  return null
}

function shuffleArray(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ─── Main component ───────────────────────────────────────────────
export default function Jukebox({ onLogout }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [library, setLibrary] = useState(() => {
    try { return JSON.parse(localStorage.getItem('trivia_library') ?? '[]') }
    catch { return [] }
  })
  const [searching, setSearching] = useState(false)
  const [resultsKey, setResultsKey] = useState(0)
  const [playingId, setPlayingId] = useState(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [showLive, setShowLive] = useState(false)

  const shuffleOrderRef = useRef([])
  const shuffleIdxRef = useRef(0)
  const debounceRef = useRef(null)

  const advanceToNext = useCallback(() => {
    const order = shuffleOrderRef.current
    let idx = shuffleIdxRef.current + 1
    if (idx >= order.length) {
      // Reshuffle and loop
      const newOrder = shuffleArray(library.map((_, i) => i))
      shuffleOrderRef.current = newOrder
      idx = 0
    }
    shuffleIdxRef.current = idx
    const song = library[shuffleOrderRef.current[idx]]
    if (song) {
      setPlayingId(song.id)
      playTrackFn.current(song)
    }
  }, [library])

  const player = useSpotifyPlayer({ onAdvance: advanceToNext })

  // Keep a stable ref to playTrack for use inside callbacks
  const playTrackFn = useRef(null)
  useEffect(() => {
    playTrackFn.current = (song) => {
      player.playTrack(song.uri, song.startMs ?? 0, song.stopMs ?? song.duration_ms)
    }
  }, [player.playTrack])

  useEffect(() => {
    localStorage.setItem('trivia_library', JSON.stringify(library))
  }, [library])

  // Sync playing indicator with SDK state
  useEffect(() => {
    if (player.currentTrack) {
      const uri = player.currentTrack.uri
      const match = library.find(t => t.uri === uri)
      if (match) setPlayingId(match.id)
    }
  }, [player.currentTrack, library])

  const search = useCallback((q) => {
    clearTimeout(debounceRef.current)
    if (!q.trim()) { setResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const tracks = await searchTracks(q)
        setResults(tracks)
        setResultsKey(k => k + 1)
      } finally {
        setSearching(false)
      }
    }, 280)
  }, [])

  const addToLibrary = (track) => {
    if (library.some(t => t.id === track.id)) return
    setLibrary(prev => [...prev, {
      ...track,
      startMs: 0,
      stopMs: track.duration_ms,
    }])
  }

  const removeFromLibrary = (id) => {
    setLibrary(prev => prev.filter(t => t.id !== id))
    if (playingId === id) {
      player.fadeAndPause()
      setPlayingId(null)
      setIsPlaying(false)
    }
  }

  const updateTimes = (id, startMs, stopMs) => {
    setLibrary(prev => prev.map(t => t.id === id ? { ...t, startMs, stopMs } : t))
  }

  const startShuffle = useCallback(() => {
    if (library.length === 0) return
    const order = shuffleArray(library.map((_, i) => i))
    shuffleOrderRef.current = order
    shuffleIdxRef.current = 0
    const song = library[order[0]]
    setPlayingId(song.id)
    setIsPlaying(true)
    setShowLive(true)
    playTrackFn.current(song)
  }, [library])

  const handleStop = useCallback(async () => {
    await player.fadeAndPause()
    setIsPlaying(false)
    setPlayingId(null)
    setShowLive(false)
  }, [player.fadeAndPause])

  const handleSkip = useCallback(() => {
    advanceToNext()
  }, [advanceToNext])

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <header className="sticky top-0 z-10 border-b border-white/[0.05] bg-[#0a0a0a]/90 backdrop-blur-md px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="text-xl leading-none">🎵</span>
          <span className="text-base font-semibold tracking-tight">Trivia Jukebox</span>
        </div>
        <div className="flex items-center gap-4">
          {player.error && <span className="text-xs text-red-400/80">{player.error}</span>}
          {!player.isReady && !player.error && (
            <span className="text-xs text-white/25">Connecting…</span>
          )}
          {isPlaying && (
            <button
              onClick={() => setShowLive(v => !v)}
              className={`text-xs font-medium transition-colors duration-150 cursor-pointer px-2.5 py-1 rounded-full ${
                showLive
                  ? 'text-black bg-white'
                  : 'text-white/50 hover:text-white border border-white/[0.12] hover:border-white/30'
              }`}
            >
              Live
            </button>
          )}
          <button
            onClick={() => { logout(); onLogout() }}
            className="text-xs text-white/30 hover:text-white/60 transition-colors duration-150 cursor-pointer"
          >
            Disconnect
          </button>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-5 py-10 space-y-8 pb-40">
        {/* Search */}
        <div>
          <div className="relative">
            <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/30">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM14 14l-3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <input
              type="text"
              placeholder="Search for a song…"
              value={query}
              onChange={e => { setQuery(e.target.value); search(e.target.value) }}
              className="w-full bg-white/[0.05] border border-white/[0.07] rounded-2xl pl-10 pr-5 py-4 text-white placeholder-white/25 outline-none focus:border-[#1DB954]/40 focus:bg-white/[0.07] transition-all duration-200 text-sm"
            />
            {searching && (
              <div className="absolute right-4 top-1/2 -translate-y-1/2">
                <div className="w-4 h-4 border-[1.5px] border-white/10 border-t-[#1DB954] rounded-full animate-spin" />
              </div>
            )}
          </div>

          {results.length > 0 && (
            <div key={resultsKey} className="mt-2 bg-[#111] border border-white/[0.07] rounded-2xl overflow-hidden">
              {results.map((track, i) => (
                <SearchResult
                  key={track.id}
                  track={track}
                  index={i}
                  inLibrary={library.some(t => t.id === track.id)}
                  onAdd={addToLibrary}
                />
              ))}
            </div>
          )}
        </div>

        {/* Library */}
        {library.length > 0 && (
          <div className="animate-fade-up">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-semibold text-white/35 uppercase tracking-widest">
                Library · {library.length}
              </span>
              <button
                onClick={() => { setLibrary([]); handleStop() }}
                className="text-[11px] text-white/25 hover:text-red-400/80 transition-colors duration-150 cursor-pointer"
              >
                Clear all
              </button>
            </div>
            <div className="space-y-1">
              {library.map((track, i) => (
                <LibraryItem
                  key={track.id}
                  track={track}
                  index={i}
                  isPlaying={track.id === playingId && !player.isPaused}
                  onRemove={() => removeFromLibrary(track.id)}
                  onUpdateTimes={(start, stop) => updateTimes(track.id, start, stop)}
                />
              ))}
            </div>
          </div>
        )}

        {library.length === 0 && !query && (
          <div className="text-center py-16 text-white/[0.15] text-sm select-none">
            Add songs to your library, then hit shuffle to play
          </div>
        )}
      </main>

      {showLive && (
        <LiveScreen
          currentTrack={player.currentTrack}
          isPaused={player.isPaused}
          onClose={() => setShowLive(false)}
        />
      )}

      <Player
        player={player}
        isPlaying={isPlaying && !player.isPaused}
        onPlay={startShuffle}
        onStop={handleStop}
        onSkip={handleSkip}
        library={library}
      />
    </div>
  )
}

// ─── Search Result ────────────────────────────────────────────────
function SearchResult({ track, index, inLibrary, onAdd }) {
  const img = track.album?.images?.[2] ?? track.album?.images?.[0]
  const artists = track.artists?.map(a => a.name).join(', ')

  return (
    <div
      className="animate-fade-up flex items-center gap-3 px-4 py-3 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.04] transition-colors duration-150"
      style={{ animationDelay: `${index * 35}ms` }}
    >
      {img
        ? <img src={img.url} alt="" className="w-10 h-10 rounded-lg object-cover flex-shrink-0" />
        : <div className="w-10 h-10 rounded-lg bg-white/[0.06] flex-shrink-0" />
      }
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white truncate leading-tight">{track.name}</p>
        <p className="text-xs text-white/35 truncate mt-0.5">{artists} · {track.album?.name}</p>
      </div>
      <button
        onClick={() => onAdd(track)}
        disabled={inLibrary}
        className={`flex-shrink-0 text-[11px] font-semibold px-3 py-1.5 rounded-full transition-all duration-150 cursor-pointer active:scale-[0.97] ${
          inLibrary
            ? 'text-[#1DB954]/50 bg-[#1DB954]/[0.08] cursor-default'
            : 'text-[#1DB954] bg-[#1DB954]/[0.1] hover:bg-[#1DB954]/[0.18]'
        }`}
      >
        {inLibrary ? '✓' : '+'}
      </button>
    </div>
  )
}

// ─── Library Item ─────────────────────────────────────────────────
function LibraryItem({ track, index, isPlaying, onRemove, onUpdateTimes }) {
  const img = track.album?.images?.[2] ?? track.album?.images?.[0]
  const artists = track.artists?.map(a => a.name).join(', ')

  return (
    <div
      className={`animate-slide-in flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-150 group ${
        isPlaying ? 'bg-[#1DB954]/[0.08]' : 'bg-white/[0.03] hover:bg-white/[0.05]'
      }`}
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <div className="w-5 flex-shrink-0 flex items-center justify-center">
        {isPlaying
          ? <span className="w-2 h-2 rounded-full bg-[#1DB954]" />
          : <span className="text-[11px] font-mono text-white/20 tabular-nums">{index + 1}</span>
        }
      </div>

      {img
        ? <img src={img.url} alt="" className="w-9 h-9 rounded-md object-cover flex-shrink-0" />
        : <div className="w-9 h-9 rounded-md bg-white/[0.06] flex-shrink-0" />
      }

      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium truncate leading-tight ${isPlaying ? 'text-[#1DB954]' : 'text-white'}`}>
          {track.name}
        </p>
        <p className="text-xs text-white/35 truncate mt-0.5">{artists}</p>
      </div>

      {/* Time range editor */}
      <div className="flex items-center gap-1 flex-shrink-0 text-[11px] text-white/30">
        <TimeInput
          ms={track.startMs ?? 0}
          onChange={v => onUpdateTimes(v, track.stopMs ?? track.duration_ms)}
        />
        <span className="text-white/15">→</span>
        <TimeInput
          ms={track.stopMs ?? track.duration_ms}
          onChange={v => onUpdateTimes(track.startMs ?? 0, v)}
        />
      </div>

      <button
        onClick={onRemove}
        className="opacity-0 group-hover:opacity-100 text-white/25 hover:text-red-400/70 text-xs transition-all duration-150 cursor-pointer active:scale-[0.97] flex-shrink-0 pl-1"
      >
        ✕
      </button>
    </div>
  )
}

// ─── Inline time editor ───────────────────────────────────────────
function TimeInput({ ms, onChange }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(msToTime(ms))

  useEffect(() => {
    if (!editing) setVal(msToTime(ms))
  }, [ms, editing])

  const commit = () => {
    setEditing(false)
    const parsed = timeToMs(val)
    if (parsed !== null) onChange(parsed)
    else setVal(msToTime(ms))
  }

  if (editing) {
    return (
      <input
        className="w-12 bg-white/[0.08] border border-white/[0.15] rounded px-1 py-0.5 text-[11px] text-white outline-none text-center"
        value={val}
        onChange={e => setVal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => e.key === 'Enter' && commit()}
        autoFocus
      />
    )
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="hover:text-white/60 transition-colors duration-100 cursor-pointer tabular-nums font-mono"
    >
      {msToTime(ms)}
    </button>
  )
}
