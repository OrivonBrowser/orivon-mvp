// Header edits for the network privacy controls. Pure: no `electron` import.
// Every function returns the object it was given when it changes nothing, so
// the web-request owner can tell "no opinion" from "rewrite the headers"
// (web-request-owner.ts answers a bare `{}` for an unchanged result).

export interface PrivacySignals {
  readonly gpc: boolean
  readonly dnt: boolean
}

/** The key `headers` already holds for `name`, whatever its case. */
function keyOf (headers: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  return Object.keys(headers).find((key) => key.toLowerCase() === wanted)
}

/** `headers` with `name` set to `value`, replacing a differently-cased spelling of the same header. */
function withHeader (headers: Record<string, string>, name: string, value: string): Record<string, string> {
  const existing = keyOf(headers, name)
  if (existing === name && headers[existing] === value) return headers
  const next = { ...headers }
  if (existing !== undefined) delete next[existing]
  next[name] = value
  return next
}

/** Adds `Sec-GPC: 1` and `DNT: 1` as asked; a signal that is off leaves the request as it was. */
export function withPrivacySignals (headers: Record<string, string>, signals: PrivacySignals): Record<string, string> {
  let next = headers
  if (signals.gpc) next = withHeader(next, 'Sec-GPC', '1')
  if (signals.dnt) next = withHeader(next, 'DNT', '1')
  return next
}

/** `headers` without the `Cookie` request header. */
export function withoutCookie (headers: Record<string, string>): Record<string, string> {
  const existing = keyOf(headers, 'cookie')
  if (existing === undefined) return headers
  const next = { ...headers }
  delete next[existing]
  return next
}

/** A response's headers without `Set-Cookie`. */
export function withoutSetCookie (headers: Record<string, string[]>): Record<string, string[]> {
  const existing = keyOf(headers, 'set-cookie')
  if (existing === undefined) return headers
  const next = { ...headers }
  delete next[existing]
  return next
}
