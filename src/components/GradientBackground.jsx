/* eslint-disable react-refresh/only-export-components -- pure renderer helpers are exported for focused state/math tests */
import { useEffect, useRef } from 'react'
import {
  blendDurationMs, brightnessAdjustment, motionSpeed,
  lightRadius, seamBlend, haloDepth,
} from '../lib/gradientTuning.js'
import { prepareTwoLightField } from '../lib/twoLightBlend.js'

const TINY_SIZE = 48
const SENTINEL = '#080808'
const FALLBACK = ['#702070', '#d83a88']
const VALID_HEX = /^#[0-9a-f]{6}$/i

function hashString(value) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function makeLightParams({ shuffleKey = 0, artUrl = '', colors = [] }) {
  let seed = hashString(`${shuffleKey}|${artUrl}|${colors.join('|')}`)
  const rng = () => {
    seed += 0x6d2b79f5
    let value = seed
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
  return [0, 1].map(() => ({
    baseX: 0.25 + rng() * 0.5,
    baseY: 0.25 + rng() * 0.5,
    ampX: 0.2 + rng() * 0.12,
    ampY: 0.2 + rng() * 0.12,
    freqX: (0.35 + rng() * 0.2) * motionSpeed(),
    freqY: (0.3 + rng() * 0.2) * motionSpeed(),
    phaseX: rng() * Math.PI * 2,
    phaseY: rng() * Math.PI * 2,
    radius: lightRadius() + (rng() - 0.5) * 0.1,
  }))
}

function isNearBlack(hex) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 0.299 * r + 0.587 * g + 0.114 * b < 32
}

export function normalizeScene({ colors = [], weights = [], artUrl = '', shuffleKey = 0 } = {}) {
  const valid = colors.map((color, index) => ({ color, weight: weights[index] }))
    .filter(({ color }) => typeof color === 'string' && VALID_HEX.test(color))
  const allSentinel = valid.length > 0 && valid.length === colors.length &&
    valid.every(({ color }) => color.toLowerCase() === SENTINEL)
  const usable = valid.map(({ color, weight }) => ({ color: color.toLowerCase(), weight }))
    .filter(({ color }) => color !== SENTINEL && !isNearBlack(color))
  const selected = usable.length >= 2 ? usable.slice(0, 2)
    : usable.length === 1 ? [usable[0], usable[0]]
      : FALLBACK.map(color => ({ color, weight: undefined }))
  const normalized = selected.map(({ color }) => color)
  const rawWeights = selected.map(({ weight }) => weight)
  const validWeights = rawWeights.every(weight => Number.isFinite(weight) && weight >= 0)
  const totalWeight = validWeights ? rawWeights[0] + rawWeights[1] : 0
  const normalizedWeights = totalWeight > 0
    ? rawWeights.map(weight => weight / totalWeight)
    : [0.5, 0.5]
  const identity = `${shuffleKey}|${artUrl}|${normalized.join('|')}|${normalizedWeights.join('|')}`
  return {
    artUrl,
    colors: normalized,
    weights: normalizedWeights,
    identity,
    ready: usable.length > 0 && !allSentinel,
    shuffleKey,
    lights: makeLightParams({ shuffleKey, artUrl, colors: normalized }),
  }
}

export function createTransitionState(currentInput) {
  return {
    current: normalizeScene(currentInput),
    outgoing: null,
    incoming: null,
    pending: null,
    blendStart: null,
    snapshotRequest: null,
  }
}

function startTransition(state, scene, now) {
  const visible = state.incoming || state.current
  if (visible.identity === scene.identity) return state
  const interrupted = state.blendStart !== null && state.outgoing && state.incoming
  const snapshotRequest = interrupted ? {
    outgoing: state.outgoing,
    incoming: state.incoming,
    progress: Math.max(0, Math.min(1, (now - state.blendStart) / blendDurationMs())),
  } : null
  return {
    current: state.current,
    outgoing: interrupted ? { snapshot: true } : visible,
    incoming: scene,
    pending: null,
    blendStart: now,
    snapshotRequest,
  }
}

