/**
 * The Content-Security-Policy every document served from this computer carries in the local-files
 * session. It names no `default-src`, so scripts, styles, images, fonts and media of the document's
 * own folder keep loading; what it removes is a document reading another `file:` resource as data:
 * `connect-src` has no `file:` (so `fetch` and XMLHttpRequest cannot read a sibling), `frame-src`
 * and `object-src` have none (no sibling as a frame or plugin), and `worker-src` allows only
 * `blob:` and `data:`.
 */
export const LOCAL_FILE_CSP = [
  'connect-src https: http: wss: ws: blob: data:',
  'frame-src https: http: blob: data:',
  'worker-src blob: data:',
  "object-src 'none'"
].join('; ')

/**
 * The policy of a `file:` document served to a session that is not the local-files session: a
 * sandboxed, empty page with nothing it may load, shown only until the tab moves to the
 * local-files session.
 */
export const INERT_FILE_CSP = "sandbox; default-src 'none'"

/**
 * `headers` plus each of `policies` as one more Content-Security-Policy header. The browser enforces
 * every policy it is sent, so the result is their intersection: a later policy can only narrow an
 * earlier one, never relax it.
 */
export function withPolicies (headers: Headers, policies: readonly string[]): Headers {
  const result = new Headers(headers)
  for (const policy of policies) result.append('content-security-policy', policy)
  return result
}

/**
 * `X-Content-Type-Options: nosniff` on every local-file response. Without it a page can include a text
 * file as a script or a stylesheet: the file is parsed as code, and the error it raises (a ReferenceError
 * naming the first unknown word, as an `.env` value is) tells the page what the file says. With it, only
 * a file whose type is a script or a stylesheet runs as one.
 */
export const NO_SNIFF_HEADER = ['x-content-type-options', 'nosniff'] as const
