import { useState, useEffect, useRef, useCallback } from 'react'
import { searchTracks, logout } from '../lib/spotify'

export default function Jukebox({ onLogout }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [queue, setQueue] = useState(() => {
    try { return JSON.parse(localStorage.getItem('trivia_queue') ?? '[]') }
    catch { return [] }
  })
  const [searching, setSearching] = useState(false)
  const [resultsKey, setResultsKey] = useState(0)
  const debounceRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    localStorage.setItem('trivia_queue', JSON.stringify(queue))
  }, [queue])

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

  const addToQueue = (track) => {
    if (queue.some(t => t.id === track.id)) return
    setQueue(prev => [...prev, track])
  }

  const removeFromQueue = (id) => {
    setQueue(prev => prev.filter(t => t.id !== id))
  }

  const clearAll = () => setQueue([])

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <header className="sticky top-0 z-10 border-b border-white/[0.05] bg-[#0a0a0a]/90 backdrop-blur-md px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="text-xl leading-none">🎵</span>
          <span className="text-base font-semibold tracking-tight text-white">Trivia Jukebox</span>
        </div>
        <button
          onClick={() => { logout(); onLogout() }}
          className="text-xs text-white/30 hover:text-white/60 transition-colors duration-150 cursor-pointer"
        >
          Disconnect
        </button>
      </header>

      <main className="max-w-xl mx-auto px-5 py-10 space-y-8">
        {/* Search */}
        <div>
          <div className="relative">
            <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/30">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM14 14l-3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <input
              ref={inputRef}
              type="text"
              placeholder="Search for a song…"
              value={query}
              onChange={e => { setQuery(e.target.value); search(e.target.value) }}
              className="w-full bg-white/[0.05] border border-white/[0.07] rounded-2xl pl-11 pr-5 py-4 text-white placeholder-white/25 outline-none focus:border-[#1DB954]/40 focus:bg-white/[0.07] transition-all duration-200 text-sm"
            />
            {searching && (
              <div className="absolute right-4 top-1/2 -translate-y-1/2">
                <div className="w-4 h-4 border-[1.5px] border-white/10 border-t-[#1DB954] rounded-full animate-spin" />
              </div>
            )}
          </div>

          {results.length > 0 && (
            <div
              key={resultsKey}
              className="mt-2 bg-[#111] border border-white/[0.07] rounded-2xl overflow-hidden"
            >
              {results.map((track, i) => (
                <SearchResult
                  key={track.id}
                  track={track}
                  index={i}
                  inQueue={queue.some(t => t.id === track.id)}
                  onAdd={addToQueue}
                />
              ))}
            </div>
          )}
        </div>

        {/* Queue */}
        {queue.length > 0 && (
          <div className="animate-fade-up">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-semibold text-white/35 uppercase tracking-widest">
                Queue · {queue.length}
              </span>
              <button
                onClick={clearAll}
                className="text-[11px] text-white/25 hover:text-red-400/80 transition-colors duration-150 cursor-pointer"
              >
                Clear all
              </button>
            </div>
            <div className="space-y-1">
              {queue.map((track, i) => (
                <QueueItem
                  key={track.id}
                  track={track}
                  index={i}
                  onRemove={removeFromQueue}
                />
              ))}
            </div>
          </div>
        )}

        {queue.length === 0 && !query && (
          <div className="text-center py-16 text-white/[0.15] text-sm select-none">
            Search for songs to build your trivia queue
          </div>
        )}
      </main>
    </div>
  )
}

function SearchResult({ track, index, inQueue, onAdd }) {
  const img = track.album?.images?.[2] ?? track.album?.images?.[0]
  const artists = track.artists?.map(a => a.name).join(', ')

  return (
    <div
      className="animate-fade-up flex items-center gap-3 px-4 py-3 border-b border-white/[0.04] last:border-0 @media(hover:hover){hover:bg-white/[0.04]} transition-colors duration-150"
      style={{ animationDelay: `${index * 35}ms` }}
    >
      {img
        ? <img src={img.url} alt="" width={40} height={40} className="rounded-lg object-cover flex-shrink-0 w-10 h-10" />
        : <div className="w-10 h-10 rounded-lg bg-white/[0.06] flex-shrink-0" />
      }
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white leading-tight truncate">{track.name}</p>
        <p className="text-xs text-white/35 truncate mt-0.5">{artists} · {track.album?.name}</p>
      </div>
      <button
        onClick={() => onAdd(track)}
        disabled={inQueue}
        className={`flex-shrink-0 text-[11px] font-semibold px-3 py-1.5 rounded-full transition-all duration-150 cursor-pointer active:scale-[0.97] ${
          inQueue
            ? 'text-[#1DB954]/50 bg-[#1DB954]/[0.08] cursor-default'
            : 'text-[#1DB954] bg-[#1DB954]/[0.1] hover:bg-[#1DB954]/[0.18]'
        }`}
      >
        {inQueue ? '✓' : '+'}
      </button>
    </div>
  )
}

function QueueItem({ track, index, onRemove }) {
  const img = track.album?.images?.[2] ?? track.album?.images?.[0]
  const artists = track.artists?.map(a => a.name).join(', ')

  return (
    <div
      className="animate-slide-in flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.03] hover:bg-white/[0.05] transition-all duration-150 group"
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <span className="text-[11px] font-mono text-white/20 w-4 text-right flex-shrink-0 tabular-nums">
        {index + 1}
      </span>
      {img
        ? <img src={img.url} alt="" width={36} height={36} className="rounded-md object-cover flex-shrink-0 w-9 h-9" />
        : <div className="w-9 h-9 rounded-md bg-white/[0.06] flex-shrink-0" />
      }
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white leading-tight truncate">{track.name}</p>
        <p className="text-xs text-white/35 truncate mt-0.5">{artists}</p>
      </div>
      <button
        onClick={() => onRemove(track.id)}
        className="opacity-0 group-hover:opacity-100 text-white/25 hover:text-red-400/70 text-xs transition-all duration-150 cursor-pointer active:scale-[0.97] flex-shrink-0"
      >
        Remove
      </button>
    </div>
  )
}
