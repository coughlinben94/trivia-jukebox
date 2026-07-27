# Gradient Bug Fix + Library Search Implementation Plan

> **For agentic workers:** Execute task-by-task inline in this session (no subagent dispatch — scope is small, context is already loaded, and root causes were already diagnosed live against the deployed API). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the palette-extraction bug that makes every album's ambient background render as the same flat gold, flag (without blind-reverting) a self-noted animation-timing risk, and add an in-library search box so Ben can jump straight to a song's trim editor instead of scrolling the grid.

**Architecture:** Two surgical fixes to `api/palette.js` (undo a same-day regression), one documentation/monitor note on `LiveScreen.jsx` (no code change — unverified without live testing), and one small client-side filter + input added to `Jukebox.jsx`'s existing library panel, reusing the `LibraryCard`/`setModalTrack` flow that already exists.

**Tech Stack:** React 19, Vite, Vercel serverless function (`api/palette.js`, `sharp`), vitest.

---

## File Structure

- Modify: `api/palette.js` — remove the pre-quantization near-black pixel filter that starves `medianCut()` of real color data on dark covers; make the `MIN_COLORS` padding step respect hue-diversity instead of undoing it.
- Modify: `src/components/LiveScreen.jsx` — no code change; add one-line comment marking the 350ms entrance-settle sleep as an active watch item (already self-flagged in `a699d8d`'s commit message).
- Modify: `src/components/Jukebox.jsx` — add `librarySearch` state, a `filteredLibrary` memo, a search input in the library panel, and wire the existing `libraryGrid` memo to filter off it.

---

### Task 1: Fix palette dark-cover gold bug

**Files:**
- Modify: `api/palette.js:40-49` (pre-quantization filter)
- Modify: `api/palette.js:93-105` (MIN_COLORS padding)

**Root cause (confirmed live against the deployed API, not guessed):**

```
Leon Bridges  — "Ain't Got Nothing On You": #c1a30b #a25122 #9f850a #d7be44 #947f11
Mayer Hawthorne — "Love Like That":          #f7d025 #a85926 #efc621 #ffe840 #f3cc36
```

Two visually unrelated covers (a warm outdoor photo, a dark indoor photo) return near-identical ~50°-hue gold sets. Two bugs compound:

1. `a699d8d` (2026-07-26) added a `LUMA_THRESHOLD` filter that drops near-black pixels from the raw pixel population *before* `medianCut()` ever runs (lines 40-49). On a dark cover this can leave only a small warm-highlight fraction as input. Since `medianCut()` already picks each bucket's single *most vivid* pixel (not an average — that was the 7/19 fix), an already-highlight-only input just produces repeated near-duplicate golds. A second, separate filter at line 66 (`ranked.filter(c => c.luma >= LUMA_THRESHOLD)`) already drops near-black *candidates* from the final output — that one is correct and does the job this pre-filter was meant to do, without corrupting `medianCut`'s view of the real image.
2. `4d975f1`'s hue-diversity dedup (`HUE_GAP_DEG = 25`) only runs on the first selection pass (lines 84-92). The `MIN_COLORS` padding fallback (lines 93-105) backfills from `ranked` with no hue check at all, so it silently re-adds the near-duplicate golds the dedup pass just excluded.

- [ ] **Step 1: Remove the pre-quantization near-black filter**

Replace `api/palette.js:40-49`:

```js
    // Drop near-black pixels before quantising — a black border, letterboxing,
    // or a mostly-black cover shouldn't win a median-cut bucket and end up
    // driving a blob. Keep anything with real luminance so the gradient
    // favors the other colors on the cover. If the art really is all black
    // (filtering leaves too few points to be meaningful), fall back to the
    // unfiltered set rather than starving medianCut of input.
    const LUMA_THRESHOLD = 30;
    const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
    const litPixels = pixels.filter(p => luma(p) >= LUMA_THRESHOLD);
    const source = litPixels.length >= pixels.length * 0.05 ? litPixels : pixels;
```

with:

```js
    // Do NOT pre-filter dark pixels here. Tried on 2026-07-26 (a699d8d) to
    // keep a black border/letterboxing from winning a bucket, but on a
    // genuinely dark cover it can strip out most of the image, leaving only
    // a small warm-highlight fraction as medianCut's input — every bucket
    // then represents variations of that one highlight, which is why two
    // completely different covers (a golden outdoor photo and a dark indoor
    // photo) both extracted near-identical gold palettes on 2026-07-27.
    // The near-black filter on the RANKED CANDIDATES below (LUMA_THRESHOLD)
    // already keeps black from becoming an output color, without corrupting
    // what medianCut sees.
    const LUMA_THRESHOLD = 30;
    const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
    const source = pixels;
```

- [ ] **Step 2: Make MIN_COLORS padding respect hue diversity**

Replace `api/palette.js:99-105`:

```js
    let colors = vivid.map(c => c.hex);
    if (colors.length < MIN_COLORS) {
      for (const c of ranked) {
        if (colors.length >= MIN_COLORS) break;
        if (!colors.includes(c.hex)) colors.push(c.hex);
      }
    }
```

with:

```js
    let colors = vivid.map(c => c.hex);
    if (colors.length < MIN_COLORS) {
      // Pad with the same hue-gap rule as the main pass first — a cover that
      // only had 2 genuinely distinct hues shouldn't get those 2 diluted
      // back down to 5-near-duplicates just to hit MIN_COLORS. Only if that
      // still comes up short (the cover truly has no more distinct hues to
      // offer) fall back to filling with whatever's left, duplicates and all.
      for (const c of ranked) {
        if (colors.length >= MIN_COLORS) break;
        if (colors.includes(c.hex)) continue;
        const hue = hexToHue(c.hex);
        if (colors.some(hex => hueDelta(hexToHue(hex), hue) < HUE_GAP_DEG)) continue;
        colors.push(c.hex);
      }
      for (const c of ranked) {
        if (colors.length >= MIN_COLORS) break;
        if (!colors.includes(c.hex)) colors.push(c.hex);
      }
    }
```

- [ ] **Step 3: Verify against the two covers that reproduced the bug**

Run (against local `api/palette.js` logic — reuses the deployed function once pushed; for a pre-push sanity check, deploy to a preview or just push to main since Vercel auto-deploys on `git push` per this repo's workflow):

```bash
curl -s "https://trivia-jukebox.vercel.app/api/palette?url=https%3A%2F%2Fi.scdn.co%2Fimage%2Fab67616d00001e02f48c6b7df709454b5785253e"
curl -s "https://trivia-jukebox.vercel.app/api/palette?url=https%3A%2F%2Fi.scdn.co%2Fimage%2Fab67616d00001e02fb8ea05deeb8233e73ed5148"
```

Expected: the two results are no longer near-identical gold sets — the Mayer Hawthorne (dark cover) result in particular should include real browns/darker hues, not four shades of yellow.

- [ ] **Step 4: Commit**

```bash
git add api/palette.js
git commit -m "palette: fix dark-cover gold bug — drop pre-quantization luma filter, make MIN_COLORS padding hue-aware"
```

---

### Task 2: Entrance-settle timing — monitor, don't blind-revert

**Files:**
- Modify: `src/components/LiveScreen.jsx:230-239`

Ben's own commit (`a699d8d`) trimmed the post-settle pause before `entranceActive` flips from 600ms to 350ms, with the note: *"if a chop reappears on live testing, this is the first thing to revert."* No live evidence of a chop has been reported yet — reverting without evidence would just be guessing, and this file already carries the revert instructions inline. Leaving the code as-is; adding one line so the watch item isn't only in git log.

- [ ] **Step 1: Add a monitor comment**

In `src/components/LiveScreen.jsx`, directly above the existing comment block at line ~230 (`// Let the record + tonearm springs settle...`), add:

```js
        // WATCHING (2026-07-27): no live-tested chop reported yet at 350ms.
        // If one shows up, this is a one-line revert — see the note below.
```

- [ ] **Step 2: Commit**

```bash
git add src/components/LiveScreen.jsx
git commit -m "docs: flag entrance-settle timing as an active watch item"
```

---

### Task 3: In-library song search

**Files:**
- Modify: `src/components/Jukebox.jsx:75-78` (state)
- Modify: `src/components/Jukebox.jsx:822-839` (`libraryGrid` memo)
- Modify: `src/components/Jukebox.jsx:953-969` (library panel JSX)

Filters the already-added library (left panel) by song/artist name so Ben can jump straight to a track's `SongDetailModal` (trim in/out editor) instead of scrolling the grid. Separate from the existing right-side Spotify search (`query`/`results`, used to *add* new songs) — this one filters what's already in `library`.

- [ ] **Step 1: Add search state next to the existing search state**

In `src/components/Jukebox.jsx`, right after line 78 (`const [resultsKey, setResultsKey] = useState(0)`):

```js
  const [librarySearch, setLibrarySearch] = useState('')
```

- [ ] **Step 2: Add the filtered-library memo**

Directly above the `libraryGrid` memo (before line 822), add:

```js
  const filteredLibrary = useMemo(() => {
    const q = librarySearch.trim().toLowerCase()
    if (!q) return library
    return library.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.artists?.some(a => a.name.toLowerCase().includes(q))
    )
  }, [library, librarySearch])
```

- [ ] **Step 3: Point `libraryGrid` at the filtered list**

Replace `src/components/Jukebox.jsx:822-839`:

```js
  const libraryGrid = useMemo(() => (
    <div className="grid grid-cols-4 gap-2">
      {library.map((track, i) => (
        <LibraryCard
          key={track.id}
          track={track}
          isPlaying={track.id === playingId && !player.isPaused}
          isPaused={track.id === playingId && player.isPaused}
          onRemove={() => removeFromLibrary(track.id)}
          onClick={() => setModalTrack(track)}
          onDragStart={() => handleDragStart(i)}
          onDragOver={(e) => handleDragOver(e, i)}
          onDragEnd={handleDragEnd}
        />
      ))}
    </div>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [library, playingId, player.isPaused])
```

with:

```js
  const libraryGrid = useMemo(() => (
    <div className="grid grid-cols-4 gap-2">
      {filteredLibrary.map((track) => {
        const i = library.indexOf(track)
        return (
          <LibraryCard
            key={track.id}
            track={track}
            isPlaying={track.id === playingId && !player.isPaused}
            isPaused={track.id === playingId && player.isPaused}
            onRemove={() => removeFromLibrary(track.id)}
            onClick={() => setModalTrack(track)}
            onDragStart={() => handleDragStart(i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDragEnd={handleDragEnd}
          />
        )
      })}
    </div>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [filteredLibrary, library, playingId, player.isPaused])
```

`i` is looked up by identity against the unfiltered `library` array so drag-reorder indices stay correct against the real array even while a search filter is active. (Drag-to-reorder while filtered will feel odd — reordering across a filtered subset isn't a defined operation — but it won't corrupt state, since `handleDragStart`/`handleDragOver` always index into the real `library`.)

- [ ] **Step 4: Add the search input to the library panel**

Replace `src/components/Jukebox.jsx:953-969`:

```js
        {/* Library panel */}
        <div className="flex-1 flex flex-col overflow-hidden border-r border-white/[0.05]">

          {/* Library grid */}
          <div className="flex-1 overflow-y-auto p-3 pb-32">
            {library.length > 0 ? (
              libraryGrid
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center select-none pb-16">
                <p className="text-white text-sm">
                  {sets.activeId === 'main' ? 'Your library is empty' : `${activeSetName} is empty`}
                </p>
                <p className="text-ink-muted text-xs mt-1">Search on the right to add songs</p>
              </div>
            )}
          </div>
        </div>
```

with:

```js
        {/* Library panel */}
        <div className="flex-1 flex flex-col overflow-hidden border-r border-white/[0.05]">

          {/* Library search — filters the songs already in this set, to jump
              straight to a track's trim editor instead of scrolling. Separate
              from the Spotify search on the right, which adds new songs. */}
          {library.length > 0 && (
            <div className="p-3 border-b border-white/[0.05] flex-shrink-0">
              <div className="relative">
                <div className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-white">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10ZM14 14l-3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </div>
                <input
                  type="text"
                  placeholder="Search this library…"
                  value={librarySearch}
                  onChange={e => setLibrarySearch(e.target.value)}
                  className="w-full bg-white/[0.04] border border-white/[0.06] rounded-xl pl-9 pr-8 py-2.5 text-white placeholder-white/20 outline-none focus:border-accent/35 focus:bg-white/[0.06] transition-colors duration-200 text-sm"
                />
                {librarySearch && (
                  <button
                    onClick={() => setLibrarySearch('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white transition-colors duration-150 cursor-pointer text-sm leading-none"
                    aria-label="Clear library search"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Library grid */}
          <div className="flex-1 overflow-y-auto p-3 pb-32">
            {library.length > 0 ? (
              filteredLibrary.length > 0 ? (
                libraryGrid
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-center select-none pb-16">
                  <p className="text-white text-sm">No matches for &ldquo;{librarySearch}&rdquo;</p>
                </div>
              )
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center select-none pb-16">
                <p className="text-white text-sm">
                  {sets.activeId === 'main' ? 'Your library is empty' : `${activeSetName} is empty`}
                </p>
                <p className="text-ink-muted text-xs mt-1">Search on the right to add songs</p>
              </div>
            )}
          </div>
        </div>
```

- [ ] **Step 5: Clear the search when switching sets/themes**

`librarySearch` should reset when Ben switches sidebar themes — a search from "Main Library" silently carrying over and hiding songs in a different, unrelated set would be confusing. Find `switchSet` (around `Jukebox.jsx:686-694`) and add a reset inside it:

```js
    setSets(prev => ({ ...prev, activeId: id }))
```

becomes:

```js
    setSets(prev => ({ ...prev, activeId: id }))
    setLibrarySearch('')
```

- [ ] **Step 6: Manual verification (no automated UI test — Jukebox.jsx has no existing component test harness, and Playwright is unusable against this app per the OAuth block; this matches the existing test convention of shuffle.js/track.js/SongDetailModal.jsx only)**

On `trivia-jukebox.vercel.app`, with a library that has 5+ songs:
1. Type a partial song name into the new library search box — grid should filter live.
2. Type a partial artist name — grid should filter live.
3. Clear via the ✕ button — full grid returns.
4. Click a filtered result — `SongDetailModal` should open on the correct track (same as clicking any unfiltered `LibraryCard` today).
5. Switch to a different theme in the sidebar — search box should be empty, not still filtering.

- [ ] **Step 7: Run existing unit tests to confirm nothing broke**

```bash
npm run test
```

Expected: `shuffle.test.js`, `track.test.js`, `SongDetailModal.test.jsx` all still pass — none of these touch `Jukebox.jsx` directly, so this is a regression guard on shared modules (`track.js`), not a test of the new filter itself.

- [ ] **Step 8: Commit**

```bash
git add src/components/Jukebox.jsx
git commit -m "feat: add in-library search to jump to a song's trim editor"
```

---

## Self-Review

**Spec coverage:** all three items from the prior diagnosis are covered — palette dark-cover bug (Task 1), entrance-timing watch item (Task 2, deliberately not code-changed without evidence), library search (Task 3).

**Placeholder scan:** no TBD/"add appropriate handling" left in any step — every code block is the literal diff.

**Type/name consistency:** `filteredLibrary`, `librarySearch`, `setLibrarySearch` are used identically across Steps 2–5 of Task 3. `hueDelta`/`hexToHue` (Task 1, Step 2) already exist in `api/palette.js` from the 7/26 commit — reused, not redefined.
