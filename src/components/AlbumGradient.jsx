import { useState, useEffect, useRef, useCallback } from 'react'

const ANGLES     = [0, 45, 90, 135, 180, 225, 270, 315]
const DRIFTS     = ['gradientDriftH', 'gradientDriftV', 'gradientDriftD1', 'gradientDriftD2']
const DIRECTIONS = ['translateX(100%)', 'translateX(-100%)', 'translateY(100%)', 'translateY(-100%)']

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

function randomParams() {
  return {
    angle:    pick(ANGLES),
    drift:    pick(DRIFTS),
    duration: (25 + Math.random() * 10).toFixed(1), // 25–35 s
  }
}

function makeGradient(colors, angle) {
  const stops = colors.length >= 2 ? colors.join(', ') : '#1a1a2e, #16213e, #0a0a0a'
  return `linear-gradient(${angle}deg, ${stops})`
}

export default function AlbumGradient({ colors = [], active = true }) {
  const [bottom,  setBottom]  = useState(() => ({ colors, params: randomParams() }))
  const [top,     setTop]     = useState(null)
  const [sliding, setSliding] = useState(false)

  const isFirst    = useRef(true)
  const pendingRef = useRef(null)
  // Ref mirror of top so transitionEnd handler always reads the live value
  const topRef = useRef(null)
  useEffect(() => { topRef.current = top }, [top])

  // Mount the incoming layer off-screen, then start sliding it in after two
  // animation frames so the browser has painted the initial off-screen position
  const startSlide = useCallback((newColors) => {
    setTop({ colors: newColors, params: randomParams(), direction: pick(DIRECTIONS) })
    setSliding(false)
  }, [])

  useEffect(() => {
    if (!top) return
    let raf2
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setSliding(true))
    })
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2) }
  }, [top])

  // React to incoming color changes from usePalette
  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; return }
    if (!colors.length) return
    if (topRef.current === null) {
      startSlide(colors)
    } else {
      pendingRef.current = colors  // queue; drain after current slide finishes
    }
  }, [colors, startSlide])

  // After slide completes: promote top → bottom, drain any queued change
  const handleTransitionEnd = useCallback((e) => {
    if (e.propertyName !== 'transform') return
    const settled = topRef.current
    if (!settled) return
    setBottom({ colors: settled.colors, params: settled.params })
    setTop(null)
    setSliding(false)
    if (pendingRef.current) {
      const next = pendingRef.current
      pendingRef.current = null
      // rAF so top state clears before the next slide mounts
      requestAnimationFrame(() => startSlide(next))
    }
  }, [startSlide])

  const driftAnim = (p) =>
    `${p.drift} ${p.duration}s ease-in-out infinite alternate`

  const base = { position: 'absolute', inset: 0, backgroundSize: '400% 400%' }

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 0, overflow: 'hidden' }}>

      {/* Bottom layer — current song, always drifting */}
      <div style={{
        ...base,
        background:          makeGradient(bottom.colors, bottom.params.angle),
        animation:           driftAnim(bottom.params),
        animationPlayState:  active ? 'running' : 'paused',
      }} />

      {/* Top layer — incoming song, sweeps in from a random edge */}
      {top && (
        <div
          style={{
            ...base,
            background:         makeGradient(top.colors, top.params.angle),
            animation:          driftAnim(top.params),
            animationPlayState: active ? 'running' : 'paused',
            transform:          sliding ? 'translate(0, 0)' : top.direction,
            transition:         'transform 4s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
          onTransitionEnd={handleTransitionEnd}
        />
      )}
    </div>
  )
}
