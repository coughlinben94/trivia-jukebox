# Folder Guide — Trivia Jukebox

Plain-English map of this project, so you can find your way around without a coding background.

## What this is
A Spotify-powered music player used during the grading breaks at Baynes trivia nights — a turntable-style UI with track fades, trim points, an album-gradient background, shuffle, and saved libraries. Built with React + Vite.

## How to run it on your computer
1. Open a terminal in this folder.
2. `npm install` (first time only)
3. `npm run dev` — opens the player in your browser (Vite prints the address).

## What's in each folder
- **src/** — the actual app: the player, the turntable, playback logic, the visual background. Almost all changes happen here.
- **public/** — images and static files served directly to the browser.
- **api/** — small server-side functions (e.g. talking to Spotify).
- **dist/** — an auto-generated built copy of the app, created by `npm run build`. Never edited by hand; safe to delete and regenerate.

## Key files at the root
- **README.md** — technical template notes (fairly generic).
- **PRODUCT.md** / **STACK.md** — what it does and what it's built with.
- **index.html** — the base page the app loads into.
- **package.json** — project settings and `npm` commands.
- The `*.config.js` files — tooling settings; leave alone unless changing setup.
