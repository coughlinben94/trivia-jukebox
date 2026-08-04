import { describe, expect, it } from 'vitest'
import * as gradientBackground from '../components/GradientBackground.jsx'
import {
  computeAnchorPositions,
  createTransitionState,
  makeLightParams,
  normalizeScene,
  resizeCanvasesPreservingSnapshot,
  updateTransitionState,
} from '../components/GradientBackground.jsx'
import { makeFlowNoise2D } from '../lib/flowNoise.js'

describe('GradientBackground scene preparation', () => {
  it('uses safe fallback colors while treating an all-sentinel palette as not ready', () => {
    const scene = normalizeScene({
      colors: ['#080808', '#080808'],
      artUrl: 'cover.jpg',
      shuffleKey: 4,
    })

    expect(scene.colors).toEqual(['#702070', '#d83a88'])
    expect(scene.ready).toBe(false)
  })

  it('draws fallback but marks malformed and near-black-only palettes not ready', () => {
    const scene = normalizeScene({ colors: ['bad', '#010203'], shuffleKey: 1 })

    expect(scene.colors).toEqual(['#702070', '#d83a88'])
    expect(scene.ready).toBe(false)
  })

  it('normalizes valid population weights and falls back to equal weights', () => {
    expect(normalizeScene({
      colors: ['#ff0000', '#0088ff'], weights: [8, 2],
    }).weights).toEqual([0.8, 0.2])
    expect(normalizeScene({
      colors: ['#ff0000', '#0088ff'], weights: [Infinity, -1],
    }).weights).toEqual([0.5, 0.5])
  })
})

describe('makeLightParams', () => {
  it('is deterministic for the same song identity', () => {
    const input = { shuffleKey: 9, artUrl: 'a.jpg', colors: ['#ff0000', '#00ff00'] }
    expect(makeLightParams(input)).toEqual(makeLightParams(input))
  })

  it('changes motion when art or colors change under the same shuffle key', () => {
    const base = { shuffleKey: 9, artUrl: 'a.jpg', colors: ['#ff0000', '#00ff00'] }
    expect(makeLightParams({ ...base, artUrl: 'b.jpg' })).not.toEqual(makeLightParams(base))
    expect(makeLightParams({ ...base, colors: ['#0000ff', '#00ff00'] })).not.toEqual(makeLightParams(base))
  })

  it('creates two independent light paths', () => {
    const [a, b] = makeLightParams({ shuffleKey: 3, artUrl: 'a.jpg', colors: ['#123456', '#abcdef'] })
    expect(a).not.toEqual(b)
  })
})

