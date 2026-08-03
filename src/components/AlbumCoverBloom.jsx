import { useEffect, useRef, useMemo, useState } from 'react'
import { blendDurationMs } from '../lib/gradientTuning.js'

// AlbumCoverBloom — third gradient engine, opt-in via ?gradient=bloom or
// localStorage.trivia_gradient_engine='bloom' (same mechanism LiveScreen
// already uses for mesh/circles — see getGradientEngine below). Mesh stays
// the DEFAULT; this is a new option sitting alongside it, not a
// replacement — nothing about the existing mesh/circles path changes.
//
// Origin (2026-08-04): three "blob" attempts (circles, mesh, mesh
// variants) all eventually hit the owner's "i hate the blob concept" wall.
// This engine uses the actual album cover art as the visual source instead
// of abstract shapes: the real cover, heavily blurred and slowly panned
// (Ken Burns), IS the background. A second, blended-on-top canvas layer
// gives the color field its own independent life (owner: "the actual
// background colors need to move" — a panned photo alone reads as static
// once the pan settles into a rhythm). Song-to-song changes are a
// SHARED-DIRECTION slide: the outgoing layer keeps moving the direction it
// was already headed while fading, and the incoming layer enters from the
// opposite edge moving the SAME direction — a conveyor, not a crossfade-in-
// place (owner: "not just instant flash... same direction the other is
// leaving"). Direction is picked deterministically per shuffleKey (same
// seeded-per-index convention as AlbumGradient/AlbumGradientMesh's blob
// rng) so a replayed session always slides the same way, but different
// sessions vary.
//
// Prototyped first as a fable-built mock (mock-A3-cover-bloom-silky.html)
// per the owner's explicit ask to "invoke a fable agent and build it" —
// this file ports that prototype's three techniques (live per-pixel wash
// motion, shared-direction slide, custom cubic-bezier easing) into the
// real prop contract this app's other two engines already share.

export const DIRECTIONS = ['left', 'right', 'up', 'down']

// Deterministic per key — NOT the fixed rotating list the fable mock used
// (that repeats the same first direction every fresh page load). A cheap
// seeded hash instead, same shape as makeBlobParams' rng in
// AlbumGradientMesh.jsx, so a given shuffleKey always resolves to the same
// direction (reproducible for QA / a specific reported session) while
// different keys spread across all four directions.
export function directionForKey(key) {
  const x = Math.sin((key + 1) * 12.9898) * 43758.5453
  const frac = x - Math.floor(x)
  return DIRECTIONS[Math.floor(frac * DIRECTIONS.length) % DIRECTIONS.length]
}

// Strong custom easing (emil-design-eng: default CSS ease/linear read as
// mechanical) — motion uses a snappy ease-out; opacity uses a slower,
// symmetric curve so the fade settles AFTER the slide has visually
// connected, not simultaneously with it (fable's mock: "opacity fades on a
// slower curve so the fade lands at the tail, after the motion has
// connected").
const EASE_MOTION  = 'cubic-bezier(0.23, 1, 0.32, 1)'
const EASE_OPACITY = 'cubic-bezier(0.55, 0, 0.45, 1)'

const OFFSET = { left: { x: -100, y: 0 }, right: { x: 100, y: 0 }, up: { x: 0, y: -100 }, down: { x: 0, y: 100 } }

// Fan up to 2 real palette colors into a handful of wash sources with
// slight hue/lightness variance, so the live-motion layer has some visual
// depth even from a 1-2 color palette. Plain HSL string manipulation, not
// OKLab vector math — this layer is a decorative overlay blended via CSS
// mix-blend-mode, not the primary hue signal, so there's no hue-
// cancellation risk to design around here (unlike the mesh engine).
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0
  const l = (max + min) / 2
  const d = max - min
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break
      case g: h = (b - r) / d + 2; break
      default: h = (r - g) / d + 4
    }
    h *= 60
  }
  return [h, s * 100, l * 100]
}

function makeWashSources(colors) {
  const base = colors.length ? colors : ['#3a3a3a']
  const sources = []
  const count = 4
  for (let i = 0; i < count; i++) {
    const [h, s, l] = hexToHsl(base[i % base.length])
    sources.push({
      hueBase: h, sat: Math.min(85, s + 10), lightBase: Math.min(70, Math.max(30, l)),
      seed: i * 17.3 + 4.1,
    })
  }
  return sources
}

function drawWash(ctx, w, h, t, sources) {
  ctx.clearRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'lighter'
  for (const src of sources) {
    const cx = (0.5 + 0.4 * Math.sin(t * 0.05 + src.seed)) * w
    const cy = (0.5 + 0.4 * Math.sin(t * 0.037 + src.seed * 1.3)) * h
    const hue = src.hueBase + Math.sin(t * 0.03 + src.seed) * 14
    const light = src.lightBase + Math.sin(t * 0.021 + src.seed * 0.7) * 8
    const r = Math.max(w, h) * 0.75
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
    grad.addColorStop(0, `hsla(${hue},${src.sat}%,${light}%,0.55)`)
    grad.addColorStop(1, `hsla(${hue},${src.sat}%,${light}%,0)`)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
  }
  ctx.globalCompositeOperation = 'source-over'
}

