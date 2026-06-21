import { useState, useEffect, useRef, useCallback } from 'react'
import { getToken } from '../lib/spotify'

export function useSpotifyPlayer() {
  const [isReady, setIsReady] = useState(false)
  const [isPaused, setIsPaused] = useState(true)
  const [currentTrack, setCurrentTrack] = useState(null)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState(null)
  const playerRef = useRef(null)
  const deviceIdRef = useRef(null)
  const intervalRef = useRef(null)

  useEffect(() => {
    let player

    const init = async () => {
      const token = await getToken()
      if (!token) return

      player = new window.Spotify.Player({
        name: 'Trivia Jukebox',
        getOAuthToken: cb => getToken().then(cb),
        volume: 0.8,
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
        setPosition(state.position)
        setDuration(state.duration)
      })

      player.addListener('account_error', () =>
        setError('Spotify Premium required for in-browser playback.')
      )
      player.addListener('authentication_error', () =>
        setError('Spotify authentication failed. Try reconnecting.')
      )
      player.addListener('initialization_error', ({ message }) =>
        setError(`Player failed to initialize: ${message}`)
      )

      await player.connect()
      playerRef.current = player
    }

    if (window.Spotify) {
      init()
    } else {
      window.onSpotifyWebPlaybackSDKReady = init
    }

    return () => {
      clearInterval(intervalRef.current)
      playerRef.current?.disconnect()
    }
  }, [])

  // Poll position while playing
  useEffect(() => {
    clearInterval(intervalRef.current)
    if (!isPaused) {
      intervalRef.current = setInterval(() => {
        playerRef.current?.getCurrentState().then(state => {
          if (state) setPosition(state.position)
        })
      }, 500)
    }
    return () => clearInterval(intervalRef.current)
  }, [isPaused])

  const play = useCallback(async (uris) => {
    if (!deviceIdRef.current) return
    const token = await getToken()
    await fetch(
      `https://api.spotify.com/v1/me/player/play?device_id=${deviceIdRef.current}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ uris }),
      }
    )
  }, [])

  const togglePlay = useCallback(() => playerRef.current?.togglePlay(), [])

  const seek = useCallback((ms) => {
    setPosition(ms)
    playerRef.current?.seek(ms)
  }, [])

  const skipNext = useCallback(() => playerRef.current?.nextTrack(), [])
  const skipPrev = useCallback(() => playerRef.current?.previousTrack(), [])

  return { isReady, isPaused, currentTrack, position, duration, error, play, togglePlay, seek, skipNext, skipPrev }
}
