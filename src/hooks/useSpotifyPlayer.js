import { useState, useEffect, useRef, useCallback } from 'react'
import { getToken, refreshToken } from '../lib/spotify'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const FADE_STEPS = 24
const FADE_MS = 2500

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
  const fadeVolume = async (from, to, gen) => {
    const player = playerRef.current
    if (!player) return
    fadingRef.current = true
    const steps = FADE_STEPS
    const stepMs = FADE_MS / steps
    for (let i = 0; i < steps; i++) {
      if (genRef.current !== gen) { fadingRef.current = false; return }
      const v = from + (to - from) * (i / steps)
      player.setVolume(Math.max(0, Math.min(1, v)))
      await sleep(stepMs)
    }
    fadingRef.current = false
  }

  // ─── Position monitor ────────────────────────────────────────────
  // preview=true: fade+pause at stopMs but do NOT advance to the next song
  const startMonitor = useCallback((stopMs, gen, preview = false) => {
    clearInterval(monitorRef.current)
    // Capture this monitor's own interval id in the closure rather than reading
    // monitorRef.current at clear-time — a stale tick from a superseded generation
    // could otherwise clear a *newer* monitor's interval (it reassigns monitorRef
    // between this tick firing and the ref-based clear running).
    const intervalId = setInterval(async () => {
      if (genRef.current !== gen) { clearInterval(intervalId); return }
      const state = await playerRef.current?.getCurrentState()
      if (!state) return
      if (seekingRef.current) return
      const pos = state.position
      if (!state.paused) setPosition(pos)

      const maxVol = maxVolumeRef.current
      // Guard !state.paused: don't trigger on Spotify's own buffering pauses near stopMs
      if (stopMs > 0 && pos >= stopMs - FADE_MS && !state.paused) {
        clearInterval(intervalId)
        if (!preview) onFadeStartRef.current?.()
        await fadeVolume(maxVol, 0, gen)
        if (genRef.current !== gen) return
        if (!preview) transitioningRef.current = true   // suppress isPaused during advance gap
        await playerRef.current?.pause()
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
        const deadline = setTimeout(() => resolve(null), 5000)
        const poll = setInterval(() => {
          if (deviceIdRef.current) {
            clearInterval(poll)
            clearTimeout(deadline)
            resolve(deviceIdRef.current)
          }
        }, 100)
      })
      if (!deviceId) {
        setError('Spotify player still connecting — try again in a moment.')
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
      return false
    }
    // A newer playTrack call already superseded this one while we awaited the
    // token — don't send a now-pointless play command for a stale uri.
    if (genRef.current !== gen) return undefined
    const doPlay = (tok) => fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: [uri] }),
      }
    )
    let playRes = await doPlay(token)
    if (playRes.status === 401) {
      // getToken() thought this token was fresh — Spotify disagrees. Force a
      // refresh once and retry before giving up.
      const freshToken = await refreshToken()
      if (!freshToken) {
        console.error('[playTrack] 401 on play and token refresh failed')
        return false
      }
      playRes = await doPlay(freshToken)
    }
    if (!playRes.ok) {
      console.error('[playTrack] play request failed', playRes.status)
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

    transitioningRef.current = false  // new track confirmed; restore isPaused tracking
    // A newer playTrack call superseded this one — bail without reporting
    // failure. Callers must treat `undefined` (superseded) differently from
    // `false` (genuine failure): only a real failure should reset the UI.
    if (genRef.current !== gen) return undefined

    if (!confirmed) {
      // The state-changed listener never fired a matching uri within 4s — the
      // /play PUT may have landed after a different call's PUT reordered on the
      // network, so Spotify could be playing the wrong track. Double-check
      // directly before blindly seeking/fading against a track that isn't loaded.
      const state = await player.getCurrentState()
      if (state?.track_window?.current_track?.uri !== uri) {
        console.error('[playTrack] Spotify never confirmed this track loaded — aborting')
        return false
      }
    }

    if (startMs > 0) {
      // Give Spotify 400ms to buffer the start of the track before seeking
      await sleep(400)
      if (genRef.current !== gen) return undefined

      const doSeek = async () => {
        // REST API seek only — more reliable than SDK seek; using both caused a double-seek glitch
        const t = await getToken()
        await fetch(
          `https://api.spotify.com/v1/me/player/seek?position_ms=${startMs}&device_id=${deviceId}`,
          { method: 'PUT', headers: { Authorization: `Bearer ${t}` } }
        )
      }

      await doSeek()

      // Poll until position lands at or just past the in-point.
      // Allow up to 300ms before startMs to handle slight Spotify overshoot.
      // Reject if position is still far before startMs — that means seek hasn't landed yet.
      const landed = await new Promise(resolve => {
        const deadline = setTimeout(() => resolve(false), 3000)
        const poll = setInterval(async () => {
          const s = await player.getCurrentState()
          if (!s) return
          if (s.position >= startMs - 300 && s.position <= startMs + 5000) {
            clearInterval(poll)
            clearTimeout(deadline)
            resolve(true)
          }
        }, 100)
      })

      // If first seek timed out, try once more
      if (!landed && genRef.current === gen) {
        await doSeek()
        await sleep(800)
      }
    } else {
      await sleep(200)
    }

    if (genRef.current !== gen) return undefined

    const maxVol = maxVolumeRef.current
    await fadeVolume(0, maxVol, gen)

    if (genRef.current !== gen) return undefined

    startMonitor(stopMs > startMs ? stopMs : 0, gen, preview)
    return true
  }, [startMonitor])

  // ─── Fade out and pause — live screen playback only ───────────────
  const fadeAndPause = useCallback(async () => {
    genRef.current += 1
    const gen = genRef.current
    transitioningRef.current = false  // manual stop always restores isPaused tracking
    clearInterval(monitorRef.current)
    const maxVol = maxVolumeRef.current
    await fadeVolume(maxVol, 0, gen)
    if (genRef.current !== gen) return
    await playerRef.current?.pause()
    playerRef.current?.setVolume(0)
  }, [])

  // ─── Pause immediately, no fade — preview/scrubber (SongDetailModal) ──
  const pause = useCallback(async () => {
    genRef.current += 1
    transitioningRef.current = false
    clearInterval(monitorRef.current)
    await playerRef.current?.pause()
  }, [])

  // ─── Manual scrub ────────────────────────────────────────────────
  const seek = useCallback((ms) => {
    seekingRef.current = true
    clearTimeout(seekTimerRef.current)
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
