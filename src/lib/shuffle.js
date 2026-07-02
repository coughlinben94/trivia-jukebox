export function shuffleArray(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// Resolve the next track to play given the current shuffle order (array of
// song ids), the index just played, and the live library. Ids no longer
// present in the library (removed since the order was built) are skipped
// rather than causing playback to silently stop. When the order is
// exhausted, reshuffles from the current library and swaps the head if it
// would immediately repeat the last-played id.
export function resolveNext(order, idx, lib) {
  let nextOrder = order
  let nextIdx = idx + 1
  while (nextIdx < nextOrder.length && !lib.some(t => t.id === nextOrder[nextIdx])) nextIdx++

  if (nextIdx >= nextOrder.length) {
    const lastId = nextOrder[nextOrder.length - 1]
    nextOrder = shuffleArray(lib.map(t => t.id))
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
