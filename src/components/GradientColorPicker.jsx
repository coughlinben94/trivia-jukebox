import { useEffect, useRef, useState } from 'react'

// Separate pop-up window for picking a song's two gradient colors — split out
// of SongDetailModal 2026-08-04 (owner: wanted the eyedropper on a bigger
// cover image, "not super precise" reaching up to the small strip at the top
// of the trim-editor popup; also cleaner UI/UX than everything crammed into
// one long scrolling sheet). This is a controlled component: SongDetailModal
// owns the actual color state and passes it down, this component only owns
// the eyedropper's "which slot is armed" interaction.

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')
}

export default function GradientColorPicker({
  track,
  autoColor1,
  autoColor2,
  gradientOverride1,
  gradientOverride2,
  swatchCandidates,
  onPick,
  onClose,
  onToast,
}) {
  const img = track.album?.images?.[0]

  // Which color slot (1 or 2) is armed to sample from the cover on next
  // click, or null when idle.
  const [armedSlot, setArmedSlot] = useState(null)
  const armedSlotRef = useRef(null)
  useEffect(() => { armedSlotRef.current = armedSlot }, [armedSlot])
  const coverImgRef = useRef(null)

  // Reads the clicked pixel off the big cover image via an offscreen canvas.
  // Spotify's image CDN (i.scdn.co) sends CORS headers permitting
  // crossOrigin="anonymous" canvas reads (confirmed 2026-08-04), so this
  // needs no server round-trip. Accounts for object-contain's letterboxing
  // so a click in the blank padding around a non-square cover is ignored
  // rather than sampling the wrong pixel.
  const handleCoverClick = (e) => {
    const slot = armedSlotRef.current
    const el   = coverImgRef.current
    if (!slot || !el || !el.naturalWidth) return

    const rect  = el.getBoundingClientRect()
    const scale = Math.min(rect.width / el.naturalWidth, rect.height / el.naturalHeight)
    const renderedW = el.naturalWidth  * scale
    const renderedH = el.naturalHeight * scale
    const offsetX = (rect.width  - renderedW) / 2
    const offsetY = (rect.height - renderedH) / 2
    const x = e.clientX - rect.left - offsetX
    const y = e.clientY - rect.top  - offsetY
    if (x < 0 || y < 0 || x > renderedW || y > renderedH) return  // clicked the letterbox padding, not the art

    try {
      const canvas = document.createElement('canvas')
      canvas.width  = el.naturalWidth
      canvas.height = el.naturalHeight
      const ctx = canvas.getContext('2d')
      ctx.drawImage(el, 0, 0)
      const [r, g, b] = ctx.getImageData(Math.floor(x / scale), Math.floor(y / scale), 1, 1).data
      onPick(slot, rgbToHex(r, g, b))
      setArmedSlot(null)
    } catch {
      onToast?.('Could not sample that color — try again')
      setArmedSlot(null)
    }
  }

  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    const h = (e) => {
      if (e.repeat) return
      if (e.key === 'Escape') {
        if (armedSlotRef.current) { setArmedSlot(null); return }  // cancel eyedropper first, don't close under it
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6 bg-black/85 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-surface-raised border border-white/[0.07] rounded-t-3xl sm:rounded-3xl w-full max-w-md shadow-2xl animate-fade-up overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Big cover art — much bigger than the strip in the trim editor, so
            the eyedropper has room to be precise. */}
        <div className="relative aspect-square bg-black overflow-hidden">
          {img && (
            <img
              src={img.url}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-30"
              style={{ filter: 'blur(24px) saturate(1.4)', transform: 'scale(1.1)' }}
            />
          )}
          {img && (
            <img
              ref={coverImgRef}
              src={img.url}
              alt=""
              crossOrigin="anonymous"
              onClick={handleCoverClick}
              className={`relative w-full h-full object-contain drop-shadow-2xl ${armedSlot ? 'cursor-crosshair' : ''}`}
            />
          )}
          {armedSlot && (
            <div className="absolute inset-x-0 bottom-3 flex justify-center">
              <span className="px-2.5 py-1 rounded-full bg-black/70 text-white text-[11px] font-medium">
                tap the cover to pick color {armedSlot} · esc to cancel
              </span>
            </div>
          )}
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-7 h-7 rounded-full bg-black/60 text-white hover:text-white flex items-center justify-center transition-[transform,color] duration-150 active:scale-[0.97] cursor-pointer"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        <div className="p-5">
          <span className="block text-[11px] font-semibold text-white uppercase tracking-wide mb-3">Gradient colors</span>
          {[1, 2].map(slot => {
            const override = slot === 1 ? gradientOverride1 : gradientOverride2
            const auto     = slot === 1 ? autoColor1        : autoColor2
            const current  = override ?? auto
            return (
              <div key={slot} className="flex items-center gap-2 flex-wrap mb-3 last:mb-0">
                <span className="text-[11px] text-white w-11 shrink-0">Color {slot}</span>
                <button
                  onClick={() => setArmedSlot(s => s === slot ? null : slot)}
                  title="Pick from cover art"
                  aria-label={`Pick color ${slot} from cover art`}
                  style={{ background: current ?? '#333', transition: 'transform 160ms cubic-bezier(0.23,1,0.32,1)' }}
                  className={`w-8 h-8 rounded-full cursor-pointer flex items-center justify-center active:scale-[0.92] ${
                    armedSlot === slot ? 'ring-2 ring-accent' : 'ring-1 ring-white/20'
                  }`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.8))' }}>
                    <path d="M19 3a3 3 0 0 1 0 4.24l-9.5 9.5-4.5 1 1-4.5 9.5-9.5A3 3 0 0 1 19 3z" />
                  </svg>
                </button>
                {swatchCandidates.map((hex, i) => (
                  <button
                    key={hex + i}
                    onClick={() => onPick(slot, hex)}
                    title={hex}
                    aria-label={`Use ${hex} as color ${slot}`}
                    style={{ background: hex, transition: 'transform 160ms cubic-bezier(0.23,1,0.32,1)' }}
                    className={`w-8 h-8 rounded-full cursor-pointer active:scale-[0.92] ${
                      current === hex ? 'ring-2 ring-white' : 'ring-1 ring-white/20'
                    }`}
                  />
                ))}
                <label
                  className="w-8 h-8 rounded-full cursor-pointer relative overflow-hidden flex items-center justify-center ring-1 ring-white/20"
                  style={{
                    background: override && !swatchCandidates.includes(override)
                      ? override
                      : 'conic-gradient(from 0deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
                  }}
                  title={`Pick a custom color ${slot}`}
                >
                  <input
                    type="color"
                    aria-label={`Pick a custom color ${slot}`}
                    className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                    value={override ?? current ?? '#888888'}
                    onChange={e => onPick(slot, e.target.value)}
                  />
                </label>
                {override && (
                  <button
                    onClick={() => onPick(slot, null)}
                    className="text-[11px] text-white hover:text-white cursor-pointer transition-colors duration-150"
                  >
                    ↺ auto
                  </button>
                )}
              </div>
            )
          })}

          <button
            onClick={onClose}
            style={{ transition: 'transform 160ms cubic-bezier(0.23,1,0.32,1)' }}
            className="w-full mt-2 py-3 bg-accent text-black text-sm font-bold rounded-xl hover:bg-accent-hover active:scale-[0.97] cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
