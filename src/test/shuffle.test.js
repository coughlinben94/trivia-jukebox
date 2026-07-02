import { describe, it, expect, vi, afterEach } from 'vitest'
import { shuffleArray, resolveNext, resolveUpcoming } from '../lib/shuffle'

function song(id) { return { id, name: id } }

afterEach(() => vi.restoreAllMocks())

describe('resolveNext', () => {
  it('advances to the next id in the order', () => {
    const lib = [song('a'), song('b'), song('c')]
    const order = ['a', 'b', 'c']
    const { idx, song: next } = resolveNext(order, 0, lib)
    expect(idx).toBe(1)
    expect(next.id).toBe('b')
  })

  it('skips a removed upcoming song and plays the next surviving one', () => {
    // Order was built as a, b, c. 'b' (the upcoming song) gets removed from
    // the library before advance is called.
    const lib = [song('a'), song('c')]
    const order = ['a', 'b', 'c']
    const { idx, song: next } = resolveNext(order, 0, lib)
    expect(next.id).toBe('c')
    expect(order[idx]).toBe('c')
  })

  it('is unaffected by mid-order reordering of the library array', () => {
    // Reordering the library (drag-reorder) changes array position but not
    // membership — resolveNext looks up by id, not index, so the sequence
    // defined by `order` holds regardless of library array order.
    const order = ['a', 'b', 'c']
    const libOriginal = [song('a'), song('b'), song('c')]
    const libReordered = [song('c'), song('a'), song('b')]

    const r1 = resolveNext(order, 0, libOriginal)
    const r2 = resolveNext(order, 0, libReordered)
    expect(r1.song.id).toBe('b')
    expect(r2.song.id).toBe('b')
  })

  it('reshuffles from the live library when the order is exhausted', () => {
    const lib = [song('a'), song('b'), song('c')]
    const order = ['a', 'b', 'c']
    const { order: newOrder, idx, song: next } = resolveNext(order, 2, lib)
    expect(idx).toBe(0)
    expect(newOrder).toHaveLength(3)
    expect(new Set(newOrder)).toEqual(new Set(['a', 'b', 'c']))
    expect(next.id).toBe(newOrder[0])
  })

  it('does not immediately repeat the last-played id after reshuffling', () => {
    // Force the internal Fisher-Yates shuffle to land 'c' (the last-played
    // id) first: rand=0 at i=2 swaps index2<->0 ('a','b','c' -> 'c','b','a'),
    // rand=0.5 at i=1 is a no-op (j=1), leaving 'c' at index 0. Any later
    // Math.random() calls (the anti-repeat swap) use the real generator.
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.5)
    const lib = [song('a'), song('b'), song('c')]
    const order = ['x', 'y', 'c'] // last played id is 'c'
    const { order: newOrder } = resolveNext(order, 2, lib)
    expect(newOrder[0]).not.toBe('c')
    expect(new Set(newOrder)).toEqual(new Set(['a', 'b', 'c']))
  })

  it('returns null song when the library is empty', () => {
    const { song: next } = resolveNext(['a'], 0, [])
    expect(next).toBeNull()
  })
})

describe('resolveUpcoming', () => {
  it('returns the next track in the order', () => {
    const lib = [song('a'), song('b')]
    expect(resolveUpcoming(['a', 'b'], 0, lib)?.id).toBe('b')
  })

  it('skips a removed track and returns the next surviving one', () => {
    const lib = [song('a'), song('c')]
    expect(resolveUpcoming(['a', 'b', 'c'], 0, lib)?.id).toBe('c')
  })

  it('returns null at the end of the order without reshuffling', () => {
    const lib = [song('a'), song('b')]
    expect(resolveUpcoming(['a', 'b'], 1, lib)).toBeNull()
  })
})

describe('shuffleArray', () => {
  it('does not mutate the input array', () => {
    const input = [1, 2, 3, 4, 5]
    const copy = [...input]
    shuffleArray(input)
    expect(input).toEqual(copy)
  })

  it('preserves all elements', () => {
    const input = ['a', 'b', 'c', 'd']
    expect(new Set(shuffleArray(input))).toEqual(new Set(input))
  })
})
