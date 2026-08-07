const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID
const REDIRECT_URI = import.meta.env.DEV
  ? 'http://127.0.0.1:5173'
  : 'https://trivia-jukebox.vercel.app/'
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ')

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length))
}

function base64url(buffer) {
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

async function generateChallenge(verifier) {
  const encoded = new TextEncoder().encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', encoded)
  return base64url(new Uint8Array(hash))
}

export async function login() {
  const verifier = base64url(randomBytes(32))
  const challenge = await generateChallenge(verifier)
  // localStorage survives cross-tab redirects; sessionStorage is wiped when iOS
  // opens the Spotify native app and redirects back in a new Safari tab.
  localStorage.setItem('pkce_verifier', verifier)

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  })

  window.location.href = `https://accounts.spotify.com/authorize?${params}`
}

export async function handleCallback(code) {
  const verifier = localStorage.getItem('pkce_verifier')
  localStorage.removeItem('pkce_verifier')

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  })

  const data = await res.json()
  // res.ok check (2026-08-07, Opus review) — a failed exchange (expired
  // code, PKCE mismatch) returned Spotify's error JSON without throwing, so
  // App.jsx's .catch never fired and the user silently bounced back to the
  // "Connect Spotify" screen with no error message shown — indistinguishable
  // from never having clicked the button.
  if (!res.ok) throw new Error(data.error_description || data.error || 'Spotify token exchange failed')
  if (data.access_token) {
    localStorage.setItem('spotify_token', data.access_token)
    if (data.refresh_token) localStorage.setItem('spotify_refresh_token', data.refresh_token)
    localStorage.setItem('spotify_token_expiry', Date.now() + data.expires_in * 1000)
  }
  return data
}

// A bare `await fetch(...)` here (no timeout) was the same root cause as the
// 2026-07-28 "shuffle plays nothing, forever" bug in useSpotifyPlayer.js's
// doSeek/doPlay — this call sits underneath both of those (getToken() calls
// this whenever the cached token is stale), so a stalled response here hangs
// the whole playback pipeline just as badly, with no error and no recovery.
export async function refreshToken() {
  const token = localStorage.getItem('spotify_refresh_token')
  if (!token) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  let res
  try {
    res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token,
        client_id: CLIENT_ID,
      }),
      signal: controller.signal,
    })
  } catch (err) {
    console.error('[refreshToken] request timed out or failed', err)
    return null
  } finally {
    clearTimeout(timer)
  }

  const data = await res.json()
  if (data.access_token) {
    localStorage.setItem('spotify_token', data.access_token)
    localStorage.setItem('spotify_token_expiry', Date.now() + data.expires_in * 1000)
    if (data.refresh_token) localStorage.setItem('spotify_refresh_token', data.refresh_token)
  }
  return data.access_token ?? null
}

export async function getToken() {
  const expiry = Number(localStorage.getItem('spotify_token_expiry') ?? 0)
  if (Date.now() > expiry - 60_000) return refreshToken()
  return localStorage.getItem('spotify_token')
}

export function logout() {
  localStorage.removeItem('spotify_token')
  localStorage.removeItem('spotify_refresh_token')
  localStorage.removeItem('spotify_token_expiry')
}

export async function searchTracks(query) {
  const token = await getToken()
  if (!token) return []
  const res = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=8`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  // A 401/expired-token response still returns JSON, so without this a
  // failed search silently rendered as "No results found" — diagnosable now
  // via the console at least (2026-08-07, Opus review).
  if (!res.ok) { console.error('[searchTracks] request failed', res.status); return [] }
  const data = await res.json()
  return data.tracks?.items ?? []
}
