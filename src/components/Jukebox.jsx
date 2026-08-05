import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { searchTracks, logout } from '../lib/spotify'
import { supabase } from '../lib/supabase'
import { slimTrack, songNeedsSlim, hasTrim, uid, totalSongs } from '../lib/track'
import { shuffleArray, resolveNext, resolveUpcoming, buildSessionOrder } from '../lib/shuffle'
import { loadPlayed, savePlayed } from '../lib/playedStore'
import { useSpotifyPlayer } from '../hooks/useSpotifyPlayer'
import { prefetchPalette } from '../hooks/usePalette'
import { hasOverrides, TUNING_EVENT } from '../lib/gradientTuning'
import Player from './Player'
import LiveScreen from './LiveScreen'
import TestScreen from './TestScreen'
import SongDetailModal from './SongDetailModal'


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

// Guard 3 catch-up: `remote` has moved on past `baseline` (the last sets we
// know we were in sync with) without us. Rather than discarding whatever the
// user just did to `outgoing` (add/edit/new set) since `baseline`, replay
// that local delta on top of `remote` — per-song, by id, per set — so a
// stale-tab catch-up can't silently eat a real edit. Deletions aren't
// replayed (a song missing from `outgoing` but present in `remote` is left
// alone) since we can't tell "user deleted it" from "never had it" from ids
// alone, and leaving a song in is far less surprising than losing one.
function mergeLocalDelta(baseline, outgoing, remote) {
  const baseItems = baseline?.items ?? {}
  const items = { ...(remote?.items ?? {}) }
  for (const [setId, outSet] of Object.entries(outgoing?.items ?? {})) {
    const baseSongs = baseItems[setId]?.songs ?? []
    const baseById = new Map(baseSongs.map(s => [s.id, s]))
    const changed = (outSet.songs ?? []).filter(s => {
      const prior = baseById.get(s.id)
      return !prior || JSON.stringify(prior) !== JSON.stringify(s)
    })
    if (!changed.length) continue
    const destSet = items[setId] ?? { name: outSet.name, songs: [] }
    const destSongs = destSet.songs ?? []
    const destById = new Map(destSongs.map(s => [s.id, s]))
    changed.forEach(s => destById.set(s.id, s))
    items[setId] = { ...destSet, songs: Array.from(destById.values()) }
  }
  return { ...(remote ?? outgoing), items }
}

