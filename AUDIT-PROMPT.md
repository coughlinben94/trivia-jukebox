# Full audit prompt for Claude Code

Paste this whole thing into a Claude Code session in ~/Projects/baynes-trivia/trivia-jukebox.

---

Run a full, in-depth audit of trivia-jukebox — timing, the gradient/
background system, and shuffle/playback correctness. Ben's had a long night
of live-tuned patches to this app and wants everything actually run down
and fixed, not just flagged. Read ~/.agents/skills/using-superpowers/SKILL.md,
~/.agents/skills/systematic-debugging/SKILL.md, and
~/.agents/skills/trivia-jukebox/SKILL.md before starting.

Repo: ~/Projects/baynes-trivia/trivia-jukebox (React/Vite/Framer Motion/
Spotify Web Playback SDK/Supabase, deployed at trivia-jukebox.vercel.app).
Hard rules from this repo's own CLAUDE.md, read it in full first:
local dev is broken on Vite 8 (`npm run dev` is flaky, don't chase it —
verify with `npx vite build --outDir /tmp/x` and `npx vitest run` instead);
Playwright is unusable here (Spotify OAuth blocks automation browsers) —
anything touching real playback needs Ben live on the actual site, you
cannot log into Spotify yourself; there is exactly ONE live gradient
renderer, `AlbumGradientMesh.jsx` (imported as `GradientBackground` in
`LiveScreen.jsx`) — a dead file `GradientBackground.jsx` also exists with
its own tests but is not used live, don't confuse the two; when a
data-fed visual looks wrong, dump the data before touching the renderer —
CLAUDE.md documents a real five-hour, eight-commit chase on 2026-07-19 that
turned out to be a data bug in `api/palette.js`, not the renderer.

## Ground truth before you touch anything

