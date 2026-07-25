# trivia-jukebox — Claude Code Instructions

## Superpowers (read first, every session)
Read `~/.agents/skills/using-superpowers/SKILL.md` at the start of every session. Non-negotiable.

Invoke these automatically:
- systematic-debugging → before any bug fix
- writing-plans → before any new feature
- verification-before-completion → before marking anything done
- dispatching-parallel-agents → for large multi-part tasks
- subagent-driven-development → for complex feature builds
- brainstorming → before entering plan mode

## Read These First
1. `~/.agents/skills/trivia-jukebox/SKILL.md` — THE playbook for this app: turntable/playback UI, track fades + trim points, canvas album-gradient background, palette extraction, shuffle, libraries/sets, QuickAdd route, Trivia OS handoff, Supabase sync
2. `~/.agents/skills/baynes-ops/SKILL.md` — suite-wide context, Supabase patterns
3. `~/.agents/skills/emil-design-eng/SKILL.md` — animation/polish feel (turntable, gradient, springs)

## Hard rules (details in the jukebox skill — these are the ones that bite)
- **This app is stable — do not refactor, restructure, or add complexity without a clear bug to fix.**
- **Local dev is broken on Vite 8** (`npm run dev` is flaky — import-analysis parser bug). Test against the live URL `trivia-jukebox.vercel.app`, not localhost. Don't try to fix local dev.
- **Deploy is `git push` → Vercel auto-deploys.** No separate deploy command.
- **Playwright is unusable here** — Spotify OAuth blocks automation browsers. Unit tests (`vitest run`) cover `shuffle.js`/`track.js`/`SongDetailModal.jsx`; playback/OAuth flows require a manual live-URL check.
- **Supabase table `jukebox_state`** (singleton row) lives in the Business Suite project (`dreggwinegtirxxanntv`) per this repo's env — NOT the Trivia project. Never create a new project.
- **Do not re-add in-app volume ducking** — it was intentionally deleted; volume is handled at system level (BetterTouchTool + Stream Deck).
- **No iframe embedding** — Spotify blocks it. Trivia OS integration uses full-page navigation.
- **When a data-fed visual looks wrong, dump the data before touching the renderer.** The gradient is driven by `api/palette.js`; the renderer only draws what the palette hands it. On 2026-07-19 roughly five hours and eight commits went into tuning gradient renderers — a WebGL noise version, a from-scratch OKLab mesh, sharpened weights, a rebuilt two-color collision, an intensity bump — chasing "flat, no color." At 21:30 commit `30e6594` found the actual cause: bucket-averaging in `api/palette.js` was washing out vivid colors before any renderer saw them. Print the extracted palette for the offending album cover first. If the colors are already dull in the array, the renderer is not the bug.
- **Two live gradient renderers exist; know which you're judging.** `AlbumGradient.jsx` (radial circle blobs) is the default. `AlbumGradientMesh.jsx` (Canvas2D soft mesh, OKLab mixing) is opt-in via `?gradient=mesh` or `localStorage.trivia_gradient_engine = 'mesh'`. `AlbumGradientNoise.jsx` is retired (read as "lava lamp"). **Open question, unresolved:** the mesh was demoted to opt-in at 21:36 on 2026-07-19 — six minutes after the palette fix landed — so it has never been judged against a working palette. Before re-judging it, note that several of its tuning layers (weight sharpening, accent boost, the +25% intensity pass) were added specifically to fight the washed-out palette and may now overshoot. Turn those down before deciding, or the comparison is against a costume, not the renderer.
