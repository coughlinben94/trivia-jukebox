import { describe, it, expect } from 'vitest'
import { resolveCrossfadeHex } from '../components/AlbumGradientMesh.jsx'

// Thinktank round 3 (2026-08-03): each blob crossfades independently from
// its own family's outgoing shade to its incoming shade over ~7.5s
// (blendPairRgb, OKLab lerp). The steady-state hue gate in
// pickGradientColors only ever validates a song's OWN pair at t=0/t=1 --
// never the cross-family combination that exists mid-fade (family A's
// partial blend vs family B's partial blend). Monte Carlo (200k simulated
// transitions, each song's own pair pre-gated to 30-140 deg) measured this
// swinging past 140 deg in a real, non-rare fraction of transitions, worst
// case 178.7 deg at real chroma. resolveCrossfadeHex closes it cheaply:
// since family assignment is index-parity (parseColors: array[0] -> family
// A, array[1] -> family B), swapping which incoming color feeds which
// family flips BOTH cross-pairs at once, so try that before accepting a bad
// pairing, and fall back to single-color (monochrome fan) if even the swap
// doesn't clear it.
describe('resolveCrossfadeHex', () => {
  it('passes the incoming pair through unchanged when both cross-pairs are already compatible', () => {
    // out = [red(~10deg), gold(~85deg)], in = [violet(~295deg)... ] picked
    // so the direct cross-pairs (outA vs inB, outB vs inA) both land in
    // 30-140. Using real-ish hues: out red/gold (75 apart), in gold/teal-ish
    // won't necessarily hold across implementations of hue math, so this
    // test only asserts on hex identity, not the geometry -- it uses colors
    // verified compatible by pickGradientColors.test.js's own fixtures.
    const out = ['#ea513f', '#e8a33d'] // red / gold, ~55 deg apart (see pickGradientColors.test.js)
    const inn = ['#ea513f', '#e8a33d'] // same pair coming back in -- trivially compatible both ways
    expect(resolveCrossfadeHex(out, inn)).toEqual(['#ea513f', '#e8a33d'])
  })

  it('swaps the incoming pair when the direct cross-pairs are incompatible but the swapped ones are fine', () => {
    // OKLab hues verified with a standalone node check before writing this
    // assertion: outA=27.3deg, outB=236.9deg, inA=78.9deg, inB=177.4deg.
    // Direct cross-pairs: |outA-inB|=150.1deg (fails the 140deg ceiling),
    // |outB-inA|=158.1deg (also fails) -- so the direct assignment must be
    // rejected. Swapped cross-pairs: |outA-inA|=51.6deg, |outB-inB|=59.5deg
    // -- both comfortably in-band, so the swap must be taken.
    const out = ['#d92626', '#269dd9'] // outA / outB
    const inn = ['#d99d26', '#26d9bb'] // inA / inB
    const result = resolveCrossfadeHex(out, inn)
    expect(result).toEqual(['#26d9bb', '#d99d26']) // inB, inA -- family A now gets inB, family B gets inA
  })

  it('falls back to a single color when neither direct nor swapped assignment is compatible', () => {
    // out = red(~11deg)/gold(~63deg), both clustered on the warm side; in =
    // a single near-complementary teal/cyan color repeated so neither
    // direct nor swapped placement can land in-band against both.
    const out = ['#ea513f', '#e8a33d']
    const inn = ['#2fd3c8', '#2fd3c8']
    const result = resolveCrossfadeHex(out, inn)
    expect(result).toEqual(['#2fd3c8'])
  })

  it('passes incoming through unchanged when either side has fewer than 2 colors', () => {
    expect(resolveCrossfadeHex(['#ea513f'], ['#e8a33d', '#3a6fd8'])).toEqual(['#e8a33d', '#3a6fd8'])
    expect(resolveCrossfadeHex(['#ea513f', '#e8a33d'], ['#3a6fd8'])).toEqual(['#3a6fd8'])
    expect(resolveCrossfadeHex([], ['#3a6fd8', '#e8a33d'])).toEqual(['#3a6fd8', '#e8a33d'])
  })
})