Read the FULL git history of `src/components/LiveScreen.jsx` and
`src/components/Jukebox.jsx` — not just tonight's commits, going back as
far as the log goes (`git log --follow -p -- <file>`, and `git log
--oneline -- <file>` for the full list first so you know how far back to
go). Tonight's session (roughly the last ~15 commits as of this writing)
made a long chain of live-tuned changes: entrance/transition audio-firing
timing, tonearm spring configs, a token-guarded register/unregister
handshake between the two files, and a fix to which of `entranceSong`/
`currentTrack` wins when LiveScreen first displays a song. Several of
those changes already had to be partially reverted once tonight because a
"faster" change broke a visual that had been carefully live-tuned over
MULTIPLE EARLIER sessions (a spring stiffness bump broke a drop animation
tuned across several passes on 2026-07-30 specifically — full history is
in the log, it's not a one-off). Do not assume tonight's values are
correct just because they're most recent, and do not assume older values
are correct just because they're older — actually read the commit
messages and inline comments to understand WHY each number is what it is
before changing anything. A lot of comments in both files already narrate
this history in detail — read them, they're not decoration.

Two temporary diagnostics are live right now: `console.log('[jukebox:transition]', ...)`
in `runTransition` (LiveScreen.jsx) right before `setShown(target)` — logs
target name/uri/gradientOverride/newArtUrl — and
`console.log('[jukebox:palette]', ...)` in the `palette` useMemo in the
same file — logs shown name/uri and extracted palette colors. Use these,
don't add redundant new ones until you've read what they already tell you
in a live session with Ben.

## Track 1 — the active bug: display/audio mismatch

Ben's exact words: "its playing a diff song than what album is actually on
the spinner." Get a live repro going with him — song vs. displayed art/
name diverging, either at shuffle start or mid-session on a transition.
Watch the `[jukebox:transition]` log against what's actually audible when
it happens. If the logged name matches what's playing, the bug is
downstream in rendering (how `artUrl`/`shown` reach the DOM/canvas), not
song selection. If it doesn't match, the bug is upstream in
`resolveNext`/`shuffleIdxRef`/`shuffleOrderRef` in `src/lib/shuffle.js`
and how `Jukebox.jsx`'s `advanceToNext`/`tryPlay` uses them — read those
closely, including the retry path (`tryPlay(true)` on a failed
`playTrackFn` call re-advances the shuffle index and fires a SECOND visual
transition while the first is still mid-flight via `runTransition`'s
`busyRef`/`pendingRef` queue — work out exactly what that produces on
screen and whether it self-corrects or can wedge into a stuck bad state).
Also check the debounced reconciliation-backstop effect in LiveScreen.jsx
(watches `currentTrack?.uri`, calls `runTransition(currentTrack)` — note
it uses the raw Spotify SDK object, not the library object, so if this is
what's actually firing, song NAME would be correct but any manual color
override would be lost — useful to distinguish which bug you're looking at
if it turns out to be color-only, not song-only).

## Track 2 — full timing audit

Catalog every `type: 'spring'` (stiffness+damping), every `sleep()`/
`setTimeout()` duration, and every `Promise.race`-against-a-timeout
pattern in both files. For each spring compute critical damping
(`2*sqrt(stiffness)`) and flag anything meaningfully underdamped without a
comment explicitly saying that's intentional — underdamped springs
overshoot/oscillate, which is what caused at least one wobble bug fixed
earlier tonight. For every `sleep()` that gates a step which could instead
await a real animation's own promise, flag it — this codebase has an
established preference for awaiting real animations over guessed sleeps
(several comments say so directly), so a fixed sleep standing in for that
is worth a second look, though check the commit history first — several
sleeps were deliberately kept as sleeps because they add pacing BEYOND
spring settle time, not because nobody thought to await instead. For every
ref-based timing guard (flags like `audioJustFiredRef`, `busyRef`,
`transitionTokenRef`, `entrancePlayedRef`), do the actual arithmetic on
when it's set vs. when it's read/cleared, the same way a mismatch between
a 700ms clear-timer and an 820ms read gap was caught and fixed tonight —
don't eyeball it, add up the actual sleep/await chain between set and
read. Check whether any fallback/backstop timer (there are at least two:
one for the entrance, ~4000ms as of tonight's last fix, one for
song-to-song transitions, 2500ms) is now SHORTER than its own primary
trigger's typical happy-path duration — if so it's not a backstop anymore,
it's silently become the primary path, which already happened once
tonight with the entrance fallback and needs re-checking after any further
timing changes.

## Track 3 — full background/gradient system audit

Read `src/components/AlbumGradientMesh.jsx` in full, the `usePalette` hook
(`src/hooks/usePalette.js`), `api/palette.js`, and
`src/lib/pickGradientColors.js`/`applyGradientOverride.js` (or wherever
those actually live — search for them). Check:
- Whether a silent palette-fetch failure (`api/palette.js` returning an
  error, or the fetch itself failing) is ever swallowed with no retry and
  no visible trace, leaving stale colors on screen indefinitely — check
  every `.catch()` in `usePalette.js` for this pattern specifically.
- Whether the swap-time color blend in `AlbumGradientMesh.jsx` (the
  `colors` effect, roughly line 384-404 as of tonight) restarts its ease
  from zero velocity even when a background `nextColors` pre-blend was
  already partway there — if so this produces a visible stall/hitch right
  as a new song's record lands, not a snap, which could easily read as "a
  color glitch" without being an obvious hard break.
- Whether the `isFirst`/`isFirstNext`/`isFirstKey` mount-skip refs in
  `AlbumGradientMesh.jsx` could ever get re-triggered mid-session (would
  silently skip a real color update by treating it as the initial mount).
- Whether the `entranceActive`-gated `pendingBlendRef` defer logic can
  ever lose an update or apply a stale one, especially under a fast
  manual skip during the entrance itself (this is a DIFFERENT scenario
  than Track 1's bug — Ben confirmed Track 1 happened on a NORMAL
  transition, not a quick skip during entrance, so don't conflate the two,
  but this path is real and worth checking on its own).
- Cross-reference `src/test/*.test.js` (`applyGradientOverride.test.js`,
  `pickGradientColors.test.js`, `gradientTuning.test.js`,
  `GradientBackground.test.js` — note that last one tests the DEAD file,
  not the live one, `AlbumGradientMesh.jsx` currently has zero test
  coverage) for what's actually covered vs. what these mechanisms leave
  unverified.

## Track 4 — everything else

Ben's ask was "timing issues, background problems, anything" — don't stop
at LiveScreen.jsx/Jukebox.jsx/AlbumGradientMesh.jsx. Sweep the rest of
`src/` too: `src/components/Player.jsx`, `SongDetailModal.jsx`,
`TestScreen.jsx`, `QuickAdd`/mobile route if present, `src/hooks/
useSpotifyPlayer.js` in full (not just the monitor logic covered in
Track 1 — read the whole file, especially `playTrack`'s fade-in sequencing
and any other timing-guarded ref), `src/lib/shuffle.js`,
`src/lib/playedStore.js`, `src/lib/fade.js`, and the Supabase sync path
for libraries/sets if it has any timing-sensitive debounce/retry logic.
Same standard as the other tracks: only flag/fix things with concrete
evidence (arithmetic, a real race, a swallowed error), not stylistic
nitpicks. If you find something outside timing/background/gradient
entirely (a logic bug, a stale comment describing removed behavior, dead
code) that's fair game too — "anything" was the actual ask.

## What to actually do

For anything you find with concrete evidence (arithmetic that doesn't
hold, a race you can point to specific lines for, a swallowed error) — fix
it, verify with `npx vitest run` and `npx vite build --outDir /tmp/x`,
then commit and push it yourself (you have real git access here, unlike
the Cowork session that wrote this prompt — no need to hand Ben terminal
commands one at a time, just `git add -A && git commit -m "..." && git
push` per logical fix, with a commit message that actually describes
everything in that commit, not just the first thing you thought of).
Vercel auto-deploys on push — no separate deploy step. For anything that
needs live confirmation (the Track 1 bug especially), get Ben to reproduce
it with you watching console output together rather than guessing. Do not
re-touch spring/timing values that are already correct and tuned just
because they're theoretically improvable — this app is explicitly marked
stable in CLAUDE.md, changes need a real bug behind them, not aesthetic
preference. When you're done, give Ben one plain-prose summary (not a
bullet list) of everything found, everything fixed, everything pushed,
and anything still open that needs him live to pin down.