describe('whole-frame transition state', () => {
  const current = { colors: ['#ff0000', '#00ff00'], artUrl: 'one.jpg', shuffleKey: 2 }
  const next = { colors: ['#0000ff', '#ff00ff'], artUrl: 'two.jpg', shuffleKey: 2 }

  it('starts early for ready next colors and does not restart when current promotes', () => {
    let state = createTransitionState(current)
    state = updateTransitionState(state, { current, next, entranceActive: false, now: 100 })
    expect(state.blendStart).toBe(100)
    expect(state.incoming.artUrl).toBe('two.jpg')

    state = updateTransitionState(state, {
      current: next,
      next: { colors: ['#080808', '#080808'], artUrl: '', shuffleKey: 2 },
      entranceActive: false,
      now: 250,
    })
    expect(state.blendStart).toBe(100)
    expect(state.incoming.artUrl).toBe('two.jpg')
  })

  it('includes weights in scene identity so weighted promotion does not restart', () => {
    const weightedNext = { ...next, colors: ['#0088ff', '#ff00ff'], weights: [0.8, 0.2] }
    let state = createTransitionState({ ...current, weights: [0.5, 0.5] })
    state = updateTransitionState(state, {
      current: { ...current, weights: [0.5, 0.5] }, next: weightedNext,
      entranceActive: false, now: 100,
    })
    const identity = state.incoming.identity
    state = updateTransitionState(state, {
      current: weightedNext, next: { colors: ['#080808'] },
      entranceActive: false, now: 250,
    })
    expect(state.current.identity).toBe(identity)
    expect(state.current.weights).toEqual([0.8, 0.2])
    expect(state.blendStart).toBe(100)
  })

  it('defers a ready upcoming scene during entrance and flushes it on release', () => {
    let state = createTransitionState(current)
    state = updateTransitionState(state, { current, next, entranceActive: true, now: 100 })
    expect(state.blendStart).toBeNull()
    expect(state.pending.artUrl).toBe('two.jpg')

    state = updateTransitionState(state, { current, next, entranceActive: false, now: 200 })
    expect(state.blendStart).toBe(200)
    expect(state.pending).toBeNull()
  })

  it('keeps the latest ready pending scene and flushes it even if next becomes sentinel', () => {
    const later = { colors: ['#ffaa00', '#00aaff'], artUrl: 'three.jpg', shuffleKey: 2 }
    let state = createTransitionState(current)
    state = updateTransitionState(state, { current, next, entranceActive: true, now: 100 })
    state = updateTransitionState(state, { current, next: later, entranceActive: true, now: 150 })
    expect(state.pending.artUrl).toBe('three.jpg')

    state = updateTransitionState(state, {
      current,
      next: { colors: ['#080808'], shuffleKey: 2 },
      entranceActive: false,
      now: 200,
    })
    expect(state.incoming.artUrl).toBe('three.jpg')
    expect(state.pending).toBeNull()
    expect(state.blendStart).toBe(200)
  })

  it('requests a snapshot carrying current alpha when an in-flight blend is interrupted', () => {
    const later = { colors: ['#ffaa00', '#00aaff'], artUrl: 'three.jpg', shuffleKey: 2 }
    let state = createTransitionState(current)
    state = updateTransitionState(state, { current, next, entranceActive: false, now: 100 })
    state = updateTransitionState(state, { current, next: later, entranceActive: false, now: 3850 })

    expect(state.snapshotRequest.outgoing.artUrl).toBe('one.jpg')
    expect(state.snapshotRequest.incoming.artUrl).toBe('two.jpg')
    expect(state.snapshotRequest.progress).toBeCloseTo(0.5)
    expect(state.outgoing.snapshot).toBe(true)
    expect(state.incoming.artUrl).toBe('three.jpg')
    expect(state.blendStart).toBe(3850)
  })

  it('starts a transition for a direct current change without preloading', () => {
    let state = createTransitionState(current)
    state = updateTransitionState(state, {
      current: next,
      next: { colors: ['#080808'], shuffleKey: 2 },
      entranceActive: false,
      now: 300,
    })
    expect(state.outgoing.artUrl).toBe('one.jpg')
    expect(state.incoming.artUrl).toBe('two.jpg')
    expect(state.blendStart).toBe(300)
  })

  it('starts a new scene when only shuffle key changes', () => {
    let state = createTransitionState(current)
    state = updateTransitionState(state, {
      current: { ...current, shuffleKey: 3 },
      next: { colors: ['#080808'], shuffleKey: 3 },
      entranceActive: false,
      now: 400,
    })
    expect(state.outgoing.shuffleKey).toBe(2)
    expect(state.incoming.shuffleKey).toBe(3)
    expect(state.blendStart).toBe(400)
  })
})

describe('whole-frame transition compositing', () => {
  it.each([0, 0.5, 1])('keeps opaque frame coverage throughout a dissolve at progress %s', progress => {
    expect(gradientBackground.crossfadeOpacities).toBeTypeOf('function')

    const { outgoing, incoming } = gradientBackground.crossfadeOpacities(progress)
    const sourceOverCoverage = incoming + outgoing * (1 - incoming)

    expect({ outgoing, incoming }).toEqual({ outgoing: 1, incoming: progress })
    expect(sourceOverCoverage).toBe(1)
  })

  it('composites an interrupted snapshot exactly like the last displayed stack', () => {
    expect(gradientBackground.compositeSnapshot).toBeTypeOf('function')
    const alphaCalls = []
    const drawCalls = []
    const context = {
      clearRect: () => {},
      drawImage: image => drawCalls.push(image),
      set globalAlpha(value) { alphaCalls.push(value) },
    }
    const outgoing = { id: 'outgoing' }
    const incoming = { id: 'incoming' }

    gradientBackground.compositeSnapshot(context, outgoing, incoming, 0.5, 100, 50)

    expect(drawCalls).toEqual([outgoing, incoming])
    expect(alphaCalls).toEqual([1, 0.5, 1])
  })
})

