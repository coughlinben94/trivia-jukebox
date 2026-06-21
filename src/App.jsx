import { useEffect, useState } from 'react'
import { login, handleCallback, logout, getToken } from './lib/spotify'
import Jukebox from './components/Jukebox'

export default function App() {
  const [token, setToken] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')

    if (code) {
      window.history.replaceState({}, '', '/')
      handleCallback(code)
        .then(() => getToken().then(setToken))
        .finally(() => setLoading(false))
    } else {
      getToken().then(setToken).finally(() => setLoading(false))
    }
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="w-5 h-5 border-[1.5px] border-white/10 border-t-[#1DB954] rounded-full animate-spin" />
      </div>
    )
  }

  if (!token) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center gap-8">
        <div className="text-center space-y-2">
          <div className="text-5xl mb-4">🎵</div>
          <h1 className="text-2xl font-semibold tracking-tight">Trivia Jukebox</h1>
          <p className="text-sm text-white/35">Your personal music trivia queue</p>
        </div>
        <button
          onClick={login}
          className="bg-[#1DB954] hover:bg-[#1ed760] text-black text-sm font-semibold px-7 py-3 rounded-full transition-all duration-150 active:scale-[0.97]"
        >
          Connect Spotify
        </button>
      </div>
    )
  }

  return <Jukebox onLogout={() => setToken(null)} />
}
