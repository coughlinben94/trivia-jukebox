// Slim a raw Spotify track down to exactly the fields the UI reads.
// Idempotent: re-running on an already-slim track produces the same shape,
// since only known fields are read and everything else (available_markets,
// external_ids, full artist objects, etc.) is dropped rather than carried over.
export function slimTrack(track) {
  return {
    id: track.id,
    uri: track.uri,
    name: track.name,
    artists: (track.artists ?? []).map(a => ({ name: a.name })),
    album: {
      name: track.album?.name,
      images: track.album?.images,
    },
    duration_ms: track.duration_ms,
  }
}

// True if a stored song still carries the bulky raw Spotify payload
// (available_markets appears at both track and album level).
export function songNeedsSlim(song) {
  return 'available_markets' in song || 'available_markets' in (song.album ?? {})
}

// Strip "(feat. X)" / "(with X)" / "- feat. X" style suffixes for display
// only. Storage keeps the real Spotify title untouched (needed for search,
// dedup, exact-match lookups). Handles parenthesized and bare trailing forms,
// case-insensitive, with or without a period after "feat".
const FEAT_RE = /\s*[([]\s*(?:feat|ft|featuring|with)\.?\s+[^)\]]+[)\]]|\s*[-–]\s*(?:feat|ft|featuring)\.?\s+.+$/i

export function displayName(name) {
  if (!name) return name
  return name.replace(FEAT_RE, '').trim()
}
