import { useState, useEffect, useRef } from 'react'

export function fmt(ms) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function parseMmSs(str) {
  const parts = str.split(':').map(Number)
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]))
    return (parts[0] * 60 + parts[1]) * 1000
  const sec = Number(str)
  return isNaN(sec) ? null : sec * 1000
}

export function TimeField({ label, value, minMs = 0, maxMs, onChange }) {
  const [editing, setEditing] = useState(false)
  const [raw, setRaw] = useState('')
  const ref = useRef(null)

  const start = () => {
    setRaw(fmt(value))
    setEditing(true)
    setTimeout(() => ref.current?.select(), 0)
  }
  const commit = () => {
    const ms = parseMmSs(raw)
    if (ms !== null) onChange(Math.max(minMs, Math.min(maxMs, ms)))
    setEditing(false)
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[11px] text-ink-muted">{label}</span>
      {editing ? (
        <input
          ref={ref}
          type="text"
          value={raw}
          onChange={e => setRaw(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              // Cancel just this field edit — stop the event so the modal's
              // window-level Escape handler doesn't also close the whole modal.
              e.stopPropagation()
              setEditing(false)
            }
          }}
          className="w-16 text-center text-sm font-mono font-bold bg-white/[0.08] text-white rounded-lg px-2 py-1.5 outline-none border border-accent/50"
        />
      ) : (
        <button
          onClick={start}
          className="text-sm font-mono font-bold text-accent hover:text-white transition-colors duration-150 cursor-pointer px-2 py-1 rounded-lg hover:bg-white/[0.05]"
          title="Click to type a time"
        >
          {fmt(value)}
        </button>
      )}
    </div>
  )
}

export function SetMarkerButton({ label, position, savedMs, onClick }) {
  const [wasJustSet, setWasJustSet] = useState(false)

  const handleClick = () => {
    onClick()
    setWasJustSet(true)
  }

  useEffect(() => {
    if (wasJustSet && Math.abs(position - savedMs) > 500) {
      setWasJustSet(false)
    }
  }, [position, savedMs, wasJustSet])

  const isConfirmed = wasJustSet || Math.abs(position - savedMs) < 500

  return (
    <button
      onClick={handleClick}
      style={{ transition: 'transform 160ms cubic-bezier(0.23,1,0.32,1), background 200ms cubic-bezier(0.23,1,0.32,1)' }}
      className={`py-3 rounded-xl flex flex-col items-center gap-0.5 cursor-pointer active:scale-[0.97]
        ${isConfirmed
          ? 'bg-accent/15 ring-1 ring-accent/25'
          : 'bg-white/[0.05] hover:bg-white/[0.09]'
        }`}
    >
      <span
        className="text-[10px] font-bold uppercase tracking-wider"
        style={{ transition: 'color 200ms cubic-bezier(0.23,1,0.32,1)' }}
      >
        {isConfirmed
          ? <span className="text-accent">✓ {label}</span>
          : <span className="text-white">{label}</span>
        }
      </span>
      <span className="text-[10px] tabular-nums" style={{ transition: 'color 200ms', color: isConfirmed ? 'rgba(29,185,84,0.6)' : 'rgba(255,255,255,0.3)' }}>
        {fmt(savedMs)}
      </span>
    </button>
  )
}
