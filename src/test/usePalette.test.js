import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePalette } from '../hooks/usePalette.js'

// Track 3 audit (2026-08-04): a failed palette fetch used to log a warning
// and leave the hook pinned at FALLBACK forever, with nothing to ever retry
// it. Guards the fix — one retry after a transient failure should still
// land the real palette.

describe('usePalette retry-once behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('retries once after a failed fetch and applies the palette that lands', async () => {
    vi.useFakeTimers()
    let callCount = 0
    global.fetch = vi.fn(() => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error('network blip'))
      return Promise.resolve({
        json: () => Promise.resolve({ colors: ['#112233', '#445566'], weights: [0.6, 0.4] }),
      })
    })

    let result
    await act(async () => {
      ;({ result } = renderHook(() => usePalette('https://i.scdn.co/image/retry-test-1')))
    })

    expect(result.current.colors).toEqual(['#080808', '#080808', '#080808', '#080808', '#080808'])
    expect(callCount).toBe(1)

    // First attempt's rejection needs a microtask tick to reach the .catch()
    // and schedule the retry timer before advancing fake time past it.
    // advanceTimersByTimeAsync flushes microtasks between fake-timer ticks,
    // so the retry fetch's own resolution lands inside this same act().
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })

    expect(result.current.colors).toEqual(['#112233', '#445566'])
    expect(callCount).toBe(2)
  })

  it('falls back and stops after the retry also fails', async () => {
    vi.useFakeTimers()
    global.fetch = vi.fn(() => Promise.reject(new Error('still down')))

    let result
    await act(async () => {
      ;({ result } = renderHook(() => usePalette('https://i.scdn.co/image/retry-test-2')))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200)
    })

    expect(result.current.colors).toEqual(['#080808', '#080808', '#080808', '#080808', '#080808'])
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })
})
