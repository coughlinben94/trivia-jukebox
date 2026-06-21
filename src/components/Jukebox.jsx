import { useState, useEffect, useRef, useCallback } from 'react'
import { searchTracks, getPlaylists, getPlaylistTracks, logout } from '../lib/spotify'
import { useSpotifyPlayer } from '../hooks/useSpotifyPlayer'
import Player from './Player'
import LiveScreen from './LiveScreen'
import SongDetailModal from './SongDetailModal'

function shuffleArray(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function uid() { return Math.random().toString(36).slice(2) }

function loadSets() {
  try {
    const stored = JSON.parse(localStorage.getItem('trivia_sets') ?? 'null')
    if (stored) return stored
    // Migrate old flat library
    const old = JSON.parse(localStorage.getItem('trivia_library') ?? '[]')
    return { activeId: 'main', items: { main: { name: 'Main Library', songs: old } } }
  } catch {
    return { activeId: 'main', items: { main: { name: 'Main Library', songs: [] } } }
  }
}

export default function Jukebox({ onLogout }) {
  const [sets, setSets] = useState(loadSets)
  const [tab, setTab] = useState('search')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [playlists, setPlaylists] = useState([])
  const [openPlaylist, setOpenPlaylist] = useState(null)
  const [playlistTracks, setPlaylistTracks] = useState([])
  const [loadingPlaylist, setLoadingPlaylist] = useState(false)
  const [loadingPlaylists, setLoadingPlaylists] = useState(false)
  const [searching, setSearching] = useState(false)
  const [resultsKey, setResultsKey] = useState(0)
  const [playingId, setPlayingId] = useState(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [showLive, setShowLive] = useState(false)
  const [modalTrack, setModalTrack] = useState(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [newSetName, setNewSetName] = useState('')
  const [addingSet, setAddingSet] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [renamingVal, setRenamingVal] = useState('')

  const library = sets.items[sets.activeId]?.songs ?? []
  const activeSetName = sets.items[sets.activeId]?.name ?? 'Library'

  const setLibrary = useCallback((updater) => {
    setSets(prev => {
      const cur = prev.items[prev.activeId]?.songs ?? []
      const songs = typeof updater === 'function' ? updater(cur) : updater
      return { ...prev, items: { ...prev.items, [prev.activeId]: { ...prev.items[prev.activeId], songs } } }
    })
  }, [])

  useEffect(() => {
    localStorage.setItem('trivia_sets', JSON.stringify(sets))
  }, [sets])

  const shuffleOrderRef = useRef([])
  const shuffleIdxRef = useRef(0)
  const debounceRef = useRef(null)
  const playTrackFn = useRef(null)
  const dragIdxRef = useRef(null)

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
    if (player.currentTrack) {
      const match = library.find(t => t.uri === player.currentTrack.uri)
      if (match) setPlayingId(match.id)
    }
  }, [player.currentTrack?.uri])

  useEffect(() => {
    if (tab === 'playlists' && playlists.length === 0 && !loadingPlaylists) {
      setLoadingPlaylists(true)
      getPlaylists().then(items => { setPlaylists(items); setLoadingPlaylists(false) })
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

  const addAllToLibrary = (tracks) => {
    const toAdd = tracks.filter(t => t && !library.some(l => l.id === t.id))
    if (toAdd.length === 0) return
    setLibrary(prev => [...prev, ...toAdd.map(t => ({ ...t, startMs: 0, stopMs: t.duration_ms }))])
  }

  const removeFromLibrary = (id) => {
    setLibrary(prev => prev.filter(t => t.id !== id))
    if (playingId === id) { player.fadeAndPause(); setPlayingId(null); setIsPlaying(false) }
  }

  const updateTimes = useCallback((id, startMs, stopMs) => {
    setLibrary(prev => prev.map(t => t.id === id ? { ...t, startMs, stopMs } : t))
  }, [setLibrary])

  const clearLibrary = () => {
    setLibrary([])
    handleStop()
    setConfirmClear(false)
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
    playTrackFn.current?.(song)
  }, [library])

  const handleStop = useCallback(async () => {
    await player.fadeAndPause()
    setIsPlaying(false)
    setPlayingId(null)
    setShowLive(false)
  }, [player.fadeAndPause])

  const switchSet = (id) => {
    if (id === sets.activeId) return
    if (isPlaying) handleStop()
    setPlayingId(null)
    setConfirmClear(false)
    setSets(prev => ({ ...prev, activeId: id }))
  }

  const createSet = () => {
    const name = newSetName.trim()
    if (!name) return
    const id = uid()
    setSets(prev => ({
      ...prev,
      activeId: id,
      items: { ...prev.items, [id]: { name, songs: [] } }
    }))
    setNewSetName('')
    setAddingSet(false)
  }

  const deleteSet = (id) => {
    if (id === 'main') return
    if (isPlaying && sets.activeId === id) handleStop()
    setSets(prev => {
      const items = { ...prev.items }
      delete items[id]
      return { ...prev, activeId: prev.activeId === id ? 'main' : prev.activeId, items }
    })
  }

  const renameSet = (id) => {
    const name = renamingVal.trim()
    if (!name || id === 'main') return
    setSets(prev => ({
      ...prev,
      items: { ...prev.items, [id]: { ...prev.items[id], name } }
    }))
    setRenamingId(null)
  }

  useEffect(() => {
    const handler = (e) => {
      if (e.code !== 'Space') return
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return
      if (modalTrack) return
      e.preventDefault()
      if (isPlaying) handleStop()
      else startShuffle()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isPlaying, handleStop, startShuffle, modalTrack])

  const handleDragStart = (i) => { dragIdxRef.current = i }
  const handleDragOver = (e, i) => {
    e.preventDefault()
    const from = dragIdxRef.current
    if (from === null || from === i) return
    setLibrary(prev => {
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(i, 0, item)
      dragIdxRef.current = i
      return next
    })
  }
  const handleDragEnd = () => { dragIdxRef.current = null }

  const inLibrary = (id) => library.some(t => t.id === id)
  const setOrder = Object.keys(sets.items)

  return (
    <div className="h-screen bg-[#0a0a0a] text-white flex flex-col overflow-hidden">
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

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar — sets */}
        <aside className="w-44 flex-shrink-0 border-r border-white/[0.05] bg-[#0d0d0d] flex flex-col py-4 overflow-y-auto">
          <p className="text-[9px] font-bold uppercase tracking-widest text-white/20 px-4 mb-3">Trivia Themes</p>
          <div className="flex-1 space-y-0.5 px-2">
            {setOrder.map(id => (
              <SetItem
                key={id}
                id={id}
                set={sets.items[id]}
                isActive={sets.activeId === id}
                isRenaming={renamingId === id}
                renamingVal={renamingVal}
                onSelect={() => switchSet(id)}
                onDelete={id !== 'main' ? () => deleteSet(id) : undefined}
                onStartRename={() => { setRenamingId(id); setRenamingVal(sets.items[id].name) }}
                onRenameChange={setRenamingVal}
                onRenameCommit={() => renameSet(id)}
                onRenameCancel={() => setRenamingId(null)}
              />
            ))}
          </div>

          {/* Add new set */}
          <div className="px-2 mt-3">
            {addingSet ? (
              <div className="flex gap-1">
                <input
                  autoFocus
                  type="text"
                  value={newSetName}
                  onChange={e => setNewSetName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') createSet()
                    if (e.key === 'Escape') { setAddingSet(false); setNewSetName('') }
                  }}
                  placeholder="Name…"
                  className="flex-1 bg-white/[0.06] text-white text-[11px] rounded-lg px-2 py-1.5 outline-none border border-white/[0.08] placeholder-white/20 min-w-0"
                />
                <button onClick={createSet} className="text-[#1DB954] text-xs px-1.5 cursor-pointer hover:opacity-80">✓</button>
              </div>
            ) : (
              <button
                onClick={() => setAddingSet(true)}
                className="w-full text-left text-[11px] text-white/25 hover:text-white/50 transition-colors duration-150 cursor-pointer px-2 py-1.5 rounded-lg hover:bg-white/[0.04] flex items-center gap-1.5"
              >
                <span className="text-base leading-none">+</span>
                <span>New night</span>
              </button>
            )}
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-5 py-8 pb-44 space-y-6">
            {/* Tabs */}
            <div className="flex justify-center">
              <div className="flex gap-1 bg-white/[0.04] p-1 rounded-xl">
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
                    <div className="flex items-center justify-between mb-4">
                      <button
                        onClick={() => { setOpenPlaylist(null); setPlaylistTracks([]) }}
                        className="flex items-center gap-2 text-xs text-white/40 hover:text-white/70 transition-colors cursor-pointer"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
                        {openPlaylist.name}
                      </button>
                      {playlistTracks.length > 0 && (
                        <button
                          onClick={() => addAllToLibrary(playlistTracks)}
                          className="text-[11px] font-semibold text-[#1DB954] bg-[#1DB954]/10 hover:bg-[#1DB954]/20 px-3 py-1 rounded-full transition-all duration-150 cursor-pointer active:scale-[0.97]"
                        >
                          + Add all
                        </button>
                      )}
                    </div>
                    {loadingPlaylist ? (
                      <div className="flex justify-center py-10">
                        <div className="w-4 h-4 border-[1.5px] border-white/10 border-t-[#1DB954] rounded-full animate-spin" />
                      </div>
                    ) : playlistTracks.length === 0 ? (
                      <div className="py-10 text-center text-white/20 text-xs">
                        No tracks found. If this playlist is private, disconnect and reconnect Spotify to grant playlist access.
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
                  <div className="grid grid-cols-5 gap-2">
                    {loadingPlaylists ? (
                      <div className="col-span-3 py-10 text-center">
                        <div className="w-4 h-4 border-[1.5px] border-white/10 border-t-[#1DB954] rounded-full animate-spin mx-auto" />
                      </div>
                    ) : playlists.length === 0 ? (
                      <div className="col-span-3 py-10 text-center text-white/20 text-xs">
                        No playlists found — try disconnecting and reconnecting Spotify.
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
            {library.length > 0 && tab === 'search' && (
              <div className="animate-fade-up">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-[11px] font-semibold text-white/30 uppercase tracking-widest">
                    {activeSetName} · {library.length}
                  </span>
                  {confirmClear ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-white/40">Clear all?</span>
                      <button onClick={clearLibrary} className="text-[11px] text-red-400 hover:text-red-300 cursor-pointer transition-colors">Yes</button>
                      <button onClick={() => setConfirmClear(false)} className="text-[11px] text-white/30 hover:text-white/60 cursor-pointer transition-colors">Cancel</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmClear(true)}
                      className="text-[11px] text-white/20 hover:text-white/40 transition-colors duration-150 cursor-pointer"
                    >
                      Clear all
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-5 gap-2">
                  {library.map((track, i) => (
                    <LibraryCard
                      key={track.id}
                      track={track}
                      isPlaying={track.id === playingId && !player.isPaused}
                      isPaused={track.id === playingId && player.isPaused}
                      onRemove={() => removeFromLibrary(track.id)}
                      onClick={() => setModalTrack(track)}
                      onDragStart={() => handleDragStart(i)}
                      onDragOver={(e) => handleDragOver(e, i)}
                      onDragEnd={handleDragEnd}
                    />
                  ))}
                </div>
              </div>
            )}

            {library.length === 0 && (
              <div className="text-center py-16 text-white/[0.12] text-sm select-none">
                {tab === 'search' && !query
                  ? `Search or browse playlists to add songs to ${activeSetName}`
                  : null}
              </div>
            )}
          </div>
        </main>
      </div>

      {showLive && (
        <LiveScreen
          currentTrack={player.currentTrack}
          isPaused={player.isPaused}
          onClose={() => setShowLive(false)}
        />
      )}

      {modalTrack && (
        <SongDetailModal
          track={modalTrack}
          player={player}
          onUpdateTimes={updateTimes}
          onClose={() => setModalTrack(null)}
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

function SetItem({ id, set, isActive, isRenaming, renamingVal, onSelect, onDelete, onStartRename, onRenameChange, onRenameCommit, onRenameCancel }) {
  return (
    <div className={`group flex items-center rounded-lg px-2 py-1.5 transition-all duration-150 ${
      isActive ? 'bg-white/[0.08] text-white' : 'text-white/40 hover:text-white/70 hover:bg-white/[0.04]'
    }`}>
      {isRenaming ? (
        <input
          autoFocus
          type="text"
          value={renamingVal}
          onChange={e => onRenameChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onRenameCommit()
            if (e.key === 'Escape') onRenameCancel()
          }}
          onBlur={onRenameCommit}
          className="flex-1 bg-transparent text-[11px] text-white outline-none min-w-0"
        />
      ) : (
        <button
          onClick={onSelect}
          onDoubleClick={id !== 'main' ? onStartRename : undefined}
          className="flex-1 text-left text-[11px] font-medium truncate cursor-pointer"
        >
          {set.name}
          {set.songs?.length > 0 && (
            <span className="ml-1.5 text-[9px] text-white/25">{set.songs.length}</span>
          )}
        </button>
      )}
      {onDelete && !isRenaming && (
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          className="opacity-0 group-hover:opacity-100 text-white/25 hover:text-red-400/70 transition-all duration-150 cursor-pointer text-[10px] ml-1 flex-shrink-0"
        >✕</button>
      )}
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

function LibraryCard({ track, isPlaying, isPaused, onRemove, onClick, onDragStart, onDragOver, onDragEnd }) {
  const img = track.album?.images?.[0]
  const artists = track.artists?.map(a => a.name).join(', ')
  const hasTrim = track.startMs > 0 || (track.stopMs && track.stopMs < track.duration_ms - 1000)
  return (
    <div
      className={`relative group rounded-xl overflow-hidden transition-all duration-200 cursor-pointer select-none ${
        isPlaying ? 'ring-1 ring-[#1DB954]/40' : isPaused ? 'ring-1 ring-white/15' : ''
      }`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onClick={onClick}
    >
      <div className="aspect-square bg-white/[0.04]">
        {img
          ? <img src={img.url} alt="" className="w-full h-full object-cover" draggable={false} />
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
        {isPaused && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <span className="text-white/60 text-sm">⏸</span>
          </div>
        )}
        {hasTrim && !isPlaying && !isPaused && (
          <div className="absolute bottom-1.5 left-1.5 w-1.5 h-1.5 rounded-full bg-[#1DB954]/60" />
        )}
        <button
          onClick={e => { e.stopPropagation(); onRemove() }}
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
