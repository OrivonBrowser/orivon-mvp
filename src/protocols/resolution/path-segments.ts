// The one way a requested URL path becomes the names a content tree is walked by.

/**
 * A URL pathname's segments, percent-decoded. Undefined for anything that
 * could name something other than a child of the root: `.`, `..`, an
 * encoded slash, a NUL, or an empty segment before the end.
 */
export function pathSegments (pathname: string): string[] | undefined {
  if (!pathname.startsWith('/')) return undefined
  const raw = pathname.slice(1).split('/')
  if (raw[raw.length - 1] === '') raw.pop()
  const segments: string[] = []
  for (const part of raw) {
    let segment: string
    try {
      segment = decodeURIComponent(part)
    } catch {
      return undefined
    }
    if (segment === '' || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\0')) return undefined
    segments.push(segment)
  }
  return segments
}
