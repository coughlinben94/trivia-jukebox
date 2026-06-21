const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID
const REDIRECT_URI = import.meta.env.DEV
  ? 'http://127.0.0.1:5173'
  : 'https://trivia-jukebox.vercel.app'
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
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
  sessionStorage.setItem('pkce_verifier', verifier)

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
  const verifier = sessionStorage.getItem('pkce_verifier')
  sessionStorage.removeItem('pkce_verifier')

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
  if (data.access_token) {
    localStorage.setItem('spotify_token', data.access_token)
    localStorage.setItem('spotify_refresh_token', data.refresh_token)
    localStorage.setItem('spotify_token_expiry', Date.now() + data.expires_in * 1000)
  }
  return data
}

export async function refreshToken() {
  const token = localStorage.getItem('spotify_refresh_token')
  if (!token) return null

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token,
      client_id: CLIENT_ID,
    }),
  })

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
  const data = await res.json()
  return data.tracks?.items ?? []
}
