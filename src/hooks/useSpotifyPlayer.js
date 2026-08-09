import { useState, useEffect, useRef, useCallback } from 'react'
import { getToken, refreshToken } from '../lib/spotify'
import { computeFadeBudget } from '../lib/fade'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const FADE_STEPS = 24
const FADE_MS = 2500

// Root cause of the 2026-07-28 "shuffle plays nothing, forever" bug: every
// other awaited network step in this file (deviceId poll, play-confirmation
// listener, seek landed-poll) has an explicit deadline with a fallback. The
// play PUT and seek PUT fetches did not — a bare `await fetch(...)` with no
// timeout. If that fetch never settles (a stalled connection, a dropped
// response — doesn't matter why), playTrack hangs forever with no error, no
// fade-in, no tonearm drop, no audio, and no recovery. Surviving a page
// refresh or a full Spotify disconnect/reconnect doesn't rule this out: the
// hang isn't caused by stale in-memory state, it's caused by whatever's
// stalling the network path repeating on the next attempt too. Wrap the
// two calls that can block the whole pipeline (play, seek) in a hard
// timeout so a stall degrades to a caught failure instead of an infinite
// hang.
const NETWORK_TIMEOUT_MS = 6000
const fetchWithTimeout = (url, options, timeoutMs = NETWORK_TIMEOUT_MS) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer))
}

// Same gap, different shape (2026-07-30): the Spotify SDK's own
// player.pause() returns a Promise we don't control the way a fetch's
// AbortController does — there's no signal to pass it, it just resolves
// when Spotify acknowledges the pause. If that ack never comes, `await
// player.pause()` blocks forever with no error, same as the unguarded
// fetches above. Reproduced live: start a shuffle session, open a
// DIFFERENT song's preview in SongDetailModal, hit its play button —
// handlePlay's `await onStopLiveShuffle()` (which bottoms out in
// fadeAndPause's `await playerRef.current?.pause()` below) never resolved,
// so the preview's own playTrack call was never even reached. Races the
// pause call against a timeout instead of awaiting it bare — proceeding
// after the timeout (rather than throwing) is deliberate: the caller's
// next step is always to force local volume/state anyway, so a slow-to-ack
// pause shouldn't block that.
const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise(resolve => setTimeout(resolve, ms)),
])
// Manual stop (spacebar/iPad) needs to actually go quiet fast — the host hits
// it because they're about to talk (read a question, make an announcement),
// not because a song is musically ending. The full FADE_MS=2500 fade was
// built for that second case (song-to-song, see startMonitor) and dragging it
// into a deliberate "stop now" left trailing audio bleeding into the first
// couple seconds of whatever the host said next. Short enough to avoid an
// audible click/pop, nowhere near long enough to read as a musical fade-out.
const STOP_FADE_MS = 400

