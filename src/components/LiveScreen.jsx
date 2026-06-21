import { useState, useEffect, useCallback } from 'react'

export default function LiveScreen({ currentTrack, isPaused, onClose }) {
  const [shown, setShown] = useState(currentTrack)
  const [prev, setPrev] = useState(null)

  useEffect(() => {
    if (!currentTrack || currentTrack.uri === shown?.uri) return
    setPrev(shown)
    setShown(currentTrack)
  }, [currentTrack?.uri])

  useEffect(() => {
    if (!prev) return
    const t = setTimeout(() => setPrev(null), 1400)
    return () => clearTimeout(t)
  }, [prev?.uri])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const bgUrl = shown?.album?.images?.[0]?.url
  const prevBgUrl = prev?.album?.images?.[0]?.url
  const artUrl = shown?.album?.images?.[0]?.url
  const prevArtUrl = prev?.album?.images?.[0]?.url

  return (
    <div className="fixed inset-0 bg-black z-50 overflow-hidden flex flex-col items-center justify-center">

      {/* Blurred background — prev fading out */}
      {prevBgUrl && (
        <div
          key={prev.uri + '-bg'}
          className="absolute inset-0 bg-center bg-cover live-fade-out"
          style={{
            backgroundImage: `url(${prevBgUrl})`,
            filter: 'blur(72px) brightness(0.25) saturate(1.8)',
            transform: 'scale(1.25)',
          }}
        />
      )}

      {/* Blurred background — current fading in */}
      {bgUrl && (
        <div
          key={(shown?.uri ?? 'empty') + '-bg'}
          className="absolute inset-0 bg-center bg-cover live-fade-in"
          style={{
            backgroundImage: `url(${bgUrl})`,
            filter: 'blur(72px) brightness(0.25) saturate(1.8)',
            transform: 'scale(1.25)',
          }}
        />
      )}

      {/* Dark vignette overlay */}
      <div className="absolute inset-0 bg-black/30" />

      {/* Content */}
      <div className="relative z-10 flex flex-col items-center gap-8 px-10 text-center max-w-lg w-full">
        {shown ? (
          <>
            {/* Album art — overflow-hidden clips the slide so art stays inside the frame */}
            <div className="relative w-72 h-72 sm:w-80 sm:h-80 rounded-2xl overflow-hidden"
                 style={{ boxShadow: '0 32px 80px rgba(0,0,0,0.7)' }}>
              {/* Prev art sliding out to left */}
              {prev && prevArtUrl && (
                <img
                  key={prev.uri + '-art'}
                  src={prevArtUrl}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover live-art-out"
                />
              )}
              {/* Current art sliding in from right, pulses while playing */}
              <img
                key={shown.uri + '-art'}
                src={artUrl}
                alt=""
                className={`absolute inset-0 w-full h-full object-cover live-art-in ${!isPaused ? 'live-playing' : ''}`}
              />
            </div>

            {/* Track info */}
            <div key={shown.uri + '-text'} className="live-text-in">
              <h1 className="text-3xl sm:text-4xl font-bold text-white tracking-tight leading-tight mb-2">
                {shown.name}
              </h1>
              <p className="text-lg text-white font-medium">
                {shown.artists?.map(a => a.name).join(', ')}
              </p>
            </div>
          </>
        ) : (
          <p className="text-white text-base">Waiting for music…</p>
        )}
      </div>

      {/* Paused pill */}
      {isPaused && shown && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 text-xs text-white tracking-widest uppercase">
          Paused
        </div>
      )}

      {/* Exit */}
      <button
        onClick={onClose}
        className="absolute top-6 right-6 text-white hover:text-white transition-colors duration-150 cursor-pointer text-lg leading-none"
        aria-label="Close live screen"
      >
        ✕
      </button>
    </div>
  )
}
