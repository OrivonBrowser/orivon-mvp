// HTTP Range header parsing for a single, known-length resource -- pure, no
// I/O. Split out of serve.ts (Rule 2). ADR-0007's own probe (spike/adr7-
// probe/) proved Electron's protocol.handle can carry a real 206 response --
// this file is the part that decides WHICH bytes a given Range header asks
// for, over the one form this loader needs to support (RFC 9110 SS14.1.2's
// single byte-range-spec; a list of ranges is deliberately out of scope --
// see RangeResult's own doc).

/** Inclusive byte offsets, both ends within the resource's length. */
export interface ByteRange {
  readonly start: number
  readonly end: number
}

export type RangeResult =
  /** No Range header, or one this loader does not parse (see below) -- serve the whole resource, status 200. */
  | { readonly kind: 'none' }
  | { readonly kind: 'satisfiable', readonly range: ByteRange }
  /** A Range header naming a range this resource cannot satisfy -- status 416. */
  | { readonly kind: 'unsatisfiable' }

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/

/**
 * Parses one `Range` header against a resource of `totalLength` bytes.
 *
 * A MULTI-RANGE header (`bytes=0-10,20-30`) does not match `SINGLE_RANGE`
 * and falls through to `'none'` -- RFC 9110 SS14.1.2 permits ignoring a
 * Range header entirely and serving the whole resource, and doing so here is
 * simpler than a `multipart/byteranges` response this loader has no reader
 * that needs. Likewise a header that fails to parse at all: this loader is
 * not the place to enforce Range syntax on a client that will get correct
 * bytes either way.
 *
 * `totalLength` bounds every number below it -- a request naming a range
 * that starts at or past the end of the resource is `'unsatisfiable'`, and
 * an end past the last byte is silently clamped to it, matching ordinary
 * static file server behaviour.
 */
export function parseRange (rangeHeader: string | null, totalLength: number): RangeResult {
  if (rangeHeader === null) return { kind: 'none' }

  const match = SINGLE_RANGE.exec(rangeHeader.trim())
  if (match === null) return { kind: 'none' }

  const [, startText, endText] = match as unknown as [string, string, string]
  if (startText === '' && endText === '') return { kind: 'none' }

  let start: number
  let end: number
  if (startText === '') {
    // A SUFFIX range ("bytes=-500"): the last `endText` bytes of the resource.
    const suffixLength = Number(endText)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { kind: 'unsatisfiable' }
    start = Math.max(0, totalLength - suffixLength)
    end = totalLength - 1
  } else {
    start = Number(startText)
    end = endText === '' ? totalLength - 1 : Number(endText)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end) return { kind: 'unsatisfiable' }
  if (totalLength === 0 || start >= totalLength) return { kind: 'unsatisfiable' }

  return { kind: 'satisfiable', range: { start, end: Math.min(end, totalLength - 1) } }
}
