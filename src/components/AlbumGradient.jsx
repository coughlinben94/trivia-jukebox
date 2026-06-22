import { useState, useEffect, useRef } from 'react'

const ANGLES = [0, 45, 90, 135, 180, 225, 270, 315]
const DRIFTS  = ['gradientDriftH', 'gradientDriftV', 'gradientDriftD1', 'gradientDriftD2']

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

function randomParams() {
  return {
    angle:    pick(ANGLES),
    drift:    pick(DRIFTS),
    duration: (25 + Math.random() * 10).toFixed(1), // 25–35 s
  }
}

export default function AlbumGradient({ colors = [], active = true }) {
  const [params, setParams] = useState(randomParams)
  const isFirst = useRef(true)

  useEffect(() => {
    // Skip the initial mount fire — first params are already set
    if (isFirst.current) { isFirst.current = false; return }
    if (colors.length === 0) return
    setParams(randomParams())
  }, [colors])

  const stops    = colors.length >= 2 ? colors.join(', ') : '#1a1a2e, #16213e, #0a0a0a'
  const gradient = `linear-gradient(${params.angle}deg, ${stops})`

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        background: gradient,
        backgroundSize: '400% 400%',
        animation: `${params.drift} ${params.duration}s ease-in-out infinite alternate`,
        animationPlayState: active ? 'running' : 'paused',
        transition: 'background 3s ease',
      }}
    />
  )
}
