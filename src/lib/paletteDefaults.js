// Shared between api/palette.js (runs on Vercel's infra) and the client
// tuning board (src/lib/gradientTuning.js). Pure data + one pure function —
// no browser or Node APIs — so both bundles can import it (Vercel's nft
// tracing follows the ../src import when bundling the serverless function).
//
// Only the VARIETY dial reaches the server (see the plan doc's dial table).
// It's a single 0-100 "feel" value; this file is the one place that curve
// is defined, so the client and server can never compute it differently.

export function varietyToConfig(variety) {
  // Number(undefined)/Number('abc') is NaN, and `NaN ?? 50` is still NaN (??
  // only catches null/undefined) — an earlier version of this line let a bad
  // input fall all the way through to HUE_GAP_DEG: NaN. Guard on isFinite.
  const n = Number(variety)
  const v = (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50) / 100
  return {
    HUE_GAP_DEG: Math.round(5 + (45 - 5) * v),   // 50 → 25, matches today's hardcoded value
    MIN_COLORS: Math.round(3 + (7 - 3) * v),      // 50 → 5, matches today's hardcoded value
  }
}

// Reads t_VARIETY off the request (0-100). Absent/invalid → 50 (today's
// behavior, byte-identical query string, keeps the CDN cache warm).
// Returns { cfg, overridden } — overridden tells the handler to answer
// no-store instead of using the normal 24h cache.
export function resolvePaletteConfig(query = {}) {
  const raw = query.t_VARIETY
  if (raw === undefined) return { cfg: varietyToConfig(50), overridden: false }
  const n = Number(raw)
  if (!Number.isFinite(n)) return { cfg: varietyToConfig(50), overridden: false }
  return { cfg: varietyToConfig(n), overridden: true }
}