export function useSpotifyPlayer({ onAdvance, onFadeStart } = {}) {
  const [isReady, setIsReady] = useState(false)
  const [isPaused, setIsPaused] = useState(true)
  const [currentTrack, setCurrentTrack] = useState(null)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState(null)
  const [volume, setVolumeState] = useState(0.8)

  const playerRef = useRef(null)
  const deviceIdRef = useRef(null)
  const genRef = useRef(0)
  const monitorRef = useRef(null)
  const seekingRef = useRef(false)
  const seekTimerRef = useRef(null)
  const stopWatchDisabledRef = useRef(false)
  const maxVolumeRef = useRef(0.8)
  const onAdvanceRef = useRef(onAdvance)
  const onFadeStartRef = useRef(onFadeStart)
  // Suppresses the transient isPaused=true the SDK emits during auto-advance
  const transitioningRef = useRef(false)
  const fadingRef = useRef(false)

  useEffect(() => { onAdvanceRef.current = onAdvance }, [onAdvance])
  useEffect(() => { onFadeStartRef.current = onFadeStart }, [onFadeStart])

  useEffect(() => {
    window.onSpotifyWebPlaybackSDKReady = () => {}

    let player

    const init = async () => {
      const token = await getToken()
      if (!token) return

      player = new window.Spotify.Player({
        name: 'Trivia Jukebox',
        getOAuthToken: cb => getToken().then(cb),
        volume: 0,
      })

      player.addListener('ready', ({ device_id }) => {
        deviceIdRef.current = device_id
        setIsReady(true)
      })
      player.addListener('not_ready', () => setIsReady(false))
      player.addListener('player_state_changed', state => {
        if (!state) return
        // The SDK hands us a fresh track object on every state event (buffer,
        // seek, pause…). Keep the previous reference while the URI is unchanged
        // so consumers comparing by identity (memo'd LiveScreen) don't re-render.
        const next = state.track_window.current_track
        setCurrentTrack(prev => (prev?.uri === next?.uri ? prev : next))
        // Suppress the transient paused=true the SDK emits right after auto-advance pause()
        if (!transitioningRef.current) setIsPaused(state.paused)
        setDuration(state.duration)
        if (!seekingRef.current) setPosition(state.position)
      })
      player.addListener('account_error', () =>
        setError('Spotify Premium required for in-browser playback.')
      )
      player.addListener('authentication_error', () =>
        setError('Auth failed — try reconnecting Spotify.')
      )
      player.addListener('initialization_error', ({ message }) =>
        setError(`Player init failed: ${message}`)
      )

      await player.connect()
      playerRef.current = player
    }

    if (window.Spotify) init()
    else window.onSpotifyWebPlaybackSDKReady = init

    return () => {
      clearInterval(monitorRef.current)
      playerRef.current?.disconnect()
    }
  }, [])

  // ─── Fade helpers ───────────────────────────────────────────────
  // durationMs defaults to FADE_MS but callers can pass a shorter window when
  // there isn't a full FADE_MS of room outside the trimmed in/out points to
  // spend on the fade (see playTrack/startMonitor).
  const fadeVolume = async (from, to, gen, durationMs = FADE_MS) => {
    const player = playerRef.current
    if (!player) return
    fadingRef.current = true
    const steps = FADE_STEPS
    const stepMs = durationMs / steps
    for (let i = 0; i < steps; i++) {
      if (genRef.current !== gen) { fadingRef.current = false; return }
      const v = from + (to - from) * (i / steps)
      player.setVolume(Math.max(0, Math.min(1, v)))
      await sleep(stepMs)
    }
    // i/steps never reaches 1 inside the loop (i maxes out at steps-1), so the
    // last applied value is one step short of `to` — land exactly on target.
    if (genRef.current === gen) player.setVolume(Math.max(0, Math.min(1, to)))
    fadingRef.current = false
  }

  // ─── Position monitor ────────────────────────────────────────────
  // preview=true: fade+pause at stopMs but do NOT advance to the next song
  // fadeOutBudget: how much of the trim window the out-fade may spend — must
  // match the fade-in's own budget (see playTrack) so the two never overlap.
  const startMonitor = useCallback((stopMs, gen, preview = false, fadeOutBudget = FADE_MS) => {
    clearInterval(monitorRef.current)
    stopWatchDisabledRef.current = false
    // Capture this monitor's own interval id in the closure rather than reading
    // monitorRef.current at clear-time — a stale tick from a superseded generation
    // could otherwise clear a *newer* monitor's interval (it reassigns monitorRef
    // between this tick firing and the ref-based clear running).
    const intervalId = setInterval(async () => {
      if (genRef.current !== gen) { clearInterval(intervalId); return }
      // Capped (2026-08-07, Opus review) — matches the file's own stated
      // discipline (every awaited step needs a deadline) that this specific
      // call missed. Degrades safely: !state just skips one 300ms tick.
      const state = await withTimeout(playerRef.current?.getCurrentState(), 1500)
      if (!state) return
      if (seekingRef.current) return
      const pos = state.position
      if (!state.paused) setPosition(pos)

      const maxVol = maxVolumeRef.current
      // Trigger BEFORE stopMs now, not at it (flipped 2026-07-28) — the fade
      // spends its time INSIDE the trim window, landing at 0 exactly AT
      // stopMs, mirroring how the fade-IN already spends its time inside the
      // window from startMs. The previous approach (trigger at stopMs, fade
      // into the time AFTER it) deliberately kept the trimmed content at full
      // volume all the way through the out-point — but that meant playback
      // always continued up to FADE_MS past the point the host actually
      // chose to stop at, which on some songs ran straight into the next
      // lyric/sentence instead of a clean gap. Trade-off: a song whose
      // punchy final note lands right at stopMs now fades into that note
      // instead of hitting it at full volume — acceptable to avoid ever
      // overshooting the host's chosen stop point.
      // Guard !state.paused: don't trigger on Spotify's own buffering pauses near stopMs
      if (stopMs > 0 && pos >= stopMs - fadeOutBudget && !state.paused && !stopWatchDisabledRef.current) {
        clearInterval(intervalId)
        if (!preview) onFadeStartRef.current?.()
        // Clamp to whatever's actually left before the out-point — polling is
        // only every 300ms, so pos may already be partway into the fade
        // window by the time this tick fires; fade over what's actually left
        // rather than assuming the full budget is still available.
        const roomBefore = Math.max(0, stopMs - pos)
        const fadeMs = Math.min(fadeOutBudget, roomBefore)
        await fadeVolume(maxVol, 0, gen, fadeMs)
        if (genRef.current !== gen) return
        if (!preview) transitioningRef.current = true   // suppress isPaused during advance gap
        // Guarded (2026-08-04, Opus review of the A->B gap): this was the one
        // remaining un-timeout'd SDK await in the file -- the exact shape of
        // hang the header comment above describes, just not yet hit here.
        // Volume is already ramped to 0 by this point and the next playTrack
        // call replaces playback outright, so proceeding after a slow ack
        // risks nothing audible.
        await withTimeout(playerRef.current?.pause(), 200)
        // A stop can land during the await above — re-check before advancing,
        // and skip setVolume(0) too so a superseding play isn't muted.
        if (genRef.current !== gen) return
        playerRef.current?.setVolume(0)
        if (!preview) onAdvanceRef.current?.()
      }
    }, 300)
    monitorRef.current = intervalId
  }, [])

  // ─── Play a track with custom start/stop ─────────────────────────
  const playTrack = useCallback(async (uri, startMs = 0, stopMs = 0, preview = false) => {
    const player = playerRef.current
    if (!player) return false

    let deviceId = deviceIdRef.current
    if (!deviceId) {
      // SDK ready event hasn't fired yet — poll for up to 5s
      deviceId = await new Promise(resolve => {
        const poll = setInterval(() => {
          if (deviceIdRef.current) {
            clearInterval(poll)
            clearTimeout(deadline)
            resolve(deviceIdRef.current)
          }
        }, 100)
        // clearInterval(poll) added (2026-08-07, Opus review) — the deadline
        // losing the race left this 100ms interval running for the life of
        // the page, exactly when the device never becomes ready (i.e.
        // exactly when something's already gone wrong).
        const deadline = setTimeout(() => { clearInterval(poll); resolve(null) }, 5000)
      })
      if (!deviceId) {
        setError('Spotify player still connecting — try again in a moment.')
        transitioningRef.current = false
        return false
      }
    }

    genRef.current += 1
    const gen = genRef.current
    clearInterval(monitorRef.current)

    // Await the volume-zero so Spotify can't start audibly before the seek
    await player.setVolume(0)
    setIsPaused(false)

    const token = await getToken()
    if (!token) {
      console.error('[playTrack] token refresh failed — aborting play')
      transitioningRef.current = false
      return false
    }
    // A newer playTrack call already superseded this one while we awaited the
    // token — don't send a now-pointless play command for a stale uri.
    if (genRef.current !== gen) return undefined
    // position_ms in the /play body itself (2026-08-04, Opus review of the
    // A->B gap): asks Spotify to start already at the trim's in-point instead
    // of starting at 0 and seeking after — when it lands close enough (checked
    // below, after confirm), this skips the 400ms buffer sleep + a whole seek
    // round trip + the landed-poll entirely. Nothing below this is deleted:
    // if it DOESN'T land close enough, the existing sleep->seek->poll path
    // still runs untouched as a fallback, so this can only ever save time,
    // never remove the safety net.
    const doPlay = (tok) => fetchWithTimeout(
      `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(startMs > 0 ? { uris: [uri], position_ms: startMs } : { uris: [uri] }),
      }
    )
    let playRes
    try {
      playRes = await doPlay(token)
      if (playRes.status === 401) {
        // getToken() thought this token was fresh — Spotify disagrees. Force a
        // refresh once and retry before giving up.
        const freshToken = await refreshToken()
        // A newer playTrack call superseded this one while we awaited the
        // refresh — don't retry a now-pointless play command for a stale uri.
        if (genRef.current !== gen) return undefined
        if (!freshToken) {
          console.error('[playTrack] 401 on play and token refresh failed')
          transitioningRef.current = false
          return false
        }
        playRes = await doPlay(freshToken)
      }
    } catch (err) {
      // Timeout (AbortError) or a genuine network failure — either way the
      // play request never landed. Fail cleanly instead of hanging forever.
      console.error('[playTrack] play request timed out or failed', err)
      transitioningRef.current = false
      return false
    }
    if (!playRes.ok) {
      console.error('[playTrack] play request failed', playRes.status)
      transitioningRef.current = false
      return false
    }

    const confirmed = await new Promise(resolve => {
      const timeout = setTimeout(() => {
        player.removeListener('player_state_changed', check)
        resolve(false)
      }, 4000)
      const check = (state) => {
        if (state?.track_window?.current_track?.uri === uri) {
          clearTimeout(timeout)
          player.removeListener('player_state_changed', check)
          resolve(true)
        }
      }
      player.addListener('player_state_changed', check)
    })

    // A newer playTrack call superseded this one — bail without reporting
    // failure. Callers must treat `undefined` (superseded) differently from
    // `false` (genuine failure): only a real failure should reset the UI.
    // Gen check moved above the transitioningRef write (2026-08-07, Opus
    // review) — writing it first let a superseded call transiently
    // un-suppress isPaused tracking while a newer call was still mid-confirm.
    if (genRef.current !== gen) return undefined
    transitioningRef.current = false  // new track confirmed; restore isPaused tracking

    if (!confirmed) {
      // The state-changed listener never fired a matching uri within 4s — the
      // /play PUT may have landed after a different call's PUT reordered on the
      // network, so Spotify could be playing the wrong track. Double-check
      // directly before blindly seeking/fading against a track that isn't loaded.
      const state = await withTimeout(player.getCurrentState(), 1500)
      if (state?.track_window?.current_track?.uri !== uri) {
        console.error('[playTrack] Spotify never confirmed this track loaded — aborting')
        return false
      }
    }

    // Fade-in: seek to startMs itself (the trim's own in-point) and ramp
    // volume 0 → max over the stretch of trimmed content that follows — the
    // clip audibly fades up from its own start. Both the fade-in and the
    // fade-out (see startMonitor) now spend their ramp INSIDE the trim
    // window (2026-07-28), so a short trim can't fit two full FADE_MS ramps
    // without them colliding — fade-in eating the whole window left nothing
    // for the fade-out, which then triggered instantly and cut the song off
    // right after it faded in. computeFadeBudget splits the window evenly
    // between the two fades so they never overlap; both sides must use the
    // SAME budget (passed to startMonitor below) or they'll drift back out
    // of sync.
    const fadeBudget = computeFadeBudget(startMs, stopMs, FADE_MS)
    const fadeInMs = fadeBudget

    // Did the position_ms sent with /play above already land close enough to
    // skip the seek fallback entirely? Checked via getCurrentState, not the
    // player_state_changed payload used for `confirmed` above — position
    // isn't reliably present on that event.
    let seekNeeded = startMs > 0
    if (startMs > 0) {
      const s = await withTimeout(player.getCurrentState(), 1500)
      if (genRef.current !== gen) return undefined
      if (s && s.position >= startMs - 300 && s.position <= startMs + 3000) {
        seekNeeded = false
      }
    }

    if (startMs > 0 && seekNeeded) {
      // Give Spotify 400ms to buffer the start of the track before seeking
      await sleep(400)
      if (genRef.current !== gen) return undefined

      const doSeek = async () => {
        // REST API seek only — more reliable than SDK seek; using both caused a double-seek glitch
        try {
          const t = await getToken()
          await fetchWithTimeout(
            `https://api.spotify.com/v1/me/player/seek?position_ms=${startMs}&device_id=${deviceId}`,
            { method: 'PUT', headers: { Authorization: `Bearer ${t}` } }
          )
        } catch (err) {
          // Timeout (AbortError) or network failure — don't hang the whole
          // playTrack pipeline on a seek that never lands. The landed-poll
          // right after this already has its own 3s deadline and a one-time
          // retry; swallowing here just lets that existing fallback run
          // instead of blocking forever on an unsettled fetch.
          console.error('[playTrack] seek request timed out or failed', err)
        }
      }

      await doSeek()

      // Poll until position lands at or just past the in-point. Checks
      // immediately (2026-08-04) instead of waiting a full 100ms tick before
      // the first check, then falls back to the same 100ms interval.
      // Allow up to 300ms before startMs to handle slight Spotify overshoot.
      // Reject if position is still far before startMs — that means seek hasn't landed yet.
      const landed = await new Promise(resolve => {
        let poll, deadline
        const settle = (result) => { clearInterval(poll); clearTimeout(deadline); resolve(result) }
        const check = async () => {
          const s = await withTimeout(player.getCurrentState(), 1500)
          return !!s && s.position >= startMs - 300 && s.position <= startMs + 5000
        }
        deadline = setTimeout(() => settle(false), 3000)
        poll = setInterval(async () => { if (await check()) settle(true) }, 100)
        check().then(ok => { if (ok) settle(true) })
      })

      // If first seek timed out, try once more
      if (!landed && genRef.current === gen) {
        await doSeek()
        await sleep(800)
      }
    } else if (startMs === 0) {
      await sleep(200)
    }
    // else: position_ms already landed close enough — go straight to fade-in.

    if (genRef.current !== gen) return undefined

    const maxVol = maxVolumeRef.current
    await fadeVolume(0, maxVol, gen, fadeInMs)

    if (genRef.current !== gen) return undefined

    startMonitor(stopMs > startMs ? stopMs : 0, gen, preview, fadeBudget)
    return true
  }, [startMonitor])

  // ─── Fade out and pause — live screen playback only ───────────────
  const fadeAndPause = useCallback(async () => {
    genRef.current += 1
    const gen = genRef.current
    transitioningRef.current = false  // manual stop always restores isPaused tracking
    clearInterval(monitorRef.current)
    const maxVol = maxVolumeRef.current
    await fadeVolume(maxVol, 0, gen, STOP_FADE_MS)
    if (genRef.current !== gen) return
    await withTimeout(playerRef.current?.pause(), 2000)
    // A newer call (e.g. playTrack) may have started while we awaited the
    // pause — don't zero the volume out from under it.
    if (genRef.current !== gen) return
    playerRef.current?.setVolume(0)
  }, [])

  // ─── Pause immediately, no fade — preview/scrubber (SongDetailModal) ──
  const pause = useCallback(async () => {
    genRef.current += 1
    transitioningRef.current = false
    clearInterval(monitorRef.current)
    await withTimeout(playerRef.current?.pause(), 2000)
  }, [])

  // ─── Manual scrub ────────────────────────────────────────────────
  // disableStopWatch: SongDetailModal passes this so dragging past the
  // song's saved trim-out point doesn't immediately trigger the position
  // monitor's fade+pause (it's still watching for the OLD stopMs from
  // whichever playTrack call is live) — lets the preview scrubber roam the
  // whole track. Player.jsx's live-playback scrubber omits it, so trims
  // still stop live playback at the host's chosen out-point.
  const seek = useCallback((ms, { disableStopWatch = false } = {}) => {
    seekingRef.current = true
    clearTimeout(seekTimerRef.current)
    if (disableStopWatch) stopWatchDisabledRef.current = true
    setPosition(ms)
    const deviceId = deviceIdRef.current
    // REST API seek only — more reliable than the SDK's player.seek(), same as playTrack's doSeek
    if (deviceId) {
      getToken().then(token => {
        if (!token) return
        fetch(
          `https://api.spotify.com/v1/me/player/seek?position_ms=${ms}&device_id=${deviceId}`,
          { method: 'PUT', headers: { Authorization: `Bearer ${token}` } }
        )
      })
    }
    seekTimerRef.current = setTimeout(() => { seekingRef.current = false }, 700)
  }, [])

  // ─── Volume control ──────────────────────────────────────────────
  const setVolume = useCallback((v) => {
    maxVolumeRef.current = v
    setVolumeState(v)
    if (fadingRef.current) return
    playerRef.current?.setVolume(v)
  }, [])

  return {
    isReady, isPaused, currentTrack, position, duration, error,
    volume, setVolume,
    playTrack, fadeAndPause, pause, seek,
  }
}
