import { describe, expect, it } from 'vitest'
import {
  createTransitionState,
  makeLightParams,
  normalizeScene,
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

  it('normalizes malformed and near-black colors without rendering black', () => {
    const scene = normalizeScene({ colors: ['bad', '#010203'], shuffleKey: 1 })

    expect(scene.colors).toEqual(['#702070', '#d83a88'])
    expect(scene.ready).toBe(true)
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

  it('defers a ready upcoming scene during entrance and flushes it on release', () => {
    let state = createTransitionState(current)
    state = updateTransitionState(state, { current, next, entranceActive: true, now: 100 })
    expect(state.blendStart).toBeNull()
    expect(state.pending.artUrl).toBe('two.jpg')

    state = updateTransitionState(state, { current, next, entranceActive: false, now: 200 })
    expect(state.blendStart).toBe(200)
    expect(state.pending).toBeNull()
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
})
