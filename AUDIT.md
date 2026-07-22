# Trivia Jukebox — Code Audit

Date: 2026-07-22
Scope: full read-through of `src/` and `api/` — `Jukebox.jsx`, `useSpotifyPlayer.js`, `shuffle.js`, `track.js`, `spotify.js`, `supabase.js`, `SongDetailModal.jsx`, `ScrubberControls.jsx`, `Player.jsx`, `LiveScreen.jsx`, `AlbumGradient.jsx`, `usePalette.js`, `api/palette.js`, `App.jsx`, `QuickAdd.jsx`, plus existing vitest suites.
Method: static read-through + trace-by-hand of the async/state-machine paths (Supabase sync, playback generations, LiveScreen choreography). Nothing here was reproduced live against `trivia-jukebox.vercel.app` — treat severities as "should reproduce" until you've clicked through them once. No source changes made; this app is marked stable-do-not-touch, so this is diagnosis only.

Overall: the code is unusually well-defended for a solo project — the git-blame-style comments show several of these exact bug classes were already found and fixed once (the trim-point-wipe bug, the shuffle desync bug, the stale-fade race). The remaining findings below are mostly the *next* layer of the same handful of hard problems: multi-writer state sync, and one shared mutable resource (the single Spotify player) being reachable from two different UI surfaces (the main shuffle session and the per-song preview) that don't fully know about each other.

---

## Findings, worst first

### 1. Opening the live song's own card and hitting its Pause button silently kills the show — HIGH

**Where:** `SongDetailModal.jsx:47-54` (`handlePlay`/`handleStop`) interacting with `useSpotifyPlayer.js:334-339` (`pause`).

**Repro:**
1. Shuffle is playing track X live (`showLive` open on the TV).
2. Host clicks X's card in the library grid to check/adjust its trim points. `SongDetailModal` opens with `track = X`. Since `currentTrack.uri === track.uri`, `isActive` is `true` and the modal's own transport shows the real live playback state — a pause icon.
3. Host taps that pause icon. This calls the modal's local `handleStop`, which is just `player.pause()` — **not** `Jukebox.handleStop`. It bumps the player's generation counter and clears the position-monitor interval directly, bypassing every bit of Jukebox's session state (`isPlaying`, `showLive`, `shuffleOrderRef`, `playedIdsRef`).
4. Host taps play again in the same modal. Because `isActive` is `true`, the modal's guard — `if (isLiveShuffling && !isActive) await onStopLiveShuffle()` — does **not** fire (it only protects against previewing a *different* song). So it calls `playTrack(track.uri, startMs, stopMs, preview=true)` directly: a fresh play from the clip's **in-point**, in preview mode.
5. Preview mode never calls `onAdvance`. When this clip reaches its out-point it fades out and just sits there, paused, forever. Jukebox's `isPlaying` flag never went false, so nothing tells the host the set has stalled — the TV shows the turntable arm lifted, correctly reflecting "paused," but there is no next song coming and no toast explaining why.

**Why it's easy to hit:** checking or nudging a trim point on whatever's currently playing is a completely ordinary thing to do mid-show. The modal's own comment (`SongDetailModal.jsx:41-46`) shows the author already reasoned about "previewing a different song would hijack live playback" and built a guard for exactly that — the gap is the unconsidered case where the song you're previewing **is** the live one.

**Blast radius:** not a crash, no data loss, and it is recoverable — hitting the main Play button in the bottom bar starts a brand-new shuffle session and everything resumes. But until someone notices, the room goes silent with a paused turntable on screen and no error, which during a live trivia grading break reads as "the jukebox broke."

**Fix direction:** in the modal, treat `isActive` the same as "would hijack live playback" — i.e. always route through `onStopLiveShuffle()` before taking over the shared player, or simpler: when `isActive` is true, don't give the modal its own transport controls at all (show a "currently live — use the main player to control it" state instead of a working play/pause button).

---

### 2. Wiping the whole library doesn't stick — it un-deletes itself on the next sync — HIGH

**Where:** `Jukebox.jsx:143-152` (`writeToSupabase`, "Guard 1b").

