import { useRef, useState, useEffect, useCallback } from 'react'
import {
  DIALS, T, setDial, resetDial, clearDials, setEngine,
  hasOverrides, exportSnippet, TUNING_EVENT,
} from '../lib/gradientTuning.js'

// A single DJ-style vertical fader — bottom of the track is 0, top is 100.
// Replaced the earlier rotary knob 2026-07-27: the knob's drag was reported
// "wrong direction / too sensitive" on a Mac trackpad, which traced back to
// two separate bugs (an over-aggressive px-per-unit multiplier, and a wheel
// direction that fought macOS's default natural-scrolling). A vertical
// fader sidesteps both failure modes at the root — it maps the drag to an
// ABSOLUTE position within the track's own real pixel height (via
// getBoundingClientRect), not a relative delta with a tunable multiplier, so
// there's no sensitivity constant to get wrong, and "top = 100, bottom = 0"
// is unambiguous regardless of trackpad scroll settings (which only affect
// the scroll-to-nudge wheel gesture, kept below with its already-fixed sign).
//
// The fader reads its value straight out of gradientTuning.js's module store
// (T(id)) rather than holding it in React state — the store is the single
// source of truth the renderers read too. TuningBoard subscribes to
// TUNING_EVENT and re-renders the whole board on every change, which is what
// makes these reads current. Without that subscription the store would move
// and the fader would never visually track it.
const TRACK_HEIGHT = 128 // px — tall enough for comfortable, non-twitchy control

function Fader({ id, label, hint }) {
  const value = T(id)
  const trackRef = useRef(null)
  const draggingRef = useRef(false)
  const isOverridden = value !== 50

  const setFromClientY = useCallback((clientY, committed) => {
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // 0 at the bottom edge, 1 at the top edge — clamped, so dragging past
    // either end just pins to min/max instead of wrapping or erroring.
    const frac = 1 - (clientY - rect.top) / rect.height
    setDial(id, Math.min(100, Math.max(0, frac * 100)), committed)
  }, [id])

  const onPointerDown = useCallback((e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = true
    setFromClientY(e.clientY, false)
  }, [setFromClientY])

  const onPointerMove = useCallback((e) => {
    if (!draggingRef.current) return
    setFromClientY(e.clientY, false)
  }, [setFromClientY])

  const onPointerUp = useCallback((e) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    // committed=true here does the 'release' dials' heavy work (remount,
    // palette refetch) — 'live' dials have already been applying every
    // frame via the committed=false calls during the drag.
    setFromClientY(e.clientY, true)
  }, [setFromClientY])

  // Wheel is attached manually, non-passive: React binds onWheel at the root as
  // a passive listener, where preventDefault() is a no-op with a console
  // warning. Nudging a fader shouldn't also scroll whatever's underneath.
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      // Sign fixed 2026-07-27 for Mac trackpad natural scrolling — see the
      // block comment above the component.
      setDial(id, T(id) + (e.deltaY < 0 ? -1 : 1), true)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [id])

  const onDoubleClick = useCallback(() => resetDial(id), [id])

  return (
    <div className="flex flex-col items-center gap-1.5 select-none">
      <span className="text-[9px] tabular-nums text-white/40">{Math.round(value)}</span>
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        className="relative w-3 rounded-full cursor-ns-resize touch-none"
        style={{ height: TRACK_HEIGHT, background: 'rgba(255,255,255,0.08)' }}
        title={`${label}: ${Math.round(value)}${hint ? ` — ${hint}` : ''}\ndrag to set · scroll to nudge · double-click to reset`}
      >
        {/* Fill — bottom-anchored, grows upward with value */}
        <div
          className="absolute bottom-0 left-0 right-0 rounded-full pointer-events-none"
          style={{
            height: `${value}%`,
            background: isOverridden ? 'rgba(167,139,250,0.75)' : 'rgba(255,255,255,0.35)',
          }}
        />
        {/* Thumb — centered on the current position */}
        <div
          className="absolute left-1/2 w-6 h-3 rounded-sm pointer-events-none"
          style={{
            bottom: `calc(${value}% - 6px)`,
            transform: 'translateX(-50%)',
            background: '#e8e4dc',
            boxShadow: isOverridden
              ? '0 0 0 2px rgba(167,139,250,0.6), 0 1px 3px rgba(0,0,0,0.5)'
              : '0 1px 3px rgba(0,0,0,0.5)',
          }}
        />
      </div>
      <div className="flex items-center gap-1">
        <span className="text-[9px] font-semibold tracking-wide text-white/70">{label}</span>
        <InfoIcon text={hint} />
      </div>
    </div>
  )
}

