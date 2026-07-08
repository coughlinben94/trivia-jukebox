import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SongDetailModal from '../components/SongDetailModal'

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const TRACK = {
  id: 'track-1',
  uri: 'spotify:track:abc123',
  name: 'Test Song',
  duration_ms: 240000,   // 4:00
  startMs: 10000,        // 0:10
  stopMs:  200000,       // 3:20
  artists: [{ name: 'Test Artist' }],
  album: { images: [{ url: 'https://example.com/art.jpg' }] },
}

function makePlayer(overrides = {}) {
  return {
    position:     0,
    duration:     0,
    seek:         vi.fn(),
    playTrack:    vi.fn(),
    pause:        vi.fn(),
    currentTrack: null,
    isPaused:     true,
    ...overrides,
  }
}

// Renders modal and returns callbacks + rerender
function renderModal(trackOverrides = {}, playerOverrides = {}, handlers = {}) {
  const onUpdateTimes = handlers.onUpdateTimes ?? vi.fn()
  const onClose       = handlers.onClose       ?? vi.fn()
  const track  = { ...TRACK, ...trackOverrides }
  const player = makePlayer(playerOverrides)

  const result = render(
    <SongDetailModal
      track={track}
      player={player}
      onUpdateTimes={onUpdateTimes}
      onClose={onClose}
    />
  )

  return { onUpdateTimes, onClose, track, player, ...result }
}

// The Set In / Set Out buttons contain their label + a time sub-label.
// Use role+name regex to find them regardless of ✓ prefix.
const setInBtn  = () => screen.getByRole('button', { name: /Set In/i })
const setOutBtn = () => screen.getByRole('button', { name: /Set Out/i })

// The two TimeField toggle-buttons (In value, Out value)
const timeFieldBtns = () => screen.getAllByTitle('Click to type a time')

// ─── Set In ────────────────────────────────────────────────────────────────────

describe('Set In', () => {
  it('saves current position as startMs immediately when track is active', () => {
    const onUpdateTimes = vi.fn()
    renderModal(
      {},
      { currentTrack: { uri: TRACK.uri }, position: 30000, duration: 240000, isPaused: false },
      { onUpdateTimes }
    )

    fireEvent.click(setInBtn())

    expect(onUpdateTimes).toHaveBeenCalledWith('track-1', 30000, TRACK.stopMs)
  })

  it('saves localPos as startMs when track is not active', () => {
    // When not active, displayPosition = localPos = track.startMs (10000)
    const onUpdateTimes = vi.fn()
    renderModal({}, {}, { onUpdateTimes })

    fireEvent.click(setInBtn())

    expect(onUpdateTimes).toHaveBeenCalledWith('track-1', TRACK.startMs, TRACK.stopMs)
  })

  it('Set In marker turns green (✓) immediately after click', () => {
    renderModal(
      {},
      { currentTrack: { uri: TRACK.uri }, position: 30000, duration: 240000, isPaused: true }
    )

    fireEvent.click(setInBtn())

    // After setting, label should include the ✓ checkmark
    expect(screen.getByText(/✓.*Set In/)).toBeInTheDocument()
  })

  it('startMs persists in next onUpdateTimes call after Set Out', () => {
    const onUpdateTimes = vi.fn()
    const player = makePlayer({
      currentTrack: { uri: TRACK.uri },
      position: 5000,
      duration: 240000,
      isPaused: true,
    })

    const { rerender } = render(
      <SongDetailModal
        track={TRACK}
        player={player}
        onUpdateTimes={onUpdateTimes}
        onClose={vi.fn()}
      />
    )

    fireEvent.click(setInBtn())
    expect(onUpdateTimes).toHaveBeenLastCalledWith('track-1', 5000, TRACK.stopMs)

    // Move position and Set Out
    player.position = 190000
    rerender(
      <SongDetailModal
        track={TRACK}
        player={player}
        onUpdateTimes={onUpdateTimes}
        onClose={vi.fn()}
      />
    )

    fireEvent.click(setOutBtn())
    // startMs should still be 5000 (what we set), not the original 10000
    expect(onUpdateTimes).toHaveBeenLastCalledWith('track-1', 5000, 190000)
  })
})

// ─── Set Out ───────────────────────────────────────────────────────────────────

