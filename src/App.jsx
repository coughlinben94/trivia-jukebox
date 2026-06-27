import { useEffect, useState } from 'react'
import { login, handleCallback, getToken } from './lib/spotify'
import Jukebox from './components/Jukebox'
import QuickAdd from './components/QuickAdd'

export default function App() {
  const [token, setToken] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')

    if (code) {
      // Remove ?code= from the URL first so a refresh doesn't re-attempt the exchange
      window.history.replaceState({}, '', '/')
      handleCallback(code)
        .then(() => getToken())
        .then(tok => {
          // Token is stored in localStorage by handleCallback before this runs.
          // Set React state, then — if the user initiated auth from /add — restore that route.
          // Both happen before React re-renders, so QuickAdd always mounts with a valid token.
          setToken(tok)
          const returnTo = sessionStorage.getItem('oauth_return')
          if (returnTo) {
            sessionStorage.removeItem('oauth_return')
            window.history.replaceState({}, '', returnTo)
          }
        })
        .catch(err => { console.error('OAuth error:', err); setError('Login failed — please try again.') })
        .finally(() => setLoading(false))
    } else {
      getToken().then(setToken).finally(() => setLoading(false))
    }
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-base flex items-center justify-center">
        <div className="w-5 h-5 border-[1.5px] border-white/10 border-t-accent rounded-full animate-spin" />
      </div>
    )
  }

  const isAddRoute = window.location.pathname === '/add'

  // Save the intended route before OAuth so we can restore it after the redirect lands on /
  const handleLogin = () => {
    if (isAddRoute) sessionStorage.setItem('oauth_return', '/add')
    login()
  }

  if (!token) {
    return (
      <div className="min-h-screen bg-base text-white flex flex-col items-center justify-center gap-8">
        <div className="text-center space-y-2">
          <div className="text-5xl mb-4">🎵</div>
          <h1 className="text-2xl font-semibold tracking-tight">Trivia Jukebox</h1>
          <p className="text-sm text-white">Your personal music trivia queue</p>
        </div>
        <button
          onClick={handleLogin}
          className="bg-accent hover:bg-accent-hover text-black text-sm font-semibold px-7 py-3 rounded-full transition-all duration-150 active:scale-[0.97]"
        >
          Connect Spotify
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    )
  }

  return isAddRoute ? <QuickAdd /> : <Jukebox onLogout={() => setToken(null)} />
}
