import { useState, useEffect, useRef } from 'react'
import { searchTracks } from '../lib/spotify'
import { supabase } from '../lib/supabase'
import { slimTrack } from '../lib/track'

function uid() { return Math.random().toString(36).slice(2) }

function totalSongs(sets) {
  return Object.values(sets?.items ?? {}).reduce((n, s) => n + (s.songs?.length ?? 0), 0)
}

export default function QuickAdd() {
  const sessionIdRef = useRef(uid())

  const [sets, setSets]           = useState(null)
  const [setsError, setSetsError] = useState(false)

  const [query, setQuery]         = useState('')
  const [results, setResults]     = useState([])
  const [searching, setSearching] = useState(false)

  // 'search' | 'confirm'
  const [step, setStep]           = useState('search')
  const [track, setTrack]         = useState(null)

  const [destSetId, setDestSetId] = useState('')

  const [saveState, setSaveState]     = useState('idle') // 'idle'|'saving'|'saved'|'error'
  const [errorMsg, setErrorMsg]       = useState('')
  const [savedToName, setSavedToName] = useState('')

  // Load sets from Supabase on mount
  useEffect(() => {
    supabase
      .from('jukebox_state')
      .select('sets')
      .eq('id', 'singleton')
      .single()
      .then(({ data, error }) => {
        if (error || !data?.sets) { setSetsError(true); return }
        setSets(data.sets)
        setDestSetId(data.sets.activeId ?? Object.keys(data.sets.items)[0] ?? '')
      })
      .catch(() => setSetsError(true))
  }, [])

  // Debounced search
  useEffect(() => {
    if (!query.trim()) { setResults([]); setSearching(false); return }
    setSearching(true)
    const id = setTimeout(async () => {
      try {
        const tracks = await searchTracks(query)
        setResults(tracks)
      } catch { setResults([]) }
      finally { setSearching(false) }
    }, 300)
    return () => clearTimeout(id)
  }, [query])

  const handleSelectTrack = (t) => {
    setTrack(t)
    setSaveState('idle')
    setErrorMsg('')
    setStep('confirm')
  }

  const handleBack = () => {
    setStep('search')
    setTrack(null)
  }

  const handleAdd = async () => {
    if (!destSetId || !track || !sets) return
    setSaveState('saving')
    setErrorMsg('')
    try {
      // Always fetch fresh sets to avoid overwriting concurrent laptop changes
      const { data, error } = await supabase
        .from('jukebox_state')
        .select('sets')
        .eq('id', 'singleton')
        .single()
      if (error) throw error

      const currentSets  = data.sets
      const currentSongs = currentSets.items[destSetId]?.songs ?? []

      if (currentSongs.some(s => s.id === track.id)) {
        setSaveState('error')
        setErrorMsg('Already in this library')
        return
      }

      const song = { ...slimTrack(track), startMs: 0, stopMs: track.duration_ms ?? 0 }
      const updatedSets = {
        ...currentSets,
        items: {
          ...currentSets.items,
          [destSetId]: {
            ...currentSets.items[destSetId],
            songs: [...currentSongs, song],
          },
        },
      }

      // Guard: never write empty sets (structurally impossible here, but enforced explicitly)
      if (totalSongs(updatedSets) === 0) throw new Error('Write aborted: would produce empty library')

      // Phone sessionId is independent from the laptop's — laptop realtime handler
      // sees last_writer !== its own sessionId and applies this as a remote change.
      const { error: writeError } = await supabase
        .from('jukebox_state')
        .upsert({
          id: 'singleton',
          sets: updatedSets,
          last_writer: sessionIdRef.current,
          updated_at: new Date().toISOString(),
        })
      if (writeError) throw writeError

      const name = currentSets.items[destSetId]?.name ?? 'Library'
      setSavedToName(name)
      setSets(updatedSets)
      setSaveState('saved')

      setTimeout(() => {
        setSaveState('idle')
        setStep('search')
        setTrack(null)
        setQuery('')
        setResults([])
      }, 1800)
    } catch (err) {
      setSaveState('error')
      setErrorMsg(err.message ?? 'Failed to save — check connection and try again')
    }
  }

  if (setsError) {
    return (
      <div className="min-h-screen bg-base text-white flex flex-col items-center justify-center gap-4 px-6">
        <p className="text-sm text-ink-muted text-center">Couldn't load your libraries. Check connection.</p>
        <button
          onClick={() => window.location.reload()}
          className="text-accent text-sm font-medium py-2 px-4 cursor-pointer"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-base text-white">

      {/* Header */}
      <div className="flex items-center gap-2 px-5 pt-14 pb-5">
        {step === 'confirm' && (
          <button
            onClick={handleBack}
            className="text-accent text-sm font-medium py-2 pr-3 -ml-1 cursor-pointer flex-shrink-0"
          >
            ← Back
          </button>
        )}
        <h1 className="text-base font-semibold text-white">
          {step === 'search' ? 'Add a Song' : 'Add to Library'}
        </h1>
      </div>

      {/* Search step */}
      {step === 'search' && (
        <div className="px-5">
          <div className="relative mb-5">
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search Spotify…"
              autoComplete="off"
              className="w-full bg-surface border border-white/[0.08] rounded-2xl px-4 py-4 text-white placeholder:text-ink-muted text-base outline-none focus:border-accent/40 transition-colors duration-150"
            />
            {searching && (
              <div className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 border-[1.5px] border-white/10 border-t-accent rounded-full animate-spin" />
            )}
          </div>

          {results.length > 0 && (
            <div className="flex flex-col">
              {results.map((t, i) => (
                <button
                  key={t.id}
                  onClick={() => handleSelectTrack(t)}
                  className={`flex items-center gap-4 py-3 text-left cursor-pointer active:bg-surface rounded-xl transition-colors duration-100 ${i > 0 ? 'border-t border-white/[0.05]' : ''}`}
                >
                  {t.album?.images?.at(-1)?.url
                    ? <img src={t.album.images.at(-1).url} alt="" className="w-14 h-14 rounded-xl object-cover flex-shrink-0" />
                    : <div className="w-14 h-14 rounded-xl bg-surface-raised flex-shrink-0" />
                  }
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-white truncate leading-snug">{t.name}</p>
                    <p className="text-xs text-ink-muted truncate mt-0.5">{t.artists?.map(a => a.name).join(', ')}</p>
                    <p className="text-xs text-ink-muted/60 mt-0.5">{t.album?.name}</p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {!searching && query.trim() && results.length === 0 && (
            <p className="text-sm text-ink-muted text-center mt-10">No results for "{query}"</p>
          )}

          {!query.trim() && (
            <p className="text-sm text-ink-muted text-center mt-16">Type to search Spotify</p>
          )}
        </div>
      )}

      {/* Confirm step */}
      {step === 'confirm' && track && (
        <div className="px-5 pb-10">

          {/* Track identity */}
          <div className="flex items-center gap-4 mb-8">
            {track.album?.images?.[0]?.url
              ? <img src={track.album.images[0].url} alt="" className="w-16 h-16 rounded-2xl object-cover flex-shrink-0 shadow-lg" />
              : <div className="w-16 h-16 rounded-2xl bg-surface-raised flex-shrink-0" />
            }
            <div className="min-w-0">
              <p className="font-semibold text-white leading-snug truncate">{track.name}</p>
              <p className="text-xs text-ink-muted mt-0.5 truncate">{track.artists?.map(a => a.name).join(', ')}</p>
              <p className="text-xs text-ink-muted/60 mt-1 truncate">{track.album?.name}</p>
            </div>
          </div>

          {/* Library picker */}
          {sets ? (
            <div className="mb-6">
              <label className="block text-[11px] text-ink-muted mb-2 font-medium">Add to library</label>
              <div className="relative">
                <select
                  value={destSetId}
                  onChange={e => setDestSetId(e.target.value)}
                  className="w-full bg-surface border border-white/[0.08] rounded-2xl px-4 py-4 text-white text-sm outline-none appearance-none cursor-pointer focus:border-accent/40 transition-colors duration-150"
                >
                  {Object.entries(sets.items).map(([id, set]) => (
                    <option key={id} value={id} className="bg-surface">
                      {set.name} · {set.songs?.length ?? 0} songs
                    </option>
                  ))}
                </select>
                <svg className="absolute right-4 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M7 10l5 5 5-5z"/>
                </svg>
              </div>
            </div>
          ) : (
            <div className="mb-6 h-14 bg-surface rounded-2xl animate-pulse" />
          )}

          {/* Add button / success */}
          {saveState === 'saved' ? (
            <div className="w-full py-4 text-center bg-accent/10 border border-accent/25 rounded-2xl">
              <p className="text-accent font-semibold text-sm">Added to {savedToName} ✓</p>
            </div>
          ) : (
            <button
              onClick={handleAdd}
              disabled={saveState === 'saving' || !sets || !destSetId}
              className="w-full py-4 bg-accent text-black font-bold text-sm rounded-2xl cursor-pointer active:scale-[0.98] transition-transform duration-150 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saveState === 'saving'
                ? 'Adding…'
                : `Add to ${sets?.items[destSetId]?.name ?? 'Library'}`}
            </button>
          )}

          {saveState === 'error' && (
            <p className="text-red-400 text-sm text-center mt-4">{errorMsg}</p>
          )}
        </div>
      )}
    </div>
  )
}