export function updateTransitionState(state, { current, next, entranceActive, now }) {
  const currentScene = normalizeScene(current)
  const nextScene = normalizeScene(next)

  // Promotion of an already-preloaded scene updates metadata only; fade clock
  // and seeded incoming motion remain untouched.
  if (state.incoming?.identity === currentScene.identity) {
    state = { ...state, current: state.incoming }
  } else if (state.current.identity !== currentScene.identity) {
    if (entranceActive && !state.current.ready) {
      state = { ...state, current: currentScene }
    } else {
      state = startTransition(state, currentScene, now)
    }
  }

  if (entranceActive) {
    return nextScene.ready ? { ...state, pending: nextScene } : state
  }
  // Flush a previously-ready pending scene before considering a now-empty
  // next palette; entrance release must not lose the last useful preload.
  if (state.pending) return startTransition({ ...state, pending: null }, state.pending, now)
  if (!nextScene.ready) return state
  return startTransition(state, nextScene, now)
}

function drawScene(ctx, smallCtx, scene, timestamp, width, height) {
  const t = timestamp / 1000
  const [a, b] = scene.lights
  const ax = a.baseX + Math.sin(t * a.freqX + a.phaseX) * a.ampX
  const ay = a.baseY + Math.sin(t * a.freqY + a.phaseY) * a.ampY
  const bx = b.baseX + Math.sin(t * b.freqX + b.phaseX) * b.ampX
  const by = b.baseY + Math.sin(t * b.freqY + b.phaseY) * b.ampY
  const field = scene.field || (scene.field = prepareTwoLightField(...scene.colors, {
    brightnessAdjustment: brightnessAdjustment(),
    haloDepth: haloDepth(),
    seamBlend: seamBlend(),
    weightA: scene.weights[0],
    weightB: scene.weights[1],
  }))
  const image = scene.imageData || (scene.imageData = smallCtx.createImageData(TINY_SIZE, TINY_SIZE))

  for (let y = 0; y < TINY_SIZE; y += 1) {
    for (let x = 0; x < TINY_SIZE; x += 1) {
      const nx = x / (TINY_SIZE - 1)
      const ny = y / (TINY_SIZE - 1)
      const index = (y * TINY_SIZE + x) * 4
      field.sampleInto(
        Math.hypot(nx - ax, ny - ay) / a.radius,
        Math.hypot(nx - bx, ny - by) / b.radius,
        image.data,
        index,
      )
    }
  }
  smallCtx.putImageData(image, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.imageSmoothingEnabled = true
  ctx.filter = `blur(${Math.max(12, width / 70)}px)`
  ctx.drawImage(smallCtx.canvas, -width * 0.03, -height * 0.03, width * 1.06, height * 1.06)
  ctx.filter = 'none'
}

export function crossfadeOpacities(progress) {
  const clamped = Math.max(0, Math.min(1, progress))
  return { outgoing: 1, incoming: clamped }
}

export function compositeSnapshot(context, outgoing, incoming, progress, width, height) {
  const { outgoing: outgoingAlpha, incoming: incomingAlpha } = crossfadeOpacities(progress)
  context.clearRect(0, 0, width, height)
  context.globalAlpha = outgoingAlpha
  context.drawImage(outgoing, 0, 0)
  context.globalAlpha = incomingAlpha
  context.drawImage(incoming, 0, 0)
  context.globalAlpha = 1
}

export function resizeCanvasesPreservingSnapshot(
  canvases,
  snapshotCanvas,
  snapshotContext,
  dpr,
  makeCanvas = () => document.createElement('canvas'),
) {
  const saved = makeCanvas()
  saved.width = Math.max(1, snapshotCanvas.width)
  saved.height = Math.max(1, snapshotCanvas.height)
  const savedContext = saved.getContext('2d')
  if (savedContext) savedContext.drawImage(snapshotCanvas, 0, 0)

  canvases.forEach(canvas => {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr))
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr))
  })
  snapshotCanvas.width = canvases[0].width
  snapshotCanvas.height = canvases[0].height
  if (savedContext) {
    snapshotContext.drawImage(saved, 0, 0, snapshotCanvas.width, snapshotCanvas.height)
  }
}