Guard 1b exists to stop the *empty-default-on-first-render* race from clobbering a populated remote row — a real bug this codebase already fixed once. But as written it blocks **every** write of an empty state, forever, once the remote row has ever held songs:

```js
if (totalSongs(outgoing) === 0) {
  const { data } = await supabase.from('jukebox_state')...
  if (data?.sets && totalSongs(data.sets) > 0) return  // remote has data — abort
}
```

**Repro:** Clear every set (the sidebar "Clear" action on each, or delete every non-`main` set and clear `main`) so the library is genuinely, intentionally empty. localStorage now correctly shows empty. But Supabase still holds the last populated row, so this guard aborts the write — silently, no toast, forever, every 500ms it's retried. Reload the page, or just wait for the next tab-focus resync (`Jukebox.jsx:309-328`) or a laptop sleep/wake cycle: the sync pulls the old, fully-populated row back down and the "deleted" library reappears in full.

**There is currently no way to intentionally empty the library and have it stay empty.** That's a real trap for exactly the maintenance task you'd expect to do periodically (start a new season, purge test songs, rebuild a theme from scratch).

**Fix direction:** Guard 1b should distinguish "empty because we haven't loaded yet" (the case it's actually guarding against — solved by `syncCompletedRef`, which already gates this) from "empty because the user genuinely emptied it." A cheap fix: track a `hasEverHadSongsLocallyRef` or simply trust `syncCompletedRef` alone and drop the remote-recheck entirely once sync has completed once — at that point an empty `outgoing` really did come from a real user action, not from an uninitialized render. If keeping the belt-and-suspenders remote check, add an explicit "confirm wipe" affordance (a second click, like the existing Clear-with-confirm pattern in `SetItem`) that sets a ref bypassing this guard for that one write.

---

### 3. A library wipe from another device leaves a dead, un-advancing player on this one — MEDIUM/HIGH

**Where:** `Jukebox.jsx:270-300` (realtime handler), interacting with `Jukebox.jsx:447-481` (`advanceToNext`) and `shuffle.js:37-57` (`resolveNext`).

Guard 2 in the realtime handler only blocks an incoming update if the **entire** state (all sets combined) is empty while local has songs. It does not protect a single set from being emptied out from under a device that's actively playing from it.

**Repro:** Device A is shuffle-playing from Set "90s". From Device B (another laptop, or a QuickAdd session), clear or otherwise empty Set "90s" — total songs across all sets is still > 0 (other sets have songs), so Guard 2 doesn't fire and the realtime update is applied on Device A. `library` (derived from the now-empty active set) becomes `[]`, but nothing calls `handleStop` — `isPlaying`/`showLive`/`playingId` are untouched. The currently-loaded song keeps playing to its natural/trimmed end (it's already loaded into the Spotify player, independent of the React state). When it ends, `onAdvance → advanceToNext → resolveNext(order, idx, [])` returns `song: null`, and `tryPlay` just `return`s — no toast, no state reset. The Player bar and LiveScreen are now frozen mid-"playing" over dead air, indefinitely, until someone manually hits Stop.

**Fix direction:** in `advanceToNext`'s `tryPlay`, when `resolveNext` comes back with no song, treat it like the existing stalled-playback path — `setIsPlaying(false); setShowLive(false); setPlayingId(null); addToast(...)` — instead of a bare `return`.

---

### 4. Trivia OS handoff into an empty (or emptied) set is a silent no-op — MEDIUM

**Where:** `Jukebox.jsx:376-445` (the `?lib=` handler).

If Trivia OS hands off with `?lib=<setId>` (or `?lib=random`) and that set has zero songs — including the `random` branch happening to land on an empty set — the handler just strips the URL param and returns (`Jukebox.jsx:408`: `if (!targetSongs.length) { strip(); return }`). No toast, no fallback to another non-empty set, no signal to Trivia OS that the handoff didn't actually start anything. From the host's chair, the display just switches to the Jukebox tab and... nothing happens. This is squarely a live-show "why is there no music" moment, and it's easy to trigger by accident (an empty custom theme set left over from testing, or the `random` pick landing on `main` right after finding #2 above nukes it).

