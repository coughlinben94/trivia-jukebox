import { useState, useEffect, useRef, useCallback } from 'react'
import { searchTracks, getPlaylists, getPlaylistTracks, logout } from '../lib/spotify'
import { useSpotifyPlayer } from '../hooks/useSpotifyPlayer'
import Player from './Player'
import LiveScreen from './LiveScreen'

function shuffleArray(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export default function Jukebox({ onLogout }) {
  const [tab, setTab] = useState('search') // 'search' | 'playlists'
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [playlists, setPlaylists] = useState([])
  const [openPlaylist, setOpenPlaylist] = useState(null)
  const [playlistTracks, setPlaylistTracks] = useState([])
  const [loadingPlaylist, setLoadingPlaylist] = useState(false)
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
  const playTrackFn = useRef(null)

  const advanceToNext = useCallback(() => {
    const order = shuffleOrderRef.current
    let idx = shuffleIdxRef.current + 1
    if (idx >= order.length) {
      const newOrder = shuffleArray(library.map((_, i) => i))
      shuffleOrderRef.current = newOrder
      idx = 0
    }
    shuffleIdxRef.current = idx
    const song = library[shuffleOrderRef.current[idx]]
    if (song) { setPlayingId(song.id); playTrackFn.current?.(song) }
  }, [library])

  const player = useSpotifyPlayer({ onAdvance: advanceToNext })

  useEffect(() => {
    playTrackFn.current = (song) =>
      player.playTrack(song.uri, song.startMs ?? 0, song.stopMs ?? song.duration_ms)
  }, [player.playTrack])

  useEffect(() => {
    localStorage.setItem('trivia_library', JSON.stringify(library))
  }, [library])

  useEffect(() => {
    if (player.currentTrack) {
      const match = library.find(t => t.uri === player.currentTrack.uri)
      if (match) setPlayingId(match.id)
    }
  }, [player.currentTrack?.uri])

  // Load playlists when tab opens
  useEffect(() => {
    if (tab === 'playlists' && playlists.length === 0) {
      getPlaylists().then(setPlaylists)
    }
  }, [tab])

  const openPlaylistFn = async (pl) => {
    setOpenPlaylist(pl)
    setLoadingPlaylist(true)
    try {
      const tracks = await getPlaylistTracks(pl.id)
      setPlaylistTracks(tracks)
    } finally { setLoadingPlaylist(false) }
  }

  const search = useCallback((q) => {
    clearTimeout(debounceRef.current)
    if (!q.trim()) { setResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const tracks = await searchTracks(q)
        setResults(tracks)
        setResultsKey(k => k + 1)
      } finally { setSearching(false) }
    }, 280)
  }, [])

  const addToLibrary = (track) => {
    if (!track || library.some(t => t.id === track.id)) return
    setLibrary(prev => [...prev, { ...track, startMs: 0, stopMs: track.duration_ms }])
  }

  const removeFromLibrary = (id) => {
    setLibrary(prev => prev.filter(t => t.id !== id))
    if (playingId === id) { player.fadeAndPause(); setPlayingId(null); setIsPlaying(false) }
  }

  const updateTimes = useCallback((id, startMs, stopMs) => {
    setLibrary(prev => prev.map(t => t.id === id ? { ...t, startMs, stopMs } : t))
  }, [])

  const startShuffle = useCallback(() => {
    if (library.length === 0) return
    const order = shuffleArray(library.map((_, i) => i))
    shuffleOrderRef.current = order
    shuffleIdxRef.current = 0
    const song = library[order[0]]
    setPlayingId(song.id)
    setIsPlaying(true)
    setShowLive(true)
    playTrackFn.current?.(song)
  }, [library])

  const handleStop = useCallback(async () => {
    await player.fadeAndPause()
    setIsPlaying(false)
    setPlayingId(null)
    setShowLive(false)
  }, [player.fadeAndPause])

  // Spacebar: play/pause (Stream Deck)
  useEffect(() => {
    const handler = (e) => {
      if (e.code !== 'Space') return
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return
      e.preventDefault()
      if (isPlaying) handleStop()
      else startShuffle()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isPlaying, handleStop, startShuffle])

  const inLibrary = (id) => library.some(t => t.id === id)

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-white/[0.05] bg-[#0a0a0a]/90 backdrop-blur-md px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="text-lg">🎵</span>
          <span className="text-sm font-semibold text-white/90 tracking-tight">Trivia Jukebox</span>
        </div>
        <div className="flex items-center gap-3">
          {player.error && <span className="text-xs text-red-400/70">{player.error}</span>}
          {!player.isReady && !player.error && (
            <span className="text-[11px] text-white/20">Connecting…</span>
          )}
          {isPlaying && (
            <button
              onClick={() => setShowLive(v => !v)}
              className={`text-xs font-medium transition-all duration-150 cursor-pointer px-3 py-1 rounded-full active:scale-[0.97] ${
                showLive ? 'bg-white text-black' : 'text-white/50 hover:text-white border border-white/10 hover:border-white/25'
              }`}
            >
              Live
            </button>
          )}
          <button
            onClick={() => { logout(); onLogout() }}
            className="text-[11px] text-white/25 hover:text-white/50 transition-colors duration-150 cursor-pointer"
          >
            Disconnect
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-8 pb-44 space-y-6">
        {/* Tabs */}
        <div className="flex gap-1 bg-white/[0.04] p-1 rounded-xl w-fit">
          {['search', 'playlists'].map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-lg text-xs font-medium capitalize transition-all duration-150 cursor-pointer ${
                tab === t ? 'bg-white text-black' : 'text-white/40 hover:text-white/70'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Search tab */}
        {tab === 'search' && (
          <div>
            <div className="relative">
              <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/25">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10ZM14 14l-3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </div>
              <input
                type="text"
                placeholder="Search for a song…"
                value={query}
                onChange={e => { setQuery(e.target.value); search(e.target.value) }}
                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-2xl pl-10 pr-5 py-3.5 text-white placeholder-white/20 outline-none focus:border-[#1DB954]/35 focus:bg-white/[0.06] transition-all duration-200 text-sm"
              />
              {searching && (
                <div className="absolute right-4 top-1/2 -translate-y-1/2">
                  <div className="w-3.5 h-3.5 border-[1.5px] border-white/10 border-t-[#1DB954] rounded-full animate-spin" />
                </div>
              )}
            </div>

            {results.length > 0 && (
              <div key={resultsKey} className="mt-1.5 bg-[#0f0f0f] border border-white/[0.06] rounded-2xl overflow-hidden shadow-xl">
                {results.map((track, i) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    index={i}
                    inLibrary={inLibrary(track.id)}
                    onAdd={addToLibrary}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Playlists tab */}
        {tab === 'playlists' && (
          <div>
            {openPlaylist ? (
              <div>
                <button
                  onClick={() => { setOpenPlaylist(null); setPlaylistTracks([]) }}
                  className="flex items-center gap-2 text-xs text-white/40 hover:text-white/70 transition-colors mb-4 cursor-pointer"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                  {openPlaylist.name}
                </button>
                {loadingPlaylist ? (
                  <div className="flex justify-center py-10">
                    <div className="w-4 h-4 border-[1.5px] border-white/10 border-t-[#1DB954] rounded-full animate-spin" />
                  </div>
                ) : (
                  <div className="bg-[#0f0f0f] border border-white/[0.06] rounded-2xl overflow-hidden">
                    {playlistTracks.map((track, i) => (
                      <TrackRow
                        key={track.id + i}
                        track={track}
                        index={i}
                        inLibrary={inLibrary(track.id)}
                        onAdd={addToLibrary}
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {playlists.length === 0 ? (
                  <div className="col-span-3 py-10 text-center">
                    <div className="w-4 h-4 border-[1.5px] border-white/10 border-t-[#1DB954] rounded-full animate-spin mx-auto" />
                  </div>
                ) : playlists.map((pl, i) => (
                  <button
                    key={pl.id}
                    onClick={() => openPlaylistFn(pl)}
                    className="animate-fade-up text-left group rounded-xl overflow-hidden bg-white/[0.03] hover:bg-white/[0.06] transition-all duration-150 cursor-pointer active:scale-[0.98]"
                    style={{ animationDelay: `${i * 25}ms` }}
                  >
                    <div className="aspect-square bg-white/[0.04]">
                      {pl.images?.[0]?.url
                        ? <img src={pl.images[0].url} alt="" className="w-full h-full object-cover" />
                        : <div className="w-full h-full flex items-center justify-center text-2xl">🎵</div>
                      }
                    </div>
                    <div className="p-2.5">
                      <p className="text-xs font-medium text-white truncate">{pl.name}</p>
                      <p className="text-[10px] text-white/30 mt-0.5">{pl.tracks?.total} songs</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Library */}
        {library.length > 0 && (
          <div className="animate-fade-up">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[11px] font-semibold text-white/30 uppercase tracking-widest">
                Library · {library.length}
              </span>
              <button
                onClick={() => { setLibrary([]); handleStop() }}
                className="text-[11px] text-white/20 hover:text-red-400/60 transition-colors duration-150 cursor-pointer"
              >
                Clear all
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3">
              {library.map((track, i) => (
                <LibraryCard
                  key={track.id}
                  track={track}
                  isPlaying={track.id === playingId && !player.isPaused}
                  onRemove={() => removeFromLibrary(track.id)}
                />
              ))}
            </div>
          </div>
        )}

        {library.length === 0 && tab === 'search' && !query && (
          <div className="text-center py-16 text-white/[0.12] text-sm select-none">
            Search or browse playlists to build your library
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
        onSkip={advanceToNext}
        library={library}
        playingId={playingId}
        onUpdateTimes={updateTimes}
      />
    </div>
  )
}

function TrackRow({ track, index, inLibrary, onAdd }) {
  const img = track.album?.images?.[2] ?? track.album?.images?.[0]
  const artists = track.artists?.map(a => a.name).join(', ')
  return (
    <div
      className="animate-fade-up flex items-center gap-3 px-4 py-2.5 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.03] transition-colors duration-150"
      style={{ animationDelay: `${index * 25}ms` }}
    >
      {img
        ? <img src={img.url} alt="" className="w-8 h-8 rounded-md object-cover flex-shrink-0" />
        : <div className="w-8 h-8 rounded-md bg-white/[0.06] flex-shrink-0" />
      }
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-white truncate">{track.name}</p>
        <p className="text-[10px] text-white/30 truncate mt-0.5">{artists}</p>
      </div>
      <button
        onClick={() => onAdd(track)}
        disabled={inLibrary}
        className={`flex-shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-full transition-all duration-150 cursor-pointer active:scale-[0.97] ${
          inLibrary
            ? 'text-[#1DB954]/40 bg-[#1DB954]/[0.07] cursor-default'
            : 'text-[#1DB954] bg-[#1DB954]/[0.1] hover:bg-[#1DB954]/[0.18]'
        }`}
      >
        {inLibrary ? '✓' : '+'}
      </button>
    </div>
  )
}

function LibraryCard({ track, isPlaying, onRemove }) {
  const img = track.album?.images?.[0]
  const artists = track.artists?.map(a => a.name).join(', ')
  return (
    <div className={`relative group rounded-xl overflow-hidden transition-all duration-200 ${isPlaying ? 'ring-1 ring-[#1DB954]/40' : ''}`}>
      <div className="aspect-square bg-white/[0.04]">
        {img
          ? <img src={img.url} alt="" className="w-full h-full object-cover" />
          : <div className="w-full h-full" />
        }
        {isPlaying && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <div className="flex items-end gap-[3px] h-5">
              {[0, 1, 2].map(i => (
                <div key={i} className="w-[3px] bg-[#1DB954] rounded-full origin-bottom"
                  style={{ height: '100%', animation: `equalizer 0.8s ${i * 0.13}s ease-in-out infinite alternate` }} />
              ))}
            </div>
          </div>
        )}
        <button
          onClick={onRemove}
          className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-black/70 text-white/50 hover:text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-150 cursor-pointer text-[10px]"
        >✕</button>
      </div>
      <div className="p-2 bg-white/[0.03]">
        <p className={`text-[11px] font-semibold truncate ${isPlaying ? 'text-[#1DB954]' : 'text-white'}`}>{track.name}</p>
        <p className="text-[10px] text-white/25 truncate mt-0.5">{artists}</p>
      </div>
    </div>
  )
}