describe('Set Out', () => {
  it('saves current position as stopMs immediately when track is active', () => {
    const onUpdateTimes = vi.fn()
    renderModal(
      {},
      { currentTrack: { uri: TRACK.uri }, position: 180000, duration: 240000, isPaused: false },
      { onUpdateTimes }
    )

    fireEvent.click(setOutBtn())

    expect(onUpdateTimes).toHaveBeenCalledWith('track-1', TRACK.startMs, 180000)
  })

  it('Set Out marker turns green (✓) immediately after click', () => {
    renderModal(
      {},
      { currentTrack: { uri: TRACK.uri }, position: 180000, duration: 240000, isPaused: true }
    )

    fireEvent.click(setOutBtn())

    expect(screen.getByText(/✓.*Set Out/)).toBeInTheDocument()
  })

  it('stopMs persists in next onUpdateTimes call after Set In', () => {
    const onUpdateTimes = vi.fn()
    const player = makePlayer({
      currentTrack: { uri: TRACK.uri },
      position: 190000,
      duration: 240000,
      isPaused: true,
    })

    const { rerender } = render(
      <SongDetailModal
        track={TRACK}
        player={player}
        onUpdateTimes={onUpdateTimes}
        onClose={vi.fn()}
      />
    )

    fireEvent.click(setOutBtn())
    expect(onUpdateTimes).toHaveBeenLastCalledWith('track-1', TRACK.startMs, 190000)

    player.position = 8000
    rerender(
      <SongDetailModal
        track={TRACK}
        player={player}
        onUpdateTimes={onUpdateTimes}
        onClose={vi.fn()}
      />
    )

    fireEvent.click(setInBtn())
    // stopMs should still be 190000 (what we set)
    expect(onUpdateTimes).toHaveBeenLastCalledWith('track-1', 8000, 190000)
  })
})

// ─── Reset ─────────────────────────────────────────────────────────────────────

describe('Reset', () => {
  it('resets startMs to 0 and stopMs to duration_ms', () => {
    const onUpdateTimes = vi.fn()
    renderModal({}, {}, { onUpdateTimes })

    fireEvent.click(screen.getByText(/reset/i))

    expect(onUpdateTimes).toHaveBeenCalledWith('track-1', 0, TRACK.duration_ms)
  })

  it('resets In field to 0:00 and Out field to 4:00', () => {
    renderModal()

    fireEvent.click(screen.getByText(/reset/i))

    // Check that the first TimeField button shows 0:00 (In) and second shows 4:00 (Out)
    const [inBtn, outBtn] = timeFieldBtns()
    expect(inBtn).toHaveTextContent('0:00')
    expect(outBtn).toHaveTextContent('4:00')
  })
})

// ─── Close / Done ──────────────────────────────────────────────────────────────

describe('Close (Done button + backdrop)', () => {
  it('Done button saves current startMs/stopMs and calls onClose', () => {
    const onUpdateTimes = vi.fn()
    const onClose = vi.fn()
    renderModal({}, {}, { onUpdateTimes, onClose })

    fireEvent.click(screen.getByText('Done'))

    expect(onUpdateTimes).toHaveBeenCalledWith('track-1', TRACK.startMs, TRACK.stopMs)
    expect(onClose).toHaveBeenCalled()
  })

  it('backdrop click closes modal', () => {
    const onClose = vi.fn()
    renderModal({}, {}, { onClose })

    const backdrop = document.querySelector('.fixed.inset-0.z-40')
    fireEvent.click(backdrop)

    expect(onClose).toHaveBeenCalled()
  })

  it('backdrop click saves current times before closing', () => {
    const onUpdateTimes = vi.fn()
    renderModal({}, {}, { onUpdateTimes })

    const backdrop = document.querySelector('.fixed.inset-0.z-40')
    fireEvent.click(backdrop)

    expect(onUpdateTimes).toHaveBeenCalledWith('track-1', TRACK.startMs, TRACK.stopMs)
  })

  it('Done button stops preview playback when song is active and playing', () => {
    const pause = vi.fn()
    renderModal(
      {},
      {
        currentTrack: { uri: TRACK.uri },
        position: 50000,
        duration: 240000,
        isPaused: false,
        pause,
      }
    )

    fireEvent.click(screen.getByText('Done'))

    expect(pause).toHaveBeenCalled()
  })

  it('Done button does NOT call pause when song is not playing', () => {
    const pause = vi.fn()
    renderModal({}, { currentTrack: null, isPaused: true, pause })

    fireEvent.click(screen.getByText('Done'))

    expect(pause).not.toHaveBeenCalled()
  })

  // ── THE BUG: Escape key uses stale closure ───────────────────────────────────
  // When the modal opens with song paused, the Escape useEffect captures
  // handleClose from the first render where isPlaying=false. If the user then
  // presses ▶ (song starts playing) and hits Escape, the stale handleClose
  // has isPlaying=false so pause() is never called — preview keeps playing.
  it('Escape key stops preview playback when song started playing after modal opened', () => {
    const pause = vi.fn()
    const onClose = vi.fn()

    // Initially not playing
    const player = makePlayer({
      currentTrack: { uri: TRACK.uri },
      position: 10000,
      duration: 240000,
      isPaused: true,
      pause,
    })

    const { rerender } = render(
      <SongDetailModal
        track={TRACK}
        player={player}
        onUpdateTimes={vi.fn()}
        onClose={onClose}
      />
    )

    // User presses ▶ — now it IS playing
    player.isPaused = false
    rerender(
      <SongDetailModal
        track={TRACK}
        player={player}
        onUpdateTimes={vi.fn()}
        onClose={onClose}
      />
    )

    // Press Escape — must stop the preview
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(pause).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})

// ─── TimeField (typed In/Out) ──────────────────────────────────────────────────

describe('TimeField', () => {
  it('parses mm:ss input and updates the In display on Enter', async () => {
    const user = userEvent.setup()
    renderModal()

    // getAllByTitle because both In and Out have title="Click to type a time"
    const [inTimeBtn] = timeFieldBtns()
    fireEvent.click(inTimeBtn)

    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, '0:30')
    fireEvent.keyDown(input, { key: 'Enter' })

    // The In button should now display 0:30
    const [updatedInBtn] = timeFieldBtns()
    expect(updatedInBtn).toHaveTextContent('0:30')
  })

  it('clamps In value to stopMs maximum (3:20)', async () => {
    const user = userEvent.setup()
    renderModal()

    // stopMs = 200000 (3:20). Typing 5:00 (300000ms) should clamp.
    const [inTimeBtn] = timeFieldBtns()
    fireEvent.click(inTimeBtn)

    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, '5:00')
    fireEvent.keyDown(input, { key: 'Enter' })

    const [updatedInBtn] = timeFieldBtns()
    expect(updatedInBtn).toHaveTextContent('3:20')
  })

  it('clamps Out value to duration_ms maximum (4:00)', async () => {
    const user = userEvent.setup()
    renderModal()

    // duration_ms = 240000 (4:00). Out can't exceed that.
    const [, outTimeBtn] = timeFieldBtns()
    fireEvent.click(outTimeBtn)

    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, '9:99')
    fireEvent.keyDown(input, { key: 'Enter' })

    // 9:99 = 639000ms — clamped to 240000ms = 4:00
    const [, updatedOutBtn] = timeFieldBtns()
    expect(updatedOutBtn).toHaveTextContent('4:00')
  })

  it('ignores non-numeric input (In stays at original value)', async () => {
    const user = userEvent.setup()
    renderModal()

    const [inTimeBtn] = timeFieldBtns()
    fireEvent.click(inTimeBtn)

    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, 'abc')
    fireEvent.keyDown(input, { key: 'Enter' })

    // startMs should still be original 0:10
    const [updatedInBtn] = timeFieldBtns()
    expect(updatedInBtn).toHaveTextContent('0:10')
  })

  it('typed In value is captured in onUpdateTimes when modal closes via Done', async () => {
    const user = userEvent.setup()
    const onUpdateTimes = vi.fn()
    renderModal({}, {}, { onUpdateTimes })

    // Type a new In value
    const [inTimeBtn] = timeFieldBtns()
    fireEvent.click(inTimeBtn)
    const input = screen.getByRole('textbox')
    await user.clear(input)
    await user.type(input, '0:45')
    fireEvent.keyDown(input, { key: 'Enter' })

    // Close via Done
    fireEvent.click(screen.getByText('Done'))

    expect(onUpdateTimes).toHaveBeenLastCalledWith('track-1', 45000, TRACK.stopMs)
  })
})

