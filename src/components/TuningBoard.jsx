import { useRef, useState, useEffect, useCallback } from 'react'
import {
  DIALS, T, setDial, resetDial, clearDials, setEngine,
  hasOverrides, exportSnippet, TUNING_EVENT,
} from '../lib/gradientTuning.js'

// A single DJ-style rotary knob. Drag vertically to turn (standard pro-audio
// knob convention — up increases, matches a physical knob's feel better than a
// circular drag gesture would on a trackpad). Scroll to nudge by 1.
// Double-click resets to 50 (the default — see gradientTuning.js's
// derived-value comments for why 50 always reproduces today's live look).
//
// The knob reads its value straight out of gradientTuning.js's module store
// (T(id)) rather than holding it in React state — the store is the single
// source of truth the renderers read too. TuningBoard subscribes to
// TUNING_EVENT and re-renders the whole board on every change, which is what
// makes these reads current. Without that subscription the store would move
// and the knob would never visually turn.
function Knob({ id, label, hint }) {
  const value = T(id)
  const dragRef = useRef(null)
  const elRef = useRef(null)
  const isOverridden = value !== 50

  const onPointerDown = useCallback((e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, startValue: T(id) }
  }, [id])

  const onPointerMove = useCallback((e) => {
    if (!dragRef.current) return
    const dy = dragRef.current.startY - e.clientY // up = positive = increase
    // committed=false: 'release' dials (MOTION/SIZE/VARIETY) hold their heavy
    // work — remount, palette refetch — until pointer-up. 'live' dials apply
    // every frame regardless, since the renderers re-read on each draw.
    setDial(id, dragRef.current.startValue + dy * 0.6, false)
  }, [id])

  const onPointerUp = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    setDial(id, T(id), true) // commit + persist at the dragged-to value
  }, [id])

  // Wheel is attached manually, non-passive: React binds onWheel at the root as
  // a passive listener, where preventDefault() is a no-op with a console
  // warning. Nudging a knob shouldn't also scroll whatever's underneath.
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      setDial(id, T(id) + (e.deltaY < 0 ? 1 : -1), true)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [id])

  const onDoubleClick = useCallback(() => resetDial(id), [id])

  // 270° sweep, -135deg (min) to +135deg (max), matching a physical mixer knob.
  const rotation = -135 + (value / 100) * 270

  return (
    <div className="flex flex-col items-center gap-1.5 select-none">
      <div
        ref={elRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        className="relative w-12 h-12 rounded-full cursor-ns-resize touch-none"
        style={{
          background: 'radial-gradient(circle at 35% 30%, #3a3a3a, #161616 70%)',
          boxShadow: isOverridden
            ? '0 0 0 2px rgba(167,139,250,0.6), 0 2px 6px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.15)'
            : '0 2px 6px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.1)',
        }}
        title={`${label}: ${Math.round(value)}${hint ? ` — ${hint}` : ''}\ndrag to turn · scroll to nudge · double-click to reset`}
      >
        <div
          className="absolute left-1/2 top-1/2 w-[3px] h-4 rounded-full bg-white/80"
          style={{ transform: `translate(-50%, -100%) rotate(${rotation}deg)`, transformOrigin: '50% 100%' }}
        />
      </div>
      <span className="text-[9px] font-semibold tracking-wide text-white/70">{label}</span>
      <span className="text-[9px] tabular-nums text-white/40">{Math.round(value)}</span>
    </div>
  )
}

const HINTS = {
  BRIGHTNESS: 'brighter, more saturated blobs',
  MOTION:     'blobs drift faster (applies on release)',
  SIZE:       'each blob covers more screen (applies on release)',
  BLEND:      'distinct bodies vs. one creamy average',
  VARIETY:    'more distinct hues pulled from the art (refetches on release)',
  CROSSFADE:  'song-to-song background transitions get faster',
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
      {DIALS.map(d => <Knob key={d.id} id={d.id} label={d.label} hint={HINTS[d.id]} />)}

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