// Short, plain-English blurbs for the hover info icon — no jargon, no
// mechanics (commit timing lives in the code comments, not here).
const HINTS = {
  BRIGHTNESS: 'How bright and bold the colors look.',
  MOTION:     'How fast the color blobs move.',
  SIZE:       'How big each color blob is.',
  BLEND:      'Sharp color shapes vs. soft blending.',
  VARIETY:    'How many different colors show up.',
  CROSSFADE:  'How fast the background fades to the next song.',
}

// Small "i" badge with a hover tooltip — CSS-only (Tailwind named group),
// no JS state needed. Sits next to each fader's label.
function InfoIcon({ text }) {
  if (!text) return null
  return (
    <div className="relative group/info">
      <span
        className="w-3.5 h-3.5 rounded-full border border-white/25 text-white/50 text-[8px] leading-none flex items-center justify-center cursor-help select-none"
        aria-label={text}
      >
        i
      </span>
      <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-32 opacity-0 group-hover/info:opacity-100 transition-opacity duration-150 z-10">
        <div className="bg-black/95 border border-white/10 rounded-lg px-2.5 py-2 text-[10px] leading-snug text-white/85 shadow-lg text-center">
          {text}
        </div>
      </div>
    </div>
  )
}

// The mixer. Fixed to the bottom of whatever screen mounts it (TestScreen),
// above LiveScreen's z-50 so it sits over the turntable while a real song
// plays. `engine` is display-only state owned by the parent — the switch
// writes localStorage via setEngine() and the parent remounts the renderer.
export default function TuningBoard({ engine, engineLocked = false }) {
  const [copied, setCopied] = useState(false)
  const [, forceRender] = useState(0)

  // Single subscription for the whole board: the dial store lives outside
  // React, so this is what turns a store write into a visible knob movement
  // (and keeps RESET ALL's disabled state honest).
  useEffect(() => {
    const onChange = () => forceRender(n => n + 1)
    window.addEventListener(TUNING_EVENT, onChange)
    return () => window.removeEventListener(TUNING_EVENT, onChange)
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exportSnippet())
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked (non-secure context, permissions) — dump it where
      // it's still recoverable instead of failing silently.
      console.log(exportSnippet())
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex items-end gap-5 px-5 py-4 rounded-2xl"
      style={{
        background: 'linear-gradient(180deg, rgba(20,20,20,0.92), rgba(10,10,10,0.96))',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
        backdropFilter: 'blur(12px)',
      }}
    >
      {DIALS.map(d => <Fader key={d.id} id={d.id} label={d.label} hint={HINTS[d.id]} />)}

      <div className="w-px self-stretch bg-white/10 mx-1" />

      {/* Engine A/B — a toggle switch, not a knob, like a mixer's routing switch */}
      <div className="flex flex-col items-center gap-1.5">
        <button
          onClick={() => setEngine(engine === 'mesh' ? 'circles' : 'mesh')}
          disabled={engineLocked}
          className="w-12 h-6 rounded-full relative transition-colors duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-default"
          style={{ background: engine === 'mesh' ? 'rgba(167,139,250,0.5)' : 'rgba(255,255,255,0.15)' }}
          title={engineLocked
            ? '?gradient= in the URL is forcing the engine — drop the param to use this switch'
            : 'Switch gradient engine (mesh / circles)'}
        >
          <div
            className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-150"
            style={{ transform: engine === 'mesh' ? 'translateX(26px)' : 'translateX(2px)' }}
          />
        </button>
        <span className="text-[9px] font-semibold tracking-wide text-white/70">{engine === 'mesh' ? 'MESH' : 'CIRCLES'}</span>
        {engineLocked && <span className="text-[8px] text-amber-300/70">?gradient= wins</span>}
      </div>

      <div className="w-px self-stretch bg-white/10 mx-1" />

      <div className="flex flex-col items-center gap-2">
        <button
          onClick={copy}
          className="text-[10px] font-semibold tracking-wide text-white bg-white/10 hover:bg-white/20 transition-colors duration-150 cursor-pointer px-3 py-1.5 rounded-lg"
        >
          {copied ? 'COPIED ✓' : 'COPY VALUES'}
        </button>
        <button
          onClick={clearDials}
          disabled={!hasOverrides()}
          className="text-[10px] font-medium tracking-wide text-white/50 hover:text-white/80 disabled:opacity-30 disabled:cursor-default transition-colors duration-150 cursor-pointer"
        >
          RESET ALL
        </button>
      </div>
    </div>
  )
}
