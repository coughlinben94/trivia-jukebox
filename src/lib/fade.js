// Shared fade-in/fade-out budget math for useSpotifyPlayer.
//
// Root cause (2026-07-28): the fade-in ramps UP inside the trim window
// (starting at startMs), and the fade-out ramps DOWN inside the trim window
// too (landing at stopMs) — both were independently clamped to `FADE_MS`
// with no awareness of each other. For any trimmed window shorter than
// 2*FADE_MS, the fade-in already consumes most/all of the window before the
// fade-out's own trigger threshold (stopMs - FADE_MS), so the position
// monitor sees pos already at/past that threshold the instant it starts
// polling — firing an instant (sometimes literally 0ms) fade-out right after
// the fade-in, which reads as "song didn't play" and auto-advances. Only
// hits songs with a short custom trim (SongDetailModal in/out points), which
// is why it looked occasional/random — full-length songs have a window of
// minutes, far larger than 2*FADE_MS.
//
// Fix: split whatever room the window has evenly between the two fades so
// they can never overlap, capped at FADE_MS each for normal-length windows.
export function computeFadeBudget(startMs, stopMs, fadeMs) {
  if (!(stopMs > startMs)) return fadeMs
  const room = stopMs - startMs
  return Math.min(fadeMs, room / 2)
}
