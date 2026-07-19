import { useEffect, useRef, useMemo } from 'react'

// WebGL2 flow-noise version of the LiveScreen background. Same prop contract
// as AlbumGradient.jsx (colors/nextColors/active/shuffleKey/entranceActive)
// so it's a drop-in swap — see LiveScreen.jsx for the flag that picks between
// this and the canvas2D version. This one has no shapes at all: color comes
// from a domain-warped simplex noise field, so there's nothing "circle"
// shaped to ever perceive, at the cost of needing a WebGL2 context (falls
// back to a flat near-black canvas if that's unavailable — see initGL below).
//
// Kept as a SEPARATE file from AlbumGradient.jsx rather than replacing it —
// that file is proven/tuned and stays the safe default; this is the opt-in
// experiment (?gradient=noise or localStorage.trivia_gradient_engine=noise).

const BLEND_DURATION_MS = 7500
const NUM_COLORS = 6

function hexToRgb01(hex) {
  if (!hex || hex.length < 7) return [8 / 255, 8 / 255, 8 / 255]
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ]
}

function parseColors(hexArr, n) {
  const src = hexArr.length ? hexArr : ['#080808']
  return Array.from({ length: n }, (_, i) => [...hexToRgb01(src[i % src.length])])
}

function easeInOut(t) {
  t = Math.max(0, Math.min(1, t))
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}

function lerp(a, b, t) { return a + (b - a) * t }

// Seeded per-color offsets/scale/speed for the noise weight fields — same
// "shared beat, staggered offset" idea as AlbumGradient's circle rhythm fix,
// translated to noise space: every color's weight field uses the same base
// scale/speed (so they read as one coordinated flow) but a distinct spatial
// offset (so each color has its own region of presence within that flow).
function makeColorSeeds() {
  function rng(i, slot) {
    const x = Math.sin((i * 7 + slot) * 9301 + 49297) * 233280
    return x - Math.floor(x)
  }
  return Array.from({ length: NUM_COLORS }, (_, i) => ({
    offsetX: rng(i, 0) * 40,
    offsetY: rng(i, 1) * 40,
  }))
}

const VERTEX_SRC = `#version 300 es
layout(location = 0) in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`

// Standard Ashima Arts 2D simplex noise (public-domain-style shader utility,
// ubiquitous in WebGL noise work) + fbm + domain warp for organic flow.
const FRAGMENT_SRC = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_colors[6];
uniform vec2 u_seeds[6];

vec3 mod289(vec3 x){return x - floor(x*(1.0/289.0))*289.0;}
vec2 mod289(vec2 x){return x - floor(x*(1.0/289.0))*289.0;}
vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}

float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                      -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
          + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m; m = m*m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amp * snoise(p);
    p *= 2.0;
    amp *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  // Keep noise-space square regardless of aspect ratio so flow doesn't stretch.
  vec2 p = uv * vec2(u_resolution.x / u_resolution.y, 1.0) * 2.2;
  float t = u_time * 0.045;

  // Domain warp: feed noise through noise for smooth, non-repeating flow —
  // this (not the color mixing below) is what makes it read as liquid
  // motion instead of a scrolling static pattern.
  vec2 warp = vec2(
    fbm(p + vec2(t, -t)),
    fbm(p + vec2(5.2, 1.3) + vec2(-t, t))
  );
  vec2 warped = p + warp * 0.9;

  float weights[6];
  float total = 0.0;
  for (int i = 0; i < 6; i++) {
    float n = fbm(warped + u_seeds[i] + t * 0.6);
    float w = pow(clamp(n * 0.5 + 0.5, 0.0, 1.0), 1.6);
    weights[i] = w;
    total += w;
  }

  vec3 color = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    color += u_colors[i] * (weights[i] / max(total, 0.0001));
  }

  fragColor = vec4(color, 1.0);
}
`

function compileShader(gl, type, src) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Shader compile failed: ${info}`)
  }
  return shader
}