**Fix direction:** filter empty sets out of the `random` pool before picking; for a specific empty `lib=` target, fall back to a toast ("`<Set name>` has no songs — pick another theme") rather than doing nothing silently, or fall back to shuffling `main` if it has songs.

---

### 5. The stale-write catch-up guard can silently eat a real edit, not just protect against a stale one — MEDIUM

**Where:** `Jukebox.jsx:154-186` ("Guard 3").

This guard exists to stop a tab that missed a realtime event (backgrounded tab, laptop sleep) from blindly overwriting a newer remote state — a real, already-diagnosed bug per the comments (this is literally how trim points got wiped before). But the fix, as written, doesn't distinguish "our local `sets` is stale and we should discard it" from "the user made a genuine edit against a stale base and we're about to throw it away." When the guard trips, it always pulls the remote row and calls `setSets(remoteRow.sets)` — discarding whatever local edit was pending in this write, with no toast, no merge attempt (contrast with the stash-merge path a few lines up, which *does* merge instead of discard for the "remote update arrived mid-debounce" case).

**Repro (narrow window, but real):** tab backgrounded long enough to miss a realtime UPDATE (`lastAppliedUpdatedAtRef` now behind reality) → user brings it back and immediately deletes a song or edits a trim point before the visibility-regain resync (`Jukebox.jsx:309-328`) has had a chance to run → the 500ms debounced write trips Guard 3, pulls the older-to-this-tab-but-actually-current remote row, and the user's edit is gone with no explanation.

**Fix direction:** when Guard 3 trips, diff `outgoing` against `lastAppliedUpdatedAtRef`'s snapshot and merge the local delta into the freshly-pulled remote row (same pattern already used for the stash-merge case just above it in the same function), instead of unconditionally replacing local state.

---

### 6. QuickAdd's reach may be capped by Spotify's app-quota mode — WORTH VERIFYING (unknown severity)

**Where:** `App.jsx:54-73`, `spotify.js:32-49`.

