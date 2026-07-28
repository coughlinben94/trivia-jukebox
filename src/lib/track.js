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

// Strip ANY parenthesized/bracketed content for display — session tags
// ("(OurVinyl Session)"), remaster/edit/live notes, "(feat. X)"/"(with X)",
// etc. Storage keeps the real Spotify title untouched (needed for search,
// dedup, exact-match lookups). Also strips a bare trailing "- feat. X" with
// no brackets at all, since that's the same clutter without parens around it.
const PAREN_RE = /\s*[([][^)\]]*[)\]]/g
const TRAILING_FEAT_RE = /\s*[-–]\s*(?:feat|ft|featuring)\.?\s+.+$/i

export function displayName(name) {
  if (!name) return name
  return name.replace(PAREN_RE, '').replace(TRAILING_FEAT_RE, '').trim()
}
