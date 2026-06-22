import { useState, useEffect, useRef, useCallback } from 'react'
import { searchTracks, logout } from '../lib/spotify'
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
    const old = JSON.parse(localStorage.getItem('trivia_library') ?? '[]')
    return { activeId: 'main', items: { main: { name: 'Main Library', songs: old } } }
  } catch {
    return { activeId: 'main', items: { main: { name: 'Main Library', songs: [] } } }
  }
}

export default function Jukebox({ onLogout }) {
  const [sets, setSets] = useState(loadSets)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [resultsKey, setResultsKey] = useState(0)
  const [playingId, setPlayingId] = useState(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [showLive, setShowLive] = useState(false)
  const [liveEnding, setLiveEnding] = useState(false)
  const [modalTrack, setModalTrack] = useState(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [newSetName, setNewSetName] = useState('')
  const [addingSet, setAddingSet] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [renamingVal, setRenamingVal] = useState('')
  const [nextSong, setNextSong] = useState(null)
  const [shuffleKey, setShuffleKey] = useState(0)

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
  // Set true by startShuffle; consumed by the currentTrack watcher to open the live screen
  // only after the SDK has confirmed the track — avoids the race that caused missing art
  const pendingLiveOpenRef = useRef(false)
  // Always-live library ref so advanceToNext never closes over a stale snapshot
  const libraryRef = useRef(library)
  useEffect(() => { libraryRef.current = library }, [library])

  const advanceToNext = useCallback(() => {
    const lib = libraryRef.current
    const order = shuffleOrderRef.current
    let idx = shuffleIdxRef.current + 1
    if (idx >= order.length) {
      const lastLibIdx = order[order.length - 1]
      const newOrder = shuffleArray(lib.map((_, i) => i))
      if (newOrder[0] === lastLibIdx && newOrder.length > 1) {
        const swapIdx = 1 + Math.floor(Math.random() * (newOrder.length - 1))
        ;[newOrder[0], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[0]]
      }
      shuffleOrderRef.current = newOrder
      idx = 0
    }
    shuffleIdxRef.current = idx
    setNextSong(lib[shuffleOrderRef.current[idx + 1]] ?? null)
    const song = lib[shuffleOrderRef.current[idx]]
    if (song) { setPlayingId(song.id); playTrackFn.current?.(song) }
  }, [])

  const player = useSpotifyPlayer({ onAdvance: advanceToNext })

  useEffect(() => {
    playTrackFn.current = (song) =>
      player.playTrack(song.uri, song.startMs ?? 0, song.stopMs ?? song.duration_ms)
      // returns the Promise<true|false> from playTrack so startShuffle can await it
  }, [player.playTrack])

  useEffect(() => {
    if (player.currentTrack) {
      const match = library.find(t => t.uri === player.currentTrack.uri)
      if (match) setPlayingId(match.id)
      if (pendingLiveOpenRef.current) {
        pendingLiveOpenRef.current = false
        setShowLive(true)
      }
    }
  }, [player.currentTrack?.uri])

  const search = useCallback((q) => {
    clearTimeout(debounceRef.current)
    if (!q.trim()) { setResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const tracks = await searchTracks(q)
        setResults(tracks)
        setResultsKey(k => k + 1)
      } catch (err) {
        console.error('[search]', err)
        setResults([])
      } finally { setSearching(false) }
    }, 280)
  }, [])

  const addToLibrary = (track) => {
    if (!track || library.some(t => t.id === track.id)) return
    setLibrary(prev => [{ ...track, startMs: 0, stopMs: track.duration_ms }, ...prev])
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

  const startShuffle = useCallback(async () => {
    console.log('🔵 startShuffle CALLED — library.length:', library.length)
    if (library.length === 0) return
    setShuffleKey(k => k + 1)
    const order = shuffleArray(library.map((_, i) => i))
    shuffleOrderRef.current = order
    shuffleIdxRef.current = 0
    setNextSong(library[order[1]] ?? null)
    const song = library[order[0]]
    setPlayingId(song.id)
    setIsPlaying(true)
    pendingLiveOpenRef.current = true   // live screen opens when SDK confirms the track
    const started = await playTrackFn.current?.(song)
    console.log('🔵 startShuffle DONE — started:', started)
    if (!started) {
      pendingLiveOpenRef.current = false
      setIsPlaying(false)
      setShowLive(false)
      setPlayingId(null)
    }
  }, [library])

  const handleStop = useCallback(() => {
    player.fadeAndPause()
    setIsPlaying(false)
    setPlayingId(null)
    if (showLive) {
      setLiveEnding(true)  // LiveScreen animates out, then calls onClose → setShowLive(false)
    } else {
      setShowLive(false)
    }
  }, [player.fadeAndPause, showLive])

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
    if (!name) return
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
    <div className="h-screen bg-[#272729] text-white flex flex-col overflow-hidden">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-white/[0.05] bg-[#272729]/90 backdrop-blur-md px-6 py-4 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <span className="text-lg">🎵</span>
          <span className="text-sm font-semibold text-white tracking-tight">Trivia Jukebox</span>
        </div>
        <div className="flex items-center gap-3">
          {player.error && <span className="text-xs text-red-400/70">{player.error}</span>}
          {!player.isReady && !player.error && (
            <span className="text-[11px] text-white">Connecting…</span>
          )}
          {isPlaying && (
            <button
              onClick={() => setShowLive(v => !v)}
              className={`text-xs font-medium transition-colors duration-150 cursor-pointer px-3 py-1 rounded-full active:scale-[0.97] ${
                showLive ? 'bg-white text-black' : 'text-white hover:text-white border border-white/10 hover:border-white/25'
              }`}
            >
              Live
            </button>
          )}
          <button
            onClick={() => { logout(); onLogout() }}
            className="text-[11px] text-white hover:text-white transition-colors duration-150 cursor-pointer"
          >
            Disconnect
          </button>
        </div>
      </header>

      {/* Body: sidebar + library + search */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left sidebar — trivia themes */}
        <aside className="w-44 flex-shrink-0 border-r border-white/[0.05] bg-[#212123] flex flex-col py-4 overflow-y-auto">
          <p className="text-[9px] font-bold uppercase tracking-widest text-white px-4 mb-2">Trivia Themes</p>

          {/* Add new theme — at top */}
          <div className="px-2 mb-3">
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
                  placeholder="Theme name…"
                  className="flex-1 bg-white/[0.06] text-white text-[11px] rounded-lg px-2 py-1.5 outline-none border border-[#1DB954]/40 placeholder-white/20 min-w-0"
                />
                <button onClick={createSet} className="text-[#1DB954] text-xs px-1.5 cursor-pointer hover:opacity-80">✓</button>
              </div>
            ) : (
              <button
                onClick={() => setAddingSet(true)}
                className="w-full text-[11px] font-semibold text-[#1DB954] border border-[#1DB954]/30 hover:border-[#1DB954]/60 hover:bg-[#1DB954]/[0.07] transition-colors duration-150 cursor-pointer px-2 py-2 rounded-lg flex items-center justify-center gap-1.5 active:scale-[0.97]"
              >
                <span className="text-sm leading-none">+</span>
                <span>Add Theme</span>
              </button>
            )}
          </div>

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
                onClear={() => {
                  const cur = sets.items[id]?.songs ?? []
                  if (cur.length === 0) return
                  if (!window.confirm(`Clear all ${cur.length} songs from "${sets.items[id].name}"?`)) return
                  setSets(prev => ({ ...prev, items: { ...prev.items, [id]: { ...prev.items[id], songs: [] } } }))
                  if (sets.activeId === id) { player.fadeAndPause(); setPlayingId(null); setIsPlaying(false) }
                }}
                onStartRename={() => { setRenamingId(id); setRenamingVal(sets.items[id].name) }}
                onRenameChange={setRenamingVal}
                onRenameCommit={() => renameSet(id)}
                onRenameCancel={() => setRenamingId(null)}
              />
            ))}
          </div>
        </aside>

        {/* Library panel */}
        <div className="flex-1 flex flex-col overflow-hidden border-r border-white/[0.05]">

          {/* Library grid */}
          <div className="flex-1 overflow-y-auto p-3 pb-32">
            {library.length > 0 ? (
              <div className="grid grid-cols-4 gap-2">
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
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center select-none pb-16">
                <p className="text-white text-sm">
                  {sets.activeId === 'main' ? 'Your library is empty' : `${activeSetName} is empty`}
                </p>
                <p className="text-white text-xs mt-1">Search on the right to add songs</p>
              </div>
            )}
          </div>
        </div>

        {/* Search panel */}
        <div className="w-80 flex-shrink-0 flex flex-col overflow-hidden">
          {/* Search input */}
          <div className="p-3 border-b border-white/[0.05] flex-shrink-0">
            <div className="relative">
              <div className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-white">
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10ZM14 14l-3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </div>
              <input
                type="text"
                placeholder="Search for a song…"
                value={query}
                onChange={e => { setQuery(e.target.value); search(e.target.value) }}
                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl pl-9 pr-4 py-2.5 text-white placeholder-white/20 outline-none focus:border-[#1DB954]/35 focus:bg-white/[0.06] transition-colors duration-200 text-sm"
              />
              {searching && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="w-3 h-3 border-[1.5px] border-white/10 border-t-[#1DB954] rounded-full animate-spin" />
                </div>
              )}
            </div>
          </div>

          {/* Search results */}
          <div className="flex-1 overflow-y-auto pb-32">
            {results.length > 0 ? (
              <div key={resultsKey}>
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
            ) : searching ? null : !query ? (
              <div className="flex items-center justify-center h-full text-white text-xs pb-16">
                Type to search Spotify
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-white text-xs pb-16">
                No results found
              </div>
            )}
          </div>
        </div>
      </div>

      {showLive && (
        <LiveScreen
          currentTrack={player.currentTrack}
          isPaused={player.isPaused}
          ending={liveEnding}
          onClose={() => { setShowLive(false); setLiveEnding(false) }}
          nextArtUrl={nextSong?.album?.images?.[0]?.url ?? null}
          shuffleKey={shuffleKey}
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

function SetItem({ id, set, isActive, isRenaming, renamingVal, onSelect, onDelete, onClear, onStartRename, onRenameChange, onRenameCommit, onRenameCancel }) {
  return (
    <div className={`group flex items-center rounded-lg px-2 py-1.5 transition-colors duration-150 ${
      isActive ? 'bg-white/[0.08] text-white' : 'text-white hover:text-white hover:bg-white/[0.04]'
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
          onDoubleClick={onStartRename}
          className="flex-1 text-left text-[11px] font-medium truncate cursor-pointer"
        >
          {set.name}
          {set.songs?.length > 0 && (
            <span className="ml-1.5 text-[9px] text-white">{set.songs.length}</span>
          )}
        </button>
      )}
      {!isRenaming && (
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 ml-1 flex-shrink-0 transition-opacity duration-150">
          {onClear && set.songs?.length > 0 && (
            <button
              onClick={e => { e.stopPropagation(); onClear() }}
              title="Clear all songs"
              className="text-white hover:text-red-400/80 transition-colors cursor-pointer p-0.5"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
              </svg>
            </button>
          )}
          {onDelete && (
            <button
              onClick={e => { e.stopPropagation(); onDelete() }}
              title="Delete theme"
              className="text-white hover:text-red-400/80 transition-colors cursor-pointer text-[10px] p-0.5"
            >✕</button>
          )}
        </div>
      )}
    </div>
  )
}

function TrackRow({ track, index, inLibrary, onAdd }) {
  const img = track.album?.images?.[2] ?? track.album?.images?.[0]
  const artists = track.artists?.map(a => a.name).join(', ')
  return (
    <div
      className="animate-fade-up flex items-center gap-3 px-3 py-2.5 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.03] transition-colors duration-150"
      style={{ animationDelay: `${index * 25}ms` }}
    >
      {img
        ? <img src={img.url} alt="" className="w-8 h-8 rounded-md object-cover flex-shrink-0" />
        : <div className="w-8 h-8 rounded-md bg-white/[0.06] flex-shrink-0" />
      }
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-white truncate">{track.name}</p>
        <p className="text-[10px] text-white truncate mt-0.5">{artists}</p>
      </div>
      <button
        onClick={() => onAdd(track)}
        disabled={inLibrary}
        className={`flex-shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-full transition-colors duration-150 cursor-pointer active:scale-[0.97] ${
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
      className={`relative group rounded-xl overflow-hidden transition-shadow duration-200 cursor-pointer select-none ${
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
            <span className="text-white text-sm">⏸</span>
          </div>
        )}
        {hasTrim && !isPlaying && !isPaused && (
          <div className="absolute bottom-1.5 left-1.5 w-1.5 h-1.5 rounded-full bg-[#1DB954]/60" />
        )}
        <button
          onClick={e => { e.stopPropagation(); onRemove() }}
          className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-black/70 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 cursor-pointer text-[10px]"
        >✕</button>
      </div>
      <div className="p-2 bg-white/[0.03] text-center">
        <p className={`text-[11px] font-semibold truncate ${isPlaying ? 'text-[#1DB954]' : 'text-white'}`}>{track.name}</p>
        <p className="text-[10px] text-white truncate mt-0.5">{artists}</p>
      </div>
    </div>
  )
}