describe('resizeCanvasesPreservingSnapshot', () => {
  it('copies and redraws the outgoing snapshot around destructive canvas resize', () => {
    const drawCalls = []
    const snapshotContext = { drawImage: (...args) => drawCalls.push(args) }
    const snapshot = { width: 120, height: 60, getContext: () => snapshotContext }
    const visible = [{ clientWidth: 200, clientHeight: 100, width: 120, height: 60 }]
    const tempContext = { drawImage: (...args) => drawCalls.push(args) }
    const makeCanvas = () => ({ width: 0, height: 0, getContext: () => tempContext })

    resizeCanvasesPreservingSnapshot(visible, snapshot, snapshotContext, 2, makeCanvas)

    expect(visible[0]).toMatchObject({ width: 400, height: 200 })
    expect(snapshot).toMatchObject({ width: 400, height: 200 })
    expect(drawCalls[0][0]).toBe(snapshot)
    expect(drawCalls.at(-1)[0]).not.toBe(snapshot)
    expect(drawCalls.at(-1).slice(1)).toEqual([0, 0, 400, 200])
  })
})

describe('computeAnchorPositions', () => {
  it('never lets the two anchors get closer than MIN_ANCHOR_SEPARATION (0.35), across many songs and times', () => {
    // Mirrors the independent audit that found the original bug: real
    // makeLightParams seeding across many songs, sampled across a whole
    // song's worth of timestamps, checking the actual invariant the clamp
    // is supposed to guarantee -- not just a couple of hand-picked t values.
    let minSepSeen = Infinity
    for (let song = 0; song < 300; song++) {
      const lights = makeLightParams({
        shuffleKey: song, artUrl: `song-${song}.jpg`, colors: ['#aa3366', '#3366aa'],
      })
      const wobble = makeFlowNoise2D(song * 7919 + 13)
      for (let tSec = 0; tSec <= 200; tSec += 0.5) {
        const { ax, ay, bx, by } = computeAnchorPositions(lights, tSec, wobble)
        const sep = Math.hypot(bx - ax, by - ay)
        if (sep < minSepSeen) minSepSeen = sep
      }
    }
    // Small float tolerance around the 0.35 floor itself.
    expect(minSepSeen).toBeGreaterThanOrEqual(0.35 - 1e-9)
  })

  it('never lets the push-axis direction flip more than 90 degrees frame-to-frame when prevDirection is threaded through (the flash/whip fix)', () => {
    // Two independent adversarial reviews caught the same follow-on bug in
    // the first version of this clamp: rescaling DISTANCE while inheriting
    // the raw, unstable DIRECTION unchanged meant a true anchor-crossing
    // event rendered as an instant ~180 degree reversal at full contrast --
    // up to ~92% of the frame flipping pool membership in a single 60fps
    // frame, in ~1/3 of simulated songs. The dot-product hysteresis check
    // guarantees the chosen direction is always within 90 degrees of the
    // previous frame's by construction; this test proves that guarantee
    // actually holds when prevDirection is threaded frame-to-frame the way
    // drawScene does it (scene.prevAnchorDir), not just that the formula
    // looks right on paper.
    const angleBetween = (u1, v1, u2, v2) => {
      const dot = Math.max(-1, Math.min(1, u1 * u2 + v1 * v2))
      return Math.acos(dot) * (180 / Math.PI)
    }
    let maxJump = 0
    const jumps = []
    for (let song = 0; song < 40; song++) {
      const lights = makeLightParams({
        shuffleKey: song, artUrl: `whip-${song}.jpg`, colors: ['#ff2222', '#2222ff'],
      })
      const wobble = makeFlowNoise2D(song * 4111 + 71)
      let prevDirection = null
      let prev = null
      // 60fps over 30s -- fine enough to catch the exact frame-to-frame
      // spikes the original audits measured.
      for (let frame = 0; frame <= 1800; frame++) {
        const tSec = frame / 60
        const result = computeAnchorPositions(lights, tSec, wobble, {
          prevDirection, wobbleAmt: 0.106,
        })
        prevDirection = result.direction
        if (prev) {
          const jump = angleBetween(prev.ux, prev.uy, result.direction.ux, result.direction.uy)
          if (jump > maxJump) maxJump = jump
          jumps.push(jump)
        }
        prev = result.direction
      }
    }
    // Hard guarantee from the hysteresis construction itself.
    expect(maxJump).toBeLessThanOrEqual(90 + 1e-6)
    // And empirically it's not just bounded, it's actually smooth in the
    // typical case -- median frame-to-frame push-axis change stays small,
    // proving this reads as organic motion rather than "never quite 180
    // but still visibly snapping."
    const sorted = [...jumps].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    expect(median).toBeLessThan(5)
  })

  it('keeps speedMod reaching a materially wider range than the pre-fix ~0.964-1.025 (a real ~3x improvement, not a per-song guarantee)', () => {
    // +-0.15 is a designed CEILING, not a schedule -- this is organic noise,
    // and the owner separately asked for motion to feel "more random"
    // rather than perfectly periodic, so any single song's realized range
    // is seed-dependent. The honest, statistically sound check is the
    // GLOBAL range across many simulated songs (real makeLightParams
    // seeding), not one fixed seed/window expected to hit extremes on
    // schedule -- see computeAnchorPositions' speedMod comment for the
    // measured ~+-8-10% typical/occasionally-further reality.
    let globalMin = Infinity, globalMax = -Infinity
    for (let song = 0; song < 20; song++) {
      const lights = makeLightParams({ shuffleKey: song, artUrl: `s${song}.jpg`, colors: ['#ff0000', '#0000ff'] })
      const wobble = makeFlowNoise2D(song * 6151 + 3)
      for (let tSec = 0; tSec <= 240; tSec += 0.5) {
        const { speedMod } = computeAnchorPositions(lights, tSec, wobble)
        if (speedMod < globalMin) globalMin = speedMod
        if (speedMod > globalMax) globalMax = speedMod
      }
    }
    // Pre-fix ceiling was ~0.964/1.025 (~+-3%) for EVERY seed -- clearing
    // 0.93/1.07 (~+-7%) across a 20-song population proves the fix reaches
    // meaningfully further, without asserting a specific song hits +-15%.
    expect(globalMin).toBeLessThan(0.93)
    expect(globalMax).toBeGreaterThan(1.07)
    // Sanity bound: normalization shouldn't wildly overshoot the intended
    // envelope either (FBM_PEAK has only small headroom by construction).
    expect(globalMin).toBeGreaterThan(0.75)
    expect(globalMax).toBeLessThan(1.25)
  })

  it('still varies anchor position frame to frame (the clamp does not freeze motion)', () => {
    const lights = makeLightParams({ shuffleKey: 2, artUrl: 'b.jpg', colors: ['#ff0000', '#0000ff'] })
    const wobble = makeFlowNoise2D(99)
    const p1 = computeAnchorPositions(lights, 10, wobble)
    const p2 = computeAnchorPositions(lights, 11, wobble)
    expect(p1).not.toEqual(p2)
  })

  it('pushes coincident anchors apart along a well-defined fallback axis instead of producing NaN/undefined', () => {
    const coincident = [
      { baseX: 0.5, baseY: 0.5, ampX: 0, ampY: 0, freqX: 0, freqY: 0, phaseX: 0, phaseY: 0, driftPhaseX: 0, driftPhaseY: 0 },
      { baseX: 0.5, baseY: 0.5, ampX: 0, ampY: 0, freqX: 0, freqY: 0, phaseX: 0, phaseY: 0, driftPhaseX: 500, driftPhaseY: 500 },
    ]
    const wobble = makeFlowNoise2D(1)
    const { ax, ay, bx, by } = computeAnchorPositions(coincident, 0, wobble)
    expect([ax, ay, bx, by].every(Number.isFinite)).toBe(true)
    expect(Math.hypot(bx - ax, by - ay)).toBeGreaterThanOrEqual(0.35 - 1e-9)
  })
})
