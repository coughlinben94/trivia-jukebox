# Product

## Register

product

## Users

Ben — solo trivia host running the app on a MacBook during trivia nights. Single operator, occasional low-light bar/venue environment, wants to manage song queues and trigger music rounds quickly without thinking about the tool. No other users. Mobile irrelevant.

## Product Purpose

A Spotify-connected jukebox for trivia nights. Ben builds themed song sets before the event, then shuffle-plays them with automatic crossfades during music rounds. The "Live Screen" (shown on a TV or projector) is the audience-facing moment — a spinning vinyl record with album art that reveals the song. The main UI is logistics; the live screen is the experience.

## Brand Personality

Warm, playful, retro. Vinyl record shop meets jukebox — tactile, a little nostalgic, fun without being kitschy. The live screen already has this DNA; the rest of the app should too.

## Anti-references

- **Generic Spotify clone** — the app uses Spotify but is NOT Spotify. Dark gray + `#1DB954` green everywhere reads as a knockoff, not a product with its own identity.
- **SaaS dashboard** — no cards-with-metrics, no blue/purple gradients, no startup-y nav patterns.
- **Flat minimalist iOS** — needs more warmth and character than Apple's ultra-spare aesthetic.

## Design Principles

1. **The live screen is the product** — the jukebox management UI is logistics; everything else defers to the moment when music plays and the audience sees the record spin.
2. **Retro with restraint** — vinyl DNA expressed through texture, warmth, and motion, not literal skeuomorphism or clip-art. No faux-wood panels.
3. **Single-operator speed** — one person, one laptop, one focus. Every task should be reachable with minimal clicks. No confirmation dialogs for reversible actions.
4. **Earn familiarity** — standard affordances for standard tasks; save the personality for the moments that deserve it (the live screen, the shuffle launch).
5. **Disappear during the moment** — during live play, the UI is invisible; Ben is looking at the audience, not the screen.

## Accessibility & Inclusion

Single known user on known hardware. WCAG AA still applies for legibility in potentially dim venue lighting. No stated reduced-motion preference, but `prefers-reduced-motion` should be respected throughout. Mobile is aspirational (Ben would like to use it on his own phone eventually) but not currently required — optimize for laptop first.
