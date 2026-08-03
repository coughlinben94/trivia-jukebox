import { describe, it, expect } from 'vitest'
import { directionForKey, DIRECTIONS } from '../components/AlbumCoverBloom.jsx'

// Same seeded-per-index pattern as makeBlobParams/makeCircleParams' rng —
// deterministic per shuffleKey so a replayed session always picks the same
// slide direction (reproducible for QA), but varies session to session.
// Fable's mock walked a fixed rotating list; this pins it to a hash of the
// key instead so two DIFFERENT sessions don't always open with the same
// first direction, while a single session's own sequence stays fixed.
describe('directionForKey', () => {
  it('always returns one of the four cardinal directions', () => {
    for (let k = 0; k < 50; k++) {
      expect(DIRECTIONS).toContain(directionForKey(k))
    }
  })

  it('is deterministic — same key always returns the same direction', () => {
    for (const k of [0, 1, 2, 7, 41]) {
      expect(directionForKey(k)).toBe(directionForKey(k))
    }
  })

  it('is not the same direction for every key (uses the seed, not a constant)', () => {
    const seen = new Set(Array.from({ length: 12 }, (_, k) => directionForKey(k)))
    expect(seen.size).toBeGreaterThan(1)
  })
})
