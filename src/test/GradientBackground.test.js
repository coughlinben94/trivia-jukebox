import { describe, expect, it } from 'vitest'
import {
  createTransitionState,
  makeLightParams,
  normalizeScene,
  resizeCanvasesPreservingSnapshot,
  updateTransitionState,
} from '../components/GradientBackground.jsx'

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