export default function GradientBackground({
  colors = [], nextColors = [], active = true, shuffleKey = 0,
  entranceActive = false, artUrl = '', nextArtUrl = '',
  weights = [], nextWeights = [],
}) {
  const canvasesRef = useRef([])
  const transitionRef = useRef(createTransitionState({ colors, weights, artUrl, shuffleKey }))
  const rafRef = useRef(null)

  useEffect(() => {
    transitionRef.current = updateTransitionState(transitionRef.current, {
      current: { colors, weights, artUrl, shuffleKey },
      next: { colors: nextColors, weights: nextWeights, artUrl: nextArtUrl, shuffleKey },
      entranceActive,
      now: performance.now(),
    })
  }, [artUrl, colors, entranceActive, nextArtUrl, nextColors, nextWeights, shuffleKey, weights])

  useEffect(() => {
    if (!active) return undefined
    const canvases = canvasesRef.current
    if (canvases.length !== 2 || canvases.some(canvas => !canvas)) return undefined
    const contexts = canvases.map(canvas => canvas.getContext('2d'))
    if (contexts.some(context => !context)) return undefined
    const small = contexts.map(() => {
      const canvas = document.createElement('canvas')
      canvas.width = TINY_SIZE
      canvas.height = TINY_SIZE
      return canvas.getContext('2d')
    })
    const snapshotCanvas = document.createElement('canvas')
    const snapshotContext = snapshotCanvas.getContext('2d')
    if (!snapshotContext) return undefined

    const resize = () => {
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
      resizeCanvasesPreservingSnapshot(canvases, snapshotCanvas, snapshotContext, dpr)
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = timestamp => {
      let state = transitionRef.current
      if (state.snapshotRequest) {
        const request = state.snapshotRequest
        // Visible canvases still contain the last displayed A/B frame. Merge
        // those exact pixels (rather than re-rendering either scene) so an
        // interruption starts from what the audience actually saw. This also
        // supports repeated interruptions when canvas 0 already holds an
        // earlier snapshot.
        compositeSnapshot(
          snapshotContext,
          canvases[0],
          canvases[1],
          request.progress,
          snapshotCanvas.width,
          snapshotCanvas.height,
        )
        state = { ...state, snapshotRequest: null }
        transitionRef.current = state
      }
      if (state.blendStart !== null && timestamp - state.blendStart >= blendDurationMs()) {
        state = {
          current: state.incoming,
          outgoing: null,
          incoming: null,
          pending: state.pending,
          blendStart: null,
          snapshotRequest: null,
        }
        transitionRef.current = state
      }
      const progress = state.blendStart === null ? 1 : Math.min(1, (timestamp - state.blendStart) / blendDurationMs())
      const front = state.incoming || state.current
      const back = state.outgoing
      if (back?.snapshot) {
        contexts[0].clearRect(0, 0, canvases[0].width, canvases[0].height)
        contexts[0].drawImage(snapshotCanvas, 0, 0, canvases[0].width, canvases[0].height)
      } else if (back) {
        drawScene(contexts[0], small[0], back, timestamp, canvases[0].width, canvases[0].height)
      }
      drawScene(contexts[1], small[1], front, timestamp, canvases[1].width, canvases[1].height)
      const opacity = crossfadeOpacities(progress)
      canvases[0].style.opacity = back ? String(opacity.outgoing) : '0'
      canvases[1].style.opacity = back ? String(opacity.incoming) : '1'
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)

    return () => {
      window.removeEventListener('resize', resize)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [active])

  const canvasStyle = { position: 'absolute', inset: 0, width: '100%', height: '100%' }
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 0, overflow: 'hidden', background: FALLBACK[0] }}>
      <canvas ref={node => { canvasesRef.current[0] = node }} style={canvasStyle} />
      <canvas ref={node => { canvasesRef.current[1] = node }} style={canvasStyle} />
    </div>
  )
}
