export function shuffleArray(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Build a shuffled id order drawn from songs not yet in `playedIds` this
// session. If every song in `lib` has already had a turn, that's a lap
// completed — clear playedIds (mutates the passed Set) and draw from the
// full library again so a night never runs dry, it just starts a new lap.
function freshOrderFromPool(lib, playedIds) {
  let pool = lib.filter(t => !playedIds.has(t.id))
  if (pool.length === 0) {
    playedIds.clear()
    pool = lib
  }
  return shuffleArray(pool.map(t => t.id))
}

// Public entry point for building a brand-new session order — used whenever
// playback restarts from scratch (Shuffle-play button, Trivia OS ?lib=
// handoff), as opposed to resolveNext's mid-order advance.
export function buildSessionOrder(lib, playedIds = new Set()) {
  return freshOrderFromPool(lib, playedIds)
}

// Resolve the next track to play given the current shuffle order (array of
// song ids), the index just played, and the live library. Ids no longer
// present in the library (removed since the order was built) are skipped
// rather than causing playback to silently stop. When the order is
// exhausted, reshuffles — preferring songs not yet in `playedIds` this
// session (see freshOrderFromPool) — and swaps the head if it would
// immediately repeat the last-played id.
export function resolveNext(order, idx, lib, playedIds = new Set()) {
  let nextOrder = order
  let nextIdx = idx + 1
  while (nextIdx < nextOrder.length && !lib.some(t => t.id === nextOrder[nextIdx])) nextIdx++

  if (nextIdx >= nextOrder.length) {
    // The just-played id — not necessarily the last array element, since
    // trailing ids near the end of `order` may have been removed from the
    // library (and skipped by the while-loop above) since the order was built.
    const lastId = order[idx]
    nextOrder = freshOrderFromPool(lib, playedIds)
    if (nextOrder[0] === lastId && nextOrder.length > 1) {
      const swapIdx = 1 + Math.floor(Math.random() * (nextOrder.length - 1))
      ;[nextOrder[0], nextOrder[swapIdx]] = [nextOrder[swapIdx], nextOrder[0]]
    }
    nextIdx = 0
  }

  const song = lib.find(t => t.id === nextOrder[nextIdx]) ?? null
  return { order: nextOrder, idx: nextIdx, song }
}

// The track that will play after the current one, for the upcoming-track
// preview shown during fade-out. Skips removed ids; does not reshuffle —
// mirrors resolveNext but stops at the end of the current order.
export function resolveUpcoming(order, idx, lib) {
  let nextIdx = idx + 1
  while (nextIdx < order.length && !lib.some(t => t.id === order[nextIdx])) nextIdx++
  if (nextIdx >= order.length) return null
  return lib.find(t => t.id === order[nextIdx]) ?? null
}