export default function AlbumGradientNoise({ colors = [], nextColors = [], active = true, shuffleKey = 0, entranceActive = false }) {
  const canvasRef         = useRef(null)
  const activeRef         = useRef(active)
  const mountedRef        = useRef(true)
  const rafRef            = useRef(null)
  const glRef             = useRef(null)
  const uniformsRef       = useRef(null)
  const isFirst           = useRef(true)
  const isFirstNext       = useRef(true)
  const isFirstKey        = useRef(true)
  const pendingFromNextRef = useRef(false)
  const entranceActiveRef = useRef(entranceActive)
  const pendingBlendRef   = useRef(null)
  const colorSeeds        = useMemo(makeColorSeeds, [])

  const st = useRef(null)
  if (!st.current) {
    const initial = parseColors(colors, NUM_COLORS)
    st.current = {
      steadyRgb:  initial.map(c => [...c]),
      outRgb:     initial.map(c => [...c]),
      inRgb:      initial.map(c => [...c]),
      blendStart: -1,
    }
  }

  function startBlendTo(newHex) {
    const s   = st.current
    const now = performance.now()
    if (s.blendStart >= 0 && (now - s.blendStart) < BLEND_DURATION_MS) {
      const t = easeInOut(Math.min((now - s.blendStart) / BLEND_DURATION_MS, 1))
      s.outRgb = s.outRgb.map((c, i) => [
        lerp(c[0], s.inRgb[i][0], t),
        lerp(c[1], s.inRgb[i][1], t),
        lerp(c[2], s.inRgb[i][2], t),
      ])
    } else {
      s.outRgb = s.steadyRgb.map(c => [...c])
    }
    s.inRgb      = parseColors(newHex, NUM_COLORS)
    s.blendStart = performance.now()
    if (!rafRef.current && mountedRef.current) startLoop()
  }

  useEffect(() => {
    if (isFirstKey.current) { isFirstKey.current = false; return }
    const s     = st.current
    const black = Array.from({ length: NUM_COLORS }, () => [8 / 255, 8 / 255, 8 / 255])
    s.outRgb    = black.map(c => [...c])
    s.inRgb     = black.map(c => [...c])
    s.steadyRgb = black.map(c => [...c])
    s.blendStart = -1
    pendingFromNextRef.current = false
  }, [shuffleKey])

  useEffect(() => {
    if (isFirstNext.current) { isFirstNext.current = false; return }
    if (!nextColors.length) return
    if (nextColors.every(c => c === '#080808')) return
    if (entranceActiveRef.current) {
      pendingFromNextRef.current = true
      pendingBlendRef.current = nextColors
      return
    }
    startBlendTo(nextColors)
    pendingFromNextRef.current = true
  }, [nextColors])

  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; return }
    if (pendingFromNextRef.current) {
      pendingFromNextRef.current = false
      pendingBlendRef.current = null
      const s = st.current
      s.inRgb     = parseColors(colors, NUM_COLORS)
      s.steadyRgb = parseColors(colors, NUM_COLORS)
    } else {
      if (entranceActiveRef.current) { pendingBlendRef.current = colors; return }
      startBlendTo(colors)
    }
  }, [colors])

  useEffect(() => {
    entranceActiveRef.current = entranceActive
    if (!entranceActive && pendingBlendRef.current) {
      const pending = pendingBlendRef.current
      pendingBlendRef.current = null
      startBlendTo(pending)
    }
  }, [entranceActive])

  useEffect(() => {
    activeRef.current = active
    if (active && !rafRef.current && mountedRef.current) startLoop()
  }, [active])

  function startLoop() {
    rafRef.current = requestAnimationFrame(tick)
  }

  function tick(ts) {
    draw(ts)
    if (mountedRef.current && (activeRef.current || st.current.blendStart >= 0)) {
      rafRef.current = requestAnimationFrame(tick)
    } else {
      rafRef.current = null
    }
  }

  function draw(ts) {
    const gl = glRef.current
    const u  = uniformsRef.current
    if (!gl || !u) return
    const canvas = canvasRef.current
    const W = canvas.width, H = canvas.height
    if (!W || !H) return

    const s = st.current
    let liveColors
    if (s.blendStart >= 0) {
      const t = easeInOut(Math.min((ts - s.blendStart) / BLEND_DURATION_MS, 1))
      liveColors = s.outRgb.map((c, i) => [
        lerp(c[0], s.inRgb[i][0], t),
        lerp(c[1], s.inRgb[i][1], t),
        lerp(c[2], s.inRgb[i][2], t),
      ])
      if (t >= 1) {
        s.steadyRgb = s.inRgb.map(c => [...c])
        s.blendStart = -1
      }
    } else {
      liveColors = s.steadyRgb
    }

    gl.viewport(0, 0, W, H)
    gl.uniform2f(u.resolution, W, H)
    gl.uniform1f(u.time, ts / 1000)
    gl.uniform3fv(u.colors, new Float32Array(liveColors.flat()))
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    function resize() {
      const p = canvas.parentElement
      canvas.width  = Math.round((p ? p.clientWidth  : 0) || window.innerWidth)
      canvas.height = Math.round((p ? p.clientHeight : 0) || window.innerHeight)
    }
    resize()
    window.addEventListener('resize', resize)

    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false })
    if (!gl) {
      // No WebGL2 — this component is opt-in only (see LiveScreen's flag),
      // so failing here just means a flat near-black canvas, not a broken
      // live show on the default path. Log so it's obvious why during testing.
      console.warn('[AlbumGradientNoise] WebGL2 unavailable — falling back to flat background. Use the default (canvas2D) gradient instead.')
      return () => window.removeEventListener('resize', resize)
    }

    let program, vao, vbo
    try {
      const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC)
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC)
      program = gl.createProgram()
      gl.attachShader(program, vs)
      gl.attachShader(program, fs)
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`)
      }
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      gl.useProgram(program)

      // Fullscreen triangle (covers the viewport, cheaper than a quad — the
      // overhang past clip space gets clipped for free).
      vao = gl.createVertexArray()
      gl.bindVertexArray(vao)
      vbo = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

      const seedsFlat = new Float32Array(colorSeeds.flatMap(s => [s.offsetX, s.offsetY]))
      const seedsLoc = gl.getUniformLocation(program, 'u_seeds')
      gl.uniform2fv(seedsLoc, seedsFlat)

      uniformsRef.current = {
        resolution: gl.getUniformLocation(program, 'u_resolution'),
        time:       gl.getUniformLocation(program, 'u_time'),
        colors:     gl.getUniformLocation(program, 'u_colors'),
      }
      glRef.current = gl
    } catch (err) {
      console.error('[AlbumGradientNoise] setup failed, falling back to flat background:', err)
      return () => window.removeEventListener('resize', resize)
    }

    if (activeRef.current) startLoop()

    return () => {
      mountedRef.current = false
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      window.removeEventListener('resize', resize)
      if (program) gl.deleteProgram(program)
      if (vbo) gl.deleteBuffer(vbo)
      if (vao) gl.deleteVertexArray(vao)
    }
  }, [colorSeeds])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        display: 'block',
        willChange: 'transform',
        transform: 'translateZ(0)',
      }}
    />
  )
}