export default function Jukebox({ onLogout }) {
  const [sets, setSets] = useState(loadSets)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [resultsKey, setResultsKey] = useState(0)
  const [librarySearch, setLibrarySearch] = useState('')
  const [playingId, setPlayingId] = useState(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [showLive, setShowLive] = useState(false)
  const [liveEnding, setLiveEnding] = useState(false)
  const closeLive = useCallback(() => { setShowLive(false); setLiveEnding(false) }, [])
  // Gradient tuning screen (TestScreen.jsx) — a second, separate mount of the
  // real LiveScreen with the DJ board attached. Opened only by the TUNE button
  // in the header; no hotkey, deliberately, so nothing can pop it open mid-show.
  const [showTest, setShowTest] = useState(false)
  // Read by the currentTrack watcher below: while true, a confirmed track
  // opens the tuning screen INSTEAD of the real Live screen, so `showLive`
  // stays false for the whole tuning session and the real Live flow (Space
  // bar, the Live header toggle, the `b` handoff) is left exactly as it was.
  const tuningRef = useRef(false)
  // "Gradient dials moved from default" indicator on the Tune button. Twice in
  // one day (2026-07-30) a stale Tune-board override sat silently in
  // localStorage overriding the live show's look, discoverable only via
  // devtools — an amber dot on the button Ben already uses makes it visible.
  // Reads the module-level store (hasOverrides), not localStorage directly,
  // because the in-memory store is what the renderers actually obey — they can
  // disagree if localStorage was cleared externally while a tab stayed open.
  const [gradientTuned, setGradientTuned] = useState(hasOverrides)
  useEffect(() => {
    const onTuningChange = () => setGradientTuned(hasOverrides())
    window.addEventListener(TUNING_EVENT, onTuningChange)
    return () => window.removeEventListener(TUNING_EVENT, onTuningChange)
  }, [])
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

  // The chosen song for an entrance session (first song of a fresh shuffle),
  // shown to LiveScreen BEFORE Spotify is ever asked to play it (2026-08-04,
  // Ben live: "shouldnt play till the arm actually comes down" / "the song
  // can start playing as it starts flying downward" — audio and the entrance
  // animation used to be two independently-tuned setTimeout guesses with no
  // real link between them; see LiveScreen.jsx's runEntrance for the other
  // half of this). LiveScreen renders the entrance immediately off this
  // (using the library song's own art/name — it doesn't need Spotify to
  // confirm anything to draw a record), then calls back via onEntranceStart
  // at the exact moment it starts the fly-in, which is what actually fires
  // playTrackFn now instead of a fixed pre-delay.
  const [entranceSong, setEntranceSong] = useState(null)
  const entranceSongRef = useRef(null)
  useEffect(() => { entranceSongRef.current = entranceSong }, [entranceSong])
  // Guards against firing playTrackFn twice for the same entrance (the
  // callback and the fallback timer below both call this).
  const entrancePlayedRef = useRef(false)
  const entranceFallbackRef = useRef(null)
  // If the entrance callback never arrives — preload somehow hangs past its
  // own caps, or LiveScreen fails to mount for some other reason — this is
  // the backstop that guarantees a chosen song still actually plays. Today's
  // architecture (audio fires on its own timer, independent of any visual)
  // is immune to this failure mode; this fallback is what buys that same
  // guarantee back now that audio depends on the visual firing.
  const firePendingEntrancePlay = useCallback((song) => {
    if (!song || entrancePlayedRef.current) return
    entrancePlayedRef.current = true
    clearTimeout(entranceFallbackRef.current)
    playTrackFn.current?.(song)?.then(started => {
      // started === undefined means a newer play superseded this one — only
      // a genuine failure (false) should tear the entrance down.
      if (started === false) {
        setEntranceSong(null)
        setIsPlaying(false)
        setShowLive(false)
        setShowTest(false)
        setPlayingId(null)
        addToast('Couldn’t start playback — another session may be controlling Spotify')
      }
    })
  }, [addToast])
  const onEntranceStart = useCallback(() => {
    firePendingEntrancePlay(entranceSongRef.current)
  }, [firePendingEntrancePlay])

  // Song-to-song transition-first (2026-08-04) — same pattern as the
  // entrance block above, extended to advanceToNext (auto-advance + manual
  // skip). onTransitionRef is how Jukebox reaches into LiveScreen (see
  // LiveScreen.jsx's onRegisterTransition effect); pendingTransitionFireRef
  // is how LiveScreen reaches back to actually fire playTrackFn once its
  // Step 3 (the new record flying down) starts. transitionTokenRef guards
  // against a superseded attempt's fallback timer firing after a newer skip
  // has already taken over — see advanceToNext's tryPlay for where each of
  // these gets set.
  const onTransitionRef = useRef(null)
  const registerTransitionHandler = useCallback(({ token, fn }) => {
    if (fn) {
      transitionTokenIdRef.current = token
      onTransitionRef.current = fn
    } else if (transitionTokenIdRef.current === token) {
      onTransitionRef.current = null
    }
  }, [])
  const pendingTransitionFireRef = useRef(null)
  const transitionTokenRef = useRef(0)
  const onTransitionAudioStart = useCallback(() => {
    pendingTransitionFireRef.current?.()
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
  // updated_at of the remote row as of the last sets we know we're caught up
  // with (initial sync, an applied realtime update, a visibility resync, or
  // our own successful write). writeToSupabase compares against this before
  // upserting — if the remote has moved on without us (e.g. a realtime event
  // silently missed after the tab was backgrounded/asleep), our in-memory
  // `sets` is stale and must NOT be allowed to overwrite whatever's actually
  // on the server (this is how trim in/out points previously got wiped: a
  // stale tab's full-state write silently reverted a newer one).
  const lastAppliedUpdatedAtRef   = useRef(null)
  // The sets we were caught up on as of lastAppliedUpdatedAtRef — paired
  // with it everywhere it's set. Guard 3 diffs `outgoing` against this to
  // find what the user actually changed since, so a stale-tab catch-up can
  // merge that delta into the fresh remote row instead of discarding it.
  const lastAppliedSetsRef        = useRef(null)
  // Set by the realtime handler when an incoming update is dropped because a
  // local write is in-flight. The debounced writer merges any songs in here
  // that aren't already local (e.g. a QuickAdd) before it upserts, so a
  // same-window remote write doesn't get last-write-wins clobbered.
  const stashedIncomingSetsRef    = useRef(null)

  // Writes the current sets to Supabase (merging any stashed incoming songs
  // first). Shared by the 500ms debounced auto-save and by flushPendingWrite,
  // which the 'b' hotkey uses to force this through immediately before
  // navigating away — otherwise a debounce-window edit gets silently dropped
  // when the tab navigates mid-timer.
  const writeToSupabase = useCallback(async () => {
    supabaseDebounceRef.current = null
    // Guard 1a — never write before the initial sync has confirmed the remote state.
    // This is the primary protection against the first-render empty-default race.
    if (!syncCompletedRef.current) return

    // Merge in any songs from an incoming realtime update that arrived
    // while this write was pending and don't exist locally yet (e.g. a
    // QuickAdd from another device), so this write doesn't clobber them.
    let outgoing = setsRef.current
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
      if (outgoing !== setsRef.current) setSets(outgoing)
    }

    // Guard 3 — compare-and-swap on updated_at. If the remote row has moved on
    // since the last sets we know we're caught up with, and it wasn't our own
    // last write, this tab's `sets` is stale (most likely: a realtime UPDATE
    // event was silently missed while backgrounded/asleep). Blindly writing
    // `outgoing` would overwrite someone else's newer edit, and blindly
    // adopting the remote row would discard whatever the user just did here
    // (e.g. edited a trim point right after this tab went stale) — so instead
    // replay outgoing's delta (vs. the last-synced baseline) onto the fresh
    // remote row and write that merged result.
    // Skipped when a stash was just merged above — that merge already folds
    // in the concurrent remote change, so this write is the correct catch-up,
    // not a stale overwrite (checking here would just discard the merge and
    // drop our own pending edit instead).
    if (!stashed && lastAppliedUpdatedAtRef.current) {
      try {
        // Cheap check first (no sets payload) — only pull the full row if it
        // actually looks stale, to avoid doubling payload size on every write.
        const { data: check } = await supabase
          .from('jukebox_state').select('updated_at, last_writer').eq('id', 'singleton').single()
        if (
          check &&
          check.updated_at !== lastAppliedUpdatedAtRef.current &&
          check.last_writer !== sessionIdRef.current
        ) {
          const { data: remoteRow } = await supabase
            .from('jukebox_state').select('sets, updated_at').eq('id', 'singleton').single()
          if (!remoteRow?.sets) return
          outgoing = mergeLocalDelta(lastAppliedSetsRef.current, outgoing, remoteRow.sets)
          justLoadedFromSupabaseRef.current = true
          setSets(outgoing)
          localStorage.setItem('trivia_sets', JSON.stringify(outgoing))
          // Fall through to the upsert below so the merged result — remote's
          // catch-up plus our preserved local delta — actually gets persisted,
          // instead of leaving it only-local until the next real edit.
        }
      } catch { return }  // cannot verify remote state — do not risk overwriting it
    }

    const nowIso = new Date().toISOString()
    try {
      await supabase.from('jukebox_state').upsert({
        id: 'singleton',
        sets: outgoing,
        last_writer: sessionIdRef.current,
        updated_at: nowIso,
      })
      lastAppliedUpdatedAtRef.current = nowIso
      lastAppliedSetsRef.current = outgoing
    } catch { /* silent — localStorage is always the local fallback */ }
  }, [])

  // If a debounced write is pending, cancel its timer and run it right now —
  // used before navigating away so an in-flight edit isn't lost.
  const flushPendingWrite = useCallback(async () => {
    if (supabaseDebounceRef.current === null) return
    clearTimeout(supabaseDebounceRef.current)
    await writeToSupabase()
  }, [writeToSupabase])

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
    supabaseDebounceRef.current = setTimeout(writeToSupabase, 500)
  }, [sets, writeToSupabase])

  // On mount: fetch the authoritative sets from Supabase.
  // One-way migration: push localStorage→Supabase ONLY when remote is empty AND
  // local has songs. Never the reverse. Never empty-over-populated in either direction.
  useEffect(() => {
    async function syncFromSupabase() {
      try {
        const { data, error } = await supabase
          .from('jukebox_state')
          .select('sets, updated_at')
          .eq('id', 'singleton')
          .single()
        if (error || !data?.sets) return
        const sbSets = data.sets
        if (totalSongs(sbSets) === 0) {
          // Remote is empty — migrate localStorage up if it has songs
          const lsSets = loadSets()
          if (totalSongs(lsSets) > 0) {
            try {
              const nowIso = new Date().toISOString()
              await supabase.from('jukebox_state').upsert({
                id: 'singleton',
                sets: lsSets,
                last_writer: sessionIdRef.current,
                updated_at: nowIso,
              })
              lastAppliedUpdatedAtRef.current = nowIso
              lastAppliedSetsRef.current = lsSets
            } catch { /* migration failed silently — localStorage remains the truth */ }
          }
        } else {
          // Remote has songs — use it as the source of truth
          justLoadedFromSupabaseRef.current = true
          lastAppliedUpdatedAtRef.current = data.updated_at
          lastAppliedSetsRef.current = sbSets
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
          lastAppliedUpdatedAtRef.current = payload.new?.updated_at ?? lastAppliedUpdatedAtRef.current
          lastAppliedSetsRef.current = incoming
          setSets(incoming)
          localStorage.setItem('trivia_sets', JSON.stringify(incoming))
        }
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  // Realtime subscriptions can silently stop delivering events after a tab is
  // backgrounded or the laptop sleeps (websocket drops with no error), so a
  // long-open tab can drift out of sync without ever knowing it. Re-pull the
  // remote row whenever the tab regains focus and apply it if it's actually
  // newer — same guards as the realtime handler above, just polled on regain
  // instead of pushed. Skips while a local edit is mid-debounce so it can't
  // stomp something the user just typed.
  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== 'visible') return
      if (!syncCompletedRef.current) return
      if (supabaseDebounceRef.current !== null) return
      try {
        const { data } = await supabase
          .from('jukebox_state').select('sets, updated_at').eq('id', 'singleton').single()
        if (!data?.sets) return
        if (data.updated_at === lastAppliedUpdatedAtRef.current) return  // already current
        if (totalSongs(data.sets) === 0 && totalSongs(setsRef.current) > 0) return  // Guard 2
        lastAppliedUpdatedAtRef.current = data.updated_at
        lastAppliedSetsRef.current = data.sets
        justLoadedFromSupabaseRef.current = true
        setSets(data.sets)
        localStorage.setItem('trivia_sets', JSON.stringify(data.sets))
      } catch { /* offline — keep showing local state, next regain will retry */ }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  const shuffleOrderRef = useRef([])
  const shuffleIdxRef = useRef(0)
  // Pending timers from advanceToNext's 300ms audio-start delay (see below) —
  // cleared on stop so a delayed play can't fire after the user's already
  // stopped playback.
  const advancePlayTimersRef = useRef([])
  // Ids played so far tonight, PER SET — one Set per set id, not one shared
  // Set for the whole app. Consulted by buildSessionOrder/resolveNext so
  // pressing Shuffle-play again never repeats a song until every track in
  // that particular set has had a turn — then a new lap starts for that set
  // and it clears itself (see shuffle.js's freshOrderFromPool).
  //
  // Previously this was a single shared Set across every set/theme, which
  // had a real bug: exhausting a small set's pool (freshOrderFromPool's
  // playedIds.clear()) wiped every OTHER set's play history too. That was
  // invisible before 2026-07-29 because the whole thing lived only in memory
  // and died on every page reload anyway — the moment it's persisted (see
  // playedStore.js) a shared Set would make that bug real and visible, so
  // it's per-set from the start here.
  //
  // playedSetsRef is a live in-memory cache (Map<setId, Set<songId>>);
  // getPlayedSet lazily loads a set's history from localStorage
  // (playedStore.js) the first time it's needed, which is what makes
  // no-repeat survive the Jukebox<->Trivia OS full-page-navigation handoff
  // between rounds, not just a single uninterrupted session.
  const playedSetsRef = useRef(new Map())
  const getPlayedSet = useCallback((setId) => {
    let set = playedSetsRef.current.get(setId)
    if (!set) {
      set = loadPlayed(setId)
      playedSetsRef.current.set(setId, set)
    }
    return set
  }, [])
  const persistPlayed = useCallback((setId) => {
    const set = playedSetsRef.current.get(setId)
    if (set) savePlayed(setId, set)
  }, [])
  const debounceRef = useRef(null)
  const searchTokenRef = useRef(0)
  const shuffleDebounceRef = useRef(null)
  const handoffHoldRef = useRef(null)
  const playTrackFn = useRef(null)
  const onUpcomingTrackRef = useRef(null)
  // Tokens for identity-checked unregister (2026-08-04) — LiveScreen can
  // mount/unmount fast enough (e.g. StrictMode, or a skip landing right as
  // the old screen tears down) that a stale cleanup's `register(null)` can
  // race a newer screen's registration and wipe out the handler it just set.
  // Each register call carries a unique token; the unregister call only
  // clears the ref if its token still matches the last one stored — a
  // superseded cleanup silently no-ops instead of clobbering the new one.
  const upcomingTrackTokenRef = useRef(null)
  const transitionTokenIdRef = useRef(null)
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
          songs: (set.songs ?? []).map(s => ({ ...slimTrack(s), startMs: s.startMs, stopMs: s.stopMs, gradientOverride: s.gradientOverride, gradientOverride1: s.gradientOverride1 })),
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
    // Only pick among sets that actually have songs, so a random landing
    // never silently no-ops on an empty theme set.
    if (lib.toLowerCase() === 'random') {
      const items = setsRef.current?.items ?? {}
      const keys = Object.keys(items).filter(k => items[k].songs?.length)
      if (!keys.length) {
        addToast('No sets have songs — nothing to shuffle')
        strip()
        return
      }
      lib = keys[Math.floor(Math.random() * keys.length)]
    }

    // Contract: lib must be an existing key in items.
    if (!setsRef.current?.items?.[lib]) {
      console.warn('[Jukebox] ?lib= key not found:', lib)
      strip()
      return
    }

    const allTargetSongs = setsRef.current.items[lib].songs
    if (!allTargetSongs.length) {
      const setName = setsRef.current.items[lib].name ?? lib
      addToast(`“${setName}” has no songs — pick another theme`)
      strip()
      return
    }
    // Shuffle only ever plays songs someone's actually trimmed (see
    // startShuffle's comment for why) — untrimmed songs stay in the library
    // and visible in the grid, they just never come up in shuffle/skip.
    const targetSongs = allTargetSongs.filter(hasTrim)
    if (!targetSongs.length) {
      const setName = setsRef.current.items[lib].name ?? lib
      addToast(`“${setName}” has no trimmed songs — scrub a few songs first`)
      strip()
      return
    }

    // Select the library in state (updates the UI picker).
    setSets(prev => ({ ...prev, activeId: lib }))

    // Inline shuffle against targetSongs — bypasses startShuffle's stale `library`
    // closure. startShuffle closes over the derived `library` value; calling setSets
    // first and startShuffle immediately after would shuffle the OLD active set.
    // Capturing targetSongs from setsRef before any state update sidesteps that race.
    clearTimeout(shuffleDebounceRef.current)
    const playedIds = getPlayedSet(lib)
    const order = buildSessionOrder(targetSongs, playedIds)
    shuffleOrderRef.current = order
    shuffleIdxRef.current = 0
    const song = targetSongs.find(t => t.id === order[0])
    playedIds.add(song.id)
    persistPlayed(lib)
    prefetchPalette(song.album?.images?.[0]?.url)
    // A new play supersedes any in-flight LiveScreen exit — clear liveEnding
    // so the fresh session doesn't mount into the outgoing animation state.
    setLiveEnding(false)
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
      // Notify LiveScreen's upcoming-track preview before this pick starts
      // playing. Auto-advance gets this ~2.5s early from onFadeStart's fade
      // timer; manual Skip and retry call tryPlay directly and skipped that
      // step, leaving the gradient crossfade to hard-cut instead of blend.
      // Mirrors onFadeStart's own call, computed before shuffleIdxRef moves.
      onUpcomingTrackRef.current?.(
        resolveUpcoming(shuffleOrderRef.current, shuffleIdxRef.current, libraryRef.current.filter(hasTrim))
      )
      // Trimmed-only, same as startShuffle/the ?lib= handoff — a song
      // without a trim shouldn't come up on auto-advance or skip either.
      // shuffle.js's resolveNext already treats any id missing from `lib` as
      // "removed since the order was built" and skips it, so handing it the
      // trimmed subset here (instead of the full library) gets untrimmed
      // songs skipped for free, no change needed in shuffle.js itself.
      const lib = libraryRef.current.filter(hasTrim)
      const activeId = setsRef.current.activeId
      const playedIds = getPlayedSet(activeId)
      const { order, idx, song } = resolveNext(shuffleOrderRef.current, shuffleIdxRef.current, lib, playedIds)
      shuffleOrderRef.current = order
      shuffleIdxRef.current = idx
      if (!song) {
        // Library (or active set) is empty — e.g. emptied from another
        // device mid-play. Nothing left to advance to; stop lying about
        // playback state instead of leaving a frozen "playing" UI.
        setIsPlaying(false)
        setShowLive(false)
        setPlayingId(null)
        addToast('No songs left to play in this set')
        return
      }
      playedIds.add(song.id)
      persistPlayed(activeId)
      // A new play supersedes any in-flight LiveScreen exit — clear liveEnding
      // so the fresh session doesn't mount into the outgoing animation state.
      setLiveEnding(false)
      setPlayingId(song.id)

      // Transition-first (2026-08-04, Ben live: "song b is playing almost
      // immediately after song a is done" on the old fixed-300ms-timer
      // design — same fix already shipped for the entrance/first song, see
      // startShuffle above and LiveScreen.jsx's runTransition). Kick off the
      // visual transition immediately via the imperative handler LiveScreen
      // registered (onRegisterTransition, see LiveScreen.jsx) — it starts
      // the arm lift and fly-up using this library song's own art/name, no
      // Spotify confirmation needed for that half. The real playTrackFn call
      // is deferred to whenever runTransition's Step 3 calls back through
      // onTransitionAudioStart, right as the new record starts flying down.
      const token = ++transitionTokenRef.current
      // If nothing is registered (LiveScreen unmounted — e.g. the host hit
      // Escape or the close button to get back to the library mid-show,
      // which does NOT stop playback), the pre-signal is a silent no-op and
      // only the fallback below would ever fire the play call — meaning
      // every song from here on would have a real 2.5s gap of dead air
      // instead of ~1.3s (2026-08-04, critique review). Skip straight to
      // firing when there's no one to animate for.
      const hasScreen = !!onTransitionRef.current
      onTransitionRef.current?.(song)

      let fired = false
      let fallbackTimer = null
      const fire = () => {
        // token check: a newer tryPlay call (another skip) superseded this
        // one — LiveScreen's own busy/pending queue already handles that on
        // the visual side (see runTransition's pendingRef draining), this
        // just stops a now-stale play call from firing after the fact.
        if (fired || token !== transitionTokenRef.current) return
        fired = true
        clearTimeout(fallbackTimer)
        playTrackFn.current?.(song)?.then(started => {
          if (started !== false) return
          if (!isRetry) {
            // Single retry — skip the one bad track, don't loop the whole set.
            tryPlay(true)
          } else {
            // Retry also failed — stop lying about playback state, and actually
            // say so. This used to fail silently: music would just stop with
            // zero indication why, which is indistinguishable from "the app is
            // broken" in the moment. addToast is defined earlier in this
            // component and is a stable useCallback, safe to reference here.
            setIsPlaying(false)
            setShowLive(false)
            setPlayingId(null)
            addToast('Playback stalled and auto-retry failed — hit Shuffle to restart')
          }
        })
      }
      pendingTransitionFireRef.current = fire
      if (!hasScreen) {
        fire()
      } else {
        // Backstop, not optional (2026-08-04, Opus review): unlike the
        // entrance, this path runs every song all night, and LiveScreen can
        // be torn down mid-flight after this fires but before Step 3 (host
        // closes it while a transition is already in progress). Without
        // this, the callback that was supposed to fire the play call never
        // arrives and auto-advance silently goes dead for the rest of the
        // night. Token-guarded so it's a no-op if the real callback already
        // fired or a newer skip superseded this attempt.
        fallbackTimer = setTimeout(fire, 2500)
        advancePlayTimersRef.current.push(fallbackTimer)
      }
    }
    tryPlay(false)
  }, [addToast])

  const onFadeStart = useCallback(() => {
    // Trimmed-only, matching tryPlay above — the upcoming-track preview
    // should never name a song that skip/auto-advance would then refuse to
    // actually play.
    const lib = libraryRef.current.filter(hasTrim)
    const upcoming = resolveUpcoming(shuffleOrderRef.current, shuffleIdxRef.current, lib)
    onUpcomingTrackRef.current?.(upcoming)
  }, [])

  const player = useSpotifyPlayer({ onAdvance: advanceToNext, onFadeStart })

  const registerUpcomingTrackHandler = useCallback(({ token, fn }) => {
    if (fn) {
      upcomingTrackTokenRef.current = token
      onUpcomingTrackRef.current = fn
    } else if (upcomingTrackTokenRef.current === token) {
      onUpcomingTrackRef.current = null
    }
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
          // Tuning session: the same confirmed-track moment opens the test
          // screen and leaves showLive alone (see tuningRef above).
          if (tuningRef.current) setShowTest(true)
          else setShowLive(true)
        }
      }
      // Warm the upcoming song's palette now, not at fade start — a cold
      // /api/palette fetch (0.5-1.5s) otherwise eats most of the 2.5s
      // encroachment window the gradient gets before the song switches.
      // Trimmed-only, same reasoning as onFadeStart above.
      const upcoming = resolveUpcoming(shuffleOrderRef.current, shuffleIdxRef.current, libraryRef.current.filter(hasTrim))
      prefetchPalette(upcoming?.album?.images?.[0]?.url)
    }
  }, [player.currentTrack?.uri])

  const search = useCallback((q) => {
    clearTimeout(debounceRef.current)
    if (!q.trim()) { searchTokenRef.current += 1; setResults([]); return }
    const token = ++searchTokenRef.current
    debounceRef.current = setTimeout(async () => {
      setSearching(true)
      try {
        const tracks = await searchTracks(q)
        // A newer search (the debounce clears only a not-yet-fired timer, not
        // an in-flight fetch) may have already resolved and rendered its
        // results by the time this one lands — ignore a stale response so it
        // can't overwrite what the user is currently seeing.
        if (searchTokenRef.current !== token) return
        setResults(tracks)
        setResultsKey(k => k + 1)
      } catch (err) {
        console.error('[search]', err)
        if (searchTokenRef.current === token) setResults([])
      } finally { if (searchTokenRef.current === token) setSearching(false) }
    }, 280)
  }, [])

  const addToLibrary = (track) => {
    if (!track || library.some(t => t.id === track.id)) return
    setLibrary(prev => [{ ...slimTrack(track), startMs: 0, stopMs: track.duration_ms }, ...prev])
    addToast(`Added to ${activeSetName}`)
  }

  const removeFromLibrary = (id) => {
    setLibrary(prev => prev.filter(t => t.id !== id))
    // Route through handleStop (not a partial fadeAndPause/setPlayingId inline)
    // so the Live overlay tears down too — it only ever closes via handleStop's
    // showLive/liveEnding logic, otherwise it's left open over dead audio.
    if (playingId === id) handleStop()
    addToast('Removed')
  }

  const updateTimes = useCallback((id, startMs, stopMs) => {
    setLibrary(prev => prev.map(t => t.id === id ? { ...t, startMs, stopMs } : t))
  }, [setLibrary])

  // Manual gradient-color override (2026-08-03, thinktank round 3; extended
  // 2026-08-04 to color 1 too): a per-song hex the owner picked in
  // SongDetailModal to replace an auto-extracted gradient color. `slot` is
  // 1 or 2 — slot 1 writes `gradientOverride1`, slot 2 writes the original
  // `gradientOverride` field (kept unrenamed for backward compat with
  // already-saved songs). Manual choices are stored exactly as selected;
  // the renderer handles the resulting two-pool blend. hex === null clears
  // the override at that slot, falling back to auto-pick.
  const updateGradientOverride = useCallback((id, slot, hex) => {
    const field = slot === 1 ? 'gradientOverride1' : 'gradientOverride'
    setLibrary(prev => prev.map(t => t.id === id ? { ...t, [field]: hex } : t))
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
          songs: [{ ...slimTrack(song), startMs: song.startMs, stopMs: song.stopMs, gradientOverride: song.gradientOverride, gradientOverride1: song.gradientOverride1 }, ...destSongs],
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
      // Shuffle/skip only ever play songs someone's actually trimmed in
      // SongDetailModal — an untrimmed song plays its full raw length with
      // no fade-out/auto-advance trigger (stopMs defaults to duration_ms,
      // see playTrackFn below), which doesn't fit a timed grading-break
      // rotation the way a deliberately-trimmed clip does. Untrimmed songs
      // stay in the library and visible in the grid, they just don't come
      // up in shuffle until someone sets trim points for them.
      const scrubbed = library.filter(hasTrim)
      if (scrubbed.length === 0) {
        addToast('No trimmed songs in this set — scrub a few songs first')
        return
      }
      setShuffleKey(k => k + 1)
      const activeId = setsRef.current.activeId
      const playedIds = getPlayedSet(activeId)
      const order = buildSessionOrder(scrubbed, playedIds)
      shuffleOrderRef.current = order
      shuffleIdxRef.current = 0
      const song = scrubbed.find(t => t.id === order[0])
      playedIds.add(song.id)
      persistPlayed(activeId)
      // Warm the first song's palette during play startup so LiveScreen's
      // usePalette hits cache at mount instead of re-rendering mid-entrance.
      prefetchPalette(song.album?.images?.[0]?.url)
      // A new play supersedes any in-flight LiveScreen exit — clear liveEnding
      // so the fresh session doesn't mount into the outgoing animation state.
      setLiveEnding(false)
      setPlayingId(song.id)
      setIsPlaying(true)
      // Entrance-first (2026-08-04): show the record immediately using the
      // library song's own art/name — LiveScreen doesn't need Spotify to
      // confirm anything to draw it — and let its entrance animation itself
      // (via onEntranceStart) decide when to actually fire playTrackFn.
      // pendingUriRef stays set so the currentTrack watcher below can still
      // do its OTHER job (matching playingId / prefetching the next song's
      // palette) once Spotify does confirm, a moment later.
      entrancePlayedRef.current = false
      pendingUriRef.current = song.uri
      setEntranceSong(song)
      if (tuningRef.current) setShowTest(true)
      else setShowLive(true)
      clearTimeout(entranceFallbackRef.current)
      entranceFallbackRef.current = setTimeout(() => firePendingEntrancePlay(song), 1500)
    }, 850)   // 400 -> 650 -> 850, 2026-08-04: Ben wanted the first song's audio delayed another 200ms
    // (this now just delays the entrance appearing at all — a real request
    // to speed that up, separate from the audio-vs-visual ordering, should
    // touch this number directly)
  }, [library, addToast, firePendingEntrancePlay])

  const handleStop = useCallback(() => {
    clearTimeout(shuffleDebounceRef.current)
    advancePlayTimersRef.current.forEach(clearTimeout)
    advancePlayTimersRef.current = []
    clearTimeout(entranceFallbackRef.current)
    entrancePlayedRef.current = true   // stop is itself a reason not to fire a queued entrance play
    setEntranceSong(null)
    transitionTokenRef.current++   // invalidate any pending transition fire/fallback — stop means stop
    pendingTransitionFireRef.current = null
    const fadeDone = player.fadeAndPause()
    setIsPlaying(false)
    setPlayingId(null)
    if (showLive) {
      setLiveEnding(true)  // LiveScreen animates out, then calls onClose → setShowLive(false)
    } else {
      setShowLive(false)
    }
    // Returned so callers (SongDetailModal preview) can wait for the fade to
    // finish before starting new playback instead of clobbering it mid-fade.
    return fadeDone
  }, [player.fadeAndPause, showLive])

  // ── Gradient tuning screen ────────────────────────────────────────────────
  // Opens on a real shuffled session — same startShuffle() the Space bar and
  // the Player's play button call — because tuning the background against a
  // static preview tells you nothing about the entrance blend, the song-to-song
  // crossfade, or how the lights drift behind a spinning record.
  const openTuning = useCallback(() => {
    if (showTest) return
    tuningRef.current = true
    // Never both screens at once: if a live session is up, hand it over rather
    // than stacking a second full-screen overlay on top of it.
    setShowLive(false)
    setLiveEnding(false)
    setShowTest(true)   // mounts straight away; LiveScreen shows its empty-platter
                        // waiting state until the SDK confirms the first track
    startShuffle()
  }, [showTest, startShuffle])

  const closeTuning = useCallback(() => {
    tuningRef.current = false
    // Drop any not-yet-confirmed play, or a track landing a moment later would
    // flip showLive true and pop the real Live screen open over the library.
    pendingLiveOpenRef.current = false
    pendingUriRef.current = null
    setShowTest(false)
    handleStop()   // showLive is false throughout a tuning session, so this fades
                   // the audio and clears playback state without ever touching
                   // liveEnding — nothing half-open for Space or `b` to trip on.
  }, [handleStop])

  const switchSet = (id) => {
    if (id === sets.activeId) return
    // Always cancel a pending shuffle start, not just when isPlaying is
    // already true — startShuffle's 400ms debounce leaves isPlaying false
    // until it fires, so switching sets inside that window previously let
    // the stale timeout play a song from the set the user just left.
    clearTimeout(shuffleDebounceRef.current)
    if (isPlaying) handleStop()
    setPlayingId(null)
    setSets(prev => ({ ...prev, activeId: id }))
    setLibrarySearch('')
  }

  const createSet = () => {
    const name = newSetName.trim()
    if (!name) return
    // Block duplicate names (case-insensitive) — covers 'Main Library' too,
    // since the default library is a real entry in sets.items.
    const duplicate = Object.values(sets.items).some(
      s => s.name.trim().toLowerCase() === name.toLowerCase()
    )
    if (duplicate) {
      addToast(`A set named “${name}” already exists`)
      return  // keep the input open so the user can retry
    }
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
    // See switchSet: cancel a pending shuffle start too, not just live playback.
    if (sets.activeId === id) clearTimeout(shuffleDebounceRef.current)
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
      if (e.repeat) return
      if (e.code !== 'Space') return
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return
      if (modalTrack) return
      e.preventDefault()
      if (isPlaying) handleStop()
      // While LiveScreen is animating out (liveEnding), ignore play — starting
      // a track mid-exit would fight the transition. Stop is already a no-op here.
      else if (!liveEnding) startShuffle()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isPlaying, handleStop, startShuffle, modalTrack, liveEnding])

  useEffect(() => {
    const onDown = (e) => {
      if (e.repeat) return
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return
      if (e.target.isContentEditable) return
      if (modalTrack) return
      if (e.key === 'b') {
        // Hold-to-confirm: a quick tap does nothing (too easy to hit mid-show).
        // Only a ~500ms hold triggers the handoff; keyup below cancels the timer.
        // e.repeat guard above keeps auto-repeat from refiring this during the hold.
        handoffHoldRef.current = setTimeout(async () => {
          handoffHoldRef.current = null
          if (isPlaying || showLive) {
            // Play the same stop-and-animate exit spacebar uses (fade audio,
            // LiveScreen tonearm lift + record fly-up) instead of cutting to
            // trivia-os mid-song. Wait matches LiveScreen's exit sequence:
            // 400ms lead-in + 1850ms to onClose (see its ending effect).
            handleStop()
            await new Promise(r => setTimeout(r, 2250))
          }
          // Flush any pending debounced Supabase write first — otherwise an edit
          // made just before handing back to trivia-os (add/reorder/trim/rename)
          // gets silently dropped when the tab navigates mid-debounce.
          await flushPendingWrite()
          window.location.href = 'https://trivia-os.vercel.app/display?from=jukebox'
        }, 500)
      }
    }
    const onUp = (e) => {
      if (e.key !== 'b') return
      // Released before the hold threshold — cancel cleanly, no side effects.
      clearTimeout(handoffHoldRef.current)
      handoffHoldRef.current = null
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      clearTimeout(handoffHoldRef.current)
      handoffHoldRef.current = null
    }
  }, [modalTrack, flushPendingWrite, isPlaying, showLive, handleStop])

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
  const filteredLibrary = useMemo(() => {
    const q = librarySearch.trim().toLowerCase()
    if (!q) return library
    return library.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.artists?.some(a => a.name.toLowerCase().includes(q))
    )
  }, [library, librarySearch])

  const libraryGrid = useMemo(() => {
    const indexById = new Map(library.map((t, i) => [t.id, i]))
    return (
    <div className="grid grid-cols-4 gap-2">
      {filteredLibrary.map((track) => {
        const i = indexById.get(track.id)
        return (
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
        )
      })}
    </div>
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredLibrary, library, playingId, player.isPaused])

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
          {/* Gradient tuning — always visible, no hotkey. Starts a real
              shuffled session and opens the test screen with the DJ board. */}
          <button
            onClick={openTuning}
            className={`relative text-xs font-medium transition-colors duration-150 cursor-pointer px-3 py-1 rounded-full active:scale-[0.97] ${
              showTest ? 'bg-white text-black' : 'text-white hover:text-white border border-white/10 hover:border-white/25'
            }`}
            title={gradientTuned
              ? 'Gradient dials are moved from default — the live gradient is using tuned values. Open the board and RESET ALL to go back to stock.'
              : 'Gradient tuning board — shuffles and opens the test screen'}
          >
            Tune
            {gradientTuned && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400" />
            )}
          </button>
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
                    if (e.repeat) return
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
                  // handleStop (not a partial fadeAndPause/setPlayingId inline) so
                  // the Live overlay tears down too instead of being left open
                  // over dead audio, and any pending shuffle-start gets cancelled.
                  if (sets.activeId === id) handleStop()
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

          {/* Library search — filters the songs already in this set, to jump
              straight to a track's trim editor instead of scrolling. Separate
              from the Spotify search on the right, which adds new songs. */}
          {library.length > 0 && (
            <div className="p-3 border-b border-white/[0.05] flex-shrink-0">
              <div className="relative">
                <div className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-white">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10ZM14 14l-3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </div>
                <input
                  type="text"
                  placeholder="Search this library…"
                  value={librarySearch}
                  onChange={e => setLibrarySearch(e.target.value)}
                  className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl pl-9 pr-8 py-2.5 text-white placeholder-white/20 outline-none focus:border-accent/35 focus:bg-white/[0.06] transition-colors duration-200 text-sm"
                />
                {librarySearch && (
                  <button
                    onClick={() => setLibrarySearch('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white transition-colors duration-150 cursor-pointer text-sm leading-none"
                    aria-label="Clear library search"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Library grid */}
          <div className="flex-1 overflow-y-auto p-3 pb-32">
            {library.length > 0 ? (
              filteredLibrary.length > 0 ? (
                libraryGrid
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-center select-none pb-16">
                  <p className="text-white text-sm">No matches for &ldquo;{librarySearch}&rdquo;</p>
                </div>
              )
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
          entranceSong={entranceSong}
          onEntranceStart={onEntranceStart}
          onRegisterTransition={registerTransitionHandler}
          onTransitionAudioStart={onTransitionAudioStart}
        />
      )}

      {/* Tuning screen — mutually exclusive with showLive (openTuning clears it,
          and the currentTrack watcher routes to showTest while tuningRef is set),
          so only one full-screen LiveScreen is ever mounted. */}
      {showTest && (
        <TestScreen
          currentTrack={player.currentTrack}
          isPaused={player.isPaused}
          shuffleKey={shuffleKey}
          onUpcomingTrack={registerUpcomingTrackHandler}
          entranceSong={entranceSong}
          onEntranceStart={onEntranceStart}
          onRegisterTransition={registerTransitionHandler}
          onTransitionAudioStart={onTransitionAudioStart}
          onClose={closeTuning}
        />
      )}

      {modalTrack && (
        <SongDetailModal
          track={modalTrack}
          player={player}
          onUpdateTimes={updateTimes}
          onUpdateGradientOverride={updateGradientOverride}
          onClose={() => setModalTrack(null)}
          moveOrCopySong={moveOrCopySong}
          sets={sets}
          activeId={sets.activeId}
          onToast={addToast}
          isLiveShuffling={isPlaying}
          onStopLiveShuffle={handleStop}
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
  const trimmed = hasTrim(track)
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
        {trimmed && !isPlaying && !isPaused && (
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
