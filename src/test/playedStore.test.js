import { describe, it, expect, beforeEach, vi } from 'vitest'
import { loadPlayed, savePlayed } from '../lib/playedStore'

beforeEach(() => {
  localStorage.clear()
})

describe('playedStore', () => {
  it('returns an empty set for a set that has not played tonight', () => {
    expect(loadPlayed('main').size).toBe(0)
  })

  it('round-trips ids saved for a set', () => {
    savePlayed('main', new Set(['a', 'b', 'c']))
    const loaded = loadPlayed('main')
    expect([...loaded].sort()).toEqual(['a', 'b', 'c'])
  })

  it('keeps different sets independent — exhausting one does not touch another', () => {
    savePlayed('80s', new Set(['x', 'y']))
    savePlayed('main', new Set(['a']))
    expect([...loadPlayed('80s')].sort()).toEqual(['x', 'y'])
    expect([...loadPlayed('main')]).toEqual(['a'])
  })

  it('starts fresh on a new night', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-29T22:00:00Z'))
    savePlayed('main', new Set(['a', 'b']))
    expect(loadPlayed('main').size).toBe(2)

    // Next calendar day, well past the 6-hour late-night offset.
    vi.setSystemTime(new Date('2026-07-30T20:00:00Z'))
    expect(loadPlayed('main').size).toBe(0)
    vi.useRealTimers()
  })

  it('treats a show running past midnight as still "tonight"', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-29T23:30:00Z'))
    savePlayed('main', new Set(['a']))

    // 1:15am the next calendar day, but only ~1h45m later — same night.
    vi.setSystemTime(new Date('2026-07-30T01:15:00Z'))
    expect(loadPlayed('main').size).toBe(1)
    vi.useRealTimers()
  })

  it('never throws if localStorage access fails', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new Error('storage disabled') },
    })
    expect(() => loadPlayed('main')).not.toThrow()
    expect(() => savePlayed('main', new Set(['a']))).not.toThrow()
    Object.defineProperty(window, 'localStorage', original)
  })
})
