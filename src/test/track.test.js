import { describe, it, expect } from 'vitest'
import { slimTrack, songNeedsSlim } from '../lib/track'

const RAW_TRACK = {
  id: 'track-1',
  uri: 'spotify:track:abc123',
  name: 'Test Song',
  duration_ms: 240000,
  available_markets: Array.from({ length: 185 }, (_, i) => `MK${i}`),
  external_ids: { isrc: 'ABC123' },
  artists: [{ id: 'a1', name: 'Test Artist', uri: 'spotify:artist:a1', available_markets: ['US'] }],
  album: {
    id: 'al1',
    name: 'Test Album',
    images: [{ url: 'https://example.com/art.jpg', width: 640, height: 640 }],
    available_markets: Array.from({ length: 185 }, (_, i) => `MK${i}`),
  },
}

describe('slimTrack', () => {
  it('drops bulky fields and keeps only what the UI reads', () => {
    const slim = slimTrack(RAW_TRACK)
    expect(slim).toEqual({
      id: 'track-1',
      uri: 'spotify:track:abc123',
      name: 'Test Song',
      duration_ms: 240000,
      artists: [{ name: 'Test Artist' }],
      album: {
        name: 'Test Album',
        images: [{ url: 'https://example.com/art.jpg', width: 640, height: 640 }],
      },
    })
    expect(slim.available_markets).toBeUndefined()
    expect(slim.external_ids).toBeUndefined()
    expect(slim.artists[0].id).toBeUndefined()
  })

  it('is idempotent — slimming an already-slim track is a no-op', () => {
    const once = slimTrack(RAW_TRACK)
    const twice = slimTrack(once)
    expect(twice).toEqual(once)
  })

  it('handles missing artists/album gracefully', () => {
    const bare = { id: 'x', uri: 'spotify:track:x', name: 'Bare', duration_ms: 1000 }
    expect(() => slimTrack(bare)).not.toThrow()
    expect(slimTrack(bare).artists).toEqual([])
  })
})

describe('songNeedsSlim', () => {
  it('flags a song with track-level available_markets', () => {
    expect(songNeedsSlim({ available_markets: ['US'] })).toBe(true)
  })

  it('flags a song with album-level available_markets', () => {
    expect(songNeedsSlim({ album: { available_markets: ['US'] } })).toBe(true)
  })

  it('does not flag an already-slim song', () => {
    expect(songNeedsSlim(slimTrack(RAW_TRACK))).toBe(false)
  })
})
