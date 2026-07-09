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
