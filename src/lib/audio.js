// Synthesized cassette click: two short noise bursts with exponential decay,
// highpass filtered to be crisp. Plays on shuffle start.
export function playCassetteClick() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()

    const burst = (startTime, volume, hpHz) => {
      const sr = ctx.sampleRate
      const len = Math.floor(sr * 0.055)
      const buf = ctx.createBuffer(1, len, sr)
      const data = buf.getChannelData(0)
      for (let i = 0; i < len; i++) {
        const env = Math.pow(1 - i / len, 2.5)
        data[i] = (Math.random() * 2 - 1) * env * volume
      }
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = hpHz
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(hp)
      hp.connect(ctx.destination)
      src.start(startTime)
    }

    burst(ctx.currentTime, 0.55, 1200)          // main click
    burst(ctx.currentTime + 0.09, 0.30, 2200)  // mechanism settling (higher, softer)

    setTimeout(() => ctx.close(), 600)
  } catch (_) {}
}
