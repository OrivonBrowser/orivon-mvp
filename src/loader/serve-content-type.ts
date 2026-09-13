// Content-Type derivation for a cached asset -- pure, no I/O. Split out of
// serve.ts (Rule 2) the same way serve-range.ts is: one narrow question,
// independently testable.
//
// DERIVED FROM THE CANONICAL PATH'S RAW EXTENSION, NEVER FROM THE DECODED
// FILESYSTEM PATH -- a path whose extension is itself percent-encoded
// (`/evil%2Ejs`) is a pinned leaf like any other, but its RAW text does not
// end in `.js`, so it falls through to the conservative default below rather
// than being served as script. That is the direction ADR-0007's brief asks
// for: "be conservative for anything unknown rather than guessing something
// executable."

/** Never returned for anything but a genuinely unrecognised extension -- the browser will not execute this as script or a stylesheet. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf'
}

/**
 * `canonicalPath`'s extension (case-insensitive, ASCII-lowercased), mapped to
 * a Content-Type -- `DEFAULT_CONTENT_TYPE` for anything not in the table
 * above, including a path with no extension at all.
 */
export function contentTypeFor (canonicalPath: string): string {
  const dot = canonicalPath.lastIndexOf('.')
  if (dot === -1) return DEFAULT_CONTENT_TYPE
  const extension = canonicalPath.slice(dot).toLowerCase()
  return CONTENT_TYPES[extension] ?? DEFAULT_CONTENT_TYPE
}