// ─── Scrubber ──────────────────────────────────────────────────────────────────

describe('Scrubber', () => {
  // Since 5375a5a the scrubber commits on pointer release: onChange only moves
  // a local drag value while a pointerDown-initiated drag is active, and
  // seek()/localPos fire on pointerUp. Tests must walk the full lifecycle.
  const drag = (slider, value) => {
    fireEvent.pointerDown(slider)
    fireEvent.change(slider, { target: { value: String(value) } })
    fireEvent.pointerUp(slider, { target: { value: String(value) } })
  }

  it('calls seek() on release when track is active', () => {
    const seek = vi.fn()
    renderModal(
      {},
      { currentTrack: { uri: TRACK.uri }, position: 10000, duration: 240000, isPaused: true, seek }
    )

    drag(screen.getByRole('slider'), 60000)

    expect(seek).toHaveBeenCalledWith(60000)
  })

  it('updates local position display without calling seek() when track is not active', () => {
    const seek = vi.fn()
    renderModal({}, { seek })

    drag(screen.getByRole('slider'), 60000)

    expect(seek).not.toHaveBeenCalled()
    // Scrubber position label (the left time display) should update to 1:00
    const posDisplay = document.querySelector('.flex.justify-between span')
    expect(posDisplay).toHaveTextContent('1:00')
  })
})

// ─── Play / Stop preview ───────────────────────────────────────────────────────

describe('Play / Stop preview', () => {
  it('play button calls playTrack with startMs, stopMs, preview=true', () => {
    const playTrack = vi.fn()
    renderModal({}, { playTrack })

    fireEvent.click(screen.getByText('▶'))

    expect(playTrack).toHaveBeenCalledWith(TRACK.uri, TRACK.startMs, TRACK.stopMs, true)
  })

  it('stop button pauses immediately (no fade) when song is playing', () => {
    const pause = vi.fn()
    renderModal(
      {},
      { currentTrack: { uri: TRACK.uri }, position: 20000, duration: 240000, isPaused: false, pause }
    )

    fireEvent.click(screen.getByText('⏸'))

    expect(pause).toHaveBeenCalled()
  })
})