function Layer({ artUrl, colors, active, direction, phase, bornAt }) {
  const canvasRef = useRef(null)
  const rafRef = useRef(null)
  const sources = useMemo(() => makeWashSources(colors), [colors])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const W = 120, H = 68
    canvas.width = W; canvas.height = H
    let mounted = true
    function tick(ts) {
      if (!mounted) return
      drawWash(ctx, W, H, ts / 1000, sources)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { mounted = false; cancelAnimationFrame(rafRef.current) }
  }, [sources])

  // phase: 'enter' | 'steady' | 'exit' | 'idle'
  const off = OFFSET[direction] || OFFSET.left
  let transform = 'translate(0%, 0%) scale(1.18)'
  let opacity = 1
  if (phase === 'enter') { transform = `translate(${-off.x}%, ${-off.y}%) scale(1.18)`; opacity = 0 }
  if (phase === 'exit')  { transform = `translate(${off.x}%, ${off.y}%) scale(1.22)`; opacity = 0 }
  if (phase === 'idle')  { opacity = 0 }

  return (
    <div
      style={{
        position: 'absolute', inset: 0, overflow: 'hidden',
        opacity,
        transition: `opacity ${blendDurationMs()}ms ${EASE_OPACITY}, transform ${blendDurationMs()}ms ${EASE_MOTION}`,
      }}
    >
      <div
        style={{
          position: 'absolute', top: '-25%', left: '-25%', width: '150%', height: '150%',
          transform,
          transition: `transform ${blendDurationMs()}ms ${EASE_MOTION}`,
          animation: phase === 'steady' || phase === 'exit' ? 'coverBloomDrift 46s ease-in-out infinite alternate' : 'none',
        }}
      >
        {artUrl && (
          <img
            src={artUrl}
            alt=""
            decoding="async"
            style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              objectFit: 'cover', filter: 'blur(60px) saturate(1.25)',
            }}
          />
        )}
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            filter: 'blur(28px)', mixBlendMode: 'overlay', opacity: 0.85,
          }}
        />
      </div>
    </div>
  )
}

export default function AlbumCoverBloom({
  colors = [], nextColors = [], artUrl, nextArtUrl,
  active = true, shuffleKey = 0, entranceActive = false,
}) {
  const isFirst = useRef(true)
  const layers = useRef([
    { id: 0, artUrl, colors, phase: 'steady' },
    { id: 1, artUrl: nextArtUrl, colors: nextColors, phase: 'idle' },
  ])
  const activeIdxRef = useRef(0)
  const directionRef = useRef(directionForKey(shuffleKey))
  // Animation state (layers.current) lives in a ref so Layer identity and
  // canvas RAF state survive across a slide without remounting — this
  // counter just forces a re-render when that ref's contents change; no
  // derived state to compute.
  const [, bump] = useState(0)
  const setTick = () => bump(n => n + 1)

  useEffect(() => {
    // Prefetch the next image so it's already decoded before the slide
    // starts — avoids a decode-stall stutter mid-transition.
    if (nextArtUrl) { const img = new Image(); img.src = nextArtUrl }
  }, [nextArtUrl])

  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; return }
    directionRef.current = directionForKey(shuffleKey)
    const outIdx = activeIdxRef.current
    const inIdx = 1 - outIdx
    layers.current[inIdx] = { id: layers.current[inIdx].id + 2, artUrl, colors, phase: 'enter' }
    layers.current[outIdx] = { ...layers.current[outIdx], phase: 'exit' }
    setTick()
    // Next frame: flip incoming to steady so its transition kicks in from
    // the 'enter' starting transform/opacity to the resting state.
    requestAnimationFrame(() => {
      layers.current[inIdx] = { ...layers.current[inIdx], phase: 'steady' }
      activeIdxRef.current = inIdx
      setTick()
      setTimeout(() => {
        layers.current[outIdx] = { ...layers.current[outIdx], phase: 'idle' }
        setTick()
      }, blendDurationMs())
    })
  }, [colors, artUrl])

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 0, overflow: 'hidden', background: '#080808' }}>
      {layers.current.map((l, i) => (
        <Layer key={l.id} artUrl={l.artUrl} colors={l.colors} active={active} direction={directionRef.current} phase={l.phase} />
      ))}
      <style>{`
        @keyframes coverBloomDrift {
          0%   { transform: scale(1.18) translate(0%, 0%); }
          50%  { transform: scale(1.3) translate(-3%, 2%); }
          100% { transform: scale(1.22) translate(2%, -2%); }
        }
      `}</style>
    </div>
  )
}

