import { describe, expect, it } from 'vitest'
import { parseRange } from '../range.js'

const TOTAL = 1000

describe('parseRange', () => {
  it('no Range header -- serve the whole resource', () => {
    expect(parseRange(null, TOTAL)).toEqual({ kind: 'none' })
  })

  it('a closed range -- ADR-0007\'s own probe: bytes=100-199', () => {
    expect(parseRange('bytes=100-199', TOTAL)).toEqual({ kind: 'satisfiable', range: { start: 100, end: 199 } })
  })

  it('an open-ended range serves to the last byte', () => {
    expect(parseRange('bytes=500-', TOTAL)).toEqual({ kind: 'satisfiable', range: { start: 500, end: 999 } })
  })

  it('a suffix range serves the last N bytes', () => {
    expect(parseRange('bytes=-100', TOTAL)).toEqual({ kind: 'satisfiable', range: { start: 900, end: 999 } })
  })

  it('a suffix range longer than the resource clamps to the whole resource', () => {
    expect(parseRange('bytes=-5000', TOTAL)).toEqual({ kind: 'satisfiable', range: { start: 0, end: 999 } })
  })

  it('an end past the last byte is clamped, not rejected', () => {
    expect(parseRange('bytes=900-5000', TOTAL)).toEqual({ kind: 'satisfiable', range: { start: 900, end: 999 } })
  })

  it('a start at or past the resource length is unsatisfiable', () => {
    expect(parseRange('bytes=1000-1001', TOTAL)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange(`bytes=${TOTAL}-`, TOTAL)).toEqual({ kind: 'unsatisfiable' })
  })

  it('start after end is unsatisfiable', () => {
    expect(parseRange('bytes=200-100', TOTAL)).toEqual({ kind: 'unsatisfiable' })
  })

  it('a zero or negative suffix length is unsatisfiable, not a whole-resource fallback', () => {
    expect(parseRange('bytes=-0', TOTAL)).toEqual({ kind: 'unsatisfiable' })
  })

  it('an empty resource can never satisfy any range', () => {
    expect(parseRange('bytes=0-0', 0)).toEqual({ kind: 'unsatisfiable' })
  })

  it('a bare "bytes=-" (neither end given) falls through to "none", not a crash', () => {
    expect(parseRange('bytes=-', TOTAL)).toEqual({ kind: 'none' })
  })

  it('a multi-range header is ignored, serving the whole resource -- this loader has no multipart/byteranges reader', () => {
    expect(parseRange('bytes=0-10,20-30', TOTAL)).toEqual({ kind: 'none' })
  })

  it('a header in a unit other than bytes is ignored, not misparsed', () => {
    expect(parseRange('items=0-10', TOTAL)).toEqual({ kind: 'none' })
  })

  it('garbage is ignored, not thrown', () => {
    expect(parseRange('not a range header', TOTAL)).toEqual({ kind: 'none' })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseRange('  bytes=10-19  ', TOTAL)).toEqual({ kind: 'satisfiable', range: { start: 10, end: 19 } })
  })
})
