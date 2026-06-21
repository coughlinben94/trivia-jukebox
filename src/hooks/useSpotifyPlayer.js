import { useState, useEffect, useRef, useCallback } from 'react'
import { getToken } from '../lib/spotify'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const FADE_STEPS = 24
const FADE_MS = 2000

export function useSpotifyPlayer({ onAdvance } = {}) {
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

  useEffect(() => { onAdvanceRef.current = onAdvance }, [onAdvance])

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
        setIsPaused(state.paused)
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
    const steps = FADE_STEPS
    const stepMs = FADE_MS / steps
    for (let i = 0; i <= steps; i++) {
      if (genRef.current !== gen) return
      const v = from + (to - from) * (i / steps)
      player.setVolume(Math.max(0, Math.min(1, v)))
      await sleep(stepMs)
    }
  }

  // ─── Position monitor ────────────────────────────────────────────
  const startMonitor = useCallback((stopMs, gen) => {
    clearInterval(monitorRef.current)
    monitorRef.current = setInterval(async () => {
      if (genRef.current !== gen) { clearInterval(monitorRef.current); return }
      const state = await playerRef.current?.getCurrentState()
      if (!state || state.paused) return
      if (seekingRef.current) return
      const pos = state.position
      setPosition(pos)

      const maxVol = maxVolumeRef.current
      if (stopMs > 0 && pos >= stopMs - FADE_MS) {
        clearInterval(monitorRef.current)
        await fadeVolume(maxVol, 0, gen)
        if (genRef.current !== gen) return
        await playerRef.current?.pause()
        playerRef.current?.setVolume(0)
        onAdvanceRef.current?.()
      }
    }, 300)
  }, [])

  // ─── Play a track with custom start/stop ─────────────────────────
  const playTrack = useCallback(async (uri, startMs = 0, stopMs = 0) => {
    const player = playerRef.current
    const deviceId = deviceIdRef.current
    if (!player || !deviceId) return

    genRef.current += 1
    const gen = genRef.current
    clearInterval(monitorRef.current)

    player.setVolume(0)
    setIsPaused(false)

    const token = await getToken()
    await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris: [uri] }),
      }
    )

    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 4000)
      const check = (state) => {
        if (state?.track_window?.current_track?.uri === uri) {
          clearTimeout(timeout)
          player.removeListener('player_state_changed', check)
          resolve()
        }
      }
      player.addListener('player_state_changed', check)
    })

    if (genRef.current !== gen) return

    if (startMs > 0) {
      await player.seek(startMs)
      await sleep(300)
    }

    if (genRef.current !== gen) return

    const maxVol = maxVolumeRef.current
    await fadeVolume(0, maxVol, gen)

    if (genRef.current !== gen) return

    startMonitor(stopMs > startMs ? stopMs : 0, gen)
  }, [startMonitor])

  // ─── Fade out and pause ──────────────────────────────────────────
  const fadeAndPause = useCallback(async () => {
    genRef.current += 1
    const gen = genRef.current
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
    // Only set directly if currently playing (not mid-fade)
    playerRef.current?.setVolume(v)
  }, [])

  return {
    isReady, isPaused, currentTrack, position, duration, error,
    volume, setVolume,
    playTrack, fadeAndPause, seek,
  }
}
