import { useState, useEffect, useRef, useCallback } from 'react'
import { getToken } from '../lib/spotify'

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
  const duckRef = useRef(false)
  const duckRampRef = useRef(null)  // { cancel: () => void } | null

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
        setCurrentTrack(state.track_window.current_track)
        // Suppress the transient paused=true the SDK emits right after auto-advance pause()
        if (!transitioningRef.current) setIsPaused(state.paused)
        setDuration(state.duration)
        setPosition(state.position)
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
    monitorRef.current = setInterval(async () => {
      if (genRef.current !== gen) { clearInterval(monitorRef.current); return }
      const state = await playerRef.current?.getCurrentState()
      if (!state) return
      if (seekingRef.current) return
      const pos = state.position
      if (!state.paused) setPosition(pos)

      const maxVol = maxVolumeRef.current
      // Guard !state.paused: don't trigger on Spotify's own buffering pauses near stopMs
      if (stopMs > 0 && pos >= stopMs - FADE_MS && !state.paused) {
        clearInterval(monitorRef.current)
        if (!preview) onFadeStartRef.current?.()
        await fadeVolume(maxVol, 0, gen)
        if (genRef.current !== gen) return
        transitioningRef.current = true   // suppress isPaused during advance gap
        await playerRef.current?.pause()
        playerRef.current?.setVolume(0)
        if (!preview) onAdvanceRef.current?.()
      }
    }, 300)
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
    await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: [uri] }),
      }
    )

    await new Promise(resolve => {
      const timeout = setTimeout(() => {
        player.removeListener('player_state_changed', check)
        resolve()
      }, 4000)
      const check = (state) => {
        if (state?.track_window?.current_track?.uri === uri) {
          clearTimeout(timeout)
          player.removeListener('player_state_changed', check)
          resolve()
        }
      }
      player.addListener('player_state_changed', check)
    })

    transitioningRef.current = false  // new track confirmed; restore isPaused tracking
    if (genRef.current !== gen) return

    if (startMs > 0) {
      // Give Spotify 400ms to buffer the start of the track before seeking
      await sleep(400)
      if (genRef.current !== gen) return

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

    if (genRef.current !== gen) return

    const maxVol = maxVolumeRef.current
    await fadeVolume(0, maxVol, gen)

    if (genRef.current !== gen) return

    // If duck key is still held through the transition, snap back to ducked level
    if (duckRef.current) {
      playerRef.current?.setVolume(maxVolumeRef.current * 0.20)
    }

    startMonitor(stopMs > startMs ? stopMs : 0, gen, preview)
    return true
  }, [startMonitor])

  // ─── Fade out and pause ──────────────────────────────────────────
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

  // ─── Manual scrub ────────────────────────────────────────────────
  const seek = useCallback((ms) => {
    seekingRef.current = true
    clearTimeout(seekTimerRef.current)
    setPosition(ms)
    playerRef.current?.seek(ms)
    seekTimerRef.current = setTimeout(() => { seekingRef.current = false }, 700)
  }, [])

  // ─── Volume control ──────────────────────────────────────────────
  const setVolume = useCallback((v) => {
    maxVolumeRef.current = v
    setVolumeState(v)
    if (fadingRef.current) return
    // While ducked, apply the ducked level so the user's real volume is preserved
    playerRef.current?.setVolume(duckRef.current ? v * 0.20 : v)
  }, [])

  // ─── Duck / unduck (hold-to-talk-over-music) ─────────────────────
  // 10 steps × 25 ms = 250 ms ramp; cancel { cancel() } ref stops any in-flight ramp
  const duck = useCallback(() => {
    if (duckRef.current) return
    duckRef.current = true
    if (duckRampRef.current) { duckRampRef.current.cancel(); duckRampRef.current = null }
    if (fadingRef.current) return  // fade owns the volume; intent recorded in duckRef
    const player = playerRef.current
    if (!player) return
    const from = maxVolumeRef.current
    const to   = maxVolumeRef.current * 0.20
    let cancelled = false, step = 0
    duckRampRef.current = { cancel: () => { cancelled = true } }
    const tick = () => {
      if (cancelled) return
      step++
      player.setVolume(Math.max(0, from + (to - from) * step / 10))
      if (step < 10) setTimeout(tick, 25)
      else duckRampRef.current = null
    }
    setTimeout(tick, 25)
  }, [])

  const unduck = useCallback(() => {
    if (!duckRef.current) return
    duckRef.current = false
    if (duckRampRef.current) { duckRampRef.current.cancel(); duckRampRef.current = null }
    if (fadingRef.current) return  // fade owns the volume; intent recorded in duckRef
    const player = playerRef.current
    if (!player) return
    const from = maxVolumeRef.current * 0.20
    const to   = maxVolumeRef.current
    let cancelled = false, step = 0
    duckRampRef.current = { cancel: () => { cancelled = true } }
    const tick = () => {
      if (cancelled) return
      step++
      player.setVolume(Math.min(1, from + (to - from) * step / 10))
      if (step < 10) setTimeout(tick, 25)
      else duckRampRef.current = null
    }
    setTimeout(tick, 25)
  }, [])

  return {
    isReady, isPaused, currentTrack, position, duration, error,
    volume, setVolume,
    playTrack, fadeAndPause, seek,
    duck, unduck,
  }
}
