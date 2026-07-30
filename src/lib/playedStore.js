// Persists shuffle no-repeat history (see shuffle.js's `playedIds`) across
// the Jukebox<->Trivia OS handoff, which is a full page navigation each way
// (window.location.href, not client-side routing) — a plain in-memory Set
// resets on every trip back for a new round's grading break, which defeats
// "don't repeat a song this whole night" the moment there's more than one
// round. Keyed by BOTH a rolling "night" (so it self-clears for the next
// event with no manual reset needed) and by set id (so exhausting a small
// theme set's pool doesn't wipe a completely different set's play history —
// previously a single shared Set did exactly that, invisibly, because it
// died on every reload anyway before this existed).
//
// Night boundary is offset 6 hours so a show still running after midnight
// counts as the night it started — a real trivia night never runs the other
// direction (starting before 6am).
const STORAGE_KEY = 'trivia_played_v1'
const NIGHT_OFFSET_MS = 6 * 60 * 60 * 1000

function currentNightKey() {
  return new Date(Date.now() - NIGHT_OFFSET_MS).toISOString().slice(0, 10)
}

function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { night: currentNightKey(), bySet: {} }
    const parsed = JSON.parse(raw)
    if (parsed?.night !== currentNightKey() || typeof parsed.bySet !== 'object') {
      return { night: currentNightKey(), bySet: {} }
    }
    return parsed
  } catch {
    return { night: currentNightKey(), bySet: {} }
  }
}

// Load this set's played-ids for tonight as a Set — empty if it's a new
// night, a set that hasn't played yet tonight, or storage is unavailable/
// corrupt. Never throws; the worst case matches today's behavior (no
// persistence, i.e. every fresh load looks like a new night).
export function loadPlayed(setId) {
  try {
    const store = readStore()
    return new Set(store.bySet[setId] ?? [])
  } catch {
    return new Set()
  }
}

// Persist this set's played-ids Set for tonight. Best-effort — a write
// failure (private browsing, storage quota, etc.) just means no
// persistence for this save, not a crash; playback itself never depends on
// this succeeding.
export function savePlayed(setId, playedIds) {
  try {
    const store = readStore()
    store.bySet[setId] = [...playedIds]
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Persistence is a nice-to-have on top of the in-memory Set that already
    // drives playback this session — never let a storage failure surface.
  }
}
