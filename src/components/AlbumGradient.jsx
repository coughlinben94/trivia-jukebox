import { useEffect, useRef, useMemo } from 'react'

const BLEND_DURATION_MS = 7500
const NUM_CIRCLES  = 6
const DIRECTIONS   = ['left', 'right', 'up', 'down']

// ── Helpers ────────────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  if (!hex || hex.length < 7) return [8, 8, 8]
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ]
}

function parseColors(hexArr, n) {
  const src = hexArr.length ? hexArr : ['#080808']
  return Array.from({ length: n }, (_, i) => [...hexToRgb(src[i % src.length])])
}

function easeInOut(t) {
  t = Math.max(0, Math.min(1, t))
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}

function lerp(a, b, t) { return a + (b - a) * t }

// ── Circle layout — seeded per-index so positions are always deterministic ─────

function makeCircleParams() {
  function rng(i, slot) {
    const x = Math.sin((i * 7 + slot) * 9301 + 49297) * 233280
    return x - Math.floor(x)
  }
  return Array.from({ length: NUM_CIRCLES }, (_, i) => ({
    baseX:  0.10 + rng(i, 0) * 0.80,
    baseY:  0.10 + rng(i, 1) * 0.80,
    xAmp:   0.30,
    yAmp:   0.30,
    xFreq:  1 / (12 + rng(i, 2) * 8),
    yFreq:  1 / (12 + rng(i, 3) * 8),
    xPhase: rng(i, 4) * Math.PI * 2,
    yPhase: rng(i, 5) * Math.PI * 2,
    radius: 0.55 + rng(i, 6) * 0.15,
  }))
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function AlbumGradient({ colors = [], nextColors = [], active = true, shuffleKey = 0, entranceActive = false }) {
  const canvasRef          = useRef(null)
  const activeRef          = useRef(active)
  const mountedRef         = useRef(true)
  const rafRef             = useRef(null)
  const tickRef            = useRef(null)
  const isFirst            = useRef(true)
  const isFirstNext        = useRef(true)
  const isFirstKey         = useRef(true)
  const pendingFromNextRef  = useRef(false)
  const circleParams       = useMemo(makeCircleParams, [])
  // Cached CanvasGradient objects for the steady-state draw path.
  // Gradients are created at origin (0,0); ctx.setTransform repositions them each frame.
  // { maxDim: number, entries: Array<{ grad: CanvasGradient, r: number }> } | null
  const gradCacheRef       = useRef(null)
  const blendCacheRef      = useRef(null)
  const entranceActiveRef  = useRef(entranceActive)
  const pendingBlendRef    = useRef(null)

  // All mutable animation state in one ref
  const st = useRef(null)
  if (!st.current) {
    const initial = parseColors(colors, NUM_CIRCLES)
    st.current = {
      steadyRgb:  initial.map(c => [...c]),   // live colors in steady state
      outRgb:     initial.map(c => [...c]),   // Layer A — outgoing
      inRgb:      initial.map(c => [...c]),   // Layer B — incoming
      blendStart: -1,                          // -1 = steady state (no transition in progress)
      inOffsetX:  0,
      inOffsetY:  0,
    }
  }

  // Helper — snapshot current visual blend state as Layer A, start sweep toward newHex
  function startBlendTo(newHex) {
    const s   = st.current
    const now = performance.now()
    if (s.blendStart >= 0 && (now - s.blendStart) < BLEND_DURATION_MS) {
      const t = easeInOut(Math.min((now - s.blendStart) / BLEND_DURATION_MS, 1))
      s.outRgb = s.outRgb.map((c, i) => [
        lerp(c[0], s.inRgb[i][0], t),
        lerp(c[1], s.inRgb[i][1], t),
        lerp(c[2], s.inRgb[i][2], t),
      ])
    } else {
      s.outRgb = s.steadyRgb.map(c => [...c])
    }
    s.inRgb      = parseColors(newHex, NUM_CIRCLES)
    s.blendStart = performance.now()
    blendCacheRef.current = null
    const dir   = DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)]
    s.inOffsetX = dir === 'left' ? -1.2 : dir === 'right' ?  1.2 : 0
    s.inOffsetY = dir === 'up'   ? -1.2 : dir === 'down'  ?  1.2 : 0
    // Restart RAF if it was stopped (active=false) so the blend always runs to completion
    if (!rafRef.current && mountedRef.current) {
      tickRef.current?.()
    }
  }

  // shuffleKey: new session starts — snap everything to black so palette bleeds in fresh
  useEffect(() => {
    if (isFirstKey.current) { isFirstKey.current = false; return }
    const s     = st.current
    const black = Array.from({ length: NUM_CIRCLES }, () => [8, 8, 8])
    s.outRgb    = black.map(c => [...c])
    s.inRgb     = black.map(c => [...c])
    s.steadyRgb = black.map(c => [...c])
    s.blendStart = -1
    pendingFromNextRef.current = false
    gradCacheRef.current  = null
    blendCacheRef.current = null
  }, [shuffleKey])

  // nextColors: pre-transition 1 second before the song officially switches
  useEffect(() => {
    if (isFirstNext.current) { isFirstNext.current = false; return }
    if (!nextColors.length) return
    if (entranceActiveRef.current) { pendingBlendRef.current = nextColors; return }
    startBlendTo(nextColors)
    pendingFromNextRef.current = true
  }, [nextColors])

  // colors: official song change — snap the target to match (blend already running)
  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; return }
    if (pendingFromNextRef.current) {
      // nextColors blend in progress — just realign targets to official colors, keep blending
      pendingFromNextRef.current = false
      const s = st.current
      s.inRgb     = parseColors(colors, NUM_CIRCLES)
      s.steadyRgb = parseColors(colors, NUM_CIRCLES)
      gradCacheRef.current  = null
      blendCacheRef.current = null
    } else {
      if (entranceActiveRef.current) { pendingBlendRef.current = colors; return }
      startBlendTo(colors)
    }
  }, [colors])

  // entranceActive: keep ref current; fire any queued blend once entrance ends
  useEffect(() => {
    entranceActiveRef.current = entranceActive
    if (!entranceActive && pendingBlendRef.current) {
      const pending = pendingBlendRef.current
      pendingBlendRef.current = null
      startBlendTo(pending)
    }
  }, [entranceActive])

  // Keep active ref in sync; restart loop if it was paused
  useEffect(() => {
    activeRef.current = active
    if (active && !rafRef.current && mountedRef.current) {
      tickRef.current?.()
    }
  }, [active])

  // Canvas + RAF — runs once on mount
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')

    function resize() {
      const p     = canvas.parentElement
      // Half-res backing store, CSS-stretched to full size. The blobs are soft
      // radial gradients — invisible at 0.5 — and full-screen 'screen'-blend
      // fills are pure fill-rate cost, so this quarters per-frame raster work.
      // Matters on the Air driving the bar TV, where the GPU throttles on battery.
      const SCALE = 0.5
      canvas.width  = Math.round(((p ? p.clientWidth  : 0) || window.innerWidth)  * SCALE)
      canvas.height = Math.round(((p ? p.clientHeight : 0) || window.innerHeight) * SCALE)
    }
    resize()
    window.addEventListener('resize', resize)

    function draw(ts) {
      const W = canvas.width
      const H = canvas.height
      if (!W || !H) return

      const maxDim = Math.max(W, H)
      const tSec   = ts / 1000
      const s      = st.current

      // Near-black base
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = '#080808'
      ctx.fillRect(0, 0, W, H)

      ctx.globalCompositeOperation = 'screen'

      if (s.blendStart >= 0 && (ts - s.blendStart) < BLEND_DURATION_MS) {
        // ── Transition: two layers crossfade while Layer B sweeps in ─────────
        // Gradients cached at origin; ctx.setTransform positions them per-frame.
        // Per-layer alpha (0.9*(1-t) and 0.9*t) applied via globalAlpha — NOT baked
        // into the cache — so the crossfade curve stays fully per-frame.
        const t          = easeInOut(Math.min((ts - s.blendStart) / BLEND_DURATION_MS, 1))
        const offsetFrac = 1 - t
        const ox         = s.inOffsetX * offsetFrac * W
        const oy         = s.inOffsetY * offsetFrac * H

        if (!blendCacheRef.current || blendCacheRef.current.maxDim !== maxDim) {
          const buildLayer = (rgbArr) => rgbArr.map(([R, G, B], i) => {
            const r = circleParams[i].radius * maxDim
            const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
            g.addColorStop(0, `rgba(${R},${G},${B},0.9)`)
            g.addColorStop(1, `rgba(${R},${G},${B},0)`)
            return { grad: g, r }
          })
          blendCacheRef.current = { maxDim, out: buildLayer(s.outRgb), in: buildLayer(s.inRgb) }
        }
        const { out: outE, in: inE } = blendCacheRef.current

        // Layer A — outgoing, natural positions
        if (t < 1) {
          ctx.globalAlpha = 1 - t
          for (let i = 0; i < NUM_CIRCLES; i++) {
            const p  = circleParams[i]
            const cx = (p.baseX + p.xAmp * Math.sin(tSec * p.xFreq * Math.PI * 2 + p.xPhase)) * W
            const cy = (p.baseY + p.yAmp * Math.sin(tSec * p.yFreq * Math.PI * 2 + p.yPhase)) * H
            ctx.setTransform(1, 0, 0, 1, cx, cy)
            ctx.fillStyle = outE[i].grad
            ctx.beginPath(); ctx.arc(0, 0, outE[i].r, 0, Math.PI * 2); ctx.fill()
          }
        }

        // Layer B — incoming, sweeps in from edge
        if (t > 0) {
          ctx.globalAlpha = t
          for (let i = 0; i < NUM_CIRCLES; i++) {
            const p  = circleParams[i]
            const cx = (p.baseX + p.xAmp * Math.sin(tSec * p.xFreq * Math.PI * 2 + p.xPhase)) * W + ox
            const cy = (p.baseY + p.yAmp * Math.sin(tSec * p.yFreq * Math.PI * 2 + p.yPhase)) * H + oy
            ctx.setTransform(1, 0, 0, 1, cx, cy)
            ctx.fillStyle = inE[i].grad
            ctx.beginPath(); ctx.arc(0, 0, inE[i].r, 0, Math.PI * 2); ctx.fill()
          }
        }

        ctx.globalAlpha = 1
        ctx.setTransform(1, 0, 0, 1, 0, 0)
      } else {
        // ── Steady state or blend just completed ─────────────────────────────
        if (s.blendStart >= 0) {
          // First frame after blend ends: promote B to steady and clear the timer
          s.steadyRgb = s.inRgb.map(c => [...c])
          s.blendStart = -1
          gradCacheRef.current = null
        }
        // Build (or rebuild on resize) gradient cache. Each gradient is created at origin
        // (0,0) with the circle's fixed radius. Per-frame we translate the canvas context to
        // (cx, cy) instead of baking position into the gradient — this lets us reuse the same
        // CanvasGradient objects across every frame until colors or canvas size change.
        if (!gradCacheRef.current || gradCacheRef.current.maxDim !== maxDim) {
          gradCacheRef.current = {
            maxDim,
            entries: s.steadyRgb.map(([R, G, B], i) => {
              const r    = circleParams[i].radius * maxDim
              const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r)
              grad.addColorStop(0, `rgba(${R},${G},${B},0.9)`)
              grad.addColorStop(1, `rgba(${R},${G},${B},0)`)
              return { grad, r }
            }),
          }
        }
        const { entries } = gradCacheRef.current
        for (let i = 0; i < NUM_CIRCLES; i++) {
          const p            = circleParams[i]
          const { grad, r }  = entries[i]
          const cx = (p.baseX + p.xAmp * Math.sin(tSec * p.xFreq * Math.PI * 2 + p.xPhase)) * W
          const cy = (p.baseY + p.yAmp * Math.sin(tSec * p.yFreq * Math.PI * 2 + p.yPhase)) * H
          ctx.setTransform(1, 0, 0, 1, cx, cy)
          ctx.fillStyle = grad
          ctx.beginPath()
          ctx.arc(0, 0, r, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0)
      }
    }

    function tick(ts) {
      draw(ts)
      // Keep looping if active OR if a blend is still running (draw() resets blendStart to -1 when done)
      if (mountedRef.current && (activeRef.current || st.current.blendStart >= 0)) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
      }
    }

    tickRef.current = () => { rafRef.current = requestAnimationFrame(tick) }

    if (activeRef.current) {
      rafRef.current = requestAnimationFrame(tick)
    }

    return () => {
      mountedRef.current = false
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      window.removeEventListener('resize', resize)
    }
  }, [circleParams])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        display: 'block',
        willChange: 'transform',
        transform: 'translateZ(0)',
      }}
    />
  )
}
