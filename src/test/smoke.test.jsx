// Throwaway smoke test — mounts Jukebox and LiveScreen for real to catch
// render-time crashes (e.g. TDZ from a hook referenced before declaration)
// that a `vite build` or the existing logic-only unit tests never exercise.
// Not part of the permanent suite — delete after use.
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import Jukebox from '../components/Jukebox'
import LiveScreen from '../components/LiveScreen'
import TestScreen from '../components/TestScreen'

vi.mock('../hooks/useSpotifyPlayer', () => ({
  useSpotifyPlayer: () => ({
    isReady: true,
    isPaused: true,
    currentTrack: null,
    position: 0,
    duration: 0,
    error: null,
    playTrack: vi.fn(() => Promise.resolve(true)),
    fadeAndPause: vi.fn(() => Promise.resolve()),
    seek: vi.fn(),
  }),
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
      upsert: () => Promise.resolve({ data: null, error: null }),
    }),
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), }),
    removeChannel: () => {},
  },
}))

vi.mock('../lib/spotify', () => ({
  searchTracks: vi.fn(() => Promise.resolve([])),
  logout: vi.fn(),
}))

vi.mock('../hooks/usePalette', () => ({
  usePalette: () => ({ colors: ['#112233', '#ff0000'], weights: [0.5, 0.5] }),
  prefetchPalette: vi.fn(),
}))

describe('smoke: components mount without throwing', () => {
  it('Jukebox renders', () => {
    expect(() => render(<Jukebox onLogout={() => {}} />)).not.toThrow()
  })

  it('LiveScreen renders with entranceSong/transition props wired', () => {
    const song = {
      id: 's1', uri: 'spotify:track:x', name: 'Test', album: { images: [{ url: 'https://x/y.jpg' }] },
      artists: [{ name: 'Artist' }], duration_ms: 200000, startMs: 0, stopMs: 200000,
    }
    expect(() => render(
      <LiveScreen
        currentTrack={null}
        isPaused={false}
        ending={false}
        onClose={() => {}}
        shuffleKey={0}
        onUpcomingTrack={() => {}}
        entranceSong={song}
        onEntranceStart={() => {}}
        onRegisterTransition={() => {}}
        onTransitionAudioStart={() => {}}
      />
    )).not.toThrow()
  })

  it('TestScreen renders with the same new props forwarded', () => {
    expect(() => render(
      <TestScreen
        currentTrack={null}
        isPaused={false}
        shuffleKey={0}
        onUpcomingTrack={() => {}}
        onClose={() => {}}
        entranceSong={null}
        onEntranceStart={() => {}}
        onRegisterTransition={() => {}}
        onTransitionAudioStart={() => {}}
      />
    )).not.toThrow()
  })
})
