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
// dedup, exact-match lookups). Also strips a bare trailing " - anything" with
// no brackets at all ("Man I Need - Live At Capricorn Studios", "Song -
// Remastered 2011", "Song - feat. X") — same clutter, no parens around it.
// Requires whitespace on BOTH sides of the dash so a real mid-word hyphen
// ("Self-Titled", "T-Pain") never matches — only the space-dash-space
// convention music titles use for a trailing subtitle/version tag.
const PAREN_RE = /\s*[([][^)\]]*[)\]]/g
const DASH_SEP_RE = /\s+[-–—]\s+/g

// Cuts at the LAST " - " separator, not the first. A single greedy regex
// match from the first separator loses real title content on multi-dash
// titles — "Twenty One Pilots - Ride - Live from Tokyo" would collapse to
// just "Twenty One Pilots", eating the actual song title ("Ride") along with
// the trailing tag. Finding the last separator and cutting there keeps
// everything before it intact, however many dashes it contains, and only
// drops the one trailing subtitle/version tag.
function stripTrailingDashTag(name) {
  let lastIndex = -1, m
  DASH_SEP_RE.lastIndex = 0
  while ((m = DASH_SEP_RE.exec(name))) lastIndex = m.index
  return lastIndex === -1 ? name : name.slice(0, lastIndex)
}

export function displayName(name) {
  if (!name) return name
  return stripTrailingDashTag(name.replace(PAREN_RE, '')).trim()
}