`/add` still requires a full Spotify OAuth login (`App.jsx`'s `if (!token)` gate applies to every route, including `/add`) — the same `login()`/PKCE flow used for the main device. If the Spotify Developer app backing `VITE_SPOTIFY_CLIENT_ID` is still in Spotify's "Development Mode" (the default for a personal project, capped at 25 explicitly-allowlisted users), then **any guest scanning a QuickAdd QR code who isn't pre-added to that allowlist in the Spotify dashboard will hit a wall in Spotify's own consent screen** before ever seeing the search UI. This would silently limit "let the bar request songs" to a pre-approved list of ~25 people, which may be fine (maybe that's the intent) or may be a surprise depending on what "QuickAdd" is meant for. Worth a two-minute check of the Spotify Developer Dashboard's app settings/user-management tab to confirm which mode the app is in — this isn't something visible from the code.

---

### 7. Concurrent token refreshes aren't de-duplicated — LOW

**Where:** `spotify.js:76-103` (`getToken`/`refreshToken`).

Every caller near expiry (the position monitor tick, a manual seek, `playTrack`'s own token check) independently calls `getToken()`, and each one that finds the token expired fires its own `refreshToken()` POST. There's no shared in-flight promise, so several near-simultaneous refresh calls can go out at once. Spotify's refresh tokens aren't guaranteed idempotent under rapid concurrent use — if a stricter rotation policy ever kicks in, one of several parallel refreshes could get an `invalid_grant` for using an already-superseded refresh token, surfacing as an intermittent, hard-to-reproduce 401 right around token-expiry boundaries. Low likelihood, but cheap to harden: memoize the in-flight refresh promise so concurrent callers await the same request.

---

### 8. Scrubber seek can visibly "snap back" on a flaky network — LOW

**Where:** `useSpotifyPlayer.js:342-358` (`seek`).

`seek()` optimistically moves the displayed position immediately, fires the REST seek call fire-and-forget with no error handling, and resets `seekingRef` after a flat 700ms regardless of whether the seek actually landed. If that PUT is slow or drops, the next `player_state_changed` tick (which is no longer suppressed once `seekingRef` clears) snaps the scrubber back to wherever playback actually is — a visible jump backward. Minor, but a good candidate for "why did the scrubber just jump" reports on a bad wifi night.

---

### 9. `/api/palette` is public and uncapped — LOW / hardening note

**Where:** `api/palette.js:1-18`.

The hostname allowlist (`i.scdn.co`/`mosaic.scdn.co`) correctly closes the obvious SSRF hole — good. But the endpoint has no auth and no rate limiting, and each distinct `url` runs a real `sharp` resize + median-cut. Since Spotify album-art URLs are easy to enumerate/guess-adjacent, this is a small, low-value lever for running up Vercel function invocations if anyone ever points a script at it. Not urgent for a low-traffic personal app; worth a `Referer`/origin check or a light rate limit if this ever gets linked from anywhere public.

---

### 10. The header "Live" toggle bypasses the exit choreography — COSMETIC

**Where:** `Jukebox.jsx:817-826` (`onClick={() => setShowLive(v => !v)}`) vs. the real teardown path in `handleStop` (`Jukebox.jsx:618-631`).

Every other path that closes `LiveScreen` goes through `liveEnding` so the tonearm-lift/record-fly-up exit plays before unmount. The header toggle button skips all of that — it unmounts `LiveScreen` instantly, and re-showing it plays the **entrance** animation from scratch (record drop, art preload, the whole `runEntrance` sequence) even though the song has been playing the whole time. Toggling Live on/off mid-song is a plausible thing to do while peeking at the laptop during a show, and each toggle currently replays the full entrance choreography. Not a functional bug, just a visible rough edge.

---

## What I did *not* find

- No sign of the Spotify client secret or any credential leaking client-side — this is a proper PKCE flow, no secret needed. `localStorage` token storage is the normal trade-off for a single-purpose kiosk laptop and I wouldn't spend effort hardening it further.
- No XSS-shaped injection points — track names/artist names are rendered as text content throughout (React's default escaping), never `dangerouslySetInnerHTML`.
- The shuffle/resume logic (`shuffle.js`) held up well against deliberate adversarial input by hand-tracing (empty library, single-song library, mid-order removal, exhausted order, immediate-repeat guard) — this matches its solid existing test coverage.
- `moveOrCopySong` while the moved song is the one currently live-shuffling: traced this by hand and it appears to resolve correctly (`resolveNext` skips ids no longer in the library), but I did not verify it against the actual Framer Motion/LiveScreen interplay live. Flagging as a "probably fine, worth a real click-through" rather than a finding.

## Test-coverage gap

`shuffle.js` and `track.js` are well covered by the existing vitest suites (edge cases like empty library, exhausted order, anti-repeat swap are all exercised). Everything behind findings #2, #3, #5 — the Supabase sync guards in `Jukebox.jsx` — has zero automated coverage, and it's exactly where the highest-severity issues above live. Because local dev is broken and Playwright can't get past Spotify OAuth, this logic currently can only be exercised by hand against the live URL. Recommend pulling the guard logic (empty-write guard, compare-and-swap catch-up, stash-merge) out of the `writeToSupabase` closure into small pure functions — `shuffle.js`-style — that take `(local, remote, lastAppliedUpdatedAt, stashed)` and return a decision, so vitest can cover the sync state machine the same way it already covers shuffle resolution, without needing a live Supabase connection.

## Suggested priority order

1. Fix #1 (modal hijack) and #3 (dead player after cross-device wipe) — both are silent, mid-show playback stalls with no error surfaced; same category, cheap to fix, highest live-show risk.
2. Fix #2 (library wipe doesn't persist) before it's needed for real — it's the kind of bug that's invisible until the one day you actually want to nuke the library, and then it looks like data got randomly restored/corrupted.
3. Fix #4 (empty-set handoff) and #5 (silent edit loss on stale catch-up) — both are "no toast" gaps in otherwise-correct guards; cheap, mechanical fixes.
4. Everything else (#6-#10) is verify-when-convenient / low-urgency hardening, not urgent given this is a single-laptop, low-traffic app.
