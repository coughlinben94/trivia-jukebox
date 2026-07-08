import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { searchTracks, logout } from '../lib/spotify'
import { supabase } from '../lib/supabase'
import { slimTrack, songNeedsSlim } from '../lib/track'
import { shuffleArray, resolveNext, resolveUpcoming } from '../lib/shuffle'
import { useSpotifyPlayer } from '../hooks/useSpotifyPlayer'
import Player from './Player'
import LiveScreen from './LiveScreen'
import SongDetailModal from './SongDetailModal'

function uid() { return Math.random().toString(36).slice(2) }

function calcRuntime(songs) {
  let ms = 0
  for (const s of songs) {
    const start = s.startMs ?? 0
    const stop = (s.stopMs != null && s.stopMs > start) ? s.stopMs : (s.duration_ms ?? 0)
    ms += stop - start
  }
  return ms
}

function fmtRuntime(ms) {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m`
}

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

function totalSongs(sets) {
  return Object.values(sets?.items ?? {}).reduce((n, s) => n + (s.songs?.length ?? 0), 0)
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
  const closeLive = useCallback(() => { setShowLive(false); setLiveEnding(false) }, [])
  const [modalTrack, setModalTrack] = useState(null)
const [newSetName, setNewSetName] = useState('')
  const [addingSet, setAddingSet] = useState(false)
  const [renamingId, setRenamingId] = useState(null)
  const [renamingVal, setRenamingVal] = useState('')
  const [shuffleKey, setShuffleKey] = useState(0)
  const [toasts, setToasts] = useState([])
  const [syncDone, setSyncDone] = useState(false)

  const addToast = useCallback((msg) => {
    const id = uid()
    setToasts(prev => [...prev, { id, msg }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 2500)
  }, [])

  const library = sets.items[sets.activeId]?.songs ?? []
  const activeSetName = sets.items[sets.activeId]?.name ?? 'Library'
  // Recomputed only when the library's songs actually change, not on every
  // 300ms position tick from playback (Jukebox re-renders on every tick).
  const libraryRuntime = useMemo(() => fmtRuntime(calcRuntime(library)), [library])

  const setLibrary = useCallback((updater) => {
    setSets(prev => {
      const cur = prev.items[prev.activeId]?.songs ?? []
      const songs = typeof updater === 'function' ? updater(cur) : updater
      return { ...prev, items: { ...prev.items, [prev.activeId]: { ...prev.items[prev.activeId], songs } } }
    })
  }, [])

  // Stable session ID — embedded in every Supabase write so the realtime handler can
  // detect its own echoes without touching the sets payload shape.
  const sessionIdRef              = useRef(uid())
  const supabaseDebounceRef       = useRef(null)
  // Set true before setSets(sbSets) on initial Supabase load so the write effect
  // doesn't immediately write the data back to Supabase (one wasted round-trip).
  const justLoadedFromSupabaseRef = useRef(false)
  // Set true once syncFromSupabase() completes (success OR network failure).
  // No Supabase write is allowed before this — prevents the first-render empty-default
  // race where the 500ms debounce fires before we know what the remote row contains.
  const syncCompletedRef          = useRef(false)
  const libParamHandledRef        = useRef(false)
  // Set by the realtime handler when an incoming update is dropped because a
  // local write is in-flight. The debounced writer merges any songs in here
  // that aren't already local (e.g. a QuickAdd) before it upserts, so a
  // same-window remote write doesn't get last-write-wins clobbered.
  const stashedIncomingSetsRef    = useRef(null)

  // Persist to localStorage immediately; debounce Supabase write 500ms.
  useEffect(() => {
    localStorage.setItem('trivia_sets', JSON.stringify(sets))
    if (justLoadedFromSupabaseRef.current) {
      justLoadedFromSupabaseRef.current = false
      // Also cancel any timer that was started from the pre-load empty-state render
      // so it cannot fire and overwrite what we just loaded from Supabase.
      clearTimeout(supabaseDebounceRef.current)
      supabaseDebounceRef.current = null
      return
    }
    clearTimeout(supabaseDebounceRef.current)
    supabaseDebounceRef.current = setTimeout(async () => {
      supabaseDebounceRef.current = null
      // Guard 1a — never write before the initial sync has confirmed the remote state.
      // This is the primary protection against the first-render empty-default race.
      if (!syncCompletedRef.current) return

      // Merge in any songs from an incoming realtime update that arrived
      // while this write was pending and don't exist locally yet (e.g. a
      // QuickAdd from another device), so this write doesn't clobber them.
      let outgoing = sets
      const stashed = stashedIncomingSetsRef.current
      if (stashed) {
        stashedIncomingSetsRef.current = null
        const items = { ...outgoing.items }
        for (const [setId, stashedSet] of Object.entries(stashed.items ?? {})) {
          const localSongs = items[setId]?.songs ?? []
          const localIds = new Set(localSongs.map(s => s.id))
          const missing = (stashedSet.songs ?? []).filter(s => !localIds.has(s.id))
          if (missing.length > 0) {
            items[setId] = { ...(items[setId] ?? stashedSet), songs: [...localSongs, ...missing] }
          }
        }
        outgoing = { ...outgoing, items }
        if (outgoing !== sets) setSets(outgoing)
      }

      // Guard 1b — if we're about to write an empty state, verify the remote is also
      // empty. Catches any edge-case that bypasses Guard 1a (e.g. sync completes but
      // local state is still empty before the user adds anything).
      if (totalSongs(outgoing) === 0) {
        try {
          const { data } = await supabase
            .from('jukebox_state').select('sets').eq('id', 'singleton').single()
          if (data?.sets && totalSongs(data.sets) > 0) return  // remote has data — abort
        } catch { return }  // cannot verify remote state — do not risk it
      }
      try {
        await supabase.from('jukebox_state').upsert({
          id: 'singleton',
          sets: outgoing,
          last_writer: sessionIdRef.current,
          updated_at: new Date().toISOString(),
        })
      } catch { /* silent — localStorage is always the local fallback */ }
    }, 500)
  }, [sets])

  // On mount: fetch the authoritative sets from Supabase.
  // One-way migration: push localStorage→Supabase ONLY when remote is empty AND
  // local has songs. Never the reverse. Never empty-over-populated in either direction.
  useEffect(() => {
    async function syncFromSupabase() {
      try {
        const { data, error } = await supabase
          .from('jukebox_state')
          .select('sets')
          .eq('id', 'singleton')
          .single()
        if (error || !data?.sets) return
        const sbSets = data.sets
        if (totalSongs(sbSets) === 0) {
          // Remote is empty — migrate localStorage up if it has songs
          const lsSets = loadSets()
          if (totalSongs(lsSets) > 0) {
            try {
              await supabase.from('jukebox_state').upsert({
                id: 'singleton',
                sets: lsSets,
                last_writer: sessionIdRef.current,
                updated_at: new Date().toISOString(),
              })
            } catch { /* migration failed silently — localStorage remains the truth */ }
          }
        } else {
          // Remote has songs — use it as the source of truth
          justLoadedFromSupabaseRef.current = true
          setSets(sbSets)
          localStorage.setItem('trivia_sets', JSON.stringify(sbSets))
        }
      } catch { /* Supabase unreachable — already rendering from localStorage */ }
      finally {
        // Always mark sync done so the write effect knows it's safe to write.
        // This fires whether Supabase was reachable or not.
        syncCompletedRef.current = true
        setSyncDone(true)  // triggers the ?lib= param handler effect
      }
    }
    syncFromSupabase()
    return () => clearTimeout(supabaseDebounceRef.current)
  }, [])

  // Realtime: apply remote changes from other devices.
  // Guard: own-echo (last_writer match), in-flight edit (debounce pending),
  // and empty-clobber (incoming has 0 songs but local has songs).
  // setsRef provides a stable reference to current sets without stale closure issues.
  useEffect(() => {
    const channel = supabase
      .channel('jukebox_state_changes')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'jukebox_state', filter: 'id=eq.singleton' },
        (payload) => {
          if (payload.new?.last_writer === sessionIdRef.current) return  // own echo
          const incoming = payload.new?.sets
          if (!incoming) return
          if (supabaseDebounceRef.current !== null) {
            // Local edit in-flight — don't clobber it here, but stash the
            // incoming sets so the pending debounced write can merge in any
            // songs it doesn't have locally before it overwrites Supabase.
            stashedIncomingSetsRef.current = incoming
            return
          }
          // Guard 2 — never let an empty/default incoming state wipe a populated local library
          if (totalSongs(incoming) === 0 && totalSongs(setsRef.current) > 0) return
          setSets(incoming)
          localStorage.setItem('trivia_sets', JSON.stringify(incoming))
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  const shuffleOrderRef = useRef([])
  const shuffleIdxRef = useRef(0)
  const debounceRef = useRef(null)
  const shuffleDebounceRef = useRef(null)
  const playTrackFn = useRef(null)
  const onUpcomingTrackRef = useRef(null)
  const pendingUriRef = useRef(null)
  const dragIdxRef = useRef(null)
  // Set true by startShuffle; consumed by the currentTrack watcher to open the live screen
  // only after the SDK has confirmed the track — avoids the race that caused missing art
  const pendingLiveOpenRef = useRef(false)
  // Always-live library ref so advanceToNext never closes over a stale snapshot
  const libraryRef = useRef(library)
  useEffect(() => { libraryRef.current = library }, [library])
  // Always-live sets ref so the realtime handler (registered once, empty deps) can
  // compare incoming totalSongs against current local state without a stale closure.
  const setsRef = useRef(sets)
  useEffect(() => { setsRef.current = sets }, [sets])

  // One-time migration: slim any songs still carrying the raw Spotify payload
  // (available_markets etc.) down to the compact shape. Runs once the initial
  // sync settles, so it operates on whichever sets ended up authoritative
  // (remote or local). No-ops (no re-render) if nothing needs slimming.
  useEffect(() => {
    if (!syncDone) return
    setSets(prev => {
      const anyNeedsSlim = Object.values(prev.items).some(set => (set.songs ?? []).some(songNeedsSlim))
      if (!anyNeedsSlim) return prev
      const items = {}
      for (const [id, set] of Object.entries(prev.items)) {
        items[id] = {
          ...set,
          songs: (set.songs ?? []).map(s => ({ ...slimTrack(s), startMs: s.startMs, stopMs: s.stopMs })),
        }
      }
      return { ...prev, items }
    })
  }, [syncDone])

  // ?lib= URL param handler — Trivia OS between-rounds handoff.
  // Runs once, after the initial Supabase sync completes (syncDone flips true).
  useEffect(() => {
    if (!syncDone) return
    if (libParamHandledRef.current) return
    libParamHandledRef.current = true

    let lib = new URLSearchParams(window.location.search).get('lib')

    const strip = () => {
      const u = new URL(window.location)
      u.searchParams.delete('lib')
      window.history.replaceState({}, '', u.pathname + (u.search || ''))
    }

    if (!lib) { strip(); return }

    // Random branch — resolve before the existence check so it flows the same path.
    if (lib.toLowerCase() === 'random') {
      const keys = Object.keys(setsRef.current?.items ?? {})
      if (!keys.length) { strip(); return }
      lib = keys[Math.floor(Math.random() * keys.length)]
    }

    // Contract: lib must be an existing key in items.
    if (!setsRef.current?.items?.[lib]) {
      console.warn('[Jukebox] ?lib= key not found:', lib)
      strip()
      return
    }

    const targetSongs = setsRef.current.items[lib].songs
    if (!targetSongs.length) { strip(); return }

    // Select the library in state (updates the UI picker).
    setSets(prev => ({ ...prev, activeId: lib }))

    // Inline shuffle against targetSongs — bypasses startShuffle's stale `library`
    // closure. startShuffle closes over the derived `library` value; calling setSets
    // first and startShuffle immediately after would shuffle the OLD active set.
    // Capturing targetSongs from setsRef before any state update sidesteps that race.
    clearTimeout(shuffleDebounceRef.current)
    const order = shuffleArray(targetSongs.map(t => t.id))
    shuffleOrderRef.current = order
    shuffleIdxRef.current = 0
    const song = targetSongs.find(t => t.id === order[0])
    setShuffleKey(k => k + 1)
    setPlayingId(song.id)
    setIsPlaying(true)
    pendingLiveOpenRef.current = true
    pendingUriRef.current = song.uri
    playTrackFn.current?.(song)?.then(started => {
      // started === undefined means a newer play superseded this one — that
      // newer play owns the UI now, so only a genuine failure (false) resets it.
      if (started === false) {
        pendingLiveOpenRef.current = false
        pendingUriRef.current = null
        setIsPlaying(false)
        setShowLive(false)
        setPlayingId(null)
      }
    })

    strip()
  }, [syncDone])  // eslint-disable-line react-hooks/exhaustive-deps

  const advanceToNext = useCallback(() => {
    // isRetry closes over this call only — advanceToNext itself stays
    // argument-free since it's also wired directly to the skip button's
    // onClick, which would otherwise pass the click event as an arg.
    const tryPlay = (isRetry) => {
      const lib = libraryRef.current
      const { order, idx, song } = resolveNext(shuffleOrderRef.current, shuffleIdxRef.current, lib)
      shuffleOrderRef.current = order
      shuffleIdxRef.current = idx
      if (!song) return
      setPlayingId(song.id)
      playTrackFn.current?.(song)?.then(started => {
        if (started !== false) return
        if (!isRetry) {
          // Single retry — skip the one bad track, don't loop the whole set.
          tryPlay(true)
        } else {
          // Retry also failed — stop lying about playback state.
          setIsPlaying(false)
          setShowLive(false)
          setPlayingId(null)
        }
      })
    }
    tryPlay(false)
  }, [])

  const onFadeStart = useCallback(() => {
    const lib = libraryRef.current
    const upcoming = resolveUpcoming(shuffleOrderRef.current, shuffleIdxRef.current, lib)
    onUpcomingTrackRef.current?.(upcoming)
  }, [])

  const player = useSpotifyPlayer({ onAdvance: advanceToNext, onFadeStart })

  const registerUpcomingTrackHandler = useCallback(fn => {
    onUpcomingTrackRef.current = fn
  }, [])

  useEffect(() => {
    playTrackFn.current = (song) =>
      player.playTrack(song.uri, song.startMs ?? 0, song.stopMs ?? song.duration_ms)
      // returns the Promise<true|false> from playTrack so startShuffle can await it
  }, [player.playTrack])

  useEffect(() => {
    if (player.currentTrack) {
      const match = libraryRef.current.find(t => t.uri === player.currentTrack.uri)
      if (match) setPlayingId(match.id)
      if (pendingLiveOpenRef.current) {
        if (player.currentTrack.uri === pendingUriRef.current) {
          pendingLiveOpenRef.current = false
          pendingUriRef.current = null
          setShowLive(true)
        }
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
    setLibrary(prev => [{ ...slimTrack(track), startMs: 0, stopMs: track.duration_ms }, ...prev])
    addToast(`Added to ${activeSetName}`)
  }

  const removeFromLibrary = (id) => {
    setLibrary(prev => prev.filter(t => t.id !== id))
    if (playingId === id) { player.fadeAndPause(); setPlayingId(null); setIsPlaying(false) }
    addToast('Removed')
  }

  const updateTimes = useCallback((id, startMs, stopMs) => {
    setLibrary(prev => prev.map(t => t.id === id ? { ...t, startMs, stopMs } : t))
  }, [setLibrary])

  const moveOrCopySong = useCallback((songId, destSetId, mode) => {
    setSets(prev => {
      const activeSongs = prev.items[prev.activeId]?.songs ?? []
      const song = activeSongs.find(t => t.id === songId)
      if (!song) return prev
      const destSongs = prev.items[destSetId]?.songs ?? []
      if (destSongs.some(t => t.id === songId)) return prev
      const newItems = {
        ...prev.items,
        [destSetId]: {
          ...prev.items[destSetId],
          songs: [{ ...slimTrack(song), startMs: song.startMs, stopMs: song.stopMs }, ...destSongs],
        },
      }
      if (mode === 'move') {
        newItems[prev.activeId] = { ...prev.items[prev.activeId], songs: activeSongs.filter(t => t.id !== songId) }
      }
      return { ...prev, items: newItems }
    })
  }, [])

  const startShuffle = useCallback(() => {
    clearTimeout(shuffleDebounceRef.current)
    shuffleDebounceRef.current = setTimeout(async () => {
      if (library.length === 0) return
      setShuffleKey(k => k + 1)
      const order = shuffleArray(library.map(t => t.id))
      shuffleOrderRef.current = order
      shuffleIdxRef.current = 0
      const song = library.find(t => t.id === order[0])
      setPlayingId(song.id)
      setIsPlaying(true)
      pendingLiveOpenRef.current = true
      pendingUriRef.current = song.uri
      const started = await playTrackFn.current?.(song)
      // started === undefined means a newer play superseded this one — only
      // a genuine failure (false) should reset the UI.
      if (started === false) {
        pendingLiveOpenRef.current = false
        pendingUriRef.current = null
        setIsPlaying(false)
        setShowLive(false)
        setPlayingId(null)
      }
    }, 400)
  }, [library])

  const handleStop = useCallback(() => {
    clearTimeout(shuffleDebounceRef.current)
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

  useEffect(() => {
    const onDown = (e) => {
      if (e.repeat) return
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return
      if (e.target.isContentEditable) return
      if (modalTrack) return
      if (e.key === 'b') window.location.href = 'https://trivia-os.vercel.app/display?from=jukebox'
    }
    window.addEventListener('keydown', onDown)
    return () => window.removeEventListener('keydown', onDown)
  }, [modalTrack])

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

  const setOrder = Object.keys(sets.items)

  // Jukebox re-renders every 300ms during playback (position ticks). Memoize the
  // two big lists so React skips reconciling them by element identity — dozens of
  // cards with images shouldn't rebuild 3.3x/sec. Handlers close over playingId
  // etc., but every value they read is in the dep list, so closures stay fresh.
  const libraryGrid = useMemo(() => (
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [library, playingId, player.isPaused])

  const resultsList = useMemo(() => (
    <div key={resultsKey}>
      {results.map((track, i) => (
        <TrackRow
          key={track.id}
          track={track}
          index={i}
          inLibrary={library.some(t => t.id === track.id)}
          onAdd={addToLibrary}
        />
      ))}
    </div>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [results, resultsKey, library, activeSetName])

  return (
    <div className="h-screen bg-surface text-white flex flex-col overflow-hidden">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-white/[0.05] bg-surface/90 backdrop-blur-md px-6 py-4 flex items-center justify-between flex-shrink-0">
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
        <aside className="w-44 flex-shrink-0 border-r border-white/[0.05] bg-surface-inset flex flex-col py-4 overflow-y-auto">
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
                  className="flex-1 bg-white/[0.06] text-white text-[11px] rounded-lg px-2 py-1.5 outline-none border border-accent/40 placeholder-white/20 min-w-0"
                />
                <button onClick={createSet} className="text-accent text-xs px-1.5 cursor-pointer hover:opacity-80">✓</button>
              </div>
            ) : (
              <button
                onClick={() => setAddingSet(true)}
                className="w-full text-[11px] font-semibold text-accent border border-accent/30 hover:border-accent/60 hover:bg-accent/7 transition-colors duration-150 cursor-pointer px-2 py-2 rounded-lg flex items-center justify-center gap-1.5 active:scale-[0.97]"
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
                  setSets(prev => ({ ...prev, items: { ...prev.items, [id]: { ...prev.items[id], songs: [] } } }))
                  if (sets.activeId === id) { player.fadeAndPause(); setPlayingId(null); setIsPlaying(false) }
                  addToast(`Cleared ${sets.items[id].name}`)
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
              libraryGrid
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center select-none pb-16">
                <p className="text-white text-sm">
                  {sets.activeId === 'main' ? 'Your library is empty' : `${activeSetName} is empty`}
                </p>
                <p className="text-ink-muted text-xs mt-1">Search on the right to add songs</p>
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
                className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl pl-9 pr-4 py-2.5 text-white placeholder-white/20 outline-none focus:border-accent/35 focus:bg-white/[0.06] transition-colors duration-200 text-sm"
              />
              {searching && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="w-3 h-3 border-[1.5px] border-white/10 border-t-accent rounded-full animate-spin" />
                </div>
              )}
            </div>
          </div>

          {/* Search results */}
          <div className="flex-1 overflow-y-auto pb-32">
            {results.length > 0 ? (
              resultsList
            ) : searching ? null : !query ? (
              <div className="flex flex-col items-center justify-center h-full gap-4 px-6 pb-16 select-none">
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" className="text-accent/20">
                  <path d="M11 19A8 8 0 1 0 11 3a8 8 0 0 0 0 16ZM21 21l-4.35-4.35" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <div className="text-center">
                  <p className="text-sm font-medium text-white">Add songs</p>
                  <p className="text-xs text-ink-muted mt-1">Search Spotify to build your library</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-ink-muted text-xs pb-16">
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
          onClose={closeLive}
          shuffleKey={shuffleKey}
          onUpcomingTrack={registerUpcomingTrackHandler}
        />
      )}

      {modalTrack && (
        <SongDetailModal
          track={modalTrack}
          player={player}
          onUpdateTimes={updateTimes}
          onClose={() => setModalTrack(null)}
          moveOrCopySong={moveOrCopySong}
          sets={sets}
          activeId={sets.activeId}
          onToast={addToast}
        />
      )}

      <Player
        player={player}
        isPlaying={isPlaying && !player.isPaused}
        onPlay={startShuffle}
        onStop={handleStop}
        onSkip={advanceToNext}
        library={library}
        runtime={libraryRuntime}
      />

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="fixed bottom-24 right-4 z-50 flex flex-col gap-2 pointer-events-none">
          {toasts.map(t => (
            <div
              key={t.id}
              className="animate-fade-up bg-surface-raised border-l-2 border-accent text-white text-xs font-medium px-4 py-2.5 rounded-xl shadow-xl"
            >
              {t.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SetItem({ id, set, isActive, isRenaming, renamingVal, onSelect, onDelete, onClear, onStartRename, onRenameChange, onRenameCommit, onRenameCancel }) {
  const [clearPending, setClearPending] = useState(false)
  const clearTimerRef = useRef(null)

  const handleClearClick = (e) => {
    e.stopPropagation()
    setClearPending(true)
    clearTimerRef.current = setTimeout(() => setClearPending(false), 4000)
  }
  const handleClearConfirm = (e) => {
    e.stopPropagation()
    clearTimeout(clearTimerRef.current)
    setClearPending(false)
    onClear()
  }
  const handleClearCancel = (e) => {
    e.stopPropagation()
    clearTimeout(clearTimerRef.current)
    setClearPending(false)
  }

  useEffect(() => () => clearTimeout(clearTimerRef.current), [])

  const runtime = useMemo(() => fmtRuntime(calcRuntime(set.songs ?? [])), [set.songs])

  return (
    <div className={`group flex items-center rounded-lg transition-colors duration-150 ${
      isActive
        ? 'bg-surface-raised border-l-2 border-accent text-white pl-1.5 pr-2 py-1.5'
        : 'text-ink-muted hover:text-white hover:bg-surface-raised/50 px-2 py-1.5'
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
            <span className="ml-1.5 text-[11px] text-ink-muted">{set.songs.length} · {runtime}</span>
          )}
        </button>
      )}
      {!isRenaming && (
        <div className={`flex items-center gap-0.5 ml-1 flex-shrink-0 transition-opacity duration-150 ${clearPending ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          {onClear && set.songs?.length > 0 && (
            clearPending ? (
              <>
                <button onClick={handleClearConfirm} className="text-red-400/90 hover:text-red-400 text-[10px] font-semibold cursor-pointer transition-colors px-0.5">Sure?</button>
                <button onClick={handleClearCancel} className="text-ink-muted hover:text-white text-[10px] cursor-pointer transition-colors px-0.5">✕</button>
              </>
            ) : (
              <button onClick={handleClearClick} title="Clear all songs" className="text-white hover:text-red-400/80 transition-colors cursor-pointer p-0.5">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                </svg>
              </button>
            )
          )}
          {onDelete && !clearPending && (
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
        <p className="text-[10px] text-ink-muted truncate mt-0.5">{artists}</p>
      </div>
      <button
        onClick={() => onAdd(track)}
        disabled={inLibrary}
        className={`flex-shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-full transition-colors duration-150 cursor-pointer active:scale-[0.97] ${
          inLibrary
            ? 'text-accent/40 bg-accent/7 cursor-default'
            : 'text-accent bg-accent/10 hover:bg-accent/18'
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
      className={`relative group rounded-xl overflow-hidden cursor-pointer select-none transition-[transform,box-shadow] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:scale-[1.02] hover:shadow-xl ${
        isPlaying ? 'ring-1 ring-accent/40' : isPaused ? 'ring-1 ring-white/15' : ''
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
                <div key={i} className="w-[3px] bg-accent rounded-full origin-bottom"
                  style={{ height: '100%', willChange: 'transform', animation: `equalizer 0.8s ${i * 0.13}s ease-in-out infinite alternate` }} />
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
          <div className="absolute bottom-1.5 left-1.5 w-1.5 h-1.5 rounded-full bg-accent/60" />
        )}
        <button
          onClick={e => { e.stopPropagation(); onRemove() }}
          className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-black/70 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150 cursor-pointer text-[10px]"
        >✕</button>
      </div>
      <div className="p-2 bg-white/[0.03] text-center">
        <p className={`text-[11px] font-semibold truncate ${isPlaying ? 'text-accent' : 'text-white'}`}>{track.name}</p>
        <p className="text-[10px] text-ink-muted truncate mt-0.5">{artists}</p>
      </div>
    </div>
  )
}
